# Codex Quota Decisions

## Auto-start unused quota windows

When `AUTO_START_WINDOW_5H` or `AUTO_START_WINDOW_WK` is enabled, the Codex quota plugin may intentionally send one minimal Codex prompt when the corresponding quota window is still completely unused at 100%. The prompt must be constrained to minimize token usage and avoid file inspection or command execution.

This behavior is opt-in only. Missing flags default to false. Agents should not remove the opt-in gate or make the warmup prompt more expensive without explicit user direction.

The plugin also supports a signal-driven force ping for testing the bump path. This bypasses the opt-in env flags, unused-window check, and 30-minute cooldown, but should still use the same minimal model selection and prompt path.
