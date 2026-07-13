# Stufe 4 — Texturiertes Karten-Rendering (Design)

Status: Entwurf
Datum: 2026-07-13
Vorgänger: [Layered v2](2026-07-12-layered-v2-design.md) (PR #14, gemergt in `main` @ `87492c5`)

## 1. Kontext & Ziel

Die Arenen werden im Client bisher nur als **Greybox** dargestellt: ein vertex-gefärbtes
Heightfield-Mesh plus graue Deck-Flächen für die mehrstöckigen Karten. Ziel von Stufe 4 ist
ein **texturiertes 3D-Rendering** der Karten — die vollen Original-Terrain-Meshes von
*Future Cop: L.A.P.D.* mit ihren echten Oberflächen-Texturen, inklusive der Überhänge/Decks
als echtes Mesh (statt grauer Flächen).

**Render-only.** Kein Sim-/Hash-Impact, kein `SIM_VERSION`-Bump. Die Kollision bleibt
unverändert aus `MapData` (Greybox und Mesh teilen dieselben Kollisionsdaten). Der
Greybox-Pfad bleibt als Debug-/Fallback-Modus erhalten.

### Verifizierte Fakten (diese Session)

- **Die privaten `.glb` tragen nur Geometrie.** 1 Mesh, 1 Primitiv, non-indexed, Attribute
  ausschließlich `POSITION` + `NORMAL`. Keine UVs, keine Vertex-Farben, keine Materialien,
  keine Texturen. Generator `fcop til_mesh`. Vertex-Zahlen hoch (Conft 318k … Hk 725k).
  bbox ist um den Origin **zentriert** (z.B. Conft X∈[-104,103], Z∈[-136,103]), Y-up, Y = Höhe.
  → Der frühere Plan „`.glb` kopieren + laden = texturiert" ist damit **nicht** umsetzbar.
- **Die Textur-Zuordnung existiert aber in der Quelle.** Im Til-`Sect`-Body werden pro Tile
  bereits `texture_cord_index` (Bits 1–10) und `graphics_type_index` (Bits 22–31) geparst,
  aber verworfen. Der Header nennt `texture_cordinates_amount` (+2); an echten Bytes
  bestätigt: `texcoord_amount > 0` (Conft id2: 187, Hk id1: 148), die UV-Tabelle liegt hinter
  der Tile-Liste, im Blob ist Platz dafür. Die Original-Missions liegen vollständig vor.
- **Client-Renderpfad.** Terrain wird in `buildArenaGroup` (`packages/client/src/main.ts:219`)
  zusammengesetzt; `?render=` wird **noch nirgends** ausgewertet (URL-Params bei `main.ts:69`).
  Kein `GLTFLoader`/`TextureLoader` in Benutzung. `public/models` + `public/tex` existieren
  noch nicht. Vite serviert `public/` statisch unter `/` (kein `base`/`publicDir`-Override).
  Achsen-Abbildung: sim x → three x, sim y → three z, Höhe → three y (`terrain.ts:182-184`);
  das Greybox-Terrain liegt an der **Ecke (0,0)**, nicht origin-zentriert.

## 2. Scope / Nicht-Ziele

**In Scope:** UV+Textur-Extraktion der Terrain-Meshes; ein texturierter Karten-Renderpfad im
Client mit `?render=`-Umschaltung; Start mit einer Karte, dann Ausrollen auf alle 6.

**Nicht-Ziele (v1):**
- Kein Sim-/Determinismus-Impact, kein `SIM_VERSION`-Bump, keine Golden-Regeneration.
- Keine Mesh-Optimierung (Indexierung, Dezimierung, Draco/meshopt-Kompression) — separates
  späteres Thema (die `.glb` sind groß, Hk ~17 MB; für „sieht echt aus" zunächst zweitrangig).
- Keine 3D-Objekte/Units (`Cobj`), keine Basis-/Spawn-Meshes — bleibt Greybox/Strukturen.
- Kein Textur-Atlas (Weg B). Bewusst Weg A (s. §5).

## 3. Dekomposition (zwei Teile, A zuerst)

- **Teil A — Private UV-Pipeline** (RE-Repo `amigo-labs/fcop-reverse-engineering`,
  `tools/gfx/til_mesh.py`): erzeugt texturierte `.glb` + zugehörige Textur-PNGs. Die
  eigentliche RE-Arbeit; Voraussetzung für Teil B.
- **Teil B — Repo-Renderpfad** (`packages/client`): lädt die texturierten Assets und rendert
  sie als Alternative zum Greybox. Standard-Three.js, geradlinig sobald Teil A liefert.

## 4. Teil A — UV-Extraktion (`til_mesh.py`)

1. **RE-Verifikation des UV-Layouts** (Risiko-Schritt, zuerst): Das exakte Byte-Layout der
   `texture_cordinates`-Tabelle im `Sect`-Body (hinter der Tile-Liste, `texcoord_amount`
   Einträge) gegen `Ghoster738/Future-Cop-MIT` (`TilResource.cpp`, `Mesh.cpp`) **und** die
   Rohbytes einer echten Datei (Muster wie `_verify_sect.py`) klären. Ebenso auflösen:
   `graphics_type_index` → Cbmp-Ressourcen-ID → welche `texNN.png`.
2. **Parser (`parse_til`) erweitern:** UV-Tabelle einlesen; pro Tile aus `texture_cord_index`
   die Eck-UVs und aus `graphics_type_index` die Textur-ID ableiten.
3. **Mesh-Assemblierung (`assemble_map`) erweitern:** je Dreieck die UV pro Vertex mitführen
   und die Dreiecke **nach Textur-ID gruppieren** (eine Vertexliste je Textur).
4. **`write_glb` erweitern (Weg A):** je Textur ein Primitiv + Material; `TEXCOORD_0`-Accessor;
   Material referenziert die Textur als **externe URI** (nicht eingebettet — s. §5). Kein PBR,
   Basecolor-Textur genügt. Y-up bleibt.
5. **Sim-Alignment (wichtig):** die `.glb`-Vertices im selben Koordinatensystem emittieren wie
   die abgeleiteten Grids (`walk_height`, `wallsV/H`), die die Kollision nutzt. `til_mesh.py`
   erzeugt Mesh und Grids aus derselben Transform und kann die `.glb` daher direkt sim-aligned
   ausgeben; dann braucht der Client keinen (oder nur einen bekannten konstanten) Offset. Grund:
   die aktuelle bbox ist origin-zentriert und umfasst nur belegte Geometrie (leere Randzellen
   fehlen) — sie entspricht NICHT dem vollen sim-Punkt-Grid, ein naives `+extent/2` läge daneben.
6. **Output-Kontrakt:** je Karte ein Ordner mit `<Karte>.glb` (referenziert die PNGs relativ)
   + die verwendeten `texNN.png`. Der untexturierte Modus bleibt erhalten (Regression).
7. **Verifikation:** `.glb` in einem glTF-Viewer und im Client laden; UV-Korrektheit sichtprüfen
   (Texturen sitzen richtig, keine Verzerrung), Deckung mit dem Greybox-Umriss + Kollision.

## 5. Textur-Strategie — Weg A, externe Texturen

- **Weg A (multi-primitive):** ein Primitiv/Material/Textur je verwendeter Kachel-Textur
  (~10 pro Karte). GLTFLoader lädt das nativ; kein Atlas-Packing, kein UV-Remapping.
  Mehr Draw-Calls/Texturen — bei einem render-only Karten-Mesh unkritisch.
- **Externe Textur-Dateien** (die `.glb` referenziert PNGs per URI) statt eingebettet:
  ermöglicht, einzelne Kacheln später durch **KI-hochskalierte** Versionen zu ersetzen, ohne
  Geometrie oder eine Atlas-Datei neu zu bauen. Das ist die ausdrückliche Politur-Absicht.
- **Sampler:** `NearestFilter`, keine Mipmaps, `flatShading: true` (PS1-Look, assets.md §3/§4).
  Wird beim Laden im Client gesetzt (bzw. im glTF-Sampler vorgegeben).

## 6. Teil B — Repo-Renderpfad (`packages/client`)

1. **Ablage:** pro Karte ein Ordner `public/models/<karte>/` mit `<karte>.glb` + `texNN.png`
   (glb + PNGs zusammen → relative URIs stimmen ohne Umschreiben). Erreichbar unter
   `/models/<karte>/…`. (Abweichung von assets.md §4 `public/tex/` ist bewusst: Map-Meshes
   sind ein anderer Fall als Unit-Archetyp-Atlanten.)
2. **Render-Modus lesen:** bei `main.ts:69` `const renderMode = params.get("render") ?? "greybox"`
   (Default greybox, `mesh` schaltet den neuen Pfad).
3. **Verzweigung in `buildArenaGroup`** (`main.ts:219`): bei `mesh` statt `buildTerrainMesh`
   einen glTF-Terrain-Ladepfad einhängen. `GLTFLoader.loadAsync` (async → leere Group sofort
   zurückgeben, Meshes per `.then(g.add(...))` nachtragen). Sampler/Material wie §5 setzen.
   `buildWaterPlane` und `buildBaseStructures` bleiben; `buildTerrainMesh`/`buildWallMesh`/
   `buildDeckMeshes` entfallen im Mesh-Modus (das glTF enthält die Geometrie inkl. Decks).
4. **Alignment:** Achsen wie Greybox (x→x, y→z, Höhe→y). Vorzugsweise gibt der Extractor die
   `.glb` bereits sim-aligned aus (§4.5), sodass hier kein Offset nötig ist. Andernfalls im
   Client um einen bekannten konstanten Vektor verschieben. Ein naives `+extent/2` genügt NICHT
   (glb-bbox ≠ sim-Grid, s. §4.5/§9). Muss visuell exakt auf Greybox/Kollision passen.
5. **Dispose:** `rebuildArena` (`main.ts:241-255`) muss beim Karten-Wechsel geladene Geometrie,
   Materialien **und Texturen** freigeben.
6. **Fallback:** `?render=greybox` bleibt voll funktionsfähig; Umschalten erlaubt Alignment-Debug.

## 7. Vorgehen / Reihenfolge

Zuerst **eine** Karte end-to-end: **Hollywood Keys** (mehrstöckig → größter sichtbarer Gewinn,
prüft zugleich Decks-als-Mesh). Erst wenn diese im Client korrekt texturiert und aligned ist,
die übrigen 5 Karten ausrollen (Extractor läuft ohnehin über alle).

## 8. Kritische Dateien (Impact-Set)

- **RE-Repo (Teil A):** `tools/gfx/til_mesh.py` (`parse_til`, `assemble_map`, `write_glb`),
  ggf. `tools/gfx/extract_gfx.py` (`do_terrain`-Output-Pfade). Referenz: FC:MIT `TilResource.cpp`.
- **amigo-metropolis (Teil B):** `packages/client/src/main.ts` (URL-Param `:69`, `buildArenaGroup`
  `:219`, `rebuildArena` `:241`), neue Datei z.B. `packages/client/src/render/meshMap.ts`
  (glTF-Ladepfad, analog zu `terrain.ts`). `packages/client/public/models/` (neu).
- **Assets:** die texturierten `.glb` + PNGs (aus Teil A) nach `public/models/<karte>/`.

## 9. Offene Punkte / Risiken

- **UV-Byte-Layout (Hauptrisiko):** exakte Struktur der `texture_cordinates`-Tabelle und die
  `graphics_type_index`→PNG-Auflösung sind noch nicht final verifiziert. Erster Plan-Schritt;
  Fallback bei Blockade: untexturiertes Mesh-Rendering (Geometrie mit Überhängen, flat-shaded)
  liefert bereits Mehrwert gegenüber Greybox.
- **Dateigröße:** Hk/Ovmp ~17 MB, non-indexed. Für v1 akzeptiert; Optimierung ist Nicht-Ziel.
- **Alignment/Skala:** das glTF ist origin-zentriert und umfasst nur belegte Geometrie, das
  Greybox-Grid liegt an Ecke (0,0) und ist größer (leere Randzellen). Best gelöst im Extractor,
  indem die `.glb` im sim-Koordinatensystem der Kollisions-Grids ausgegeben wird. Höhen-Skala
  stimmt bereits (beide `int8 * 0.03125`); XZ-Skala prüfen (glb 1 tile = 1 unit ↔ sim `cellSize`,
  für die FCOP-Karten = 1). Sonst driften Mesh und Kollision.
- **Async-Laden:** `buildArenaGroup` ist synchron; der glTF-Pfad muss die Group nachträglich
  füllen, ohne den Boot-/Rebuild-Fluss zu brechen.
