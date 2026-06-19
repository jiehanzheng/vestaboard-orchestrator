import type { QuotaSnapshot, QuotaWindow } from "./index.js";

export type CodexQuotaDemoMode = "drop-1-pct" | "drop-1-color-block";

const BAR_WIDTH = 10;

export function applyCodexQuotaDemo(snapshot: QuotaSnapshot, mode: CodexQuotaDemoMode | undefined): QuotaSnapshot {
  if (!mode || !snapshot.fiveHour) {
    return snapshot;
  }

  return {
    ...snapshot,
    fiveHour: {
      ...snapshot.fiveHour,
      remainingRatio:
        mode === "drop-1-pct"
          ? dropOnePercent(snapshot.fiveHour)
          : dropOneColorBlock(snapshot.fiveHour)
    }
  };
}

function dropOnePercent(window: QuotaWindow): number {
  return clamp(window.remainingRatio - 0.01);
}

function dropOneColorBlock(window: QuotaWindow): number {
  const currentBlocks = Math.round(clamp(window.remainingRatio) * BAR_WIDTH);
  return Math.max(0, currentBlocks - 1) / BAR_WIDTH;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
