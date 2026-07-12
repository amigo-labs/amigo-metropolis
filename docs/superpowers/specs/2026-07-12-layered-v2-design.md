# Layered v2 — begehbare Mehrdeck-Arenen (Design)

- **Datum:** 2026-07-12
- **Branch:** `feat/fcop-arenas`
- **Status:** Design freigegeben (Brainstorming abgeschlossen) → bereit für Implementierungsplan
- **Quelle des Stufenplans:** `C:\Users\rueck\.claude\plans\schau-dir-die-heightmaps-proud-gizmo.md` (Stufe 5)

## 1. Kontext & Ziel

Die Sim ist heute **einwertig**: `sampleHeight(map, x, y)` liefert genau *eine* Höhe pro (x,y)
(bilinear, `map.ts:95`). Die vier v1-FCOP-Arenen sind damit spielbar. Zwei Precinct-Assault-Arenen —
**Hollywood Keys (`Hk`)** und **Venice Beach (`Ovmp`)** — sind laut Stufe-0-Zensus fundamental
mehrstöckig und ohne begehbare Überhänge nicht originalgetreu.

**Ziel:** Mehrere begehbare Laufflächen (Decks) über derselben (x,y) im **deterministischen** Sim,
sodass Avatar und Bodeneinheiten auf allen Decks laufen, über Rampen die Ebene wechseln und von
Kanten fallen.

### Verifizierte Fakten (diese Session)

- **Stapeltiefe-Zensus** (gap-geclustert über `cell_floor_levels`, strenger als das ausgelieferte
  `multi_level_points`-Flag): max. **3** begehbare Ebenen.

  | Arena | Zellen mit Boden | max. Tiefe | 1 Ebene | 2 Ebenen | 3 Ebenen |
  |---|---|---|---|---|---|
  | Hk | 65.203 | 3 | 16.185 | 48.735 | 283 (0,4 %) |
  | Ovmp | 72.189 | 3 | 32.781 | 39.200 | 208 (0,3 %) |
  | Conft | 49.596 | 3 | 49.238 | 352 | 6 |

  → Das Modell muss **N Ebenen** unterstützen (nicht fest 2). Die Dreier-Decks sind kohärente
  Strukturen (~2 m Abstand), kein Cluster-Artefakt.

- **Der Extractor kennt die Ebenen bereits**, wirft sie aber weg: `til_mesh.assemble_map`
  sammelt pro Zelle alle near-horizontalen Flächen (`cell_floor_levels`, `|face.ny| ≥ FLOOR_NY=0.5`),
  behält aber nur das Minimum (`floor_min` → `walk_height`). Die obere(n) Fläche(n) sind aus
  vorhandener Logik ableitbar — kein neues Reverse-Engineering.

- **Sim-Impact-Set** (aus Code-Exploration): Höhen-Auflösung ist auf drei Stellen zentralisiert —
  `rideHeight` (`sim.ts:835`, Avatar), `snapUnitHeight` (`units.ts:284`, alle Units), Warden-Cruise
  (`warden.ts:353`). Entity-Storage ist SoA über einem `ArrayBuffer` (`entities.ts`); es gibt
  **kein** `layer`-Feld. Snapshot ist Stride 10 mit `height` an Offset +5 (`sim.ts:1408`).

## 2. Scope

**v1 = mehrdeckige _Fortbewegung_.** Avatar + Bodeneinheiten laufen auf allen Decks, wechseln über
Rampen die Ebene, fallen von Kanten. Hover/Flieger ignorieren Layer (fliegen über alles, wie heute).

**Nicht in v1 (bewusst zurückgestellt):** **Kampf und Line-of-Sight bleiben 2D / layer-agnostisch.**
Zielerfassung nutzt 2D-Reichweite + bestehende 2D-`segmentBlocked`; Wände wirken auf allen Ebenen
gleich. Vertikale LOS, layer-bewusstes Targeting und Per-Layer-Wände sind ein separater,
determinismus-kritischer Nachfolger. Begründung: „begehbare Überhänge" ist primär Traversierung;
layered Combat würde den heißen Ziel-/Schuss-Pfad erneut aufreißen und den Umfang verdoppeln.

## 3. Dekomposition (drei eigenständig lieferbare Sub-Projekte)

| # | Sub-Projekt | Ort | Abhängig von |
|---|---|---|---|
| **1** | **Determin. N-Layer-Sim-Kern** — Datenmodell, Layer-Zustand, `resolveHeight`, Übergänge, Separation-pro-Ebene, Determinismus/Goldens, validiert gegen **hand-authorierte synthetische 3-Deck-Testmap** | dieses Repo | — |
| **2** | **Tier-1 Multi-Deck-Rendering** — Deck-Meshes aus denselben Layer-Arrays, render-only | dieses Repo (Client) | 1 |
| **3** | **FCOP-Pipeline** — Extractor emittiert N Flächen + Masken (privat, Repo-extern) → Konverter → echte Hk/Ovmp-Arenen | privat + Konverter | 1, Extractor |

Sub-Projekt **1** ist der Engineering-Kern und komplett **ohne** die privaten Daten baubar/golden-
testbar. Sub-Projekt **3** hängt am privaten Extractor-Ausbau (nicht committbar); diese Spec definiert
dessen exakten Ausgabe-Kontrakt (§8), sodass die Python-Arbeit danach geradeaus ist.

## 4. Sim-Datenmodell (`MapData` / JSON)

Layer 0 bleibt exakt das heutige `heights` (immer präsent). Zusätzliche Ebenen additiv:

```ts
// MapData — neu; leere Arrays (length 0) bei einstöckigen Maps → resolveHeight early-out
readonly layerHeights: readonly Float32Array[];  // [layer1, layer2, …], je size×size
readonly layerMask:    readonly Uint8Array[];    // [layer1, layer2, …], 1 = Deck an dieser Zelle präsent
```

JSON (`MapJson`): optionales
```ts
layers?: { heights: number[][]; mask: string[] }[]   // int 1/32 m + '0'/'1'-Zeilen, wie heights/water
```
Fehlt → einstöckig (`layerHeights`/`layerMask` = `[]`). Obere Höhen sind **kantenfortgesetzt**
definiert, wo `mask` gesetzt ist, damit die bilineare Abtastung innerhalb präsenter Zellen
wohldefiniert bleibt (dieselbe `sampleHeight`-Mechanik, keine neue Numerik).

Loader (`loadMapFromJson`, `map.ts:215`): `layers` validieren wie `heights`/`water` (Zeilen/Spalten-
Längen, integer, '0'/'1'), sonst leere Arrays. Beide Pro-Layer-Felder müssen paarweise vorhanden sein.

## 5. Entity-Layer-Zustand — der Determinismus-Trick (No-op-Invariante)

Ein per-Entity `layer`-Byte darf **nicht** in die feste SoA-Byte-Region (`entities.ts`) — das würde die
Hash-Bytes *jeder* Map ändern und die byte-identischen Goldens 01–04 brechen. Stattdessen:

- `layer` lebt in einem **Seiten-Array** `SimState.entLayer: Uint8Array(MAX_ENTITIES)`, immer allokiert.
- `hash()` (`sim.ts:1360`) läuft die feste Byte-Region **unverändert** durch und hasht `entLayer`
  **nur, wenn** `map.layerHeights.length > 0`.
- Einstöckige Maps: `entLayer` bleibt komplett 0, wird nie gelesen/geschrieben/gehasht →
  **byte-identisch zu vor v10**. Die No-op-Invariante gilt exakt wie bei den Wänden.
- `spawn`/`despawn` (`entities.ts:115/135`): `entLayer[id]` beim Spawn auf 0 setzen, beim Despawn
  nullen (Hash-Kanonizität — freed slot == never-used slot).

## 6. `resolveHeight(map, x, y, layer)` — die eine neue Höhen-Auflösung

Ersetzt den rohen `sampleHeight` an den drei Auflösungsstellen (`rideHeight`, `snapUnitHeight`, Warden):

```
resolveHeight(map, x, y, layer):
  if layer === 0 || map.layerHeights.length === 0:
    return sampleHeight(map, x, y)                 // No-op-Pfad, bit-identisch zu heute
  return sampleLayerHeight(map, layer - 1, x, y)   // bilinear auf oberer Ebene (kantenfortgesetzt)
```

`sampleLayerHeight` ist die `sampleHeight`-Logik auf `layerHeights[layer-1]`. Guard-konform (nur
`+ - * /`, `floor`, `min`, `max`).

## 7. Layer-Übergang pro Tick (deterministisch, kein Rampen-Datum)

Nach dem (x,y)-Step, für Walker/Bodeneinheiten (Hover/Flieger überspringen: ignorieren Layer):

```
cell = (floor(x/cellSize), floor(y/cellSize))
h    = ent.height[id]                      // Höhe aus letztem Tick
best = 0; bestH = sampleHeight(map, x, y)  // Layer 0 immer Kandidat
for L in 1 .. K-1 where layerMask[L] gesetzt an cell:
    hs = resolveHeight(map, x, y, L)
    if hs <= h + STEP_SNAP and hs > bestH:  // höchste erreichbare Fläche (Aufstieg nur ≤ Stufe)
        best = L; bestH = hs
entLayer[id] = best
// vertikale Auflösung wie heute: Walker snap → bestH, bzw. Gravity via timerB, wenn h ≫ bestH
```

Nur `floor` + `<=`/`>`-Vergleiche + bestehendes Sampling → guard-konform.

- **Rampe hinauf:** obere Fläche kommt in `h + STEP_SNAP`-Reichweite (Rampenkopf) → Wechsel nach oben.
- **Kante hinunter:** oberes Deck an der Nachbarzelle nicht präsent → nur Layer 0 (weit unten) Kandidat
  → `h ≫ bestH` → airborne → Gravity-Fall (bestehende Walker-Vertikallogik `sim.ts:559-577`).
- **Unter hohem Dach:** oberes Deck präsent, aber `hs > h + STEP_SNAP` → nicht erreichbar → bleibt
  Layer 0. (Man steht unter dem Dach, nicht darauf.)

`STEP_SNAP = 0.35` (bereits definiert, `sim.ts:448`) ist die max. Aufstiegs-Stufe. Der bestehende
Slope-Check (`AVATAR_WALKER_MAX_SLOPE 0.6`) gilt weiter auf der gewählten Ebene und regelt steile
Rampen.

## 8. Separation nur innerhalb derselben Ebene

`separateGroundUnits` (`units.ts:300`) trennt heute alle befreundeten Bodeneinheiten paarweise radial.
**Neu:** ein Paar nur separieren, wenn `entLayer[a] === entLayer[b]` — sonst schieben sich Einheiten
auf Boden und Dach über verschiedene Ebenen hinweg gegenseitig weg. Einziger echter Verhaltens-Zusatz
in der Separation. Nach dem Push erneut `snapUnitHeight` für beide (wie heute).

## 9. Determinismus & Versionierung

- **`SIM_VERSION` 9 → 10** (`version.ts:42`). Layered Maps sind eine neue Sim-Fähigkeit; Cross-Version-
  Peers auf einer layered Map divergierten → DO-Gate (`room.ts:109`, `lobby.ts:293`) lehnt ab. Bump +
  Golden-Regen im selben Commit (etablierter Prozess, `HANDOFF.md:38`).
- **No-op-Beweis bleibt:** Goldens 01–04 (einstöckig) → Hash-Arrays **byte-identisch**, nur
  `simVersion`-Header neu. Regressionstest wie bei Stufe 2 (elementweiser Vergleich gegen `git show HEAD:`).
- **Snapshot bleibt Stride 10** in v1 — die Entity-Höhe (Offset +5) trägt die Vertikale; der Renderer
  platziert Entities korrekt auf jedem Deck ohne Layout-Änderung. Konvergenz-Übergänge sind stetig
  (Höhen innerhalb `STEP_SNAP`), Fälle sind Gravity — keine Interpolations-Glitches. Ein `layer`-Kanal
  kommt erst, wenn der Renderer deck-bewusste Occlusion macht (Nachfolger).
- `determinismGuard.test.ts` muss grün bleiben (nur erlaubte Ops; `entLayer`-Seitenarray + bedingtes
  Hashen nutzen nur Integer-Compares/Array-Reads).

## 10. Extractor-Ausgabe-Kontrakt (Vertrag für den privaten Tool-Ausbau, Sub-Projekt 3)

`til_mesh.assemble_map` erweitern: pro Weltpunkt die distinkten near-horizontalen Flächenhöhen
**nach Höhe rangsortieren → Layer-Index = Rang** (Layer 0 = niedrigste, immer präsent; Layer L =
L-t-niedrigste Fläche, wo vorhanden). Emittieren nach `<Map>_terrain.json`:

```
layers[L] = {
  heights: int8[H][W]   // kantenfortgesetzt (Rang-L-Fläche; = walk_height für L=0)
  mask:    '0'/'1'[H][W] // 1 wo der Punkt ≥ L+1 Flächen hat
}
K = max_rang + 1        // 3 für Hk/Ovmp, 1 für einstöckige Arenen
```

`layers[0].heights` == heutiges `walk_height` (unverändert → v1-Arenen bit-identisch). Wände wie gehabt.

**Haupt-Implementierungsrisiko (privat):** Rang-Konsistenz einer Rampe, deren Fläche über Zellen den
Rang wechselt. Abgefedert dadurch, dass die Sim-Übergangsregel (§7) tolerant ist — sie sucht die
höchste *erreichbare* Fläche, keinen exakten Rang-Match. Ein Rang-Sprung an einer Rampe führt
schlimmstenfalls zu einem Tick verzögertem Wechsel, nicht zu einem Determinismus- oder Durchlauf-Bruch.

## 11. Konverter (`tools/fcop/convert.ts`)

- `TerrainJson` um optionales `layers` erweitern → 1:1 in das Map-JSON `layers` durchreichen.
- Feature-Authoring (`ArenaSpec`): optionales `layer` pro Feature (spawns/bases/lanes/spots), Default 0
  — z. B. eine Basis oder Lane auf dem Dach.
- Sanity-Checks erweitern: Feature liegt auf der Fläche seiner deklarierten Ebene (`resolveHeight` mit
  dem Feature-Layer); Lanes über Layer-Übergänge begehbar (Übergangsregel + Slope-Check).

## 12. Tier-1 Multi-Deck-Rendering (`packages/client/src/render/`, render-only)

Pro Zusatz-Ebene ein Deck-Mesh aus `layerHeights[L]`/`layerMask[L]` (nur präsente Zellen),
vertex-colored, `flatShading`, `matrixAutoUpdate=false` — dasselbe Muster wie `terrain.ts` und das
Wand-Mesh (`buildWallMesh`). **Aus denselben Arrays wie die Kollision** → Single Source of Truth, kann
nie driften. `?render=greybox` bleibt erhalten. Kein Determinismus-/Snapshot-Impact.

## 13. Testplan (Sub-Projekt 1)

- **`layered-test.json`** — hand-authorierte kleine Map (z. B. 32×32) mit Boden + Zwischendeck + Dach +
  einer Rampe, integer-Höhen, committet in `packages/sim/maps/`. Kein FCOP-Input nötig.
- **Unit-Tests** (`packages/sim/test/`): `resolveHeight` (Layer 0 vs. oben, No-op-Pfad),
  Übergangsregel (Rampe rauf, Kanten-Fall, kein Wechsel unter hohem Dach), Separation pro Ebene.
- **`golden-06-layered`** (`tools/replay/src/scripts.ts` + `packages/sim/test/goldens/`): Avatar läuft
  Rampe → Dach → quert → fällt von der Kante; Einheiten separieren deck-weise. Pin-Test wie
  `district01.test.ts` (Hash von `heights.buffer` + Layer-Buffern + Playability-Asserts).
- **Regression:** Goldens 01–04 Hash-Arrays byte-identisch (No-op-Beweis). `determinismGuard` grün.

## 14. Kritische Dateien (Impact-Set)

- `packages/sim/src/map.ts` — layered `MapData`/`MapJson` + Loader + `sampleLayerHeight`/`resolveHeight`.
- `packages/sim/src/entities.ts` — `entLayer`-Seitenarray-Anbindung, `spawn`/`despawn`-Nullen.
- `packages/sim/src/sim.ts` — `SimState.entLayer`, `hash()` bedingtes Hashen, `rideHeight`, alle
  Spawn-Höhensetzer (`:226,252,268,285,308`), Layer-Übergang in `systemAvatarMovement`.
- `packages/sim/src/units.ts` — `snapUnitHeight` (Layer), `stepAndSnap`, `separateGroundUnits` (pro Ebene).
- `packages/sim/src/warden.ts` — Cruise-Höhe (`:353`).
- `packages/sim/src/version.ts` — `SIM_VERSION` 10.
- `tools/fcop/convert.ts` — `layers` + Feature-`layer` + Sanity.
- `packages/client/src/render/` — Deck-Meshes.
- Tests: `layered-test.json`, neue Unit-Tests, `golden-06-layered`, Regressionscheck 01–04,
  `determinismGuard.test.ts`.

## 15. Offene Punkte / Risiken

- **Bilineare Abtastung an Layer-Kanten:** oberes Deck muss kantenfortgesetzte Höhen an allen 4 Ecken
  präsenter Zellen haben (Extractor-Kontrakt §10) — sonst ist das Sample an der Maskenkante undefiniert.
- **Rampen-Rang-Konsistenz** (Extractor, §10) — durch tolerante Übergangsregel abgefedert, aber im
  privaten Ausbau zu verifizieren.
- **Feature-Erreichbarkeit über Ebenen** — Konverter-Sanity muss Lanes prüfen, die Ebenen wechseln.
- **Combat/LOS 2D in v1** (§2) — dokumentierte Vereinfachung; Roof- und Ground-Einheiten können sich
  bei freier 2D-LOS gegenseitig treffen. Bewusst zurückgestellt.

## 16. Nicht-Ziele (v1)

- Vertikale LOS / layer-bewusstes Targeting / Per-Layer-Wände.
- Snapshot-`layer`-Kanal / deck-bewusste Renderer-Occlusion.
- Mehr als die vom Zensus belegten 3 Ebenen (Modell generalisiert, aber Testmap/Arenen decken ≤3 ab).
