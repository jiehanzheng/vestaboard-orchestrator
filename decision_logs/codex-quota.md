# Codex Quota Display

- Reset times may be shown even while usage still renders as full/100 when the same reset timestamp has appeared on two fresh quota ticks.
- The sidecar auto-start logic and reset-time display must use the same in-memory quota-window history for previously observed reset timestamps.
- Do not make display rendering infer reset trust from percentage text alone; keep reset timestamp observation policy outside board-specific rendering.
