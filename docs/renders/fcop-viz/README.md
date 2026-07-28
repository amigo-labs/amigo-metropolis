# FCOP logic visualization — MP arenas

Overlays the **original Future Cop: L.A.P.D. Precinct Assault logic** (reverse-
engineered `Cact`/`Csac` actors + `Cnet` lane graphs, see
[`docs/specs/fcop-logic.md`](../../specs/fcop-logic.md)) on top of the committed
textured terrain `.glb` for each of the six MP arenas, correctly aligned.

Purpose: verify the extracted logic against the original art, and document the
authentic PA layout (bases, lanes, capturable turrets, base-defence turrets,
power-ups, intrusion-detection trigger zones) per arena.

## Views (per arena)

- `<map>-top.png` — orthographic top-down; clearest alignment proof, whole layout.
- `<map>-iso.png` — isometric beauty shot, overlays on the textured terrain.
- `<map>-neutcheck.png` — top-down with only the capturable turrets (type 36),
  proving they land on the octagon turret pads baked into the terrain art.

Overlay legend: cyan/orange tubes = the two team lane graphs (`Cnet`); a 3rd white
tube on Hk = its extra net. Blue/red cubes = team bases (`TeamBase?` 28) on their
tinted base structures. Green cones = X1Alpha player spawns (type 1). White
cylinders = capturable NeutralTurrets (36). Blue/red cylinders = base-defence
Turrets (8). Magenta spheres = ItemPickups (16). Translucent boxes = Trigger (95)
volumes coloured by kind (red = enemy-intrusion proximity strip, yellow = watch,
cyan = action button). Trigger footprints are true; their height is exaggerated
for legibility.

## Arena ↔ FCOP mission mapping

| FCOP mission | map id | note |
|---|---|---|
| Conft | urban-jungle | concentric fortress |
| Slim | proving-ground | dense city streets |
| Mp | la-cantina | walled central compound |
| Joke | bug-hunt | shares Slim's lane layout, different art |
| Hk | hollywood-keys | layered; bases left/right |
| Ovmp | venice-beach | layered; central spine |

## Alignment method (important)

Raw actor `(posX/8192, posZ/8192)` and `Cnet (x/32, z/32)` live in the 0-based grid
frame; the terrain `.glb` (built by `til_mesh.py` in the RE repo) is a **centered**
copy of the same grid. The nominal centering formula `off = 8*gw + 8.5` from the
handoff is **unreliable on the padded/short axis** (for Mp it was one Til = 16 cells
too large — data fell into the edge-repeat apron).

Robust fix used here (parameter-free, per map): **align the logic bounding-box centre
to the glb bounding-box centre.** Both the art and the logic are symmetric about the
arena centre, so their bbox centres coincide.

```
bx = col - logic_cx + glb_cx
by = FLIP_Y * (row - logic_cy) + glb_cy      # FLIP_Y = -1 (glTF Z -> Blender -Y)
bz = raycast onto terrain
```

`glb_cx, glb_cy` are measured in Blender after import; `logic_cx, logic_cy` from the
data. `FLIP_Y = -1` (the glTF→Blender import flip) is uniform across all six maps
(confirmed on the non-symmetric arenas, where a wrong flip would be visible).

### Runtime mesh load (must match this)

`packages/client/src/render/meshMap.ts` uses the **same** rule in three.js space
(`sim y` = three `z`, no Blender flip):

```
position.x = logicCentre.x - glbBBoxCentre.x
position.z = logicCentre.z - glbBBoxCentre.z
position.y = 0   // authored mesh Y = heightfield frame
```

`logicCentre` = axis-aligned bbox centre of map features (spawns, bases, turrets,
lanes, …) — equivalent to the prep_viz logic bbox centre. **Never** centre on
`worldExtent/2` (padded grid centre).

### Source-of-truth hierarchy (do not invert)

| Priority | Artifact | Role |
|----------|----------|------|
| 1 | `<map>-top.png` + `viz_data_<map>.json` | **Layout truth** — where things sit on the art |
| 2 | `packages/sim/maps/<map>.json` | **Gameplay truth** — what the lockstep sim runs |
| 3 | `public/models/<map>/<map>.glb` | **Art only** — terrain/props; align to (1)/(2) |

- If JSON features and the top-down disagree → **fix the JSON** (import from
  FCOP/`prep_viz`), do not invent wall-safe detours that leave the road channel.
- **Do not bake** spawns / lanes / turret spots into the terrain GLB as the sim
  authority. Empties for artists optional; dual sources desync. Pad silhouettes
  in the mesh are decoration; live entities come from JSON + unit GLBs.

## Reproduce

1. `python prep_viz.py <Mission> <map-id>` (needs the RE repo extraction at
   `fcop-reverse-engineering/extracted/logic/<Mission>/`) → `viz_data_<map-id>.json`.
2. In Blender (with the MCP add-on), set globals `MAP_ID / GLB_PATH / DATA_PATH /
   OUT_DIR / FLIP_Y=-1` and `exec(open("build_map.py").read())`.

Layered arenas (Hk, Ovmp): the height raycast hits the topmost deck, so lower-deck
markers sit on the deck above them — XY alignment is unaffected, only Z is
approximate.
