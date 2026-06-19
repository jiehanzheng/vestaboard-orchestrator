import type { QuotaSnapshot, QuotaWindow } from "./index.js";

export type CodexQuotaDemoMode = "drop-1-pct" | "drop-1-color-block";

export interface CodexQuotaDemoState {
  pctDrops: number;
  blockDrops: number;
}

const BAR_WIDTH = 10;

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
  const afterPctDrop = clamp(window.remainingRatio - Math.max(0, demo.pctDrops) * 0.01);
  if (demo.blockDrops <= 0) {
    return afterPctDrop;
  }

  const currentBlocks = Math.round(afterPctDrop * BAR_WIDTH);
  return Math.max(0, currentBlocks - Math.max(0, demo.blockDrops)) / BAR_WIDTH;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
