#!/usr/bin/env node

import { formatQuota } from "../../../../dist/src/plugins/codexQuota/index.js";

const token = process.env.VESTABOARD_TOKEN;
const state = process.argv[2];

if (!token) {
  throw new Error("VESTABOARD_TOKEN is required.");
}

if (!["pacing-on", "pacing-off", "ping"].includes(state)) {
  throw new Error("Usage: send_codex_quota_note_state.mjs pacing-on|pacing-off|ping");
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

const message = formatQuota(snapshot, {
  board: "note",
  timeZone: "America/Los_Angeles",
  now,
  showPacing: state !== "pacing-off",
  statusMessage: state === "ping" ? "ping gpt5.4mini" : undefined
});

console.error(message.text);

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

console.error(`Sent ${state}`);
