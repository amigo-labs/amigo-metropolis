# Weapon / particle FX assets

Original *Future Cop: L.A.P.D.* `Cpyr` particle atlas, extracted by
`amigo-labs/fcop-reverse-engineering` (`tools/gfx/extract_media.py`).

| File | Role |
| --- | --- |
| `particles.png` | 256×512 8-bit atlas, rendered with palette 0 |
| `particles.json` | UV rects per particle id (`PYDT` table) |

Loaded by `packages/client/src/render/fx.ts`. Geometry-only fallbacks
(tracers, shockwave rings) stay procedural — the original never stored those
as sprites. See `CREDITS.md`.
