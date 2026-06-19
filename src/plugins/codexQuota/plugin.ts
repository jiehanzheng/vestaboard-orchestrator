import type { Plugin, PluginUpdate, Priority } from "../../orchestrator.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./demo.js";
import { formatError, formatQuota } from "./display.js";
import {
  bumpThirdRowPriority,
  cachedRowsPresentIn,
  cachedRowsUsedFor,
  errorStatus,
  logAutoStartFailure,
  logIncompleteQuota,
  logQuotaReadFailure,
  missingQuotaWindows,
  missingStatus,
  normalizeQuotaRead,
  QuotaIngredientCache,
  THIRD_ROW_MESSAGE_TTL_MS,
  ThirdRowMessageStack
} from "./pluginState.js";
import { createCodexQuotaPoller, readFixtureQuota } from "./quotaSource.js";
import type { CodexQuotaPluginOptions, Logger, QuotaPoller } from "./types.js";

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";
  private readonly quotaCache = new QuotaIngredientCache();
  private readonly thirdRowMessages = new ThirdRowMessageStack();

  constructor(
    private readonly readQuota: QuotaPoller,
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
    const now = this.options.now?.() ?? new Date();
    const demoMode = this.options.takeDemoMode?.();

    try {
      const quotaRead = await this.readQuota({ forceAutoStart: demoMode?.forceAutoStart, now });
      const { snapshot: freshQuota, thirdRowMessage, sidecarError } = normalizeQuotaRead(quotaRead);
      const missingWindows = missingQuotaWindows(freshQuota);
      this.quotaCache.update(freshQuota);
      const displayQuota = this.quotaCache.merge(freshQuota);
      const staleRows = cachedRowsUsedFor(missingWindows, freshQuota, displayQuota);
      this.pushStatusRows(now, thirdRowMessage, sidecarError, missingWindows);
      if (sidecarError) {
        logAutoStartFailure(this.options.logger, sidecarError);
      }

      const statusRow = this.thirdRowMessages.top(now);
      const message = formatQuota(applyCodexQuotaDemo(displayQuota, demoMode), {
        timeZone: this.options.timeZone,
        now,
        statusRow,
        staleRows
      });

      if (missingWindows.length > 0) {
        logIncompleteQuota(this.options.logger, missingWindows, staleRows, this.options.errorPriority);
      }

      const priority = missingWindows.length > 0 ? this.options.errorPriority : this.options.priority;
      return {
        priority: statusRow ? bumpThirdRowPriority(priority) : priority,
        message
      };
    } catch (error) {
      return this.fallbackUpdate(error, now);
    }
  }

  private fallbackUpdate(error: unknown, now: Date): PluginUpdate {
    const cachedQuota = this.quotaCache.snapshot();
    this.thirdRowMessages.push(errorStatus(error), statusExpiration(now));
    const statusRow = this.quotaCache.hasAny() ? this.thirdRowMessages.top(now) : undefined;
    const message = this.quotaCache.hasAny()
      ? formatQuota(cachedQuota, {
          timeZone: this.options.timeZone,
          now,
          statusRow,
          staleRows: cachedRowsPresentIn(cachedQuota)
        })
      : formatError(error);
    logQuotaReadFailure(this.options.logger, error, this.options.errorPriority, message, this.quotaCache.state());

    return {
      priority: statusRow ? bumpThirdRowPriority(this.options.errorPriority) : this.options.errorPriority,
      message
    };
  }

  private pushStatusRows(
    now: Date,
    thirdRowMessage: string | undefined,
    sidecarError: unknown,
    missingWindows: ("5H" | "WK")[]
  ): void {
    if (thirdRowMessage) {
      this.thirdRowMessages.push(thirdRowMessage, statusExpiration(now));
    }

    if (sidecarError) {
      this.thirdRowMessages.push(errorStatus(sidecarError), statusExpiration(now));
    }

    if (missingWindows.length > 0) {
      this.thirdRowMessages.push(missingStatus(missingWindows), statusExpiration(now));
    }
  }
}

export function createCodexQuotaPlugin({
  fixture = false,
  priority = "normal",
  errorPriority = "low",
  timeZone,
  autoStartWindow5h = false,
  autoStartWindowWk = false,
  takeDemoMode,
  logger = console,
  now
}: CodexQuotaPluginOptions & {
  takeDemoMode?: () => CodexQuotaDemoState | undefined;
  logger?: Logger;
  now?: () => Date;
} = {}): CodexQuotaPlugin {
  const readQuota = fixture
    ? readFixtureQuota
    : createCodexQuotaPoller({
        fiveHour: autoStartWindow5h,
        weekly: autoStartWindowWk
      });
  return new CodexQuotaPlugin(readQuota, { priority, errorPriority, timeZone, takeDemoMode, logger, now });
}

function statusExpiration(now: Date): Date {
  return new Date(now.getTime() + THIRD_ROW_MESSAGE_TTL_MS);
}
