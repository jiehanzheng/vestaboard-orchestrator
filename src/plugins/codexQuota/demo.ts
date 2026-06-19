import type { QuotaSnapshot, QuotaWindow } from "./types.js";

export type CodexQuotaDemoMode = "drop-1-pct" | "force-auto-start";

export interface CodexQuotaDemoState {
  pctDrops: number;
  forceAutoStart?: boolean;
}

export function applyCodexQuotaDemo(snapshot: QuotaSnapshot, demo: CodexQuotaDemoState | undefined): QuotaSnapshot {
  if (!demo || !snapshot.fiveHour) {
    return snapshot;
  }

  return {
    ...snapshot,
    fiveHour: {
      ...snapshot.fiveHour,
      remainingRatio: applyDrops(snapshot.fiveHour, demo)
    }
  };
}

function applyDrops(window: QuotaWindow, demo: CodexQuotaDemoState): number {
  return clamp(window.remainingRatio - Math.max(0, demo.pctDrops) * 0.01);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
