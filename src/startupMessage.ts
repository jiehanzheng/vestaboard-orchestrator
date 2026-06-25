import type { Plugin, VestaboardClient, VestaboardMessage } from "./orchestrator.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";
import { encode, sanitizeDisplayText } from "./plugins/codexQuota/display/shared.js";

const BOARD_SIZES: Record<VestaboardBoard, { rows: number; columns: number }> = {
  note: { rows: 3, columns: 15 },
  flagship: { rows: 6, columns: 22 }
};

export function formatStartupMessage({
  plugins,
  now,
  timeZone,
  board,
  transport
}: {
  plugins: Plugin[];
  now: Date;
  timeZone?: string;
  board: VestaboardBoard;
  transport: "local" | "cloud";
}): VestaboardMessage {
  const { rows: rowCount, columns } = BOARD_SIZES[board];
  const enabledSlugs = plugins.map((plugin) => plugin.slug ?? plugin.id).join(",");
  const lines = [
    `vbmux via ${transport}`,
    `${yyyymmdd(now, timeZone)} ${hhmm(now, timeZone)}`,
    enabledSlugs
  ];
  const rows = lines.slice(0, rowCount).map((line) => row(line, columns));

  while (rows.length < rowCount) {
    rows.push(row("", columns));
  }

  return {
    text: rows.join("\n"),
    characters: rows.map(encode)
  };
}

export async function sendStartupMessage({
  plugins,
  vestaboard,
  board,
  transport,
  timeZone,
  now = () => new Date(),
  logger = console
}: {
  plugins: Plugin[];
  vestaboard: VestaboardClient;
  board: () => Promise<VestaboardBoard>;
  transport: "local" | "cloud";
  timeZone?: string;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  try {
    await vestaboard.send(formatStartupMessage({ plugins, now: now(), timeZone, board: await board(), transport }));
    logger.info("Sent Vestaboard startup message.");
  } catch (error) {
    logger.warn("Vestaboard startup message send failed.", error);
  }
}

function row(text: string, columns: number): string {
  return sanitizeDisplayText(text).padEnd(columns, " ").slice(0, columns);
}

function yyyymmdd(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.year}${parts.month}${parts.day}`;
}

function hhmm(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}${parts.minute}`;
}

function dateParts(date: Date, timeZone?: string): Record<"year" | "month" | "day" | "hour" | "minute", string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: parts.year ?? "0000",
    month: parts.month ?? "00",
    day: parts.day ?? "00",
    hour: parts.hour === "24" ? "00" : (parts.hour ?? "00"),
    minute: parts.minute ?? "00"
  };
}
