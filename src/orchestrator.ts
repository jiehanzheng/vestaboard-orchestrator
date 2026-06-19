export type Priority = "none" | "low" | "normal" | "high" | "urgent" | string | number;

export interface VestaboardMessage {
  text: string;
  characters?: number[][];
}

export interface Plugin {
  id: string;
  getUpdate(): Promise<PluginUpdate>;
}

export interface PluginUpdate {
  priority: Priority;
  message: VestaboardMessage;
}

export interface VestaboardClient {
  send(message: VestaboardMessage): Promise<void>;
}

const PRIORITIES: Record<string, number> = {
  none: 0,
  low: 10,
  normal: 50,
  high: 80,
  urgent: 100
};

export async function tick({
  plugins,
  vestaboard,
  logger = console
}: {
  plugins: Plugin[];
  vestaboard: VestaboardClient;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const ranked = await Promise.all(
    plugins.map(async (plugin) => {
      try {
        const update = await plugin.getUpdate();
        return { plugin, update, priority: toPriorityNumber(update.priority) };
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
      await vestaboard.send(update.message);
      logger.info(`Sent Vestaboard message from ${plugin.id} at priority ${priority}.`);
      return;
    } catch (error) {
      logger.warn(`Plugin ${plugin.id} send failed.`, error);
    }
  }

  logger.info("No plugin rendered a message.");
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

function toPriorityNumber(priority: Priority): number {
  if (typeof priority === "number" && Number.isFinite(priority)) {
    return priority;
  }

  return PRIORITIES[String(priority).toLowerCase()] ?? 0;
}
