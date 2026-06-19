# Vestaboard Orchestrator

A small TypeScript service that asks plugins for priority, renders the highest-priority plugin, and sends the message to Vestaboard.

## Run

```sh
VESTABOARD_TOKEN=... pnpm start
```

Useful local commands:

```sh
pnpm dry-run
pnpm once
pnpm test
```

## Docker

Create a local `.env` from the example:

```sh
cp .env.example .env
```

Set `VESTABOARD_TOKEN` in `.env`. By default, Compose mounts `${HOME}/.codex` into `/home/node/.codex` so `codex app-server` can reuse persisted auth. If your Codex config lives elsewhere, set `CODEX_HOST_DIR` in `.env`.

Run:

```sh
docker compose up --build
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ORCHESTRATOR_INTERVAL_MINUTES` | `5` | How often to poll plugins. |
| `VESTABOARD_MODE` | `cloud` | `cloud` or `local`. |
| `VESTABOARD_TOKEN` | | Cloud Read/Write API token. |
| `VESTABOARD_CLOUD_URL` | `https://cloud.vestaboard.com/` | Cloud API endpoint. |
| `VESTABOARD_LOCAL_API_KEY` | | Local API key. |
| `VESTABOARD_LOCAL_URL` | `http://vestaboard.local:7000/local-api/message` | Local API endpoint. |
| `CODEX_QUOTA_SOURCE` | `app-server` | Use `fixture` for offline dry-runs. |
| `CODEX_QUOTA_PRIORITY` | `normal` | Plugin priority: `low`, `normal`, `high`, `urgent`, or a number. |
| `CODEX_QUOTA_ERROR_PRIORITY` | `low` | Priority for the Codex quota error message. |
| `CODEX_QUOTA_TIME_ZONE` | local process timezone | Time zone used for reset labels. |
| `CODEX_QUOTA_DEMO_PAUSE_MINUTES` | `5` | How long to pause normal polling after a signal-triggered demo render. |

The main loop is serial: it runs one orchestrator tick, waits `ORCHESTRATOR_INTERVAL_MINUTES` after that tick completes, then starts the next tick. It does not use `setInterval`, so a slow plugin cannot cause overlapping or immediate follow-up polls.

The orchestrator remembers the last successfully sent Vestaboard payload. If the next selected plugin renders the same message, the loop skips the Vestaboard API call.

## Codex Quota Plugin

The plugin renders a 15-column, 3-row Vestaboard Note-friendly layout:

```text
5HGGGGGGGG  80%
WKGGGG      40%
1330♥06/22♥0000
```

`G` in dry-run output represents Vestaboard green block character code `66`; `O` represents orange character code `64`; `W` represents white character code `69`. The actual API payload sends `characters`, not text.

The percentage shows remaining quota, derived from `100 - usedPercent`. Full quota renders as `100` so the 15-column row still fits; unavailable windows render as `--%`. The 10-block bar overlays quota remaining against time remaining until reset:

- Green blocks show quota remaining.
- Orange blocks appear only when the time-remaining bar is longer than the quota-remaining bar, showing how far behind pace the quota is.
- White blocks appear only when the quota-remaining bar is longer than the time-remaining bar, showing how far ahead pace the quota is.
- The reset line uses Vestaboard Note heart code `62` as the separator between the 5H reset, weekly reset date, and weekly reset time.

The default source spawns `codex app-server`, initializes JSON-RPC over stdin/stdout, and calls `account/rateLimits/read`. It maps aggregate `rateLimits.primary` to the 5H row and aggregate `rateLimits.secondary` to the WK row.

Each plugin returns priority and message together in one call, so the Codex quota plugin runs `codex app-server` at most once per orchestrator tick. If Codex times out, returns malformed JSON, or returns an unexpected quota shape, the plugin returns a lower-priority error message for the board instead of throwing.

Use fixture mode to validate formatting without a running or authenticated Codex app-server:

```sh
CODEX_QUOTA_SOURCE=fixture pnpm dry-run
```

## Demo Mode

The long-running process can render one realistic Codex quota demo without restarting:

```sh
kill -HUP <pid>   # drop-1-pct: reduce 5H remaining quota by one percentage point
kill -USR2 <pid>  # drop-1-color-block: reduce 5H remaining quota by one rendered block
```

Signals are cumulative for the running process. Two `SIGHUP`s render a two-point drop, and later demo signals continue from the accumulated demo offset.

The signal wakes the loop if it is sleeping, renders the demo from a fresh quota read, then pauses normal polling for `CODEX_QUOTA_DEMO_PAUSE_MINUTES`.
