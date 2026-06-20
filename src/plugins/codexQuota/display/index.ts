import type { VestaboardMessage } from "../../../orchestrator.js";
import { formatFlagshipError, formatFlagshipQuota } from "./flagship.js";
import { formatNoteError, formatNoteQuota } from "./note.js";
import { sanitizeDisplayText } from "./shared.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import type { QuotaRowName, QuotaSnapshot, VestaboardBoard } from "../types.js";

export { sanitizeDisplayText };

export function formatQuota(
  snapshot: QuotaSnapshot,
  options: {
    timeZone?: string;
    now?: Date;
    statusMessage?: string;
    staleRows?: QuotaRowName[];
    showPacing?: boolean;
    board?: VestaboardBoard;
    resetVisibility?: ResetVisibility;
  } = {}
): VestaboardMessage {
  const rendererOptions = {
    timeZone: options.timeZone,
    now: options.now ?? new Date(),
    statusMessage: options.statusMessage,
    staleRows: options.staleRows ?? [],
    showPacing: options.showPacing ?? true,
    resetVisibility: options.resetVisibility ?? legacyResetVisibility(snapshot)
  };

  return (options.board ?? "note") === "flagship"
    ? formatFlagshipQuota(snapshot, rendererOptions)
    : formatNoteQuota(snapshot, rendererOptions);
}

export function formatError(error: unknown, options: { board?: VestaboardBoard } = {}): VestaboardMessage {
  return options.board === "flagship"
    ? formatFlagshipError(error)
    : formatNoteError(error);
}

function legacyResetVisibility(snapshot: QuotaSnapshot): ResetVisibility {
  return {
    fiveHour: (snapshot.fiveHour?.remainingRatio ?? 1) < 1,
    weekly: (snapshot.weekly?.remainingRatio ?? 1) < 1
  };
}
