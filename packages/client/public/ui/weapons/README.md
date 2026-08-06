# Weapon art (Future Cop front-end)

Original Precinct Assault weapon **icons** (45×42) and **panels** (134×39/40)
from `febmp.bin`, extracted by `extract_frontend.py` in
`amigo-labs/fcop-reverse-engineering`.

| Path | Use |
|------|-----|
| `icons/<slug>.png` | Loadout strip portrait in the title menu |
| `panels/<slug>.png` | Full original card (name + rate/damage bars) — reference / future UI |

Slugs are the catalog display name lowercased with non-alphanumerics → `-`
(e.g. `Powered Mini-Gun` → `powered-mini-gun`). Only the **ten** weapons in
the live catalog ship here (`rules.md` §2 / SIM_VERSION 26).

Provenance: `CREDITS.md`. Source panels also live under
`docs/renders/fcop-ui/weapons/` for offline reference.
