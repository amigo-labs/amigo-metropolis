# Weapon / particle FX assets

Original *Future Cop: L.A.P.D.* `Cpyr` particle atlas, extracted by
`amigo-labs/fcop-reverse-engineering` (`tools/gfx/extract_media.py`).

| File | Role |
| --- | --- |
| `particles.png` | 256×512 atlas, palette 0, **background keyed out** |
| `particles.json` | UV rects per particle id (`PYDT` table) |

## The committed PNG is not the raw extract

`extract_media.py` renders palette index 0 — the background — as **opaque**
`#D5AC00` rather than transparent. It fills the corners of every sprite rect
and the whole unused bottom half of the sheet: 95,279 of 131,072 pixels. Since
`fx.ts` draws these on additive-blended quads, every one of those pixels added
light, so each muzzle flash and explosion laid a dark-yellow square over the
scene at the size of its quad.

`bun run gen:fxkey` zeroes alpha on that exact colour and rewrites the file; it
is idempotent, and `--check` reports without writing. The alpha-0 dither
*inside* each puff is the original's own stipple transparency and is left
alone. `packages/client/test/fxAtlas.test.ts` fails if the key ever comes back.

`bun run gen:fxsheet` writes `docs/renders/fx/particles-contact.png` — every id
at 2× on a checkerboard, plus per-id size and paint coverage. That is where the
id→role mapping in `fx.ts` comes from; it used to be a by-eye guess.

Loaded by `packages/client/src/render/fx.ts`. Geometry-only fallbacks
(tracers, shockwave rings) stay procedural — the original never stored those
as sprites. See `CREDITS.md`.
