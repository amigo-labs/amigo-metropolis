# fcop-fx.md — Original projectile & weapon-effect assets

Status: v1

What the original *Future Cop: L.A.P.D.* draws when something shoots, where those
assets live, and — for each one — whether the role is **extracted** or **derived**.
Companion to `assets.md` (pipeline, scale) and `fcop-logic.md` (actor data).

Everything below is reproducible from the RE repo
(`amigo-labs/fcop-reverse-engineering`, `extracted/`) plus the raws committed
under `tools/generators/units/raw/fcop-fx/`.

## 1. The effects are meshes, not sprites

The reflex is to look for the effects in `Cpyr`, the particle atlas. That is
wrong, and the mistake is worth recording because it cost a round of guessing:

- **`Cpyr` is complete and static.** 8 particles, each with exactly **one**
  sprite (`extracted/particles/particles.json`). There are no frame sequences to
  find — the committed `particles.png` is the whole set. It covers fireballs,
  puffs and sparks, and `render/fx.ts` already uses it correctly.
- **`SLFX` / `ScTA` is animated *terrain* texture** — water, neon strips,
  scrolling grilles (`extracted/findings/slfx_crops.md`). Not weapon FX.
- **`canm` animated textures do not exist for the PA arenas at all**:
  `extracted/anims/` holds Lax1, Lax2, M1a1, M2c, M3a, M3b, M4a1, Ov, Un — no
  Mp, Ovmp, Conft, Hk, Joke or Slim.

What the original actually fires are **`Cobj` meshes**, and its beams and glows
are `3DQL` *facer* primitives — `Star` (48-tri glow sized by the `3DRL` radius),
`Billboard` (12-tri cross) and `Line` (8-tri beam), which `extract_objects.py`
exports in an emissive `facer` material (`docs/objects.md`).

## 2. Two template tables: actor types 98 and 99

Every PA arena carries two actor types that the registry in `fcop-logic.md` §3
lists as unknown. They are not world placements: they sit in two tidy columns
beside the map (Mp: x ≈ 55.3–55.8 and x ≈ 51.1–51.6, z stepping ~1.9 per row),
carry no behaviour fields, and each row points at a `Cobj` through `refs`.

They are **template banks**, and their row order is the index:

| type | rows | `rec_size` | what |
|---|---|---|---|
| 99 | **15** | 68 | player weapon slots — one row per weapon |
| 98 | **9** | 32 | world/AI shooter weapons — indexed by `BaseShooter.weapon_id` |

Each row references its `Cobj` in **slot 0 and slot 3**. Those are the two team
variants: for Mortar, Grenade, Robo Dog and Helfire both slots name the *same*
id; for the Hyper Velocity Rocket (44/45) and Mine (50/51) they name two ids whose raw payload
SHA is identical; only the glow pair (46/47) differs in payload — the same
geometry in two colours. Metropolis has one mesh per role and tints per team
(`greybox.ts` `tintFor`), so slot 3 is recorded here and otherwise unused.

## 3. Player weapon table (actor type 99) — **extracted**

15 rows against the 15-weapon EXE name table from
`extracted/findings/weapon_bind.md`, sorted by z. Cobj ids are Mp's; they shift
per container, the structure does not.

| # | weapon (EXE name) | Cobj | mesh |
|---:|---|---:|---|
| 1 | Mini Gun | — | |
| 2 | Laser | — | |
| 3 | Flame Thrower | — | |
| 4 | Electric Gun | — | |
| 5 | Riot Shield | — | |
| 6 | **Helfire** | 43 | rocket, 0.39 m, body + tail glow |
| 7 | Beam Cannon | — | |
| 8 | **Ant Missle?** | 44 / 45 | rocket, 0.23 m — same family, smaller |
| 9 | **Fusion Torpedo** | 46 / 47 | pure 48-tri glow star, 0.15 m |
| 10 | **Robo Dog** | 48 | **11-frame morph**, 0.72 m |
| 11 | **Mortar** | 49 | round shell, 0.35 m, body + glow |
| 12 | **Plasma Flare** | 46 / 47 | the same glow star as row 9 |
| 13 | **Mine** | 50 / 51 | 0.37 m, body + glow, `color_anim` grey→magenta |
| 14 | Shockwave | — | |
| 15 | **Grenade** | 52 | octahedron, 0.24 m, 12 tris |

The **weapon column is the EXE name table verbatim**, question mark and spelling
included — it is evidence, not a label, so it is quoted rather than tidied. This
repo's own names differ in one place: row 8 is EXE weapon `0x13`, which
`weapons.ts` has always carried as the **Hyper Velocity Rocket**, and the asset
built from Cobj 44 is named for the catalog (`fx/rocket-hyper.glb`) because that
is the name a player sees. Same slot, two names; the table keeps the original's.

**Why the row order is the weapon order, not a guess.** Four independent checks,
each of which could have failed:

1. **Length.** Exactly 15 rows for exactly 15 weapons, in all six PA arenas.
2. **The empty rows are exactly the weapons that fire nothing.** Rows 1–5, 7 and
   14 are Mini Gun, Laser, Flame Thrower, Electric Gun, Riot Shield, Beam Cannon
   and Shockwave — every hitscan gun plus the self-centred pulse. The eight
   filled rows are exactly the eight weapons that put an object in the air. A
   wrong offset would have to keep that partition intact.
3. **The meshes match their names.** Row 10 "Robo Dog" is the only multi-frame
   object in the pool. Row 13 "Mine" is the only one with a colour animation, and
   it blinks. Row 11 "Mortar" is the round shell. Row 15 "Grenade" is a
   12-triangle octahedron.
4. **Replication.** All six arenas (Mp, Ovmp, Conft, Hk, Joke, Slim) carry the
   same 15/8/7 split at the same row indices; only the Cobj ids shift with the
   container (Helfire is 43 on Mp, 44 on Conft, 46 on Hk, 48 on Joke, 49 on Slim).

This is the binding that `weapon_bind.md` could not find — that probe was
chasing `BaseShooter.weapon_id` for *damage numbers* and correctly closed it
negative. The **visual** binding was never in that id space; it is the type-99
row order.

## 4. World / AI weapon table (actor type 98) — **derived, strongly supported**

9 rows, Mp ids: `[12, 13, 14, 42, —, 53, —, 43, 49]`.

Hypothesis: **row index = `BaseShooter.weapon_id`** (1-based). Evidence:

- The PA arenas use only four ids — `1, 3, 4, 6` (`shooter.weaponId` in
  `tools/generators/fcop/*-logic.json`, all six arenas).
- Every used id lands on a **filled** row in every arena; the two empty rows
  (5, 7) are ids nobody uses. Six arenas, zero misses.
- The assignments are semantically right: id 3 (64 shooters on Mp, all turrets
  and neutral turrets) → the **twin** bolt; id 1 (ground units + aircraft) → the
  single bolt; id 4 (**aircraft only**) → the heavy rocket; id 6 → the second
  bolt variant.

Weaker than §3 — there is no length argument, and only four of nine rows are
exercised — so it is marked derived. Rows 2, 8 and 9 carry meshes (the flat
bolt, the Helfire rocket, the mortar shell) that no PA shooter uses; they are
presumably campaign weapons sharing the bank.

| row | `weapon_id` | Cobj (Mp) | used on PA by |
|---:|---:|---:|---|
| 1 | 1 | 12 — bolt, single, 1.02 m | ground units, aircraft |
| 2 | 2 | 13 — flat 2-tri blade, 0.37 m | (unused on PA) |
| 3 | 3 | 14 — bolt, twin, 1.09 m | turrets, neutral turrets |
| 4 | 4 | 42 — rocket, 0.54 m | aircraft |
| 5 | 5 | — | (no mesh) |
| 6 | 6 | 53 — bolt, single, variant | units, aircraft |
| 7 | 7 | — | (no mesh) |
| 8 | 8 | 43 — shares the Helfire rocket | (unused on PA) |
| 9 | 9 | 49 — shares the Mortar shell | (unused on PA) |

## 5. Consequences for the client

- **A bolt is an object that flies**, ~1 m long, not an instant streak over the
  weapon's whole reach. `render/fx.ts` drew a cylinder the full length of the
  shot; the original throws a 1.02 m (single) or 1.09 m (twin) facer beam.
- **Turrets and units already have distinct looks** in the original: turrets fire
  the twin bolt, ground units and aircraft the single one.
- **There is no explosion mesh.** The FX pool contains none, `Cpyr` has no
  sequence, and the PA arenas have no `canm`. The original's explosion *is* the
  static `Cpyr` fireball, scaled and faded — which is what `fx.ts` already does.
  Nothing here licenses an 11-frame explosion; Cobj 48's frames are the Robo Dog.
- **Sizes are the original's**, like the units (`assets.md` §4): every FX model
  ships at native scale, and §3/§4 above list the measured extents.

## 6. Reproducing this

```
bun run gen:fxcobj      # docs/renders/fcop-fx/fx-cobj-contact.png from the raws
bun run gen:fxsheet     # the Cpyr contact sheet, for the sprite side
```

The tables in §3/§4 come from `extracted/logic/<Map>/actors.json` in the RE repo
(`act_type` 98/99, sorted by z) crossed with `extracted/objects/<Map>/manifest.json`
and, for the AI side, `shooter.weaponId` in `tools/generators/fcop/<map>-logic.json`.
