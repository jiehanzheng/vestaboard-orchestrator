import type { VestaboardClient, VestaboardMessage } from "./orchestrator.js";
import type { VestaboardBoard } from "./plugins/codexQuota/types.js";

export function createVestaboardClient({
  dryRun,
  token,
  localApiKey,
  cloudUrl = "https://cloud.vestaboard.com/",
  localUrl = "http://vestaboard.local:7000/local-api/message",
  fetchImpl = fetch,
  logger = console
}: {
  dryRun: boolean;
  token?: string;
  localApiKey?: string;
  cloudUrl?: string;
  localUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info">;
}): VestaboardClient {
  if (dryRun) {
    return {
      detectBoard: token ? () => detectVestaboardBoard({ token, cloudUrl, fetchImpl }) : undefined,
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
      send(message) {
        if (!message.characters) {
          throw new Error("Local Vestaboard mode requires character-code messages.");
        }

        return post(fetchImpl, localUrl, {
          headers: { "X-Vestaboard-Local-Api-Key": localApiKey },
          body: message.characters
        });
      }
    };
  }

  if (!token) {
    throw new Error("VESTABOARD_TOKEN or VESTABOARD_LOCAL_API_KEY is required.");
  }

  return {
    detectBoard: () => detectVestaboardBoard({ token, cloudUrl, fetchImpl }),
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
  fetchImpl = fetch
}: {
  token: string;
  cloudUrl?: string;
  fetchImpl?: typeof fetch;
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
  const dimensions = layoutDimensions(body.currentMessage?.layout);
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
