import type { VestaboardClient, VestaboardMessage } from "./orchestrator.js";

export function createVestaboardClient({
  dryRun,
  mode,
  token,
  localApiKey,
  cloudUrl = "https://cloud.vestaboard.com/",
  localUrl = "http://vestaboard.local:7000/local-api/message",
  fetchImpl = fetch,
  logger = console
}: {
  dryRun: boolean;
  mode: "cloud" | "local";
  token?: string;
  localApiKey?: string;
  cloudUrl?: string;
  localUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info">;
}): VestaboardClient {
  if (dryRun) {
    return {
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

  if (mode === "cloud") {
    if (!token) {
      throw new Error("VESTABOARD_TOKEN is required for cloud mode.");
    }

    return {
      send: (message) =>
        post(fetchImpl, cloudUrl, {
          headers: { "X-Vestaboard-Token": token },
          body: message.characters ? { characters: message.characters } : { text: message.text }
        })
    };
  }

  if (!localApiKey) {
    throw new Error("VESTABOARD_LOCAL_API_KEY is required for local mode.");
  }

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
