import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Plugin, PluginUpdate, Priority, VestaboardMessage } from "../../orchestrator.js";

type JsonObject = Record<string, unknown>;

interface RateWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

interface RateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

interface RateLimitsResult {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
}

interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
}

interface QuotaWindow {
  remainingRatio: number;
  resetAt: Date;
  durationMins: number;
}

type QuotaReader = () => Promise<QuotaSnapshot>;

const BAR_WIDTH = 10;
const GREEN = 66;
const ORANGE = 64;
const BLANK = 0;
const NOTE_COLUMNS = 15;
const APP_SERVER_TIMEOUT_MS = 10_000;
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10_080;

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";

  constructor(
    private readonly readQuota: QuotaReader,
    private readonly options: { priority: Priority; errorPriority: Priority; timeZone?: string }
  ) {}

  async getUpdate(): Promise<PluginUpdate> {
    try {
      return {
        priority: this.options.priority,
        message: formatQuota(await this.readQuota(), { timeZone: this.options.timeZone })
      };
    } catch (error) {
      return {
        priority: this.options.errorPriority,
        message: formatError(error)
      };
    }
  }
}

export function createCodexQuotaPlugin({
  fixture = false,
  priority = "normal",
  errorPriority = "low",
  timeZone
}: {
  fixture?: boolean;
  priority?: Priority;
  errorPriority?: Priority;
  timeZone?: string;
} = {}): CodexQuotaPlugin {
  return new CodexQuotaPlugin(fixture ? readFixtureQuota : readCodexQuota, { priority, errorPriority, timeZone });
}

export async function readCodexQuota(): Promise<QuotaSnapshot> {
  return quotaFromRateLimits(await readRateLimits());
}

export async function readRateLimits(): Promise<RateLimitsResult> {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  if (!proc.stdin || !proc.stdout) {
    throw new Error("Could not open Codex app-server pipes.");
  }

  const lines = createInterface({ input: proc.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    clearTimeout(timeout);
    lines.removeAllListeners();
    lines.close();
    proc.removeAllListeners("error");
    proc.removeAllListeners("exit");

    if (!proc.stdin.destroyed) {
      proc.stdin.end();
    }

    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
  };

  const fail = (error: Error): void => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
    cleanup();
  };

  const timeout = setTimeout(() => {
    fail(new Error(`Codex app-server timed out after ${APP_SERVER_TIMEOUT_MS}ms.`));
  }, APP_SERVER_TIMEOUT_MS);

  const send = (message: JsonObject): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = <T>(method: string, params?: JsonObject): Promise<T> => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      send(params ? { method, id, params } : { method, id });
    });
  };

  lines.on("line", (line) => {
    let message: { id?: number; method?: string; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error(`Invalid JSON from Codex: ${line}`));
      return;
    }

    if (message.method !== undefined || message.id === undefined) {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);
    if (message.error !== undefined) {
      entry.reject(new Error(`Codex app-server error: ${JSON.stringify(message.error)}`));
    } else {
      entry.resolve(message.result);
    }
  });

  proc.on("error", (error) => fail(new Error(`Could not start Codex: ${error.message}`)));
  proc.on("exit", (code, signal) => {
    if (pending.size > 0) {
      fail(new Error(`Codex app-server exited before responding: code=${code}, signal=${signal}`));
    }
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "vestaboard_orchestrator",
        title: "Vestaboard Orchestrator",
        version: "0.1.0"
      }
    });
    send({ method: "initialized", params: {} });
    return await request<RateLimitsResult>("account/rateLimits/read");
  } finally {
    cleanup();
  }
}

export function quotaFromRateLimits(result: RateLimitsResult): QuotaSnapshot {
  const windows = bucketsInPreferenceOrder(result).flatMap((bucket) => [bucket.primary, bucket.secondary].filter(isRateWindow));
  const snapshot = {
    fiveHour: windows.find((window) => window.windowDurationMins === FIVE_HOUR_MINS),
    weekly: windows.find((window) => window.windowDurationMins === WEEKLY_MINS)
  };

  if (!snapshot.fiveHour && !snapshot.weekly) {
    throw new Error("Codex rateLimits result must include a 5H or weekly quota window.");
  }

  return {
    fiveHour: snapshot.fiveHour ? quotaWindow(snapshot.fiveHour) : undefined,
    weekly: snapshot.weekly ? quotaWindow(snapshot.weekly) : undefined
  };
}

export function formatQuota(
  snapshot: QuotaSnapshot,
  options: { timeZone?: string; now?: Date } | string = {}
): VestaboardMessage {
  const timeZone = typeof options === "string" ? options : options.timeZone;
  const now = typeof options === "string" ? new Date() : (options.now ?? new Date());
  const fiveHour = quotaLine("5H", snapshot.fiveHour, now);
  const weekly = quotaLine("WK", snapshot.weekly, now);
  const reset = resetLine(snapshot.fiveHour?.resetAt, snapshot.weekly?.resetAt, timeZone);

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

function bucketsInPreferenceOrder(result: RateLimitsResult): RateLimitBucket[] {
  return [
    result.rateLimits,
    ...Object.values(result.rateLimitsByLimitId ?? {})
  ].filter((bucket): bucket is RateLimitBucket => bucket !== null && bucket !== undefined);
}

function isRateWindow(window: RateWindow | null | undefined): window is RateWindow {
  return window !== null && window !== undefined;
}

function quotaWindow(window: RateWindow): QuotaWindow {
  if (!Number.isFinite(window.usedPercent) || !Number.isFinite(window.resetsAt) || !Number.isFinite(window.windowDurationMins)) {
    throw new Error("Codex rate limit window contains invalid numeric fields.");
  }

  return {
    remainingRatio: clamp((100 - window.usedPercent) / 100),
    resetAt: new Date(window.resetsAt * 1000),
    durationMins: window.windowDurationMins
  };
}

function quotaLine(prefix: "5H" | "WK", window: QuotaWindow | undefined, now: Date): { text: string; characters: number[] } {
  if (!window) {
    const text = `${prefix}${" ".repeat(BAR_WIDTH)}--%`;
    return { text, characters: encodeRow(text) };
  }

  const quotaBlocks = Math.round(clamp(window.remainingRatio) * BAR_WIDTH);
  const timeBlocks = Math.round(timeRemainingRatio(window, now) * BAR_WIDTH);
  const orangeBlocks = Math.max(0, timeBlocks - quotaBlocks);
  const blankBlocks = BAR_WIDTH - quotaBlocks - orangeBlocks;
  const percent = percentLabel(window.remainingRatio);

  return {
    text: `${prefix}${"G".repeat(quotaBlocks)}${"O".repeat(orangeBlocks)}${" ".repeat(blankBlocks)}${percent}`,
    characters: [
      ...encode(prefix),
      ...Array(quotaBlocks).fill(GREEN),
      ...Array(orangeBlocks).fill(ORANGE),
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

function resetLine(fiveHour: Date | undefined, weekly: Date | undefined, timeZone?: string): string {
  const fiveHourReset = fiveHour ? hhmm(fiveHour, timeZone) : "----";
  const weeklyDate = weekly ? mmdd(weekly, timeZone) : "--/--";
  const weeklyTime = weekly ? hhmm(weekly, timeZone) : "----";
  return `${fiveHourReset} ${weeklyDate} ${weeklyTime}`;
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
  if (char === "%") return 54;
  if (char === "-") return 44;
  if (char === "/") return 59;

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

async function readFixtureQuota(): Promise<QuotaSnapshot> {
  const now = new Date();
  return {
    fiveHour: { remainingRatio: 0.76, resetAt: new Date(now.getTime() + 300 * 60_000), durationMins: 300 },
    weekly: { remainingRatio: 0.44, resetAt: nextMonday(now), durationMins: 10_080 }
  };
}

function nextMonday(date: Date): Date {
  const reset = new Date(date);
  reset.setDate(reset.getDate() + (reset.getDay() === 0 ? 1 : 8 - reset.getDay()));
  reset.setHours(0, 0, 0, 0);
  return reset;
}
