---
name: vestaboard-safari-screenshots
description: Capture pixel-precise Vestaboard web screenshots from Safari for README/docs assets, using API-sent messages, Safari duplicate/compose view, and border-based board crop validation for Note and Flagship layouts.
---

# Vestaboard Safari Screenshots

Use this skill when updating README/docs screenshots of Vestaboard messages rendered on `web.vestaboard.com`, especially when the output must be a tight, high-resolution board crop.

## Dependencies

The crop helper uses Pillow. Install it in a project-local temporary venv before cropping:

```sh
python3 -m venv temp_nocommit/vestaboard-safari-screenshots-venv
temp_nocommit/vestaboard-safari-screenshots-venv/bin/python -m pip install -r .codex/skills/vestaboard-safari-screenshots/requirements.txt
```

Run `scripts/crop_vestaboard_board.py` with that venv's Python, or activate the venv first.

## Workflow

1. Send the desired message through the Vestaboard API or project code path that the screenshot is meant to document.
   - Do not embed API tokens in scripts or committed files.
   - Prefer the repo formatter/client over hand-written payloads.
   - For the README Codex quota Note examples, run `pnpm build` first, then use `scripts/send_codex_quota_note_state.mjs pacing-on|pacing-off|ping` with `VESTABOARD_TOKEN` set.
2. Open the board History page in Safari.
3. Click the lower-left duplicate/copy button for the target History card to open the larger compose/visual view.
4. Capture the Safari window with `screencapture`.
5. Crop with `scripts/crop_vestaboard_board.py`.
   - Provide a rough rectangle around only the board area in screenshot pixels; this can be loose and should not depend on Safari window position.
   - The script finds the exact board border from the rough region using board-pixel projections around the rendered message content.
   - The script validates the expected grid shape before writing output.
   - Use `--rows 3 --cols 15` for Note and `--rows 6 --cols 22` for Flagship.
6. Verify output dimensions and visually inspect the crop before replacing docs assets.

## Pixel Precision

Do not hard-code Safari window position, screen size, or previously observed crop coordinates into documentation updates. Only the rough rectangle is allowed to vary per capture; exact crop bounds must be found from the board border/content in that capture.

The crop is acceptable only when:

- the script reports an exact crop rectangle and output size,
- the detected rectangle contains the expected row/column grid,
- no browser chrome, compose controls, or page background remains,
- no board edge, tile shadow, or rendered character is clipped.

## Safari Notes

Safari screenshots on Retina displays are usually 2x the point coordinate space. Use the pixel dimensions reported by `sips -g pixelWidth -g pixelHeight <capture.png>` when choosing rough crop coordinates.

If the rough rectangle contains too much non-board UI, tighten it around the board and rerun the script. Do not manually crop final assets by eye.
