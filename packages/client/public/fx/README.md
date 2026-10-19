# Weapon / particle FX assets

The original *Future Cop: L.A.P.D.*'s own effect art, imported from
`amigo-labs/fcop-reverse-engineering` by `bun run gen:fx`
(`tools/generators/fcopEffects.ts`; `--check` compares without writing).

| File | Role |
| --- | --- |
| `particles.png` | the `Cpyr` atlas page 0 (`extracted/particles/particles_page0.png`, unchanged): all eight particles, 256×256 RGBA, **each sprite drawn through its own `PYPL` palette** at the level the drawer binds (0x20). Alpha 0 is palette word 0, the colour key |
| `particles.json` | the RE's `extracted/particles/particles.json`, unchanged: per particle its rect, cell size and 256-word A1R5G5B5 palette, the 64-level rule, and the drawer's blend modes |
| `trails.png` | 128×384: one 64-texel row per arena (`FX_TRAIL_ATLAS`), its own `tex10`'s trail rect (row 0 of the exe's table at `0x0048c568`, 19×64 at (144, 84)) at x 0, the Mini Gun ribbon's three frames (`0x0048c540`, (215..254, 22..52)) at x 20, and the bolts' texels (u 162..225, v 54..83, the faces of Cobj 12, 14 and 53; `FX_BOLTS`) at x 64 |

## What the previous atlas got wrong

The atlas this replaces was rendered through palette 0 for every sprite, at a
wrong offset and bit layout, with palette index 0 left opaque (a `gen:fxkey`
pass keyed it out afterwards). Its colours were therefore not the original's,
and the roles `render/fx.ts` read off them were wrong too: ids 8, 11 and 1 are
orange fire, 5, 3 and 10 grey smoke, 6 and 7 cyan rings — not "5 the burnt-out
fireball, 6 the red muzzle flash". Nothing picks a role any more: each effect
record names its particle by id (type 93's `+0x34`, a trail node's id 10).

`bun run gen:fxsheet` writes `docs/renders/fx/particles-contact.png`, every id at
2× on a checkerboard. Loaded by `packages/client/src/render/fx.ts`; see
`CREDITS.md` and `docs/specs/fcop-fidelity.md` "Weapon effects".
