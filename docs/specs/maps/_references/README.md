# Map analysis references

This directory holds **abstracted** map analyses produced by `tools/mapalyze`
(one subdirectory per `--label`, each with `map-analysis.json` + `map-analysis.md`).

What lives here is **only** normalized, quantized topology — relative lane
ratios, chokepoint/role counts, symmetry class. It is deliberately incapable of
reconstructing any original map's geometry or art (see `PLAN.md` §2 and
`tools/mapalyze/README.md`).

What must **never** live here: raw FCMissionReader exports, geometry (`TIL`/`OBJ`),
textures (`BMP`/`PYR`), or glTF. Those stay in the git-ignored
`tools/mapalyze/_local/`. (FCOP-derived map data committed elsewhere under the
permissive asset policy — `docs/specs/assets.md` §2 — is a separate track; this
directory holds only mapalyze's abstracted analyses.)

These references inform **new, from-scratch** map specs. Topology-as-principle
and balancing carry over; exact reconstruction of any specific original map does
not.
