import assert from "node:assert/strict";
import test from "node:test";

import { DemoSignalController } from "../src/demoSignals.js";
import { isMatchingTurnCompletion, turnCompletionFailure } from "../src/plugins/codexQuota/appServer.js";
import { CodexAutoStartSidecar } from "../src/plugins/codexQuota/autoStartSidecar.js";
import { applyCodexQuotaDemo } from "../src/plugins/codexQuota/demo.js";
import {
  AutoStartPingState,
  CodexQuotaPlugin,
  formatError,
  formatQuota,
  quotaFromRateLimits,
  selectAutoStartModel
} from "../src/plugins/codexQuota/index.js";
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

  const message = formatQuota(snapshot, {
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T22:44:00-07:00")
  });

  assert.ok(snapshot.fiveHour);
  assert.equal(snapshot.weekly, undefined);
  assert.equal(message.text, "5HGGGGGGGG  80%\nWK          --%\n0244♥--/--♥----");
  assert.deepEqual(message.characters?.[1], [23, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 44, 54]);
  assert.deepEqual(message.characters?.[2], [36, 28, 30, 30, 62, 44, 44, 59, 44, 44, 62, 44, 44, 44, 44]);
});

test("renders remaining quota as green Vestaboard Note character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.3, resetAt: new Date("2026-06-21T00:00:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGG100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 27, 36, 36]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("renders full quota as 100 while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGG100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 66, 27, 36, 36]);
});

test("does not render reset time for unused quota windows", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "----♥--/--♥----");
  assert.deepEqual(message.characters?.[2], [44, 44, 44, 44, 62, 44, 44, 59, 44, 44, 62, 44, 44, 44, 44]);
});

test("renders reset time only for the used five-hour quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.99, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "0244♥--/--♥----");
});

test("renders reset date and time only for the used weekly quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.99, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "----♥06/24♥1419");
});

test("renders red blocks when quota remaining is behind time remaining", () => {
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

  assert.equal(message.text, "5HGGGRRR    30%\nWKGGGGBB    60%\n0300♥06/22♥0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 63, 63, 63, 0, 0, 0, 0, 29, 36, 54]);
});

test("renders blue blocks when quota consumption is slower than elapsed time", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.8,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.5,
        resetAt: new Date("2026-06-22T12:00:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGBBBB  80%");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 67, 67, 67, 67, 0, 0, 34, 36, 54]);
});

test("demo mode drops five-hour quota by one percentage point", () => {
  const snapshot = applyCodexQuotaDemo(
    {
      fiveHour: { remainingRatio: 0.76, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
    },
    { pctDrops: 1 }
  );

  assert.equal(snapshot.fiveHour?.remainingRatio, 0.75);
  assert.equal(snapshot.weekly?.remainingRatio, 0.6);
});

test("demo mode accumulates repeated drops", () => {
  const snapshot = applyCodexQuotaDemo(
    {
      fiveHour: { remainingRatio: 0.76, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
    },
    { pctDrops: 2 }
  );
  const message = formatQuota(snapshot, { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") });

  assert.equal(snapshot.fiveHour?.remainingRatio, 0.74);
  assert.equal(message.text.split("\n")[0], "5HGGGGGGB   74%");
});

test("auto-start model selection skips spark and prefers the last nano model", () => {
  const selection = selectAutoStartModel([
    model("gpt-5.5", ["medium"]),
    model("gpt-5.3-codex-spark", ["low"]),
    model("gpt-5.4-mini", ["medium", "high"]),
    model("gpt-5.4-nano", ["low", "medium"])
  ]);

  assert.deepEqual(selection, {
    model: "gpt-5.4-nano",
    reasoningEffort: "low"
  });
});

test("auto-start model selection falls back to mini and then the last filtered model", () => {
  assert.deepEqual(selectAutoStartModel([
    model("gpt-5.5", ["medium"]),
    model("gpt-5.4-mini", ["low"]),
    model("gpt-5.3-codex-spark", ["low"])
  ]), {
    model: "gpt-5.4-mini",
    reasoningEffort: "low"
  });
  assert.deepEqual(selectAutoStartModel([
    model("gpt-5.5", ["low"]),
    model("gpt-5.4", ["medium"]),
    model("gpt-5.3-codex-spark", ["low"])
  ]), {
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });
});

test("auto-start planner selects enabled unused windows and skips disabled or used windows", () => {
  const state = new AutoStartPingState();
  const now = new Date("2026-06-19T00:00:00-07:00");

  assert.deepEqual(state.plan(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: false, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
  assert.deepEqual(state.plan(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "fiveHour", row: "5H", resetAtMs: new Date("2026-06-19T09:44:00.000Z").getTime() }]
  });
  assert.deepEqual(state.plan(quotaSnapshot({ fiveHour: 0.99, weekly: 1 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("auto-start planner records successful windows and allows a newer reset timestamp", () => {
  const state = new AutoStartPingState();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const first = state.plan(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: firstNow });
  assert.equal(first.type, "ping");
  assert.equal(first.type === "ping" ? first.windows.length : 0, 2);

  if (first.type === "ping") {
    state.recordSuccess(first, firstNow);
  }

  assert.deepEqual(state.plan(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });

  const newer = state.plan({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  }, { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") });

  assert.deepEqual(newer, {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "fiveHour", row: "5H", resetAtMs: new Date("2026-06-19T14:44:00.000Z").getTime() }]
  });
});

test("auto-start planner applies cooldown only after successful pings", () => {
  const state = new AutoStartPingState();
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.5 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const first = state.plan(snapshot, { fiveHour: true, weekly: false }, { force: false, now });
  assert.equal(first.type, "ping");
  assert.equal(state.plan(snapshot, { fiveHour: true, weekly: false }, { force: false, now }).type, "ping");

  if (first.type === "ping") {
    state.recordSuccess(first, now);
  }

  assert.deepEqual(state.plan({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }, { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:29:59-07:00") }), {
    type: "skip",
    reason: "cooldown"
  });
  assert.equal(state.plan({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }, { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }).type, "ping");
});

test("auto-start planner force mode bypasses flags quota records and cooldown without marking windows", () => {
  const state = new AutoStartPingState();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const normal = state.plan(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: firstNow });
  assert.equal(normal.type, "ping");
  if (normal.type === "ping") {
    state.recordSuccess(normal, firstNow);
  }

  const force = state.plan(quotaSnapshot({ fiveHour: 0.8, weekly: 0.4 }), { fiveHour: false, weekly: false }, { force: true, now: new Date("2026-06-19T00:01:00-07:00") });
  assert.deepEqual(force, { type: "ping", trigger: "force", windows: [] });
  if (force.type === "ping") {
    state.recordSuccess(force, new Date("2026-06-19T00:01:00-07:00"));
  }

  assert.deepEqual(state.plan(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("codex plugin retains ping third-row messages until expiration", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  const snapshot = {
    fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return reads === 1 ? { snapshot, thirdRowMessage: "ping gpt-5.4-minilow" } : snapshot;
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", now: () => now });

  const first = await plugin.getUpdate();
  now = new Date("2026-06-19T00:04:00-07:00");
  const retained = await plugin.getUpdate();
  now = new Date("2026-06-19T00:06:00-07:00");
  const expired = await plugin.getUpdate();

  assert.equal(first.message.text.split("\n")[2], "PING GPT 5 4 MI");
  assert.equal(retained.message.text.split("\n")[2], "PING GPT 5 4 MI");
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24♥1419");
  assert.equal(first.priority, "high");
  assert.equal(retained.priority, "high");
  assert.equal(expired.priority, "normal");
});

test("app-server turn completion matching accepts events without threadId", () => {
  assert.equal(isMatchingTurnCompletion({ turn: { id: "turn-1" } }, "thread-1", "turn-1"), true);
  assert.equal(isMatchingTurnCompletion({ threadId: "thread-1", turn: { id: "turn-1" } }, "thread-1", "turn-1"), true);
  assert.equal(isMatchingTurnCompletion({ threadId: "thread-2", turn: { id: "turn-1" } }, "thread-1", "turn-1"), false);
  assert.equal(isMatchingTurnCompletion({ turn: { id: "turn-2" } }, "thread-1", "turn-1"), false);
});

test("app-server turn completion only treats completed as success", () => {
  assert.equal(turnCompletionFailure({ status: "completed" }), undefined);
  assert.match(turnCompletionFailure({ status: "failed", error: "boom" })?.message ?? "", /status failed/);
  assert.match(turnCompletionFailure({ status: "interrupted" })?.message ?? "", /status interrupted/);
  assert.match(turnCompletionFailure({})?.message ?? "", /status unknown/);
});

test("auto-start sidecar starts read-only threads without cwd", async () => {
  let threadStartParams: Record<string, unknown> | undefined;
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "model/list") {
        return {
          data: [model("gpt-5.4-mini", ["low"])],
          nextCursor: null
        } as T;
      }
      if (method === "thread/start") {
        threadStartParams = params;
        return { thread: { id: "thread-1" } } as T;
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "completed" } } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async waitForTurnCompletion() {}
  };

  await sidecar.afterQuotaRead({
    client,
    snapshot: quotaSnapshot({ fiveHour: 0.4, weekly: 0.2 }),
    force: true,
    now: new Date("2026-06-19T00:00:00-07:00")
  });

  assert.equal(threadStartParams?.sandbox, "read-only");
  assert.equal(Object.hasOwn(threadStartParams ?? {}, "cwd"), false);
});

test("auto-start sidecar rejects non-progress turn start statuses", async () => {
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "model/list") {
        return {
          data: [model("gpt-5.4-mini", ["low"])],
          nextCursor: null
        } as T;
      }
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } } as T;
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "interrupted" } } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({
    client,
    snapshot: quotaSnapshot({ fiveHour: 0.4, weekly: 0.2 }),
    force: true,
    now: new Date("2026-06-19T00:00:00-07:00")
  }), /started with status interrupted/);
});

test("codex plugin keeps fresh quota display when auto-start sidecar fails", async () => {
  const warnings: unknown[][] = [];
  const plugin = new CodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    sidecarError: new Error("model/list failed")
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.match(update.message.text.split("\n")[0], /^5H/);
  assert.match(update.message.text.split("\n")[1], /^WK/);
  assert.equal(update.message.text.split("\n")[2], "AUTO PING FAIL ");
  assert.equal(warnings[0]?.[0], "Codex quota auto-start failed after quota read.");
  assert.deepEqual(warnings[0]?.[1], {
    reason: "unknown",
    errorName: "Error",
    errorMessage: "model/list failed",
    boardStatus: "AUTO PING FAIL"
  });
});

test("codex plugin shows reset available when weekly quota is exhausted and reset credit exists", async () => {
  const plugin = new CodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles" });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[2], "RESET AVAILABLE");
});

test("codex plugin does not retain reset available after a later fetch omits reset credits", async () => {
  let reads = 0;
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      rateLimitResetCreditsAvailableCount: reads === 1 ? 1 : 0
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles" });

  const first = await plugin.getUpdate();
  const second = await plugin.getUpdate();

  assert.equal(first.priority, "high");
  assert.equal(first.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(second.priority, "normal");
  assert.equal(second.message.text.split("\n")[2], "0244♥06/24♥1419");
});

test("codex plugin does not show reset available when weekly quota remains", async () => {
  const plugin = new CodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.01, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles" });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "normal");
  assert.equal(update.message.text.split("\n")[2], "0244♥06/24♥1419");
});

test("codex plugin returns low-priority error message when quota read fails", async () => {
  const warnings: unknown[][] = [];
  const plugin = new CodexQuotaPlugin(async () => {
    throw new Error("invalid json from codex");
  }, { priority: "normal", errorPriority: "low", logger: { warn: (...args) => warnings.push(args) } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "low");
  assert.equal(update.message.text.split("\n")[0], "CODEX QUOTA ERR");
  assert.equal(update.message.characters?.every((row) => row.length === 15), true);
  assert.equal(warnings[0]?.[0], "Codex quota read failed.");
  assert.deepEqual(warnings[0]?.[1], {
    reason: "invalid_json",
    errorName: "Error",
    errorMessage: "invalid json from codex",
    fallbackPriority: "low",
    cacheState: {
      hasFiveHour: false,
      hasWeekly: false,
      updatedAt: undefined
    },
    vestaboardPreview: "CODEX QUOTA ERR | INVALID JSON FR | "
  });
});

test("codex plugin renders cached quota ingredients when a later quota read fails", async () => {
  const warnings: unknown[][] = [];
  let fail = false;
  const plugin = new CodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 30000ms.");
    }

    return {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  const good = await plugin.getUpdate();
  fail = true;
  const fallback = await plugin.getUpdate();

  assert.equal(fallback.priority, "high");
  assert.equal(fallback.message.text.split("\n")[0].replace("?", " "), good.message.text.split("\n")[0]);
  assert.equal(fallback.message.text.split("\n")[1].replace("?", " "), good.message.text.split("\n")[1]);
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal((warnings[0]?.[1] as { reason?: string }).reason, "timeout");
  assert.deepEqual((warnings[0]?.[1] as { cacheState?: { hasFiveHour: boolean; hasWeekly: boolean } }).cacheState, {
    hasFiveHour: true,
    hasWeekly: true,
    updatedAt: (warnings[0]?.[1] as { cacheState?: { updatedAt?: string } }).cacheState?.updatedAt
  });
});

test("codex plugin shows fetch fail for generic cached quota read failures", async () => {
  let fail = false;
  const plugin = new CodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server error: invalid request");
    }

    return {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} } });

  await plugin.getUpdate();
  fail = true;
  const fallback = await plugin.getUpdate();

  assert.equal(fallback.priority, "high");
  assert.equal(fallback.message.text.split("\n")[2], "FETCH FAIL     ");
});

test("codex plugin fills missing ingredients from cache and marks stale row when there is room", async () => {
  const warnings: unknown[][] = [];
  let partial = false;
  const plugin = new CodexQuotaPlugin(async () => {
    if (partial) {
      return {
        fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
      };
    }

    return {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  await plugin.getUpdate();
  partial = true;
  const fallback = await plugin.getUpdate();

  assert.equal(fallback.priority, "high");
  assert.match(fallback.message.text.split("\n")[0], /^5H/);
  assert.match(fallback.message.text.split("\n")[1], /\?/);
  assert.equal(fallback.message.text.split("\n")[2], "MISS WK        ");
  assert.deepEqual(warnings[0]?.[1], {
    missingWindows: ["WK"],
    usedCachedWindows: ["WK"],
    fallbackPriority: "low",
    boardStatus: "MISS WK"
  });
});

test("codex plugin recomputes cached ingredients instead of reusing rendered message", async () => {
  let fail = false;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = new CodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    return {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  const good = await plugin.getUpdate();
  fail = true;
  now = new Date("2026-06-19T01:00:00-07:00");
  const fallback = await plugin.getUpdate();

  assert.notEqual(fallback.message.text.split("\n")[0], good.message.text.split("\n")[0]);
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
});

test("codex plugin expires transient error status after the next successful read", async () => {
  let fail = false;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = new CodexQuotaPlugin(async () => {
    if (fail) {
      fail = false;
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    return {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await plugin.getUpdate();
  fail = true;
  now = new Date("2026-06-19T00:01:00-07:00");
  const error = await plugin.getUpdate();
  now = new Date("2026-06-19T00:01:00.500-07:00");
  const retained = await plugin.getUpdate();
  now = new Date("2026-06-19T00:01:01-07:00");
  const expired = await plugin.getUpdate();

  assert.equal(error.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal(retained.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24♥1419");
  assert.equal(error.priority, "high");
  assert.equal(retained.priority, "high");
  assert.equal(expired.priority, "normal");
});

test("codex plugin renders missing row placeholder when no cached ingredient exists", async () => {
  const plugin = new CodexQuotaPlugin(async () => ({
    fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[1], "WK          --%");
  assert.equal(update.message.text.split("\n")[2], "MISS WK        ");
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

test("demo signals queue mode and request a pause after the demo run", () => {
  const controller = new DemoSignalController();

  controller.queue("drop-1-pct", { info() {} });
  assert.deepEqual(controller.take(), { pctDrops: 1 });
  assert.equal(controller.takePauseAfterRun(), true);
  assert.equal(controller.takePauseAfterRun(), false);

  controller.queue("drop-1-pct", { info() {} });
  assert.deepEqual(controller.take(), { pctDrops: 2 });

  controller.queue("force-auto-start", { info() {} });
  assert.deepEqual(controller.take(), { pctDrops: 2, forceAutoStart: true });
  controller.queue("drop-1-pct", { info() {} });
  assert.deepEqual(controller.take(), { pctDrops: 3 });
});

test("codex plugin restores queued demo mode when quota read fails", async () => {
  const controller = new DemoSignalController();
  const forceAutoStartValues: Array<boolean | undefined> = [];
  let fail = true;
  controller.queue("drop-1-pct", { info() {} });
  controller.queue("force-auto-start", { info() {} });

  const plugin = new CodexQuotaPlugin(async (options) => {
    forceAutoStartValues.push(options?.forceAutoStart);
    if (fail) {
      fail = false;
      throw new Error("temporary quota failure");
    }

    return {
      fiveHour: { remainingRatio: 0.76, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    };
  }, {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    takeDemoMode: () => controller.take(),
    restoreDemoMode: (demo) => controller.restore(demo)
  });

  await plugin.getUpdate();
  const retry = await plugin.getUpdate();

  assert.deepEqual(forceAutoStartValues, [true, true]);
  assert.equal(retry.message.text.split("\n")[0].endsWith("75%"), true);
});

function model(name: string, reasoningEfforts: string[]) {
  return {
    id: name,
    model: name,
    supportedReasoningEfforts: reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort }))
  };
}

function quotaSnapshot({ fiveHour, weekly }: { fiveHour?: number; weekly?: number }) {
  return {
    fiveHour: fiveHour === undefined
      ? undefined
      : { remainingRatio: fiveHour, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: weekly === undefined
      ? undefined
      : { remainingRatio: weekly, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
}
