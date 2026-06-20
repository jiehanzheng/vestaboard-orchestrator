import type { Priority, VestaboardMessage } from "../../orchestrator.js";
import { priorityValue } from "../../priority.js";
import { sanitizeDisplayText } from "./display/index.js";
import type { Logger, QuotaRowName, QuotaSnapshot, QuotaWindow } from "./types.js";

export const REFRESH_STATUS_MESSAGE_TTL_MS = 5 * 60_000;
export const TRANSIENT_STATUS_MESSAGE_TTL_MS = 1_000;

const STATUS_MESSAGE_PRIORITY = "high";
const STATUS_MESSAGE_PRIORITY_VALUE = priorityValue(STATUS_MESSAGE_PRIORITY);

interface QuotaCacheState {
  hasFiveHour: boolean;
  hasWeekly: boolean;
  updatedAt?: string;
}

interface StatusMessage {
  message: string;
  expiresAt: Date;
}

export class StatusMessageStack {
  private messages: StatusMessage[] = [];

  push(message: string, now: Date, ttlMs: number): void {
    this.prune(now);
    this.messages.push({ message, expiresAt: new Date(now.getTime() + ttlMs) });
  }

  pushLow(message: string, now: Date, ttlMs: number): void {
    this.prune(now);
    this.messages.unshift({ message, expiresAt: new Date(now.getTime() + ttlMs) });
  }

  top(now: Date): string | undefined {
    this.prune(now);
    return this.messages.at(-1)?.message;
  }

  private prune(now: Date): void {
    const nowMs = now.getTime();
    this.messages = this.messages.filter((message) => message.expiresAt.getTime() > nowMs);
  }
}

export class QuotaIngredientCache {
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

export function missingQuotaWindows(snapshot: QuotaSnapshot): QuotaRowName[] {
  return [
    snapshot.fiveHour ? undefined : "5H",
    snapshot.weekly ? undefined : "WK"
  ].filter((window): window is QuotaRowName => window !== undefined);
}

export function cachedRowsUsedFor(missingWindows: QuotaRowName[], freshQuota: QuotaSnapshot, displayQuota: QuotaSnapshot): QuotaRowName[] {
  return missingWindows.filter((window) => {
    if (window === "5H") return freshQuota.fiveHour === undefined && displayQuota.fiveHour !== undefined;
    return freshQuota.weekly === undefined && displayQuota.weekly !== undefined;
  });
}

export function cachedRowsPresentIn(snapshot: QuotaSnapshot): QuotaRowName[] {
  return [
    snapshot.fiveHour ? "5H" : undefined,
    snapshot.weekly ? "WK" : undefined
  ].filter((window): window is QuotaRowName => window !== undefined);
}

export function missingStatus(missingWindows: QuotaRowName[]): string {
  return `MISS ${missingWindows.join(" ")}`;
}

export function errorStatus(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return summarizeBoardError(sanitizeDisplayText(detail));
}

export function autoStartErrorStatus(): string {
  return "AUTO PING FAIL";
}

export function logQuotaReadFailure(
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

export function logIncompleteQuota(
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

export function logAutoStartFailure(logger: Logger | undefined, error: unknown): void {
  logger?.warn("Codex quota auto-start failed after quota read.", {
    reason: summarizeFailure(error),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    boardStatus: autoStartErrorStatus()
  });
}

export function bumpStatusPriority(priority: Priority): Priority {
  return priorityValue(priority) >= STATUS_MESSAGE_PRIORITY_VALUE ? priority : STATUS_MESSAGE_PRIORITY;
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

function summarizeBoardError(message: string): string {
  if (message.includes("TIMED OUT") || message.includes("TIMEOUT")) return "TIMEOUT";
  if (message.includes("INVALID JSON")) return "BAD JSON";
  if (message.includes("EXITED")) return "EXIT";
  if (message.includes("COULD NOT START")) return "START";
  if (message.includes("RATE LIMIT")) return "RATE LIMIT";
  if (message.includes("BUBBLEWRAP")) return "BWRAP";
  return "FETCH FAIL";
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
