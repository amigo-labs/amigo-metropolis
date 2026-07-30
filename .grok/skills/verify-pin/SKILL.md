---
name: verify-pin
description: >
  Read the latest fly-mode verification pin (screenshot + pin.json notes) and
  diagnose/fix the reported visual or placement problem. Use when the user
  runs /verify-pin, mentions "latest pin", "verification pin", fly-mode pin,
  or asks you to look at a pin they just captured.
---

# /verify-pin — Live verification pin

The user captures pins in fly mode (`P` → problem modal → Enter). Pins land in:

```
docs/verification/pins/latest/pin.json
docs/verification/pins/latest/view.png
docs/verification/pins/latest/prompt.txt
```

If those paths are missing, ask whether they ran `bun run pin:serve`, or accept
attached/downloaded `*-pin.json` + `*-view.png` files.

## Steps

1. **Load the pin**
   - Read `docs/verification/pins/latest/pin.json`
   - Read `docs/verification/pins/latest/view.png` with the image reader (you must look at the pixels)
   - Optionally read `prompt.txt`

2. **Treat `notes` as the user request**
   - Non-empty `notes` = the problem statement. Do **not** ask “Was ist das Problem?” again.
   - Empty `notes` = ask once what is wrong, then proceed.

3. **Orient from structured fields**
   - `mapId`, `hit.col` / `hit.row`, world `hit.x`/`hit.z`, `camera`, `nearby`
   - Cross-check placement against:
     - `packages/sim/maps/<mapId>.json` (gameplay truth)
     - `docs/renders/fcop-viz/<mapId>/` top/iso when FCOP-derived
     - CLAUDE.md FCOP mesh-alignment rules (`meshMap.ts`, logic centre not grid centre)

4. **Report briefly**
   - What you see in the screenshot
   - How it relates to `notes` and the grid/nearby features
   - Likely layer: sim JSON vs mesh offset vs renderer/debug overlay

5. **Act**
   - Propose a concrete fix (file + change), or implement if the user wants a fix
   - After a fix, suggest re-pin (`still wrong` / `looks good`) or `bun run verify:arenas` for that map

## Rules

- Pins are **debug-only**. Never put pin logic in the sim tick path.
- Do not invent FCOP layout — viz/extract wins over hand-tuned lanes.
- Prefer one high-confidence diagnosis over a long checklist dump.
