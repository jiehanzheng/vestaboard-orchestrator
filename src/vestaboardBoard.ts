import type { VestaboardBoard, VestaboardBoardPreference } from "./vestaboardTypes.js";

export interface VestaboardBoardResolution {
  board: VestaboardBoard;
  source: "confirmed" | "assumed";
}

export interface VestaboardBoardResolver {
  resolve(): Promise<VestaboardBoard>;
  resolution(): VestaboardBoardResolution;
}

export function boardPreferenceFromEnv(value: string | undefined): VestaboardBoardPreference {
  if (value === undefined || value === "") return "auto";
  const normalized = value.toLowerCase();
  if (normalized === "auto" || normalized === "note" || normalized === "flagship") {
    return normalized;
  }

  throw new Error("VESTABOARD_BOARD must be 'auto', 'note', or 'flagship'.");
}

export function createVestaboardBoardResolver({
  preference = "auto",
  detectBoard,
  logger = console
}: {
  preference?: VestaboardBoardPreference;
  detectBoard?: () => Promise<VestaboardBoard | undefined>;
  logger?: Pick<Console, "warn">;
} = {}): VestaboardBoardResolver {
  if (preference === "note" || preference === "flagship") {
    return new FixedVestaboardBoardResolver(preference);
  }

  return new AutoVestaboardBoardResolver(detectBoard, logger);
}

class FixedVestaboardBoardResolver implements VestaboardBoardResolver {
  constructor(private readonly board: VestaboardBoard) {}

  async resolve(): Promise<VestaboardBoard> {
    return this.board;
  }

  resolution(): VestaboardBoardResolution {
    return { board: this.board, source: "confirmed" };
  }
}

class AutoVestaboardBoardResolver implements VestaboardBoardResolver {
  private current: VestaboardBoardResolution = { board: "note", source: "assumed" };

  constructor(
    private readonly detectBoard: (() => Promise<VestaboardBoard | undefined>) | undefined,
    private readonly logger: Pick<Console, "warn">
  ) {}

  async resolve(): Promise<VestaboardBoard> {
    if (this.current.source === "confirmed") {
      return this.current.board;
    }

    try {
      const detected = await this.detectBoard?.();
      if (detected) {
        this.current = { board: detected, source: "confirmed" };
        return detected;
      }
    } catch (error) {
      this.logger.warn("Vestaboard board auto-detection failed.", error);
      this.current = { board: "note", source: "assumed" };
      return this.current.board;
    }

    this.logger.warn("Vestaboard board auto-detection could not determine board type; assuming Note for this tick.");
    this.current = { board: "note", source: "assumed" };
    return this.current.board;
  }

  resolution(): VestaboardBoardResolution {
    return this.current;
  }
}
