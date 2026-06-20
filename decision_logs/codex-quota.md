# Codex Quota Display

- Reset times may be shown even while usage still renders as full/100 when the same reset timestamp has appeared on two fresh quota ticks.
- The sidecar auto-start logic and reset-time display must use the same in-memory quota-window history for previously observed reset timestamps.
- Do not make display rendering infer reset trust from percentage text alone; keep reset timestamp observation policy outside board-specific rendering.
- Official Vestaboard color constants are API character mappings, not renderer-local implementation details. Preserve global constants for red `63`, orange `64`, yellow `65`, green `66`, blue `67`, violet `68`, white `69`, and black `70` even if a specific renderer does not currently emit every color.
