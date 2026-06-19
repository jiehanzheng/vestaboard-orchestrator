import { withCodexAppServer } from "./appServer.js";
import { CodexAutoStartSidecar, type AutoStartQuotaConfig } from "./autoStartSidecar.js";
import type { QuotaPollOptions, QuotaPoller, QuotaPollResult, QuotaSnapshot, QuotaWindow } from "./types.js";

interface RateWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

interface RateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

export interface RateLimitsResult {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
}

const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10_080;

export function createCodexQuotaPoller(autoStartConfig: AutoStartQuotaConfig): QuotaPoller {
  const autoStartSidecar = new CodexAutoStartSidecar(autoStartConfig);
  return async (options: QuotaPollOptions = {}) => readCodexQuotaWithSidecar(autoStartSidecar, options);
}

export async function readCodexQuota(): Promise<QuotaSnapshot> {
  return withCodexAppServer(async (client) => {
    const rateLimits = await client.request<RateLimitsResult>("account/rateLimits/read");
    return quotaFromRateLimits(rateLimits);
  });
}

export async function readRateLimits(): Promise<RateLimitsResult> {
  return withCodexAppServer((client) => client.request<RateLimitsResult>("account/rateLimits/read"));
}

export function quotaFromRateLimits(result: RateLimitsResult): QuotaSnapshot {
  const windows = bucketsInPreferenceOrder(result).flatMap((bucket) => [bucket.primary, bucket.secondary].filter(isRateWindow));
  const snapshot = {
    fiveHour: windows.find((window) => window.windowDurationMins === FIVE_HOUR_MINS),
    weekly: windows.find((window) => window.windowDurationMins === WEEKLY_MINS)
  };

  if (!snapshot.fiveHour && !snapshot.weekly) {
    throw new Error("Codex rateLimits result must include a 5H or weekly quota window.");
  }

  return {
    fiveHour: snapshot.fiveHour ? quotaWindow(snapshot.fiveHour) : undefined,
    weekly: snapshot.weekly ? quotaWindow(snapshot.weekly) : undefined
  };
}

export async function readFixtureQuota(): Promise<QuotaSnapshot> {
  const now = new Date();
  return {
    fiveHour: { remainingRatio: 0.76, resetAt: new Date(now.getTime() + FIVE_HOUR_MINS * 60_000), durationMins: FIVE_HOUR_MINS },
    weekly: { remainingRatio: 0.44, resetAt: nextMonday(now), durationMins: WEEKLY_MINS }
  };
}

async function readCodexQuotaWithSidecar(
  autoStartSidecar: CodexAutoStartSidecar,
  options: QuotaPollOptions
): Promise<QuotaPollResult> {
  return withCodexAppServer(async (client) => {
    const rateLimits = await client.request<RateLimitsResult>("account/rateLimits/read");
    const snapshot = quotaFromRateLimits(rateLimits);
    const autoStart = await autoStartSidecar.afterQuotaRead({
      client,
      snapshot,
      force: options.forceAutoStart === true,
      now: options.now ?? new Date()
    });

    return {
      snapshot,
      thirdRowMessage: autoStart.statusMessage
    };
  });
}

function bucketsInPreferenceOrder(result: RateLimitsResult): RateLimitBucket[] {
  return [
    result.rateLimits,
    ...Object.values(result.rateLimitsByLimitId ?? {})
  ].filter((bucket): bucket is RateLimitBucket => bucket !== null && bucket !== undefined);
}

function isRateWindow(window: RateWindow | null | undefined): window is RateWindow {
  return window !== null && window !== undefined;
}

function quotaWindow(window: RateWindow): QuotaWindow {
  if (!Number.isFinite(window.usedPercent) || !Number.isFinite(window.resetsAt) || !Number.isFinite(window.windowDurationMins)) {
    throw new Error("Codex rate limit window contains invalid numeric fields.");
  }

  return {
    remainingRatio: clamp((100 - window.usedPercent) / 100),
    resetAt: new Date(window.resetsAt * 1000),
    durationMins: window.windowDurationMins
  };
}

function nextMonday(date: Date): Date {
  const reset = new Date(date);
  reset.setDate(reset.getDate() + (reset.getDay() === 0 ? 1 : 8 - reset.getDay()));
  reset.setHours(0, 0, 0, 0);
  return reset;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
