import type { VestaboardMessage } from "../../orchestrator.js";
import type { QuotaRowName, QuotaSnapshot, QuotaWindow } from "./types.js";

const BAR_WIDTH = 10;
const GREEN = 66;
const RED = 63;
const BLUE = 67;
const HEART = 62;
const BLANK = 0;
const NOTE_COLUMNS = 15;

export function formatQuota(
  snapshot: QuotaSnapshot,
  options: { timeZone?: string; now?: Date; statusRow?: string; staleRows?: QuotaRowName[] } | string = {}
): VestaboardMessage {
  const timeZone = typeof options === "string" ? options : options.timeZone;
  const now = typeof options === "string" ? new Date() : (options.now ?? new Date());
  const staleRows = typeof options === "string" ? [] : (options.staleRows ?? []);
  const fiveHour = quotaLine("5H", snapshot.fiveHour, now, staleRows.includes("5H"));
  const weekly = quotaLine("WK", snapshot.weekly, now, staleRows.includes("WK"));
  const reset = typeof options === "string" || !options.statusRow
    ? resetLine(snapshot.fiveHour, snapshot.weekly, timeZone)
    : statusLine(options.statusRow);

  return {
    text: [fiveHour.text, weekly.text, reset].join("\n"),
    characters: [fiveHour.characters, weekly.characters, encodeRow(reset)]
  };
}

export function formatError(error: unknown): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  const rows = ["CODEX QUOTA ERR", sanitizeError(detail).slice(0, NOTE_COLUMNS), ""];
  return {
    text: rows.join("\n"),
    characters: rows.map((row) => encodeRow(row.padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS)))
  };
}

export function sanitizeDisplayText(message: string): string {
  return sanitizeError(message);
}

function quotaLine(prefix: "5H" | "WK", window: QuotaWindow | undefined, now: Date, stale = false): { text: string; characters: number[] } {
  if (!window) {
    const text = `${prefix}${" ".repeat(BAR_WIDTH)}--%`;
    return { text, characters: encodeRow(text) };
  }

  const quotaBlocks = Math.round(clamp(window.remainingRatio) * BAR_WIDTH);
  const timeBlocks = Math.round(timeRemainingRatio(window, now) * BAR_WIDTH);
  const greenBlocks = Math.min(quotaBlocks, timeBlocks);
  const redBlocks = Math.max(0, timeBlocks - quotaBlocks);
  const blueBlocks = Math.max(0, quotaBlocks - timeBlocks);
  const availableBlankBlocks = BAR_WIDTH - greenBlocks - redBlocks - blueBlocks;
  const staleBlocks = stale && availableBlankBlocks > 0 ? 1 : 0;
  const blankBlocks = availableBlankBlocks - staleBlocks;
  const percent = percentLabel(window.remainingRatio);

  return {
    text: `${prefix}${"G".repeat(greenBlocks)}${"R".repeat(redBlocks)}${"B".repeat(blueBlocks)}${"?".repeat(staleBlocks)}${" ".repeat(blankBlocks)}${percent}`,
    characters: [
      ...encode(prefix),
      ...Array(greenBlocks).fill(GREEN),
      ...Array(redBlocks).fill(RED),
      ...Array(blueBlocks).fill(BLUE),
      ...Array(staleBlocks).fill(charCode("?")),
      ...Array(blankBlocks).fill(BLANK),
      ...encode(percent)
    ]
  };
}

function percentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return percent >= 100 ? "100" : `${String(percent).padStart(2, "0")}%`;
}

function timeRemainingRatio(window: QuotaWindow, now: Date): number {
  const durationMs = window.durationMins * 60_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Quota window duration must be positive.");
  }

  return clamp((window.resetAt.getTime() - now.getTime()) / durationMs);
}

function resetLine(fiveHour: QuotaWindow | undefined, weekly: QuotaWindow | undefined, timeZone?: string): string {
  const fiveHourReset = shouldShowReset(fiveHour) ? hhmm(fiveHour.resetAt, timeZone) : "----";
  const weeklyDate = shouldShowReset(weekly) ? mmdd(weekly.resetAt, timeZone) : "--/--";
  const weeklyTime = shouldShowReset(weekly) ? hhmm(weekly.resetAt, timeZone) : "----";
  return `${fiveHourReset}♥${weeklyDate}♥${weeklyTime}`;
}

function shouldShowReset(window: QuotaWindow | undefined): window is QuotaWindow {
  return window !== undefined && clamp(window.remainingRatio) < 1;
}

function statusLine(status: string): string {
  return sanitizeError(status).padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS);
}

function hhmm(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}${parts.minute}`;
}

function mmdd(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.month}/${parts.day}`;
}

function dateParts(date: Date, timeZone?: string): Record<"month" | "day" | "hour" | "minute", string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    month: parts.month ?? "00",
    day: parts.day ?? "00",
    hour: parts.hour === "24" ? "00" : (parts.hour ?? "00"),
    minute: parts.minute ?? "00"
  };
}

function encodeRow(text: string): number[] {
  const row = encode(text);
  if (row.length !== NOTE_COLUMNS) {
    throw new Error(`Vestaboard Note rows must be ${NOTE_COLUMNS} columns; got ${row.length}.`);
  }
  return row;
}

function encode(text: string): number[] {
  return [...text].map(charCode);
}

function charCode(char: string): number {
  if (char === " ") return BLANK;
  if (char === "♥") return HEART;
  if (char === "%") return 54;
  if (char === "-") return 44;
  if (char === "/") return 59;
  if (char === "?") return 60;

  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  if (char >= "1" && char <= "9") return Number(char) + 26;
  if (char === "0") return 36;

  throw new Error(`Unsupported Vestaboard character: ${char}`);
}

function sanitizeError(message: string): string {
  return message.toUpperCase().replace(/[^A-Z0-9 /%]/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
