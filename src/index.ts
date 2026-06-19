import { createCodexQuotaPlugin } from "./plugins/codexQuota/index.js";
import { LastSentMessageCache, runForever, tick } from "./orchestrator.js";
import { createVestaboardClient } from "./vestaboard.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const intervalMinutes = Number(process.env.ORCHESTRATOR_INTERVAL_MINUTES ?? "5");
const sentMessageCache = new LastSentMessageCache();

const vestaboard = createVestaboardClient({
  dryRun,
  mode: process.env.VESTABOARD_MODE === "local" ? "local" : "cloud",
  token: process.env.VESTABOARD_TOKEN,
  localApiKey: process.env.VESTABOARD_LOCAL_API_KEY,
  cloudUrl: process.env.VESTABOARD_CLOUD_URL,
  localUrl: process.env.VESTABOARD_LOCAL_URL
});

const plugins = [
  createCodexQuotaPlugin({
    fixture: process.env.CODEX_QUOTA_SOURCE === "fixture",
    priority: process.env.CODEX_QUOTA_PRIORITY ?? "normal",
    errorPriority: process.env.CODEX_QUOTA_ERROR_PRIORITY ?? "low",
    timeZone: process.env.CODEX_QUOTA_TIME_ZONE
  })
];

async function run(): Promise<void> {
  await tick({ plugins, vestaboard, sentMessageCache });
}

if (once) {
  run().catch(fail);
} else {
  runForever({
    runOnce: run,
    waitMs: intervalMinutes * 60_000
  }).catch(fail);
}

function fail(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}
