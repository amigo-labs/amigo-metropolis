# Map analysis references

This directory holds **abstracted** map analyses produced by `tools/mapalyze`
(one subdirectory per `--label`, each with `map-analysis.json` + `map-analysis.md`).

What lives here is **only** normalized, quantized topology — relative lane
ratios, chokepoint/role counts, symmetry class. It is deliberately incapable of
reconstructing any original map's geometry or art (see `PLAN.md` §2 and
`tools/mapalyze/README.md`).

What must **never** live here (or anywhere in the repo): raw FCMissionReader
exports, geometry (`TIL`/`OBJ`), textures (`BMP`/`PYR`), or glTF. Those stay in
the git-ignored `tools/mapalyze/_local/`.

These references inform **new, from-scratch** map specs. Topology-as-principle
and balancing carry over; exact reconstruction of any specific original map does
not.
