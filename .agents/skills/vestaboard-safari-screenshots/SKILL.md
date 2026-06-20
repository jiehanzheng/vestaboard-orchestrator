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
temp_nocommit/vestaboard-safari-screenshots-venv/bin/python -m pip install -r .agents/skills/vestaboard-safari-screenshots/requirements.txt
```

Run `scripts/crop_vestaboard_board.py` with that venv's Python, or activate the venv first.

## Workflow

1. Confirm inputs before touching the board.
   - Ask for the board-specific API key unless it has already been provided for this board type in the current task.
   - Ask for the board-specific Vestaboard web URL, such as `https://web.vestaboard.com/board/<board-id>/messages`; do not reuse a URL from another board.
2. Send the desired message through the Vestaboard API or project code path that the screenshot is meant to document.
   - Do not embed API tokens in scripts or committed files.
   - Prefer the repo formatter/client over hand-written payloads.
   - For README Codex quota examples, run `pnpm build` first, then use `scripts/send_codex_quota_state.mjs` with `VESTABOARD_TOKEN` set.
   - Note states: `--board note --state pacing-on|pacing-off|ping`.
   - Flagship state: `--board flagship --state standard`.
3. Open the board-specific History page in Safari.
4. Click the lower-left duplicate/copy button for the target History card to open the larger compose/visual view.
5. Capture the Safari window with `screencapture`.
6. Crop with `scripts/crop_vestaboard_board.py`.
   - Provide a rough rectangle around only the board area in screenshot pixels; this can be loose and should not depend on Safari window position.
   - The script finds the exact board border from the rough region using board-pixel projections around the rendered message content.
   - The script validates the expected grid shape before writing output.
   - Use `--rows 3 --cols 15` for Note and `--rows 6 --cols 22` for Flagship.
   - For Note README assets, use no frame padding and expect `1720x605`.
   - For Flagship README assets, use `--pad-x 23 --pad-y 22 --expect-width 1766 --expect-height 962`; this retains the thick physical frame and bottom Vestaboard mark.
7. Verify output dimensions and visually inspect the crop before replacing docs assets.

## README Crop Commands

Use the captured Safari duplicate/compose-view PNG as `CAPTURE`.

Send Note:

```sh
VESTABOARD_TOKEN="$API_KEY" \
  node .agents/skills/vestaboard-safari-screenshots/scripts/send_codex_quota_state.mjs \
  --board note --state pacing-on
```

Preview without sending by appending `--dry-run`.

Send Flagship:

```sh
VESTABOARD_TOKEN="$API_KEY" \
  node .agents/skills/vestaboard-safari-screenshots/scripts/send_codex_quota_state.mjs \
  --board flagship --state standard
```

Preview without sending by appending `--dry-run`.

Note:

```sh
temp_nocommit/vestaboard-safari-screenshots-venv/bin/python \
  .agents/skills/vestaboard-safari-screenshots/scripts/crop_vestaboard_board.py \
  "$CAPTURE" docs/images/codex-pacing-on.png \
  --rough X0,Y0,X1,Y1 --rows 3 --cols 15 \
  --expect-width 1720 --expect-height 605
```

Flagship:

```sh
temp_nocommit/vestaboard-safari-screenshots-venv/bin/python \
  .agents/skills/vestaboard-safari-screenshots/scripts/crop_vestaboard_board.py \
  "$CAPTURE" docs/images/codex-flagship.png \
  --rough X0,Y0,X1,Y1 --rows 6 --cols 22 \
  --pad-x 23 --pad-y 22 --expect-width 1766 --expect-height 962
```

For `--rough`, use screenshot pixel coordinates around the board/frame area only. It is intentionally capture-specific and should be loose enough to contain the whole board, but not the compose controls.

## Pixel Precision

Do not hard-code Safari window position, screen size, or previously observed crop coordinates into documentation updates. Only the rough rectangle is allowed to vary per capture; exact crop bounds must be found from the board border/content in that capture.

The crop is acceptable only when:

- the script reports an exact crop rectangle and output size,
- the detected rectangle contains the expected row/column grid,
- no browser chrome, compose controls, or page background remains,
- no board edge, tile shadow, or rendered character is clipped.
- for Flagship, the thick physical frame is retained; a tile-grid-only crop is not acceptable.

## Safari Notes

Safari screenshots on Retina displays are usually 2x the point coordinate space. Use the pixel dimensions reported by `sips -g pixelWidth -g pixelHeight <capture.png>` when choosing rough crop coordinates.

If the rough rectangle contains too much non-board UI, tighten it around the board and rerun the script. Do not manually crop final assets by eye.
