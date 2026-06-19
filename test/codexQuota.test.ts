import assert from "node:assert/strict";
import test from "node:test";

import { CodexQuotaPlugin, formatError, formatQuota, quotaFromRateLimits } from "../src/plugins/codexQuota/index.js";
import { LastSentMessageCache, runForever, tick, type VestaboardMessage } from "../src/orchestrator.js";

test("uses aggregate rateLimits primary and secondary windows", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_781_862_240 },
      secondary: { usedPercent: 66, windowDurationMins: 10_080, resetsAt: 1_782_076_740 }
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_781_869_432 },
        secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_782_079_599 }
      }
    }
  });

  assert.ok(snapshot.fiveHour);
  assert.ok(snapshot.weekly);
  assert.equal(snapshot.fiveHour.remainingRatio, 0.99);
  assert.equal(snapshot.weekly.remainingRatio, 0.34);
  assert.equal(snapshot.fiveHour.durationMins, 300);
  assert.equal(snapshot.weekly.durationMins, 10_080);
  assert.equal(snapshot.fiveHour.resetAt.toISOString(), "2026-06-19T09:44:00.000Z");
  assert.equal(snapshot.weekly.resetAt.toISOString(), "2026-06-21T21:19:00.000Z");
});

test("renders partial quota when only the five-hour window is present", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_781_862_240 },
      secondary: null
    }
  });

  const message = formatQuota(snapshot, "America/Los_Angeles");

  assert.ok(snapshot.fiveHour);
  assert.equal(snapshot.weekly, undefined);
  assert.equal(message.text, "5HGGGGGGGG  80%\nWK          --%\n0244♥--/--♥----");
  assert.deepEqual(message.characters?.[1], [23, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 44, 54]);
  assert.deepEqual(message.characters?.[2], [36, 28, 30, 30, 62, 44, 44, 59, 44, 44, 62, 44, 44, 44, 44]);
});

test("renders remaining quota as green Vestaboard Note character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.99, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.34, resetAt: new Date("2026-06-21T00:00:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T02:44:00-07:00") }
  );

  assert.equal(message.text, "5HGGGGGGGGGG99%\nWKGGG       34%\n0244♥06/21♥0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 35, 35, 54]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("renders full quota as 100 while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    "America/Los_Angeles"
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGG100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 27, 36, 36]);
});

test("renders orange blocks when quota remaining is behind time remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.3,
        resetAt: new Date("2026-06-19T03:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.6,
        resetAt: new Date("2026-06-22T00:00:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text, "5HGGGOOO    30%\nWKGGGGGG    60%\n0300♥06/22♥0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 64, 64, 64, 0, 0, 0, 0, 29, 36, 54]);
});

test("codex plugin returns low-priority error message when quota read fails", async () => {
  const plugin = new CodexQuotaPlugin(async () => {
    throw new Error("invalid json from codex");
  }, { priority: "normal", errorPriority: "low" });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "low");
  assert.equal(update.message.text.split("\n")[0], "CODEX QUOTA ERR");
  assert.equal(update.message.characters?.every((row) => row.length === 15), true);
});

test("orchestrator asks each plugin for priority and message in one call", async () => {
  let reads = 0;
  const sent: VestaboardMessage[] = [];
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return {
      fiveHour: { remainingRatio: 0.5, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.5, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles" });

  await tick({
    plugins: [plugin],
    vestaboard: {
      async send(message) {
        sent.push(message);
      }
    },
    logger: { info() {}, warn() {} }
  });

  assert.equal(reads, 1);
  assert.equal(sent[0]?.text.includes("0244♥06/24♥1419"), true);
});

test("orchestrator accepts numeric priority strings", async () => {
  const sent: VestaboardMessage[] = [];

  await tick({
    plugins: [
      {
        id: "low-numeric",
        async getUpdate() {
          return { priority: "10", message: { text: "low" } };
        }
      },
      {
        id: "high-numeric",
        async getUpdate() {
          return { priority: "75", message: { text: "high" } };
        }
      }
    ],
    vestaboard: {
      async send(message) {
        sent.push(message);
      }
    },
    logger: { info() {}, warn() {} }
  });

  assert.equal(sent[0]?.text, "high");
});

test("orchestrator skips Vestaboard send when selected message is unchanged", async () => {
  const sent: VestaboardMessage[] = [];
  const sentMessageCache = new LastSentMessageCache();
  const plugin = {
    id: "same-message",
    async getUpdate() {
      return { priority: "normal", message: { text: "same" } };
    }
  };

  const vestaboard = {
    async send(message: VestaboardMessage) {
      sent.push(message);
    }
  };

  await tick({ plugins: [plugin], vestaboard, sentMessageCache, logger: { info() {}, warn() {} } });
  await tick({ plugins: [plugin], vestaboard, sentMessageCache, logger: { info() {}, warn() {} } });

  assert.equal(sent.length, 1);
});

test("orchestrator retries unchanged message after failed send", async () => {
  let attempts = 0;
  const sentMessageCache = new LastSentMessageCache();
  const plugin = {
    id: "retry-message",
    async getUpdate() {
      return { priority: "normal", message: { text: "same" } };
    }
  };

  const vestaboard = {
    async send() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
    }
  };

  await tick({ plugins: [plugin], vestaboard, sentMessageCache, logger: { info() {}, warn() {} } });
  await tick({ plugins: [plugin], vestaboard, sentMessageCache, logger: { info() {}, warn() {} } });

  assert.equal(attempts, 2);
});

test("error message is encodable for Vestaboard Note", () => {
  const message = formatError(new Error("Codex app-server timed out after 10000ms."));

  assert.equal(message.text.split("\n")[0], "CODEX QUOTA ERR");
  assert.equal(message.characters?.length, 3);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("main loop waits after each completed tick", async () => {
  const events: string[] = [];
  let runs = 0;

  await runForever({
    waitMs: 300_000,
    shouldContinue: () => runs < 2,
    async runOnce() {
      events.push(`run-${runs}`);
      runs += 1;
      events.push(`done-${runs}`);
    },
    async sleep(ms) {
      events.push(`sleep-${ms}`);
    }
  });

  assert.deepEqual(events, ["run-0", "done-1", "sleep-300000", "run-1", "done-2"]);
});
