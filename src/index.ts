import { DemoSignalController } from "./demoSignals.js";
import { createCodexQuotaPlugin } from "./plugins/codexQuota/index.js";
import { LastSentMessageCache, runForever, tick } from "./orchestrator.js";
import { boardPreferenceFromEnv, createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { createVestaboardClient } from "./vestaboard.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const intervalMinutes = Number(process.env.ORCHESTRATOR_INTERVAL_MINUTES ?? "5");
const sentMessageCache = new LastSentMessageCache();
const demoPauseMinutes = Number(process.env.CODEX_QUOTA_DEMO_PAUSE_MINUTES ?? "5");
const demoSignals = new DemoSignalController();

const vestaboard = createVestaboardClient({
  dryRun,
  token: process.env.VESTABOARD_TOKEN,
  localApiKey: process.env.VESTABOARD_LOCAL_API_KEY,
  cloudUrl: process.env.VESTABOARD_CLOUD_URL,
  localUrl: process.env.VESTABOARD_LOCAL_URL
});
const boardResolver = createVestaboardBoardResolver({
  preference: boardPreferenceFromEnv(process.env.VESTABOARD_BOARD),
  detectBoard: vestaboard.detectBoard,
  logger: console
});

const plugins = [
  createCodexQuotaPlugin({
    fixture: process.env.CODEX_QUOTA_SOURCE === "fixture",
    priority: process.env.CODEX_QUOTA_PRIORITY ?? "normal",
    errorPriority: process.env.CODEX_QUOTA_ERROR_PRIORITY ?? "low",
    timeZone: process.env.CODEX_QUOTA_TIME_ZONE,
    showPacing: envOnOff(process.env.CODEX_QUOTA_SHOW_PACING, true),
    board: () => boardResolver.resolve(),
    statusMessage: () => boardResolver.resolution().source === "assumed" ? "VB SIZE PEND" : undefined,
    autoStartWindow5h: envFlag(process.env.CODEX_AUTO_START_WINDOW_5H),
    autoStartWindowWk: envFlag(process.env.CODEX_AUTO_START_WINDOW_WK),
    takeDemoMode: () => demoSignals.take(),
    restoreDemoMode: (demo) => demoSignals.restore(demo)
  })
];

async function run(): Promise<void> {
  await tick({ plugins, vestaboard, sentMessageCache });
}

if (once) {
  run().catch(fail);
} else {
  demoSignals.install(console);
  runWithDemoSignals().catch(fail);
}

function fail(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

async function runWithDemoSignals(): Promise<void> {
  await runForever({
    runOnce: run,
    waitMs: intervalMinutes * 60_000,
    sleep: async (ms) => {
      const delayMs = demoSignals.takePauseAfterRun() ? demoPauseMinutes * 60_000 : ms;
      await demoSignals.sleep(delayMs);
    }
  });
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function envOnOff(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  if (normalized === "on" || normalized === "true" || normalized === "1") return true;
  return defaultValue;
}
