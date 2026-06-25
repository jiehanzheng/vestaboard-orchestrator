import type { VestaboardClient, VestaboardMessage } from "./orchestrator.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";

export type LocalMessageTransitionStrategy =
  | "column"
  | "reverse-column"
  | "edges-to-center"
  | "row"
  | "diagonal"
  | "random";

export interface LocalMessageTransitionOptions {
  strategy: LocalMessageTransitionStrategy;
  stepIntervalMs: number;
  stepSize: number;
}

export const DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS: LocalMessageTransitionOptions = {
  strategy: "row",
  stepIntervalMs: 2000,
  stepSize: 1
};

export function createVestaboardClient({
  dryRun,
  token,
  localApiKey,
  cloudUrl = "https://cloud.vestaboard.com/",
  localUrl = "http://vestaboard.local:7000/local-api/message",
  localMessageTransition = DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS,
  fetchImpl = fetch,
  logger = console
}: {
  dryRun: boolean;
  token?: string;
  localApiKey?: string;
  cloudUrl?: string;
  localUrl?: string;
  localMessageTransition?: LocalMessageTransitionOptions;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info">;
}): VestaboardClient {
  const detectBoard = localApiKey
    ? () => detectLocalVestaboardBoard({ localApiKey, localUrl, fetchImpl, logger })
    : token
      ? () => detectVestaboardBoard({ token, cloudUrl, fetchImpl, logger })
      : undefined;

  if (dryRun) {
    return {
      detectBoard,
      async send(message) {
        logger.info("Dry-run Vestaboard message:");
        logger.info(message.text);
        if (message.characters) {
          logger.info("Character payload:");
          logger.info(JSON.stringify(message.characters));
        }
      }
    };
  }

  if (localApiKey) {
    return {
      detectBoard,
      send(message) {
        if (!message.characters) {
          throw new Error("Local Vestaboard mode requires character-code messages.");
        }

        return post(fetchImpl, localUrl, {
          headers: { "X-Vestaboard-Local-Api-Key": localApiKey },
          body: {
            characters: message.characters,
            strategy: localMessageTransition.strategy,
            step_interval_ms: localMessageTransition.stepIntervalMs,
            step_size: localMessageTransition.stepSize
          }
        });
      }
    };
  }

  if (!token) {
    throw new Error("VESTABOARD_TOKEN or VESTABOARD_LOCAL_API_KEY is required.");
  }

  return {
    detectBoard,
    send: (message) =>
      post(fetchImpl, cloudUrl, {
        headers: { "X-Vestaboard-Token": token },
        body: message.characters ? { characters: message.characters } : { text: message.text }
      })
  };
}

export async function detectVestaboardBoard({
  token,
  cloudUrl = "https://cloud.vestaboard.com/",
  fetchImpl = fetch,
  logger = console
}: {
  token: string;
  cloudUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info">;
}): Promise<VestaboardBoard | undefined> {
  const response = await fetchImpl(cloudUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Vestaboard-Token": token
    }
  });

  if (!response.ok) {
    return undefined;
  }

  const body = await response.json() as { currentMessage?: { layout?: unknown } };
  const board = boardFromLayout(body.currentMessage?.layout);
  if (!board) logger.info(`Vestaboard Cloud API raw response: ${JSON.stringify(body)}`);
  return board;
}

export async function detectLocalVestaboardBoard({
  localApiKey,
  localUrl = "http://vestaboard.local:7000/local-api/message",
  fetchImpl = fetch,
  logger = console
}: {
  localApiKey: string;
  localUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info">;
}): Promise<VestaboardBoard | undefined> {
  const response = await fetchImpl(localUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Vestaboard-Local-Api-Key": localApiKey
    }
  });

  if (!response.ok) {
    return undefined;
  }

  const body = await response.json();
  const board = boardFromLayout(localApiLayout(body));
  if (!board) logger.info(`Vestaboard Local API raw response: ${JSON.stringify(body)}`);
  return board;
}

function localApiLayout(body: unknown): unknown {
  if (body !== null && typeof body === "object" && "message" in body) {
    return (body as { message: unknown }).message;
  }

  return body;
}

export function localMessageTransitionOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "error"> = console
): { options: LocalMessageTransitionOptions; hasError: boolean } {
  let hasError = false;
  const options: LocalMessageTransitionOptions = { ...DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS };

  const strategy = env.VESTABOARD_LOCAL_MESSAGE_STRATEGY;
  if (strategy !== undefined) {
    if (isLocalMessageTransitionStrategy(strategy)) {
      options.strategy = strategy;
    } else {
      hasError = true;
      logger.error(
        `Invalid VESTABOARD_LOCAL_MESSAGE_STRATEGY '${strategy}'; using default '${DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS.strategy}'.`
      );
    }
  }

  const stepIntervalMs = positiveNumberFromEnv({
    value: env.VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS,
    name: "VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS",
    defaultValue: DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS.stepIntervalMs,
    logger
  });
  options.stepIntervalMs = stepIntervalMs.value;
  hasError ||= stepIntervalMs.hasError;

  const stepSize = positiveNumberFromEnv({
    value: env.VESTABOARD_LOCAL_MESSAGE_STEP_SIZE,
    name: "VESTABOARD_LOCAL_MESSAGE_STEP_SIZE",
    defaultValue: DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS.stepSize,
    logger
  });
  options.stepSize = stepSize.value;
  hasError ||= stepSize.hasError;

  return { options, hasError };
}

function isLocalMessageTransitionStrategy(value: string): value is LocalMessageTransitionStrategy {
  return ["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"].includes(value);
}

function positiveNumberFromEnv({
  value,
  name,
  defaultValue,
  logger
}: {
  value: string | undefined;
  name: string;
  defaultValue: number;
  logger: Pick<Console, "error">;
}): { value: number; hasError: boolean } {
  if (value === undefined) {
    return { value: defaultValue, hasError: false };
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { value: parsed, hasError: false };
  }

  logger.error(`Invalid ${name} '${value}'; using default '${defaultValue}'.`);
  return { value: defaultValue, hasError: true };
}

function boardFromLayout(layout: unknown): VestaboardBoard | undefined {
  const dimensions = layoutDimensions(layout);
  if (!dimensions) {
    return undefined;
  }

  if (dimensions.rows === 3 && dimensions.columns === 15) return "note";
  if (dimensions.rows === 6 && dimensions.columns === 22) return "flagship";
  return undefined;
}

function layoutDimensions(layout: unknown): { rows: number; columns: number } | undefined {
  const parsed = typeof layout === "string" ? parseJson(layout) : layout;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }

  const rows = parsed as unknown[];
  if (!rows.every((row) => Array.isArray(row))) {
    return undefined;
  }

  const columns = (rows[0] as unknown[]).length;
  if (columns <= 0 || !rows.every((row) => (row as unknown[]).length === columns)) {
    return undefined;
  }

  return { rows: rows.length, columns };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  { headers, body }: { headers: Record<string, string>; body: unknown }
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Vestaboard API returned ${response.status}: ${await response.text()}`);
  }
}
