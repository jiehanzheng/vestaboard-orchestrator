import type { Plugin, PluginUpdate, Priority } from "../../orchestrator.js";
import type { VestaboardBoard, VestaboardBoardProvider } from "../../vestaboardTypes.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./demo.js";
import { formatError, formatQuota } from "./display/index.js";
import {
  autoStartErrorStatus,
  bumpStatusPriority,
  cachedRowsPresentIn,
  cachedRowsUsedFor,
  errorStatus,
  logAutoStartFailure,
  logIncompleteQuota,
  logQuotaReadFailure,
  missingQuotaWindows,
  missingStatus,
  QuotaIngredientCache,
  REFRESH_STATUS_MESSAGE_TTL_MS,
  TRANSIENT_STATUS_MESSAGE_TTL_MS,
  StatusMessageStack
} from "./pluginState.js";
import { QuotaWindowHistory } from "./quotaWindowHistory.js";
import { createCodexQuotaPoller, readFixtureQuota } from "./quotaSource.js";
import type { CodexQuotaPluginOptions, Logger, QuotaPoller, QuotaSnapshot } from "./types.js";

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";
  private readonly quotaCache = new QuotaIngredientCache();
  private readonly statusMessages = new StatusMessageStack();
  private readonly quotaWindowHistory: QuotaWindowHistory;

  constructor(
    private readonly readQuota: QuotaPoller,
    private readonly options: {
      priority: Priority;
      errorPriority: Priority;
      timeZone?: string;
      showPacing?: boolean;
      board?: VestaboardBoardProvider;
      statusMessage?: () => string | undefined;
      takeDemoMode?: () => CodexQuotaDemoState | undefined;
      restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
      logger?: Logger;
      now?: () => Date;
      quotaWindowHistory?: QuotaWindowHistory;
    }
  ) {
    this.quotaWindowHistory = options.quotaWindowHistory ?? new QuotaWindowHistory();
  }

  async getUpdate(): Promise<PluginUpdate> {
    const now = this.options.now?.() ?? new Date();
    const demoMode = this.options.takeDemoMode?.();
    const board = await this.resolveBoard();

    try {
      const {
        snapshot: freshQuota,
        statusMessage,
        sidecarError,
        rateLimitResetCreditsAvailableCount
      } = await this.readQuota({ forceAutoStart: demoMode?.forceAutoStart, now });
      const missingWindows = missingQuotaWindows(freshQuota);
      this.quotaWindowHistory.recordFreshSnapshot(freshQuota);
      this.quotaCache.update(freshQuota);
      const displayQuota = this.quotaCache.merge(freshQuota);
      const staleRows = cachedRowsUsedFor(missingWindows, freshQuota, displayQuota);
      this.pushStatusMessages(now, statusMessage, sidecarError, missingWindows);
      const resetStatus = resetAvailableStatus(freshQuota, rateLimitResetCreditsAvailableCount);
      if (resetStatus) {
        this.statusMessages.pushLow(resetStatus, now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
      }
      if (sidecarError) {
        logAutoStartFailure(this.options.logger, sidecarError);
      }

      const displayStatusMessage = this.statusMessages.top(now) ?? this.options.statusMessage?.();
      const renderedQuota = applyCodexQuotaDemo(displayQuota, demoMode);
      const message = formatQuota(renderedQuota, {
        timeZone: this.options.timeZone,
        now,
        showPacing: this.options.showPacing,
        board,
        statusMessage: displayStatusMessage,
        staleRows,
        resetVisibility: this.quotaWindowHistory.resetVisibilityFor(renderedQuota)
      });

      if (missingWindows.length > 0) {
        logIncompleteQuota(this.options.logger, missingWindows, staleRows, this.options.errorPriority);
      }

      const priority = missingWindows.length > 0 ? this.options.errorPriority : this.options.priority;
      return {
        priority: displayStatusMessage ? bumpStatusPriority(priority) : priority,
        message
      };
    } catch (error) {
      if (demoMode) {
        this.options.restoreDemoMode?.(demoMode);
      }
      return this.fallbackUpdate(error, now, board);
    }
  }

  private fallbackUpdate(error: unknown, now: Date, board: VestaboardBoard): PluginUpdate {
    const cachedQuota = this.quotaCache.snapshot();
    this.statusMessages.push(errorStatus(error), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    const displayStatusMessage = this.quotaCache.hasAny() ? this.statusMessages.top(now) : undefined;
    const message = this.quotaCache.hasAny()
      ? formatQuota(cachedQuota, {
          timeZone: this.options.timeZone,
          now,
          showPacing: this.options.showPacing,
          board,
          statusMessage: displayStatusMessage,
          staleRows: cachedRowsPresentIn(cachedQuota),
          resetVisibility: this.quotaWindowHistory.resetVisibilityFor(cachedQuota)
        })
      : formatError(error, { board });
    logQuotaReadFailure(this.options.logger, error, this.options.errorPriority, message, this.quotaCache.state());

    return {
      priority: displayStatusMessage ? bumpStatusPriority(this.options.errorPriority) : this.options.errorPriority,
      message
    };
  }

  private pushStatusMessages(
    now: Date,
    statusMessage: string | undefined,
    sidecarError: unknown,
    missingWindows: ("5H" | "WK")[]
  ): void {
    if (statusMessage) {
      this.statusMessages.push(statusMessage, now, REFRESH_STATUS_MESSAGE_TTL_MS);
    }

    if (sidecarError) {
      this.statusMessages.push(autoStartErrorStatus(), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    }

    if (missingWindows.length > 0) {
      this.statusMessages.push(missingStatus(missingWindows), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    }
  }

  private async resolveBoard(): Promise<VestaboardBoard> {
    return this.options.board ? await this.options.board() : "note";
  }
}

export function createCodexQuotaPlugin({
  fixture = false,
  priority = "normal",
  errorPriority = "low",
  timeZone,
  showPacing = true,
  autoStartWindow5h = false,
  autoStartWindowWk = false,
  board,
  statusMessage,
  takeDemoMode,
  restoreDemoMode,
  logger = console,
  now
}: CodexQuotaPluginOptions & {
  takeDemoMode?: () => CodexQuotaDemoState | undefined;
  restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
  logger?: Logger;
  now?: () => Date;
} = {}): CodexQuotaPlugin {
  const quotaWindowHistory = new QuotaWindowHistory();
  const readQuota: QuotaPoller = fixture
    ? async () => ({ snapshot: await readFixtureQuota() })
    : createCodexQuotaPoller({
        fiveHour: autoStartWindow5h,
        weekly: autoStartWindowWk
      }, quotaWindowHistory);
  return new CodexQuotaPlugin(readQuota, {
    priority,
    errorPriority,
    timeZone,
    showPacing,
    board,
    statusMessage,
    takeDemoMode,
    restoreDemoMode,
    logger,
    now,
    quotaWindowHistory
  });
}

function resetAvailableStatus(snapshot: QuotaSnapshot, availableCount: number | undefined): string | undefined {
  if ((availableCount ?? 0) <= 0 || !snapshot.weekly) {
    return undefined;
  }

  return snapshot.weekly.remainingRatio <= 0 ? "reset available" : undefined;
}
