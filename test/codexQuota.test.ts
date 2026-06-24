import assert from "node:assert/strict";
import test from "node:test";

import { DemoSignalController } from "../src/demoSignals.js";
import { isMatchingTurnCompletion, parseModelListResult, turnCompletionFailure } from "../src/plugins/codexQuota/appServer.js";
import { CodexAutoStartSidecar } from "../src/plugins/codexQuota/autoStartSidecar.js";
import { applyCodexQuotaDemo } from "../src/plugins/codexQuota/demo.js";
import {
  CodexQuotaPlugin,
  formatError,
  formatQuota,
  QuotaWindowHistory,
  quotaFromRateLimits,
  type QuotaSnapshot,
  selectAutoStartModel
} from "../src/plugins/codexQuota/index.js";
import { LastSentMessageCache, runForever, tick, type VestaboardMessage } from "../src/orchestrator.js";
import { BLACK, BLUE, GREEN, ORANGE, RED, VIOLET, WHITE, YELLOW } from "../src/plugins/codexQuota/display/shared.js";
import { StatusMessageStack } from "../src/plugins/codexQuota/pluginState.js";
import { createVestaboardBoardResolver, boardPreferenceFromEnv } from "../src/vestaboardBoard.js";
import { createVestaboardClient, detectVestaboardBoard } from "../src/vestaboard.js";

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
  assert.equal(message.text, "5HGGGGGGGGW 80%\nWK          --%\n0244♥--/-------");
  assert.deepEqual(message.characters?.[1], [23, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 44, 54]);
  assert.deepEqual(message.characters?.[2], [36, 28, 30, 30, 62, 44, 44, 59, 44, 44, 44, 44, 44, 44, 44]);
});

test("renders remaining quota as green Vestaboard Note character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.3, resetAt: new Date("2026-06-21T00:00:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGW100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 69, 27, 36, 36]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("renders documented Vestaboard punctuation character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      now: new Date("2026-06-18T21:44:00-07:00"),
      statusMessage: "!@#$()-+&=;:'\""
    }
  );

  assert.equal(message.text.split("\n")[2], "!@#$()-+&=;:'\" ");
  assert.deepEqual(message.characters?.[2], [37, 38, 39, 40, 41, 42, 44, 46, 47, 48, 49, 50, 52, 53, 0]);
});

test("renders documented comma period degree and heart character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      now: new Date("2026-06-18T21:44:00-07:00"),
      statusMessage: "punct,./?°♥"
    }
  );

  assert.equal(message.text.split("\n")[2], "PUNCT,./?°♥    ");
  assert.deepEqual(message.characters?.[2], [16, 21, 14, 3, 20, 55, 56, 59, 60, 62, 62, 0, 0, 0, 0]);
});

test("preserves official Vestaboard color character constants", () => {
  assert.deepEqual({ RED, ORANGE, YELLOW, GREEN, BLUE, VIOLET, WHITE, BLACK }, {
    RED: 63,
    ORANGE: 64,
    YELLOW: 65,
    GREEN: 66,
    BLUE: 67,
    VIOLET: 68,
    WHITE: 69,
    BLACK: 70
  });
});

test("status message stack prunes expired messages before retaining new ones", () => {
  const stack = new StatusMessageStack();
  const retainedMessages = (): unknown[] => (stack as unknown as { messages: unknown[] }).messages;

  stack.push("first", new Date("2026-06-19T00:00:00-07:00"), 1_000);
  stack.push("second", new Date("2026-06-19T00:00:02-07:00"), 1_000);
  stack.pushLow("third", new Date("2026-06-19T00:00:04-07:00"), 1_000);

  assert.equal(retainedMessages().length, 1);
  assert.equal(stack.top(new Date("2026-06-19T00:00:04-07:00")), "third");
});

test("renders full quota as 100 while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGW100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 69, 27, 36, 36]);
});

test("renders single-digit percentages without a leading zero while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.09, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00"), showPacing: false }
  );

  assert.equal(message.text.split("\n")[0], "5HG          9%");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 54]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("does not render reset time for unused quota windows", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "----♥--/-------");
  assert.deepEqual(message.characters?.[2], [44, 44, 44, 44, 62, 44, 44, 59, 44, 44, 44, 44, 44, 44, 44]);
});

test("renders reset time for full windows when reset visibility is supplied", () => {
  const snapshot = {
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const message = formatQuota(snapshot, {
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T21:44:00-07:00"),
    resetVisibility: { fiveHour: true, weekly: true }
  });

  assert.equal(message.text.split("\n")[2], "0244♥06/24-1419");
});

test("quota window history shows full-window resets after two matching fresh timestamps", () => {
  const history = new QuotaWindowHistory();
  const first = quotaSnapshot({ fiveHour: 1, weekly: 1 });
  history.recordFreshSnapshot(first);
  assert.deepEqual(history.resetVisibilityFor(first), { fiveHour: false, weekly: false });

  const second = quotaSnapshot({ fiveHour: 1, weekly: 1 });
  history.recordFreshSnapshot(second);
  assert.deepEqual(history.resetVisibilityFor(second), { fiveHour: true, weekly: true });

  const changed = {
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: second.weekly
  };
  history.recordFreshSnapshot(changed);
  assert.deepEqual(history.resetVisibilityFor(changed), { fiveHour: false, weekly: true });

  history.recordFreshSnapshot(changed);
  assert.deepEqual(history.resetVisibilityFor(changed), { fiveHour: true, weekly: true });
});

test("quota window history shows used-window resets immediately", () => {
  const history = new QuotaWindowHistory();
  const snapshot = quotaSnapshot({ fiveHour: 0.995, weekly: 1 });
  history.recordFreshSnapshot(snapshot);

  assert.deepEqual(history.resetVisibilityFor(snapshot), { fiveHour: true, weekly: false });
});

test("renders reset time only for the used five-hour quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.99, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "0244♥--/-------");
});

test("renders reset date and time only for the used weekly quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.99, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "----♥06/24-1419");
});

test("renders red quota fill and white time marker when quota is far behind expected remaining", () => {
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

  assert.equal(message.text, "5HRRR   W   30%\nWKGGGGWG    60%\n0300♥06/22-0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 63, 63, 63, 0, 0, 0, 69, 0, 0, 0, 29, 36, 54]);
});

test("renders green quota fill and white time marker when quota is ahead of expected remaining", () => {
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

  assert.equal(message.text.split("\n")[0], "5HGGGGWGGG  80%");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 69, 66, 66, 66, 0, 0, 34, 36, 54]);
});

test("renders yellow quota fill when quota is slightly behind expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.35,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HYYYYW     35%");
  assert.deepEqual(message.characters?.[0], [31, 8, 65, 65, 65, 65, 69, 0, 0, 0, 0, 0, 29, 31, 54]);
});

test("renders orange quota fill when quota is moderately behind expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.3,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HOOO W     30%");
  assert.deepEqual(message.characters?.[0], [31, 8, 64, 64, 64, 0, 69, 0, 0, 0, 0, 0, 29, 36, 54]);
});

test("renders only the white marker when it covers the only quota cell", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.05,
        resetAt: new Date("2026-06-19T00:10:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HW          5%");
  assert.deepEqual(message.characters?.[0], [31, 8, 69, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 31, 54]);
});

test("renders white marker without quota fill when quota is empty but time remains", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5H    W      0%");
  assert.deepEqual(message.characters?.[0], [31, 8, 0, 0, 0, 0, 69, 0, 0, 0, 0, 0, 0, 36, 54]);
});

test("renders a minimum Note quota block for nonzero quota below one rounded cell", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.04,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.deepEqual(message.characters?.[0], [31, 8, RED, 0, 0, 0, WHITE, 0, 0, 0, 0, 0, 0, 30, 54]);
});

test("renders only green quota blocks when pacing is hidden", () => {
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
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false, staleRows: ["WK"] }
  );

  assert.equal(message.text, "5HGGG       30%\nWKGGGGGG    60%\n0300♥06/22-0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 0, 0, 0, 0, 0, 0, 0, 29, 36, 54]);
  assert.equal(message.text.includes("?"), false);
  assert.equal(message.characters?.flat().includes(63), false);
  assert.equal(message.characters?.flat().includes(67), false);
});

test("renders Flagship quota as six 22-column rows with centered 20-column bars", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.77,
        resetAt: new Date("2026-06-19T20:25:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.06,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      showPacing: false,
      resetVisibility: { fiveHour: true, weekly: true }
    }
  );
  const rows = message.text.split("\n");

  assert.equal(rows.length, 6);
  assert.equal(rows.every((row) => row.length === 22), true);
  assert.equal(message.characters?.length, 6);
  assert.equal(message.characters?.every((row) => row.length === 22), true);
  assert.equal(rows[0], "CODEX REMAINING  RESET");
  assert.equal(rows[1], "5H    77%        20:25");
  assert.equal(rows[2][0], " ");
  assert.equal(rows[2].slice(1, 21), "GGGGGGGGGGGGGGG     ");
  assert.equal(rows[2][21], " ");
  assert.equal(rows[3], "WEEK  6%   06/24 14:19");
  assert.equal(rows[4][0], " ");
  assert.equal(rows[4].slice(1, 21), "G                   ");
  assert.equal(rows[4][21], " ");
  assert.equal(rows[5], "                      ");
  assert.equal(rows[0].indexOf("REMAINING"), 6);
  assert.equal(rows[1].slice(6, 9), "77%");
  assert.equal(rows[3].slice(6, 8), "6%");
  assert.equal(rows[0].slice(-5), "RESET");
  assert.equal(rows[1].slice(-5), "20:25");
  assert.equal(rows[3].slice(-11), "06/24 14:19");
});

test("renders Flagship status override in the last row and truncates overflow", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.5, resetAt: new Date("2026-06-19T20:25:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.5, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      statusMessage: "timeout using cached weekly quota"
    }
  );

  assert.equal(message.text.split("\n")[5], "TIMEOUT USING CACHED W");
});

test("renders Flagship full quota as 100% in the aligned remaining field", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T20:25:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      showPacing: false,
      resetVisibility: { fiveHour: true, weekly: true }
    }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[1], "5H    100%       20:25");
  assert.equal(rows[3], "WEEK  100% 06/24 14:19");
  assert.equal(rows[1].slice(6, 10), "100%");
  assert.equal(rows[3].slice(6, 10), "100%");
});

test("renders Flagship pacing-off bars without red or blue blocks", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.3, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false }
  );

  assert.equal(message.characters?.flat().includes(63), false);
  assert.equal(message.characters?.flat().includes(67), false);
  assert.equal(message.characters?.flat().includes(69), false);
  assert.equal(message.text.split("\n")[2].slice(1, 21), "GGGGGG              ");
});

test("renders Flagship ratio pacing with white marker on 20-cell bars", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.3, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows.every((row) => row.length === 22), true);
  assert.equal(rows[2].slice(1, 21), "GGGGGGGGWGGGGGGG    ");
  assert.equal(rows[4].slice(1, 21), "OOOOOO  W           ");
  assert.deepEqual(message.characters?.[4].slice(1, 10), [64, 64, 64, 64, 64, 64, 0, 0, 69]);
});

test("renders Flagship marker-only bar when the marker covers the only quota cell", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.03, resetAt: new Date("2026-06-19T00:07:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[2].slice(1, 21), "W                   ");
  assert.equal(rows[4].slice(1, 21), "        W           ");
  assert.equal(message.characters?.[2][1], 69);
  assert.equal(message.characters?.[4][9], 69);
});

test("renders a minimum Flagship quota block for nonzero quota below one rounded cell", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.02, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[2].slice(1, 21), "R       W           ");
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
  assert.equal(message.text.split("\n")[0], "5HGGGGGGW   74%");
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

test("model list parser permits omitted reasoning efforts on unselected models", () => {
  const models = parseModelListResult({
    data: [
      { id: "spark", model: "gpt-5.3-codex-spark" },
      { id: "regular", model: "gpt-5.5", supportedReasoningEfforts: null },
      {
        id: "nano",
        model: "gpt-5.4-nano",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }]
      }
    ],
    nextCursor: null
  }).data;

  assert.deepEqual(selectAutoStartModel(models), {
    model: "gpt-5.4-nano",
    reasoningEffort: "low"
  });
});

test("model selection rejects when the selected model has no reasoning effort", () => {
  const models = parseModelListResult({
    data: [
      { id: "nano", model: "gpt-5.4-nano" }
    ],
    nextCursor: null
  }).data;

  assert.throws(() => selectAutoStartModel(models), /did not include a reasoning effort/);
});

test("auto-start planner selects enabled unused windows and skips disabled or used windows", () => {
  const state = new QuotaWindowHistory();
  const now = new Date("2026-06-19T00:00:00-07:00");

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: false, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "fiveHour", row: "5H", resetAtMs: new Date("2026-06-19T09:44:00.000Z").getTime() }]
  });
  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 0.99, weekly: 1 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("auto-start planner records attempted windows and allows a newer reset timestamp", () => {
  const state = new QuotaWindowHistory();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const first = state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: firstNow });
  assert.equal(first.type, "ping");
  assert.equal(first.type === "ping" ? first.windows.length : 0, 2);

  if (first.type === "ping") {
    state.recordPingAttempt(first, firstNow);
  }

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });

  const newer = state.planAutoStart({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  }, { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") });

  assert.deepEqual(newer, {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "fiveHour", row: "5H", resetAtMs: new Date("2026-06-19T14:44:00.000Z").getTime() }]
  });
});

test("auto-start planner applies cooldown after ping attempts", () => {
  const state = new QuotaWindowHistory();
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.5 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const first = state.planAutoStart(snapshot, { fiveHour: true, weekly: false }, { force: false, now });
  assert.equal(first.type, "ping");
  assert.equal(state.planAutoStart(snapshot, { fiveHour: true, weekly: false }, { force: false, now }).type, "ping");

  if (first.type === "ping") {
    state.recordPingAttempt(first, now);
  }

  assert.deepEqual(state.planAutoStart({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }, { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:29:59-07:00") }), {
    type: "skip",
    reason: "cooldown"
  });
  assert.equal(state.planAutoStart({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }, { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }).type, "ping");
});

test("auto-start planner force mode bypasses flags quota records and cooldown without marking windows", () => {
  const state = new QuotaWindowHistory();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const normal = state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: firstNow });
  assert.equal(normal.type, "ping");
  if (normal.type === "ping") {
    state.recordPingAttempt(normal, firstNow);
  }

  const force = state.planAutoStart(quotaSnapshot({ fiveHour: 0.8, weekly: 0.4 }), { fiveHour: false, weekly: false }, { force: true, now: new Date("2026-06-19T00:01:00-07:00") });
  assert.deepEqual(force, { type: "ping", trigger: "force", windows: [] });
  if (force.type === "ping") {
    state.recordPingAttempt(force, new Date("2026-06-19T00:01:00-07:00"));
  }

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("codex plugin shows full-window reset time after two matching fresh ticks", async () => {
  let reads = 0;
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return quotaPollResult({
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    now: () => new Date("2026-06-18T21:44:00-07:00")
  });

  const first = await plugin.getUpdate();
  const second = await plugin.getUpdate();

  assert.equal(reads, 2);
  assert.equal(first.message.text.split("\n")[2], "----♥--/-------");
  assert.equal(second.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin hides a changed full-window reset until it repeats", async () => {
  const snapshots = [
    quotaSnapshot({ fiveHour: 1, weekly: 1 }),
    quotaSnapshot({ fiveHour: 1, weekly: 1 }),
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: quotaSnapshot({ weekly: 1 }).weekly
    },
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: quotaSnapshot({ weekly: 1 }).weekly
    }
  ];
  let reads = 0;
  const plugin = new CodexQuotaPlugin(async () => quotaPollResult(snapshots[reads++] ?? snapshots.at(-1)!), {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    now: () => new Date("2026-06-19T00:00:00-07:00")
  });

  await plugin.getUpdate();
  await plugin.getUpdate();
  const changed = await plugin.getUpdate();
  const repeated = await plugin.getUpdate();

  assert.equal(changed.message.text.split("\n")[2], "----♥06/24-1419");
  assert.equal(repeated.message.text.split("\n")[2], "0744♥06/24-1419");
});

test("codex plugin demo drop shows five-hour reset immediately without weekly visibility", async () => {
  const plugin = new CodexQuotaPlugin(async () => quotaPollResult({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  }), {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    takeDemoMode: () => ({ pctDrops: 1 }),
    now: () => new Date("2026-06-18T21:44:00-07:00")
  });

  const update = await plugin.getUpdate();

  assert.equal(update.message.text.split("\n")[0], "5HYYYYYYYYYW99%");
  assert.equal(update.message.text.split("\n")[2], "0244♥--/-------");
});

test("codex plugin demo drop does not create stable full-window history", async () => {
  let reads = 0;
  let demoAvailable = true;
  const snapshots = [
    quotaSnapshot({ fiveHour: 1, weekly: 1 }),
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: quotaSnapshot({ weekly: 1 }).weekly
    },
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: quotaSnapshot({ weekly: 1 }).weekly
    }
  ];
  const plugin = new CodexQuotaPlugin(async () => quotaPollResult(snapshots[reads++] ?? snapshots.at(-1)!), {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    takeDemoMode: () => {
      if (!demoAvailable) {
        return undefined;
      }

      demoAvailable = false;
      return { pctDrops: 1 };
    },
    now: () => new Date("2026-06-19T00:00:00-07:00")
  });

  const demo = await plugin.getUpdate();
  const changed = await plugin.getUpdate();
  const repeated = await plugin.getUpdate();

  assert.equal(demo.message.text.split("\n")[2], "0244♥--/-------");
  assert.equal(changed.message.text.split("\n")[2], "----♥06/24-1419");
  assert.equal(repeated.message.text.split("\n")[2], "0744♥06/24-1419");
});

test("codex plugin retains ping status-message messages until expiration", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  const snapshot = {
    fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return reads === 1 ? { snapshot, statusMessage: "ping gpt5.4minilow" } : quotaPollResult(snapshot);
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", now: () => now });

  const first = await plugin.getUpdate();
  now = new Date("2026-06-19T00:04:00-07:00");
  const retained = await plugin.getUpdate();
  now = new Date("2026-06-19T00:06:00-07:00");
  const expired = await plugin.getUpdate();

  assert.equal(first.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(retained.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.deepEqual(first.message.characters?.[2], [16, 9, 14, 7, 0, 7, 16, 20, 31, 56, 30, 13, 9, 14, 9]);
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24-1419");
  assert.equal(first.priority, "high");
  assert.equal(retained.priority, "high");
  assert.equal(expired.priority, "normal");
});

test("codex plugin shows newer fetch failure above retained ping message", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  let fail = false;
  const snapshot = {
    fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const plugin = new CodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    reads += 1;
    return reads === 1 ? { snapshot, statusMessage: "ping gpt5.4minilow" } : quotaPollResult(snapshot);
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await plugin.getUpdate();
  now = new Date("2026-06-19T00:04:00-07:00");
  fail = true;
  const fallback = await plugin.getUpdate();

  assert.equal(fallback.priority, "high");
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
});

test("codex plugin shows newer missing-window status above retained ping message", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let partial = false;
  const plugin = new CodexQuotaPlugin(async () => {
    if (partial) {
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
      });
    }

    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      statusMessage: "ping gpt5.4minilow"
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await plugin.getUpdate();
  now = new Date("2026-06-19T00:04:00-07:00");
  partial = true;
  const fallback = await plugin.getUpdate();

  assert.equal(fallback.priority, "high");
  assert.equal(fallback.message.text.split("\n")[2], "MISS WK        ");
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
  let threadStartParams: { sandbox?: string; cwd?: unknown } | undefined;
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread(params: { sandbox?: string; cwd?: unknown }) {
      threadStartParams = params;
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "completed" } };
    },
    async waitForTurnCompletion() {}
  };

  const result = await sidecar.afterQuotaRead({
    client,
    snapshot: quotaSnapshot({ fiveHour: 0.4, weekly: 0.2 }),
    force: true,
    now: new Date("2026-06-19T00:00:00-07:00")
  });

  assert.equal(result.statusMessage, "ping gpt5.4minilow");
  assert.equal(threadStartParams?.sandbox, "read-only");
  assert.equal(Object.hasOwn(threadStartParams ?? {}, "cwd"), false);
});

test("auto-start sidecar rejects non-progress turn start statuses", async () => {
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread() {
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "interrupted" } };
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

test("auto-start sidecar records attempts before model reads can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      throw new Error("model/list failed");
    },
    async startThread() {
      throw new Error("unexpected startThread");
    },
    async startTurn() {
      throw new Error("unexpected startTurn");
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /model\/list failed/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
  assert.deepEqual(history.planAutoStart({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: snapshot.weekly
  }, config, { force: false, now: new Date("2026-06-19T00:29:59-07:00") }), {
    type: "skip",
    reason: "cooldown"
  });
});

test("auto-start sidecar records attempts before turn start can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread() {
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "interrupted" } };
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /started with status interrupted/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("auto-start sidecar records attempts before model selection can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [parseModelListResult({ data: [{ id: "nano", model: "gpt-5.4-nano" }] }).data[0]!],
        nextCursor: null
      };
    },
    async startThread() {
      throw new Error("unexpected startThread");
    },
    async startTurn() {
      throw new Error("unexpected startTurn");
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /did not include a reasoning effort/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
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

test("codex plugin expires reset available after a later fetch omits reset credits", async () => {
  let reads = 0;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      rateLimitResetCreditsAvailableCount: reads === 1 ? 1 : 0
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", now: () => now });

  const first = await plugin.getUpdate();
  const retained = await plugin.getUpdate();
  now = new Date("2026-06-19T00:00:01-07:00");
  const second = await plugin.getUpdate();

  assert.equal(first.priority, "high");
  assert.equal(first.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(retained.priority, "high");
  assert.equal(retained.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(second.priority, "normal");
  assert.equal(second.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin keeps stacked refresh message above reset available until it expires", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      statusMessage: reads === 1 ? "ping gpt5.4minilow" : undefined,
      rateLimitResetCreditsAvailableCount: 1
    };
  }, { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", now: () => now });

  const stacked = await plugin.getUpdate();
  now = new Date("2026-06-19T00:04:00-07:00");
  const retained = await plugin.getUpdate();
  now = new Date("2026-06-19T00:06:00-07:00");
  const resetAvailable = await plugin.getUpdate();

  assert.equal(stacked.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(retained.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(resetAvailable.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(stacked.priority, "high");
  assert.equal(retained.priority, "high");
  assert.equal(resetAvailable.priority, "high");
});

test("codex plugin keeps sidecar error above reset available in the status-message stack", async () => {
  const plugin = new CodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    sidecarError: new Error("model/list failed"),
    rateLimitResetCreditsAvailableCount: 1
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[2], "AUTO PING FAIL ");
});

test("codex plugin keeps missing-window status above reset available in the status-message stack", async () => {
  const plugin = new CodexQuotaPlugin(async () => ({
    snapshot: {
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[2], "MISS 5H        ");
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
  assert.equal(update.message.text.split("\n")[2], "0244♥06/24-1419");
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

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
      });
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24-1419");
  assert.equal(error.priority, "high");
  assert.equal(retained.priority, "high");
  assert.equal(expired.priority, "normal");
});

test("codex plugin renders missing row placeholder when no cached ingredient exists", async () => {
  const plugin = new CodexQuotaPlugin(async () => quotaPollResult({
    fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
  }), { priority: "normal", errorPriority: "low", timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[1], "WK          --%");
  assert.equal(update.message.text.split("\n")[2], "MISS WK        ");
});

test("codex plugin can show board-size pending status in the Note status lane", async () => {
  const plugin = new CodexQuotaPlugin(async () => quotaPollResult({
    fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
  }), {
    priority: "normal",
    errorPriority: "low",
    timeZone: "America/Los_Angeles",
    board: async () => "note",
    statusMessage: () => "VB SIZE PEND"
  });

  const update = await plugin.getUpdate();

  assert.equal(update.priority, "high");
  assert.equal(update.message.text.split("\n")[2], "VB SIZE PEND   ");
  assert.equal(update.message.characters?.[2].length, 15);
});

test("orchestrator asks each plugin for priority and message in one call", async () => {
  let reads = 0;
  const sent: VestaboardMessage[] = [];
  const plugin = new CodexQuotaPlugin(async () => {
    reads += 1;
    return quotaPollResult({
      fiveHour: { remainingRatio: 0.5, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.5, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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
  assert.equal(sent[0]?.text.includes("0244♥06/24-1419"), true);
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

test("board preference defaults to auto and validates explicit values", () => {
  assert.equal(boardPreferenceFromEnv(undefined), "auto");
  assert.equal(boardPreferenceFromEnv(""), "auto");
  assert.equal(boardPreferenceFromEnv("note"), "note");
  assert.equal(boardPreferenceFromEnv("flagship"), "flagship");
  assert.equal(boardPreferenceFromEnv("auto"), "auto");
  assert.throws(() => boardPreferenceFromEnv("wide"), /VESTABOARD_BOARD/);
});

test("auto board resolver assumes Note then retries until detection succeeds", async () => {
  let calls = 0;
  const resolver = createVestaboardBoardResolver({
    preference: "auto",
    async detectBoard() {
      calls += 1;
      return calls === 1 ? undefined : "flagship";
    },
    logger: { warn() {} }
  });

  assert.equal(await resolver.resolve(), "note");
  assert.deepEqual(resolver.resolution(), { board: "note", source: "assumed" });
  assert.equal(await resolver.resolve(), "flagship");
  assert.deepEqual(resolver.resolution(), { board: "flagship", source: "confirmed" });
  assert.equal(await resolver.resolve(), "flagship");
  assert.equal(calls, 2);
});

test("explicit board resolver is confirmed and never detects", async () => {
  let calls = 0;
  const resolver = createVestaboardBoardResolver({
    preference: "note",
    async detectBoard() {
      calls += 1;
      return "flagship";
    }
  });

  assert.equal(await resolver.resolve(), "note");
  assert.deepEqual(resolver.resolution(), { board: "note", source: "confirmed" });
  assert.equal(calls, 0);
});

test("Vestaboard board detection infers dimensions from Cloud API layout", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({
        currentMessage: {
          layout: JSON.stringify(Array.from({ length: 6 }, () => Array(22).fill(0)))
        }
      });
    }
  });

  assert.equal(board, "flagship");
  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
});

test("Vestaboard board detection infers Note dimensions from Cloud API layout", async () => {
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({
      currentMessage: {
        layout: JSON.stringify(Array.from({ length: 3 }, () => Array(15).fill(0)))
      }
    })
  });

  assert.equal(board, "note");
});

test("Vestaboard board detection returns undefined when no layout is available", async () => {
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({ status: "error", message: "No message found for board" })
  });

  assert.equal(board, undefined);
});

test("vestaboard client prefers local API when local key is configured", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    localApiKey: "local-key",
    cloudUrl: "https://cloud.example/",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }
  });

  await client.send({ text: "ok", characters: [[1, 2, 3]] });

  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(requests[0]?.init.body, "[[1,2,3]]");
});

test("vestaboard client detects Flagship through local API when local key is configured", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    localApiKey: "local-key",
    cloudUrl: "https://cloud.example/",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (init?.method === "GET") {
        return Response.json(Array.from({ length: 6 }, () => Array(22).fill(0)));
      }

      return new Response("", { status: 200 });
    }
  });

  const board = await client.detectBoard?.();
  await client.send({ text: "ok", characters: [[1, 2, 3]] });

  assert.equal(board, "flagship");
  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(requests[1]?.url, "http://local.example/message");
  assert.equal((requests[1]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(requests[1]?.init.body, "[[1,2,3]]");
});

test("vestaboard client detects Note through local API without cloud token", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json(Array.from({ length: 3 }, () => Array(15).fill(0)));
    }
  });

  assert.equal(await client.detectBoard?.(), "note");
  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
});

test("vestaboard client uses local detection in dry-run local mode", async () => {
  const client = createVestaboardClient({
    dryRun: true,
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async () => Response.json(Array.from({ length: 6 }, () => Array(22).fill(0))),
    logger: { info() {} }
  });

  assert.equal(await client.detectBoard?.(), "flagship");
});

test("vestaboard client falls back to cloud API when local key is absent", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }
  });

  await client.send({ text: "ok" });

  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
  assert.equal(requests[0]?.init.body, "{\"text\":\"ok\"}");
});

test("vestaboard client detects board through cloud API when local key is absent", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({ currentMessage: { layout: Array.from({ length: 6 }, () => Array(22).fill(0)) } });
    }
  });

  assert.equal(await client.detectBoard?.(), "flagship");
  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
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

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.76, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
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

function quotaPollResult(snapshot: QuotaSnapshot) {
  return { snapshot };
}
