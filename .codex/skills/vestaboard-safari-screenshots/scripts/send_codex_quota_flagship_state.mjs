#!/usr/bin/env node

import { formatQuota } from "../../../../dist/src/plugins/codexQuota/index.js";

const token = process.env.VESTABOARD_TOKEN;

if (!token) {
  throw new Error("VESTABOARD_TOKEN is required.");
}

const message = formatQuota(
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

console.error("Sent flagship");
