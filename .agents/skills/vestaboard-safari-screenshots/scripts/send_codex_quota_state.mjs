#!/usr/bin/env node

import { formatQuota } from "../../../../dist/src/plugins/codexQuota/index.js";

const token = process.env.VESTABOARD_TOKEN;
const args = parseArgs(process.argv.slice(2));
const board = args.board;
const state = args.state;

if (!args.dryRun && !token) {
  throw new Error("VESTABOARD_TOKEN is required.");
}

if (board !== "note" && board !== "flagship") {
  usage();
}

const message = board === "note" ? noteMessage(state) : flagshipMessage(state);
console.error(message.text);

if (args.dryRun) {
  console.error(`Dry-run ${board} ${state}`);
  process.exit(0);
}

const response = await fetch("https://cloud.vestaboard.com/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Vestaboard-Token": token
  },
  body: JSON.stringify({ characters: message.characters })
});

if (!response.ok) {
  throw new Error(`Vestaboard API returned ${response.status}: ${await response.text()}`);
}

console.error(`Sent ${board} ${state}`);

function noteMessage(state) {
  if (!["pacing-on", "pacing-off", "ping"].includes(state)) {
    usage();
  }

  const now = new Date("2026-06-19T00:00:00-07:00");
  const snapshot = {
    fiveHour: {
      remainingRatio: state === "ping" ? 1 : 0.3,
      resetAt: new Date(state === "ping" ? "2026-06-19T05:00:00-07:00" : "2026-06-19T03:00:00-07:00"),
      durationMins: 300
    },
    weekly: {
      remainingRatio: state === "ping" ? 1 : 0.6,
      resetAt: new Date(state === "ping" ? "2026-06-26T00:00:00-07:00" : "2026-06-22T00:00:00-07:00"),
      durationMins: 10_080
    }
  };

  return formatQuota(snapshot, {
    board: "note",
    timeZone: "America/Los_Angeles",
    now,
    showPacing: state !== "pacing-off",
    statusMessage: state === "ping" ? "ping gpt5.4mini" : undefined
  });
}

function flagshipMessage(state) {
  if (state !== "standard") {
    usage();
  }

  return formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.76,
        resetAt: new Date("2026-06-19T22:49:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.44,
        resetAt: new Date("2026-06-22T00:00:00-07:00"),
        durationMins: 10_080
      }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T17:49:00-07:00")
    }
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--board" || arg === "--state") {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    usage();
  }
  return parsed;
}

function usage() {
  throw new Error(
    "Usage: send_codex_quota_state.mjs --board note --state pacing-on|pacing-off|ping OR --board flagship --state standard [--dry-run]"
  );
}
