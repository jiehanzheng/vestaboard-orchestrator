import type { VestaboardMessage } from "../../orchestrator.js";
import type { QuotaRowName, QuotaSnapshot, QuotaWindow, VestaboardBoard } from "./types.js";

const BAR_WIDTH = 10;
const GREEN = 66;
const RED = 63;
const BLUE = 67;
const HEART = 62;
const BLANK = 0;
const NOTE_COLUMNS = 15;
const FLAGSHIP_COLUMNS = 22;
const FLAGSHIP_ROWS = 6;
const FLAGSHIP_BAR_WIDTH = 20;
const FLAGSHIP_USAGE_START = 6;
const FLAGSHIP_RESET_START = 11;
const FLAGSHIP_RESET_WIDTH = FLAGSHIP_COLUMNS - FLAGSHIP_RESET_START;
const FLAGSHIP_HEADER_RESET_START = FLAGSHIP_COLUMNS - "RESET".length;
const PUNCTUATION_CODES: Record<string, number> = {
  "!": 37,
  "@": 38,
  "#": 39,
  "$": 40,
  "(": 41,
  ")": 42,
  "-": 44,
  "+": 46,
  "&": 47,
  "=": 48,
  ";": 49,
  ":": 50,
  "'": 52,
  "\"": 53,
  "%": 54,
  ",": 55,
  ".": 56,
  "/": 59,
  "?": 60,
  "°": 62,
  "♥": HEART
};

export function formatQuota(
  snapshot: QuotaSnapshot,
  options: {
    timeZone?: string;
    now?: Date;
    statusMessage?: string;
    staleRows?: QuotaRowName[];
    showPacing?: boolean;
    board?: VestaboardBoard;
  } = {}
): VestaboardMessage {
  const timeZone = options.timeZone;
  const now = options.now ?? new Date();
  const staleRows = options.staleRows ?? [];
  const showPacing = options.showPacing ?? true;
  const board = options.board ?? "note";

  if (board === "flagship") {
    return formatFlagshipQuota(snapshot, { timeZone, now, statusMessage: options.statusMessage, staleRows, showPacing });
  }

  const fiveHour = noteQuotaLine("5H", snapshot.fiveHour, now, staleRows.includes("5H"), showPacing);
  const weekly = noteQuotaLine("WK", snapshot.weekly, now, staleRows.includes("WK"), showPacing);
  const reset = !options.statusMessage
    ? resetLine(snapshot.fiveHour, snapshot.weekly, timeZone)
    : statusLine(options.statusMessage);

  return {
    text: [fiveHour.text, weekly.text, reset].join("\n"),
    characters: [fiveHour.characters, weekly.characters, encodeRow(reset)]
  };
}

export function formatError(error: unknown, options: { board?: VestaboardBoard } = {}): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  if (options.board === "flagship") {
    const rows = [
      "CODEX QUOTA",
      "ERROR",
      sanitizeError(detail).slice(0, FLAGSHIP_COLUMNS),
      "",
      "",
      "CHECK API TOKEN"
    ];
    return flagshipMessage(rows);
  }

  const rows = ["CODEX QUOTA ERR", sanitizeError(detail).slice(0, NOTE_COLUMNS), ""];
  return {
    text: rows.join("\n"),
    characters: rows.map((row) => encodeRow(row.padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS)))
  };
}

export function sanitizeDisplayText(message: string): string {
  return sanitizeError(message);
}

function formatFlagshipQuota(
  snapshot: QuotaSnapshot,
  {
    timeZone,
    now,
    statusMessage,
    staleRows,
    showPacing
  }: {
    timeZone?: string;
    now: Date;
    statusMessage?: string;
    staleRows: QuotaRowName[];
    showPacing: boolean;
  }
): VestaboardMessage {
  const fiveHour = flagshipWindow("5H", snapshot.fiveHour, now, timeZone, staleRows.includes("5H"), showPacing);
  const weekly = flagshipWindow("WK", snapshot.weekly, now, timeZone, staleRows.includes("WK"), showPacing);
  const rows = [
    flagshipHeaderRow(),
    flagshipQuotaTextRow("5H", fiveHour.percent, fiveHour.reset),
    ` ${fiveHour.barText} `,
    flagshipQuotaTextRow("WEEK", weekly.percent, weekly.reset),
    ` ${weekly.barText} `,
    padFlagshipRow(statusMessage ? sanitizeError(statusMessage) : "")
  ];

  return {
    text: rows.join("\n"),
    characters: rows.map((row, index) => {
      if (index === 3) {
        return encodeFlagshipRow(row);
      }

      if (index === 2) {
        return [BLANK, ...fiveHour.barCharacters, BLANK];
      }

      if (index === 4) {
        return [BLANK, ...weekly.barCharacters, BLANK];
      }

      return encodeFlagshipRow(row);
    })
  };
}

function flagshipHeaderRow(): string {
  return fixedFlagshipRow([
    { start: 0, text: "CODEX" },
    { start: FLAGSHIP_USAGE_START, text: "REMAINING" },
    { start: FLAGSHIP_HEADER_RESET_START, text: "RESET" }
  ]);
}

function flagshipQuotaTextRow(label: string, percent: string, reset: string): string {
  return fixedFlagshipRow([
    { start: 0, text: label },
    { start: FLAGSHIP_USAGE_START, text: percent },
    { start: FLAGSHIP_RESET_START, text: reset.padStart(FLAGSHIP_RESET_WIDTH, " ") }
  ]);
}

function fixedFlagshipRow(parts: Array<{ start: number; text: string }>): string {
  const row = Array(FLAGSHIP_COLUMNS).fill(" ");
  for (const part of parts) {
    const text = sanitizeRowText(part.text).slice(0, FLAGSHIP_COLUMNS - part.start);
    for (const [index, char] of [...text].entries()) {
      row[part.start + index] = char;
    }
  }

  return row.join("");
}

function flagshipWindow(
  row: QuotaRowName,
  window: QuotaWindow | undefined,
  now: Date,
  timeZone: string | undefined,
  stale = false,
  showPacing = true
): { percent: string; barText: string; barCharacters: number[]; reset: string } {
  if (!window) {
    return {
      percent: "--%",
      barText: " ".repeat(FLAGSHIP_BAR_WIDTH),
      barCharacters: Array(FLAGSHIP_BAR_WIDTH).fill(BLANK),
      reset: row === "5H" ? "--:--" : "--/-- --:--"
    };
  }

  const barCharacters = quotaBar(window, now, FLAGSHIP_BAR_WIDTH, stale, showPacing);
  return {
    percent: flagshipPercentLabel(window.remainingRatio),
    barText: barCharacters.map(barTextChar).join(""),
    barCharacters,
    reset: row === "5H" ? hhmmWithColon(window.resetAt, timeZone) : `${mmdd(window.resetAt, timeZone)} ${hhmmWithColon(window.resetAt, timeZone)}`
  };
}

function noteQuotaLine(prefix: "5H" | "WK", window: QuotaWindow | undefined, now: Date, stale = false, showPacing = true): { text: string; characters: number[] } {
  if (!window) {
    const text = `${prefix}${" ".repeat(BAR_WIDTH)}--%`;
    return { text, characters: encodeRow(text) };
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

function quotaBar(window: QuotaWindow, now: Date, width: number, stale = false, showPacing = true): number[] {
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

function barTextChar(code: number): string {
  if (code === GREEN) return "G";
  if (code === RED) return "R";
  if (code === BLUE) return "B";
  if (code === charCode("?")) return "?";
  return " ";
}

function percentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return percent >= 100 ? "100" : `${String(percent).padStart(2, " ")}%`;
}

function flagshipPercentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return `${percent}%`;
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
  return `${fiveHourReset}♥${weeklyDate}-${weeklyTime}`;
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

function hhmmWithColon(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
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

function flagshipMessage(rows: string[]): VestaboardMessage {
  const paddedRows = rows.map(padFlagshipRow);
  while (paddedRows.length < FLAGSHIP_ROWS) {
    paddedRows.push(padFlagshipRow(""));
  }

  return {
    text: paddedRows.join("\n"),
    characters: paddedRows.map(encodeFlagshipRow)
  };
}

function encodeFlagshipRow(text: string): number[] {
  const row = encode(padFlagshipRow(text));
  if (row.length !== FLAGSHIP_COLUMNS) {
    throw new Error(`Vestaboard Flagship rows must be ${FLAGSHIP_COLUMNS} columns; got ${row.length}.`);
  }
  return row;
}

function padFlagshipRow(text: string): string {
  return sanitizeRowText(text).padEnd(FLAGSHIP_COLUMNS, " ").slice(0, FLAGSHIP_COLUMNS);
}

function encode(text: string): number[] {
  return [...text].map(charCode);
}

function charCode(char: string): number {
  if (char === " ") return BLANK;
  const punctuationCode = PUNCTUATION_CODES[char];
  if (punctuationCode !== undefined) return punctuationCode;

  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  if (char >= "1" && char <= "9") return Number(char) + 26;
  if (char === "0") return 36;

  throw new Error(`Unsupported Vestaboard character: ${char}`);
}

function sanitizeError(message: string): string {
  return message.toUpperCase().replace(/[^A-Z0-9 !@#$()+&=;:'"%.,/?°♥-]/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeRowText(message: string): string {
  return message.toUpperCase().replace(/[^A-Z0-9 !@#$()+&=;:'"%.,/?°♥-]/g, " ");
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
