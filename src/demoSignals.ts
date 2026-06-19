import type { CodexQuotaDemoMode } from "./plugins/codexQuota/demo.js";

export class DemoSignalController {
  private pendingMode: CodexQuotaDemoMode | undefined;
  private pauseAfterRun = false;
  private wake: (() => void) | undefined;
  private readonly handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();

  install(logger: Pick<Console, "info">): void {
    if (this.handlers.size > 0) {
      return;
    }

    this.addHandler("SIGHUP", "drop-1-pct", logger);
    this.addHandler("SIGUSR2", "drop-1-color-block", logger);
  }

  queue(mode: CodexQuotaDemoMode, logger: Pick<Console, "info"> = console): void {
    this.pendingMode = mode;
    logger.info(`Queued Codex quota demo mode: ${mode}`);
    this.wake?.();
  }

  uninstall(): void {
    for (const [signal, handler] of this.handlers) {
      process.off(signal, handler);
    }
    this.handlers.clear();
  }

  take(): CodexQuotaDemoMode | undefined {
    const mode = this.pendingMode;
    this.pendingMode = undefined;
    if (mode) {
      this.pauseAfterRun = true;
    }
    return mode;
  }

  takePauseAfterRun(): boolean {
    const pause = this.pauseAfterRun;
    this.pauseAfterRun = false;
    return pause;
  }

  sleep(ms: number): Promise<void> {
    if (this.pendingMode) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wake === done) {
          this.wake = undefined;
        }
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private trigger(mode: CodexQuotaDemoMode, logger: Pick<Console, "info">): void {
    this.queue(mode, logger);
  }

  private addHandler(signal: NodeJS.Signals, mode: CodexQuotaDemoMode, logger: Pick<Console, "info">): void {
    const handler = (): void => this.trigger(mode, logger);
    this.handlers.set(signal, handler);
    process.on(signal, handler);
  }
}
