import type { QuotaRowName, QuotaSnapshot, QuotaWindow } from "./types.js";

export interface AutoStartQuotaConfig {
  fiveHour: boolean;
  weekly: boolean;
}

export type QuotaWindowId = "fiveHour" | "weekly";

export interface AutoStartWindowCandidate {
  id: QuotaWindowId;
  row: QuotaRowName;
  resetAtMs: number;
}

export type AutoStartPingPlan =
  | { type: "skip"; reason: "no-eligible-window" | "cooldown" }
  | { type: "ping"; trigger: "force"; windows: [] }
  | { type: "ping"; trigger: "unused-quota"; windows: AutoStartWindowCandidate[] };

export type ResetVisibility = Record<QuotaWindowId, boolean>;

const AUTO_START_PING_COOLDOWN_MS = 30 * 60_000;

interface WindowHistoryEntry {
  lastSeenResetAtMs?: number;
  stableResetAtMs?: number;
  pingedResetAtMs?: number;
}

export class QuotaWindowHistory {
  private readonly windows: Record<QuotaWindowId, WindowHistoryEntry> = {
    fiveHour: {},
    weekly: {}
  };
  private lastSuccessfulPingAtMs: number | undefined;

  recordFreshSnapshot(snapshot: QuotaSnapshot): void {
    this.recordFreshWindow("fiveHour", snapshot.fiveHour);
    this.recordFreshWindow("weekly", snapshot.weekly);
  }

  resetVisibilityFor(snapshot: QuotaSnapshot): ResetVisibility {
    return {
      fiveHour: this.shouldShowReset("fiveHour", snapshot.fiveHour),
      weekly: this.shouldShowReset("weekly", snapshot.weekly)
    };
  }

  planAutoStart(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig, options: { force: boolean; now: Date }): AutoStartPingPlan {
    if (options.force) {
      return { type: "ping", trigger: "force", windows: [] };
    }

    if (this.isInCooldown(options.now)) {
      return { type: "skip", reason: "cooldown" };
    }

    const windows = this.autoStartCandidates(snapshot, config);
    return windows.length > 0
      ? { type: "ping", trigger: "unused-quota", windows }
      : { type: "skip", reason: "no-eligible-window" };
  }

  plan(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig, options: { force: boolean; now: Date }): AutoStartPingPlan {
    return this.planAutoStart(snapshot, config, options);
  }

  recordPingSuccess(plan: Extract<AutoStartPingPlan, { type: "ping" }>, now: Date): void {
    this.lastSuccessfulPingAtMs = now.getTime();
    if (plan.trigger === "force") {
      return;
    }

    for (const window of plan.windows) {
      this.windows[window.id].pingedResetAtMs = window.resetAtMs;
    }
  }

  recordSuccess(plan: Extract<AutoStartPingPlan, { type: "ping" }>, now: Date): void {
    this.recordPingSuccess(plan, now);
  }

  private recordFreshWindow(id: QuotaWindowId, window: QuotaWindow | undefined): void {
    if (!window) {
      return;
    }

    const entry = this.windows[id];
    const resetAtMs = window.resetAt.getTime();
    entry.stableResetAtMs = entry.lastSeenResetAtMs === resetAtMs ? resetAtMs : undefined;
    entry.lastSeenResetAtMs = resetAtMs;
  }

  private shouldShowReset(id: QuotaWindowId, window: QuotaWindow | undefined): boolean {
    if (!window) {
      return false;
    }

    const resetAtMs = window.resetAt.getTime();
    return clamp(window.remainingRatio) < 1 || this.windows[id].stableResetAtMs === resetAtMs;
  }

  private isInCooldown(now: Date): boolean {
    return this.lastSuccessfulPingAtMs !== undefined
      && now.getTime() - this.lastSuccessfulPingAtMs < AUTO_START_PING_COOLDOWN_MS;
  }

  private autoStartCandidates(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig): AutoStartWindowCandidate[] {
    return [
      this.autoStartCandidate("fiveHour", "5H", config.fiveHour, snapshot.fiveHour),
      this.autoStartCandidate("weekly", "WK", config.weekly, snapshot.weekly)
    ].filter((window): window is AutoStartWindowCandidate => window !== undefined);
  }

  private autoStartCandidate(
    id: QuotaWindowId,
    row: QuotaRowName,
    enabled: boolean,
    window: QuotaWindow | undefined
  ): AutoStartWindowCandidate | undefined {
    if (!enabled || !isUnusedQuotaWindow(window)) {
      return undefined;
    }

    const resetAtMs = window.resetAt.getTime();
    return this.windows[id].pingedResetAtMs === resetAtMs ? undefined : { id, row, resetAtMs };
  }
}

function isUnusedQuotaWindow(window: QuotaWindow | undefined): window is QuotaWindow {
  return window !== undefined && clamp(window.remainingRatio) >= 1;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
