import type { Priority } from "../../orchestrator.js";

export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
}

export interface QuotaWindow {
  remainingRatio: number;
  resetAt: Date;
  durationMins: number;
}

export interface QuotaPollOptions {
  forceAutoStart?: boolean;
  now?: Date;
}

export interface QuotaPollResult {
  snapshot: QuotaSnapshot;
  thirdRowMessage?: string;
  sidecarError?: unknown;
}

export type QuotaPoller = (options?: QuotaPollOptions) => Promise<QuotaSnapshot | QuotaPollResult>;
export type QuotaRowName = "5H" | "WK";
export type Logger = Pick<Console, "warn">;

export interface CodexQuotaPluginOptions {
  fixture?: boolean;
  priority?: Priority;
  errorPriority?: Priority;
  timeZone?: string;
  autoStartWindow5h?: boolean;
  autoStartWindowWk?: boolean;
}
