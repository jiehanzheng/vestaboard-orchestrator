import type { CodexQuotaDemoMode, CodexQuotaDemoState } from "./plugins/codexQuota/demo.js";

export class DemoSignalController {
  private pending = false;
  private demoState: CodexQuotaDemoState = { pctDrops: 0, forceAutoStart: false };
  private pauseAfterRun = false;
  private wake: (() => void) | undefined;
  private readonly handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();

  install(logger: Pick<Console, "info">): void {
    if (this.handlers.size > 0) {
      return;
    }

    this.addHandler("SIGHUP", "drop-1-pct", logger);
    this.addHandler("SIGUSR2", "force-auto-start", logger);
  }

  queue(mode: CodexQuotaDemoMode, logger: Pick<Console, "info"> = console): void {
    if (mode === "drop-1-pct") {
      this.demoState.pctDrops += 1;
    } else {
      this.demoState.forceAutoStart = true;
    }

    this.pending = true;
    logger.info(
      `Queued Codex quota demo mode: ${mode}; pctDrops=${this.demoState.pctDrops}, forceAutoStart=${this.demoState.forceAutoStart}`
    );
    this.wake?.();
  }

  uninstall(): void {
    for (const [signal, handler] of this.handlers) {
      process.off(signal, handler);
    }
    this.handlers.clear();
  }

  take(): CodexQuotaDemoState | undefined {
    if (!this.pending) {
      return undefined;
    }

    this.pending = false;
    this.pauseAfterRun = true;
    const demoState = { ...this.demoState };
    if (!demoState.forceAutoStart) {
      delete demoState.forceAutoStart;
    }
    this.demoState.forceAutoStart = false;
    return demoState;
  }

  takePauseAfterRun(): boolean {
    const pause = this.pauseAfterRun;
    this.pauseAfterRun = false;
    return pause;
  }

  sleep(ms: number): Promise<void> {
    if (this.pending) {
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
