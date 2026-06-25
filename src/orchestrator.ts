import { priorityValue, type Priority } from "./priority.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";

export type { Priority } from "./priority.js";

export interface VestaboardMessage {
  text: string;
  characters?: number[][];
}

export interface Plugin {
  id: string;
  slug?: string;
  getUpdate(): Promise<PluginUpdate>;
}

export interface PluginUpdate {
  priority: Priority;
  message: VestaboardMessage;
}

export interface VestaboardClient {
  send(message: VestaboardMessage): Promise<void>;
  detectBoard?(): Promise<VestaboardBoard | undefined>;
}

export class LastSentMessageCache {
  private lastMessageKey: string | undefined;

  has(message: VestaboardMessage): boolean {
    return this.lastMessageKey === messageKey(message);
  }

  remember(message: VestaboardMessage): void {
    this.lastMessageKey = messageKey(message);
  }
}

export async function tick({
  plugins,
  vestaboard,
  sentMessageCache,
  logger = console
}: {
  plugins: Plugin[];
  vestaboard: VestaboardClient;
  sentMessageCache?: LastSentMessageCache;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const ranked = await Promise.all(
    plugins.map(async (plugin) => {
      try {
        const update = await plugin.getUpdate();
        return { plugin, update, priority: priorityValue(update.priority) };
      } catch (error) {
        logger.warn(`Plugin ${plugin.id} update failed.`, error);
        return null;
      }
    })
  );

  for (const entry of ranked
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.priority - a.priority)) {
    const { plugin, update, priority } = entry;
    if (priority <= 0) {
      break;
    }

    try {
      if (sentMessageCache?.has(update.message)) {
        logger.info(`Skipped unchanged Vestaboard message from ${plugin.id}.`);
        return;
      }

      await vestaboard.send(update.message);
      sentMessageCache?.remember(update.message);
      logger.info(`Sent Vestaboard message from ${plugin.id} at priority ${priority}.`);
      return;
    } catch (error) {
      logger.warn(`Plugin ${plugin.id} send failed.`, error);
    }
  }

  logger.info("No plugin rendered a message.");
}

function messageKey(message: VestaboardMessage): string {
  return JSON.stringify(message.characters ?? message.text);
}

export async function runForever({
  runOnce,
  waitMs,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  shouldContinue = () => true
}: {
  runOnce: () => Promise<void>;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
}): Promise<void> {
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw new Error("waitMs must be a positive number.");
  }

  while (shouldContinue()) {
    await runOnce();
    if (shouldContinue()) {
      await sleep(waitMs);
    }
  }
}
