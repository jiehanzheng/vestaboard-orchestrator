# Vestaboard Orchestrator

A small TypeScript service that polls local plugins, picks the highest-priority message, and sends it to Vestaboard. Its first plugin turns Codex quota into a glanceable Vestaboard status board.

![Codex quota pacing hidden on a Vestaboard compose screen](docs/images/codex-pacing-off.png)

## How to Set Up

Docker is the intended runtime path.

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Set `VESTABOARD_TOKEN` in `.env` to a Vestaboard Cloud Read/Write API token.

3. Make sure Docker can see your Codex auth. By default, Compose mounts `${HOME}/.codex` into `/home/node/.codex`, which lets `codex app-server` reuse persisted auth. If your Codex config lives somewhere else, set `CODEX_HOST_DIR` in `.env`.

4. Start the orchestrator:

   ```sh
   docker compose up --build
   ```

The loop is serial: it runs one plugin pass, sends the selected message, waits `ORCHESTRATOR_INTERVAL_MINUTES`, then starts the next pass. If the winning message is unchanged from the last successful send, the orchestrator skips the Vestaboard API call.

## Plugins

### Codex

The Codex plugin reads `account/rateLimits/read` from `codex app-server` and renders the 5-hour and weekly quota windows into two 15-column Vestaboard rows.

| Story | Screenshot | What it means |
| --- | --- | --- |
| Pacing on | ![Codex quota with pacing colors](docs/images/codex-pacing-on.png) | Green blocks are quota remaining. Red blocks mean quota is behind the time-remaining pace. Blue blocks mean quota is ahead of pace. |
| Pacing off | ![Codex quota without pacing colors](docs/images/codex-pacing-off.png) | `CODEX_QUOTA_SHOW_PACING=off` hides pacing entirely: only green quota blocks and blanks remain. This is the clean, quiet mode for just checking remaining quota. |
| Auto-start ping | ![Codex full quota ping status](docs/images/codex-ping.png) | When a watched window is still full at 100%, the plugin can send one minimal Codex ping to start a real reset window. The third row briefly shows the ping model. |

The first two rows are quota windows:

```text
5HGGGRRR    30%
WKGGGGBB    60%
0300♥06/22♥0000
```

`G`, `R`, and `B` in dry-run output stand for Vestaboard green, red, and blue block character codes. The actual API payload sends `characters`, not plain text. Percentages are remaining quota, derived from `100 - usedPercent`. Full quota renders as `100` so the row still fits.

The third row normally shows reset timing: 5-hour reset time, weekly reset date, and weekly reset time. It is also a short-lived status row. Current-cycle statuses, fetch failures, missing quota windows, reset availability, and auto-start ping notices temporarily replace reset timing; expired statuses are pruned on later ticks.

If Codex is temporarily unavailable after a successful read, the plugin can reuse cached quota ingredients and mark the board with a short third-row status instead of throwing away the display.

#### Codex Env Config

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_QUOTA_SOURCE` | `app-server` | Use `fixture` for offline formatting checks. |
| `CODEX_QUOTA_PRIORITY` | `normal` | Plugin priority: `low`, `normal`, `high`, `urgent`, or a number. |
| `CODEX_QUOTA_ERROR_PRIORITY` | `low` | Priority used when the plugin can only render an error or incomplete quota. |
| `CODEX_QUOTA_TIME_ZONE` | local process timezone | Time zone used for reset labels. |
| `CODEX_QUOTA_SHOW_PACING` | `on` | `on` overlays red/blue pacing blocks; `off` shows only green quota blocks and blanks. |
| `CODEX_AUTO_START_WINDOW_5H` | `false` | Ping Codex once when the 5-hour window is completely unused at 100%. |
| `CODEX_AUTO_START_WINDOW_WK` | `false` | Ping Codex once when the weekly window is completely unused at 100%. |
| `CODEX_QUOTA_DEMO_PAUSE_MINUTES` | `5` | How long normal polling pauses after a signal-triggered demo render. |

When auto-start is enabled, the plugin lists visible Codex models, skips `-spark` models, prefers the last `-nano` model, then the last `-mini` model, then the last remaining model. It sends a read-only ephemeral prompt: `Reply exactly: ok. Do not inspect files or run commands.` A running process auto-starts at most once per reset timestamp and never pings more than once every 30 minutes unless forced by demo mode.

When the weekly quota row is exhausted at 0% and `account/rateLimits/read` reports reset credits are available, the third row shows `RESET AVAILABLE`. The plugin only displays that read-only account status; it does not invoke a reset.

#### Demo Mode

Use fixture mode to validate formatting without an authenticated Codex app-server:

```sh
CODEX_QUOTA_SOURCE=fixture docker compose up --build
```

The long-running process can render one realistic Codex quota demo without restarting:

```sh
kill -HUP <pid>   # drop one percentage point from 5H remaining quota
kill -USR2 <pid>  # force a Codex ping and show the retained third-row ping message
```

Signals are cumulative for the running process. Two `SIGHUP`s render a two-point drop, and later demo signals continue from the accumulated demo offset. `SIGUSR2` bypasses auto-start env flags, the 30-minute ping cooldown, and the unused-window check so the ping path can be tested on demand.
