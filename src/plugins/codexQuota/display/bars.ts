import type { QuotaWindow } from "../types.js";
import { BLANK, BLUE, charCode, clamp, GREEN, ORANGE, RED, WHITE, YELLOW } from "./shared.js";

export function quotaBar(window: QuotaWindow, now: Date, width: number, stale = false, showPacing = true): number[] {
  const remainingRatio = clamp(window.remainingRatio);
  const quotaBlocks = remainingRatio > 0
    ? Math.max(1, Math.round(remainingRatio * width))
    : 0;
  const fill = showPacing ? pacingColor(window, now) : GREEN;
  const bar = [
    ...Array(quotaBlocks).fill(fill),
    ...Array(width - quotaBlocks).fill(BLANK)
  ];

  if (showPacing) {
    const markerIndex = timeMarkerIndex(window, now, width);
    bar[markerIndex] = WHITE;
    const staleIndex = bar.findIndex((code) => code === BLANK);
    if (stale && staleIndex >= 0) {
      bar[staleIndex] = charCode("?");
    }
  }

  return bar;
}

export function barTextChar(code: number): string {
  if (code === GREEN) return "G";
  if (code === YELLOW) return "Y";
  if (code === ORANGE) return "O";
  if (code === RED) return "R";
  if (code === BLUE) return "B";
  if (code === WHITE) return "W";
  if (code === charCode("?")) return "?";
  return " ";
}

function pacingColor(window: QuotaWindow, now: Date): number {
  const timeRatio = timeRemainingRatio(window, now);
  if (timeRatio <= 0) {
    return GREEN;
  }

  const paceRatio = clamp(window.remainingRatio) / timeRatio;
  if (paceRatio >= 1) return GREEN;
  if (paceRatio >= 0.85) return YELLOW;
  if (paceRatio >= 0.65) return ORANGE;
  return RED;
}

function timeMarkerIndex(window: QuotaWindow, now: Date, width: number): number {
  return Math.min(width - 1, Math.max(0, Math.round(timeRemainingRatio(window, now) * width)));
}

function timeRemainingRatio(window: QuotaWindow, now: Date): number {
  const durationMs = window.durationMins * 60_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Quota window duration must be positive.");
  }

  return clamp((window.resetAt.getTime() - now.getTime()) / durationMs);
}
