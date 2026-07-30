# Verification pins (fly mode ↔ agent)

Live visual co-debug: fly to a spot, press **P**, type what is wrong, save a
pin. The agent reads the same pin via `/verify-pin`.

## Workflow

1. Terminal A: `bun run dev`
2. Terminal B: `bun run pin:serve` (writes pins here; optional — without it the
   browser downloads the three files)
3. Menu → **Fly** (or `?play=1&cam=fly&map=<id>`)
4. Aim the center crosshair → **P**
5. Modal: **Was ist das Problem?** → Enter
6. Chat: `/verify-pin` (or “schau den letzten Pin an”)

### Hotkeys

| Key | Action |
|-----|--------|
| `P` | Capture frame + open problem modal |
| Enter (in modal) | Save pin |
| Esc (in modal) | Cancel |

## Layout

```
docs/verification/pins/
  README.md          # this file
  latest/            # always the most recent pin (gitignored)
    pin.json
    view.png
    prompt.txt
  <id>/              # one folder per pin (gitignored by default)
    pin.json
    view.png
    prompt.txt
```

Commit a pin only when you want it as a durable bug report; day-to-day pins
stay local under `latest/` and timestamped folders.

## pin.json (version 1)

| Field | Meaning |
|-------|---------|
| `mapId` | Arena id |
| `camera` | Fly cam position + yaw/pitch |
| `hit` | Heightfield ray hit: world x/y/z, grid col/row, source |
| `nearby` | Closest map features (turrets, bases, lanes, …) |
| `notes` | **Your problem text from the modal** (agent prompt) |
| `render` / `seed` / `tick` / `url` | Session context |

`notes` is the primary instruction for the agent. If empty, the agent should
ask what the problem is.

## Privacy

The pin server binds to `127.0.0.1` only. Nothing is uploaded remotely.
