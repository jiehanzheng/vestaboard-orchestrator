import type { VestaboardMessage } from "../../../orchestrator.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import type { QuotaRowName, QuotaSnapshot, QuotaWindow } from "../types.js";
import { barTextChar, quotaBar } from "./bars.js";
import {
  BLANK,
  encode,
  flagshipPercentLabel,
  hhmmWithColon,
  mmdd,
  sanitizeDisplayText,
  sanitizeRowText
} from "./shared.js";

const FLAGSHIP_COLUMNS = 22;
const FLAGSHIP_ROWS = 6;
const FLAGSHIP_BAR_WIDTH = 20;
const FLAGSHIP_USAGE_START = 6;
const FLAGSHIP_RESET_START = 11;
const FLAGSHIP_RESET_WIDTH = FLAGSHIP_COLUMNS - FLAGSHIP_RESET_START;
const FLAGSHIP_HEADER_RESET_START = FLAGSHIP_COLUMNS - "RESET".length;

export function formatFlagshipQuota(
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
  const fiveHour = flagshipWindow("5H", snapshot.fiveHour, {
    now,
    timeZone,
    stale: staleRows.includes("5H"),
    showPacing,
    showReset: resetVisibility.fiveHour
  });
  const weekly = flagshipWindow("WK", snapshot.weekly, {
    now,
    timeZone,
    stale: staleRows.includes("WK"),
    showPacing,
    showReset: resetVisibility.weekly
  });
  const rows = [
    flagshipHeaderRow(),
    flagshipQuotaTextRow("5H", fiveHour.percent, fiveHour.reset),
    ` ${fiveHour.barText} `,
    flagshipQuotaTextRow("WEEK", weekly.percent, weekly.reset),
    ` ${weekly.barText} `,
    padFlagshipRow(statusMessage ? sanitizeDisplayText(statusMessage) : "")
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

export function formatFlagshipError(error: unknown): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return flagshipMessage([
    "CODEX QUOTA",
    "ERROR",
    sanitizeDisplayText(detail).slice(0, FLAGSHIP_COLUMNS),
    "",
    "",
    "CHECK API TOKEN"
  ]);
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
  options: {
    now: Date;
    timeZone?: string;
    stale: boolean;
    showPacing: boolean;
    showReset: boolean;
  }
): { percent: string; barText: string; barCharacters: number[]; reset: string } {
  if (!window) {
    return {
      percent: "--%",
      barText: " ".repeat(FLAGSHIP_BAR_WIDTH),
      barCharacters: Array(FLAGSHIP_BAR_WIDTH).fill(BLANK),
      reset: row === "5H" ? "--:--" : "--/-- --:--"
    };
  }

  const barCharacters = quotaBar(window, options.now, FLAGSHIP_BAR_WIDTH, options.stale, options.showPacing);
  return {
    percent: flagshipPercentLabel(window.remainingRatio),
    barText: barCharacters.map(barTextChar).join(""),
    barCharacters,
    reset: resetLabel(row, window, options.showReset, options.timeZone)
  };
}

function resetLabel(row: QuotaRowName, window: QuotaWindow, showReset: boolean, timeZone?: string): string {
  if (!showReset) {
    return row === "5H" ? "--:--" : "--/-- --:--";
  }

  return row === "5H"
    ? hhmmWithColon(window.resetAt, timeZone)
    : `${mmdd(window.resetAt, timeZone)} ${hhmmWithColon(window.resetAt, timeZone)}`;
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
