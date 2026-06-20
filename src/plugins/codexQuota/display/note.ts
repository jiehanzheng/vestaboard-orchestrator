import type { VestaboardMessage } from "../../../orchestrator.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import type { QuotaRowName, QuotaSnapshot, QuotaWindow } from "../types.js";
import { barTextChar, quotaBar } from "./bars.js";
import { encode, hhmm, mmdd, percentLabel, sanitizeDisplayText } from "./shared.js";

const BAR_WIDTH = 10;
const NOTE_COLUMNS = 15;

export function formatNoteQuota(
  snapshot: QuotaSnapshot,
  {
    timeZone,
    now,
    statusMessage,
    staleRows,
    showPacing,
    resetVisibility
  }: {
    timeZone?: string;
    now: Date;
    statusMessage?: string;
    staleRows: QuotaRowName[];
    showPacing: boolean;
    resetVisibility: ResetVisibility;
  }
): VestaboardMessage {
  const fiveHour = noteQuotaLine("5H", snapshot.fiveHour, now, staleRows.includes("5H"), showPacing);
  const weekly = noteQuotaLine("WK", snapshot.weekly, now, staleRows.includes("WK"), showPacing);
  const reset = !statusMessage
    ? resetLine(snapshot, resetVisibility, timeZone)
    : statusLine(statusMessage);

  return {
    text: [fiveHour.text, weekly.text, reset].join("\n"),
    characters: [fiveHour.characters, weekly.characters, encodeNoteRow(reset)]
  };
}

export function formatNoteError(error: unknown): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  const rows = ["CODEX QUOTA ERR", sanitizeDisplayText(detail).slice(0, NOTE_COLUMNS), ""];
  return {
    text: rows.join("\n"),
    characters: rows.map((row) => encodeNoteRow(row.padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS)))
  };
}

function noteQuotaLine(prefix: "5H" | "WK", window: QuotaWindow | undefined, now: Date, stale = false, showPacing = true): { text: string; characters: number[] } {
  if (!window) {
    const text = `${prefix}${" ".repeat(BAR_WIDTH)}--%`;
    return { text, characters: encodeNoteRow(text) };
  }

  const barCharacters = quotaBar(window, now, BAR_WIDTH, stale, showPacing);
  const percent = percentLabel(window.remainingRatio);

  return {
    text: `${prefix}${barCharacters.map(barTextChar).join("")}${percent}`,
    characters: [
      ...encode(prefix),
      ...barCharacters,
      ...encode(percent)
    ]
  };
}

function resetLine(snapshot: QuotaSnapshot, resetVisibility: ResetVisibility, timeZone?: string): string {
  const fiveHourReset = resetVisibility.fiveHour && snapshot.fiveHour ? hhmm(snapshot.fiveHour.resetAt, timeZone) : "----";
  const weeklyDate = resetVisibility.weekly && snapshot.weekly ? mmdd(snapshot.weekly.resetAt, timeZone) : "--/--";
  const weeklyTime = resetVisibility.weekly && snapshot.weekly ? hhmm(snapshot.weekly.resetAt, timeZone) : "----";
  return `${fiveHourReset}♥${weeklyDate}-${weeklyTime}`;
}

function statusLine(status: string): string {
  return sanitizeDisplayText(status).padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS);
}

function encodeNoteRow(text: string): number[] {
  const row = encode(text);
  if (row.length !== NOTE_COLUMNS) {
    throw new Error(`Vestaboard Note rows must be ${NOTE_COLUMNS} columns; got ${row.length}.`);
  }
  return row;
}
