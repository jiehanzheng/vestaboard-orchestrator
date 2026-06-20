import type { QuotaWindow } from "../types.js";
import { BLANK, BLUE, charCode, clamp, GREEN, RED } from "./shared.js";

export function quotaBar(window: QuotaWindow, now: Date, width: number, stale = false, showPacing = true): number[] {
  const quotaBlocks = Math.round(clamp(window.remainingRatio) * width);
  const timeBlocks = showPacing ? Math.round(timeRemainingRatio(window, now) * width) : quotaBlocks;
  const greenBlocks = showPacing ? Math.min(quotaBlocks, timeBlocks) : quotaBlocks;
  const redBlocks = showPacing ? Math.max(0, timeBlocks - quotaBlocks) : 0;
  const blueBlocks = showPacing ? Math.max(0, quotaBlocks - timeBlocks) : 0;
  const availableBlankBlocks = width - greenBlocks - redBlocks - blueBlocks;
  const staleBlocks = showPacing && stale && availableBlankBlocks > 0 ? 1 : 0;
  const blankBlocks = availableBlankBlocks - staleBlocks;

  return [
    ...Array(greenBlocks).fill(GREEN),
    ...Array(redBlocks).fill(RED),
    ...Array(blueBlocks).fill(BLUE),
    ...Array(staleBlocks).fill(charCode("?")),
    ...Array(blankBlocks).fill(BLANK)
  ];
}

export function barTextChar(code: number): string {
  if (code === GREEN) return "G";
  if (code === RED) return "R";
  if (code === BLUE) return "B";
  if (code === charCode("?")) return "?";
  return " ";
}

function timeRemainingRatio(window: QuotaWindow, now: Date): number {
  const durationMs = window.durationMins * 60_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Quota window duration must be positive.");
  }

  return clamp((window.resetAt.getTime() - now.getTime()) / durationMs);
}
