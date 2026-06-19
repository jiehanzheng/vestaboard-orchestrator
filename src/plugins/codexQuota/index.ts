import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Plugin, PluginUpdate, Priority, VestaboardMessage } from "../../orchestrator.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./demo.js";

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

export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
}

export interface QuotaWindow {
  remainingRatio: number;
  resetAt: Date;
  durationMins: number;
}

type QuotaReader = () => Promise<QuotaSnapshot>;
type QuotaRowName = "5H" | "WK";
type Logger = Pick<Console, "warn">;

const BAR_WIDTH = 10;
const GREEN = 66;
const ORANGE = 64;
const BLUE = 67;
const HEART = 62;
const BLANK = 0;
const NOTE_COLUMNS = 15;
const APP_SERVER_TIMEOUT_MS = 30_000;
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10_080;

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";
  private readonly quotaCache = new QuotaIngredientCache();

  constructor(
    private readonly readQuota: QuotaReader,
    private readonly options: {
      priority: Priority;
      errorPriority: Priority;
      timeZone?: string;
      takeDemoMode?: () => CodexQuotaDemoState | undefined;
      logger?: Logger;
      now?: () => Date;
    }
  ) {}

  async getUpdate(): Promise<PluginUpdate> {
    try {
      const freshQuota = await this.readQuota();
      const missingWindows = missingQuotaWindows(freshQuota);
      this.quotaCache.update(freshQuota);
      const displayQuota = this.quotaCache.merge(freshQuota);
      const staleRows = cachedRowsUsedFor(missingWindows, freshQuota, displayQuota);
      const demoMode = this.options.takeDemoMode?.();
      const message = formatQuota(applyCodexQuotaDemo(displayQuota, demoMode), {
        timeZone: this.options.timeZone,
        now: this.options.now?.(),
        statusRow: missingWindows.length > 0 ? missingStatus(missingWindows) : undefined,
        staleRows
      });

      if (missingWindows.length > 0) {
        logIncompleteQuota(this.options.logger, missingWindows, staleRows, this.options.errorPriority);
      }

      return {
        priority: missingWindows.length > 0 ? this.options.errorPriority : this.options.priority,
        message
      };
    } catch (error) {
      const cachedQuota = this.quotaCache.snapshot();
      const message = this.quotaCache.hasAny()
        ? formatQuota(cachedQuota, {
            timeZone: this.options.timeZone,
            now: this.options.now?.(),
            statusRow: errorStatus(error),
            staleRows: cachedRowsPresentIn(cachedQuota)
          })
        : formatError(error);
      logQuotaReadFailure(this.options.logger, error, this.options.errorPriority, message, this.quotaCache.state());

      return {
        priority: this.options.errorPriority,
        message
      };
    }
  }
}

export function createCodexQuotaPlugin({
  fixture = false,
  priority = "normal",
  errorPriority = "low",
  timeZone,
  takeDemoMode,
  logger = console,
  now
}: {
  fixture?: boolean;
  priority?: Priority;
  errorPriority?: Priority;
  timeZone?: string;
  takeDemoMode?: () => CodexQuotaDemoState | undefined;
  logger?: Logger;
  now?: () => Date;
} = {}): CodexQuotaPlugin {
  return new CodexQuotaPlugin(fixture ? readFixtureQuota : readCodexQuota, { priority, errorPriority, timeZone, takeDemoMode, logger, now });
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
  options: { timeZone?: string; now?: Date; statusRow?: string; staleRows?: QuotaRowName[] } | string = {}
): VestaboardMessage {
  const timeZone = typeof options === "string" ? options : options.timeZone;
  const now = typeof options === "string" ? new Date() : (options.now ?? new Date());
  const staleRows = typeof options === "string" ? [] : (options.staleRows ?? []);
  const fiveHour = quotaLine("5H", snapshot.fiveHour, now, staleRows.includes("5H"));
  const weekly = quotaLine("WK", snapshot.weekly, now, staleRows.includes("WK"));
  const reset = typeof options === "string" || !options.statusRow
    ? resetLine(snapshot.fiveHour?.resetAt, snapshot.weekly?.resetAt, timeZone)
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

function logQuotaReadFailure(
  logger: Logger | undefined,
  error: unknown,
  errorPriority: Priority,
  message: VestaboardMessage,
  cacheState: QuotaCacheState
): void {
  logger?.warn("Codex quota read failed.", {
    reason: summarizeFailure(error),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    fallbackPriority: String(errorPriority),
    cacheState,
    vestaboardPreview: messagePreview(message)
  });
}

function logIncompleteQuota(
  logger: Logger | undefined,
  missingWindows: QuotaRowName[],
  usedCachedWindows: QuotaRowName[],
  errorPriority: Priority
): void {
  logger?.warn("Codex quota ingredients incomplete.", {
    missingWindows,
    usedCachedWindows,
    fallbackPriority: String(errorPriority),
    boardStatus: missingStatus(missingWindows)
  });
}

function messagePreview(message: VestaboardMessage): string {
  return message.text.replace(/\n/g, " | ");
}

function summarizeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toUpperCase();
  if (normalized.includes("TIMED OUT") || normalized.includes("TIMEOUT")) return "timeout";
  if (normalized.includes("INVALID JSON")) return "invalid_json";
  if (normalized.includes("EXITED")) return "app_server_exited";
  if (normalized.includes("COULD NOT START")) return "app_server_start_failed";
  if (normalized.includes("RATE LIMIT")) return "rate_limit";
  if (normalized.includes("BUBBLEWRAP")) return "bubblewrap";
  return "unknown";
}

interface QuotaCacheState {
  hasFiveHour: boolean;
  hasWeekly: boolean;
  updatedAt?: string;
}

class QuotaIngredientCache {
  private cached: { fiveHour?: QuotaWindow; weekly?: QuotaWindow; updatedAt?: Date } = {};

  update(snapshot: QuotaSnapshot): void {
    if (snapshot.fiveHour) {
      this.cached.fiveHour = cloneQuotaWindow(snapshot.fiveHour);
    }

    if (snapshot.weekly) {
      this.cached.weekly = cloneQuotaWindow(snapshot.weekly);
    }

    if (snapshot.fiveHour || snapshot.weekly) {
      this.cached.updatedAt = new Date();
    }
  }

  merge(snapshot: QuotaSnapshot = {}): QuotaSnapshot {
    return {
      fiveHour: snapshot.fiveHour ? cloneQuotaWindow(snapshot.fiveHour) : cloneOptionalQuotaWindow(this.cached.fiveHour),
      weekly: snapshot.weekly ? cloneQuotaWindow(snapshot.weekly) : cloneOptionalQuotaWindow(this.cached.weekly)
    };
  }

  snapshot(): QuotaSnapshot {
    return this.merge();
  }

  hasAny(): boolean {
    return this.cached.fiveHour !== undefined || this.cached.weekly !== undefined;
  }

  state(): QuotaCacheState {
    return {
      hasFiveHour: this.cached.fiveHour !== undefined,
      hasWeekly: this.cached.weekly !== undefined,
      updatedAt: this.cached.updatedAt?.toISOString()
    };
  }
}

function cloneOptionalQuotaWindow(window: QuotaWindow | undefined): QuotaWindow | undefined {
  return window ? cloneQuotaWindow(window) : undefined;
}

function cloneQuotaWindow(window: QuotaWindow): QuotaWindow {
  return {
    remainingRatio: window.remainingRatio,
    resetAt: new Date(window.resetAt),
    durationMins: window.durationMins
  };
}

function missingQuotaWindows(snapshot: QuotaSnapshot): QuotaRowName[] {
  return [
    snapshot.fiveHour ? undefined : "5H",
    snapshot.weekly ? undefined : "WK"
  ].filter((window): window is QuotaRowName => window !== undefined);
}

function cachedRowsUsedFor(missingWindows: QuotaRowName[], freshQuota: QuotaSnapshot, displayQuota: QuotaSnapshot): QuotaRowName[] {
  return missingWindows.filter((window) => {
    if (window === "5H") return freshQuota.fiveHour === undefined && displayQuota.fiveHour !== undefined;
    return freshQuota.weekly === undefined && displayQuota.weekly !== undefined;
  });
}

function cachedRowsPresentIn(snapshot: QuotaSnapshot): QuotaRowName[] {
  return [
    snapshot.fiveHour ? "5H" : undefined,
    snapshot.weekly ? "WK" : undefined
  ].filter((window): window is QuotaRowName => window !== undefined);
}

function missingStatus(missingWindows: QuotaRowName[]): string {
  return `MISS ${missingWindows.join(" ")}`;
}

function errorStatus(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return summarizeBoardError(sanitizeError(detail));
}

function summarizeBoardError(message: string): string {
  if (message.includes("TIMED OUT") || message.includes("TIMEOUT")) return "TIMEOUT";
  if (message.includes("INVALID JSON")) return "BAD JSON";
  if (message.includes("EXITED")) return "EXIT";
  if (message.includes("COULD NOT START")) return "START";
  if (message.includes("RATE LIMIT")) return "RATE LIMIT";
  if (message.includes("BUBBLEWRAP")) return "BWRAP";
  return message.split(" ").filter(Boolean).slice(0, 2).join(" ") || "CODEX";
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

function quotaLine(prefix: "5H" | "WK", window: QuotaWindow | undefined, now: Date, stale = false): { text: string; characters: number[] } {
  if (!window) {
    const text = `${prefix}${" ".repeat(BAR_WIDTH)}--%`;
    return { text, characters: encodeRow(text) };
  }

  const quotaBlocks = Math.round(clamp(window.remainingRatio) * BAR_WIDTH);
  const timeBlocks = Math.round(timeRemainingRatio(window, now) * BAR_WIDTH);
  const greenBlocks = Math.min(quotaBlocks, timeBlocks);
  const orangeBlocks = Math.max(0, timeBlocks - quotaBlocks);
  const blueBlocks = Math.max(0, quotaBlocks - timeBlocks);
  const availableBlankBlocks = BAR_WIDTH - greenBlocks - orangeBlocks - blueBlocks;
  const staleBlocks = stale && availableBlankBlocks > 0 ? 1 : 0;
  const blankBlocks = availableBlankBlocks - staleBlocks;
  const percent = percentLabel(window.remainingRatio);

  return {
    text: `${prefix}${"G".repeat(greenBlocks)}${"O".repeat(orangeBlocks)}${"B".repeat(blueBlocks)}${"?".repeat(staleBlocks)}${" ".repeat(blankBlocks)}${percent}`,
    characters: [
      ...encode(prefix),
      ...Array(greenBlocks).fill(GREEN),
      ...Array(orangeBlocks).fill(ORANGE),
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

function resetLine(fiveHour: Date | undefined, weekly: Date | undefined, timeZone?: string): string {
  const fiveHourReset = fiveHour ? hhmm(fiveHour, timeZone) : "----";
  const weeklyDate = weekly ? mmdd(weekly, timeZone) : "--/--";
  const weeklyTime = weekly ? hhmm(weekly, timeZone) : "----";
  return `${fiveHourReset}♥${weeklyDate}♥${weeklyTime}`;
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
