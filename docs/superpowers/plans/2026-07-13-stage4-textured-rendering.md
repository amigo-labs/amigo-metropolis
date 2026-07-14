# Stufe 4 — Texturiertes Karten-Rendering — Implementation Plan

> **Status (2026-07-14): TEILWEISE UMGESETZT** — Tasks B1–B3 gelandet via
> PR #15 (`render/meshMap.ts`, `?render=mesh`, Dispose). Offen: visuelle
> Verifikation auf echter GPU, Task B4 (Basis-/Spawn-Meshes), Task B5
> (übrige Karten + Abschlussverifikation). Teil A lebt im privaten RE-Repo;
> Map-Assets bleiben per Owner-Entscheidung außerhalb dieses public repo
> (`packages/client/public/models/.gitignore`). Aktueller Status:
> `PLAN.md` Phase 10. Die Checkboxen unten werden nicht nachgepflegt.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die FCOP-Arenen als texturierte 3D-Meshes im Client rendern (statt Greybox), erste Karte end-to-end: Hollywood Keys.

**Architecture:** Zweiteilig. **Teil A** (privater Workspace `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\`, danach Sync ins Repo `amigo-labs/fcop-reverse-engineering`): `til_mesh.py` liest die UV-/Textur-Zuordnung aus den Til-Ressourcen und schreibt eine texturierte, indexierte, sim-alignte `.glb` je Karte (Weg A: ein Primitiv/Material/Textur pro Kachel-Textur, externe PNG-URIs). **Teil B** (`packages/client`): ein neuer `?render=mesh`-Pfad lädt die `.glb` per `GLTFLoader`, plus aufgewertete Basis-/Spawn-Meshes. Render-only.

**Tech Stack:** Python 3.11 + numpy (Teil A); TypeScript strict + Three.js `^0.185.0` + Vite (Teil B); glTF 2.0 binär (`.glb`) als Austauschformat.

## Global Constraints

- **Render-only:** keine Änderung in `packages/sim`; kein `SIM_VERSION`-Bump; keine Golden-Regeneration. Kollision bleibt aus `MapData`.
- **Achsen:** sim x → three x, sim y → three z, sim-Höhe → three y. Karten-Mesh muss deckungsgleich mit Greybox + Kollision liegen.
- **Textur-Strategie:** Weg A (multi-primitive pro Textur), Texturen als **externe** PNG-Dateien (nicht eingebettet) — für späteres KI-Upscaling.
- **Look:** moderner Look erlaubt (Linear+Mipmaps, Smooth-Shading, PBR); nicht auf PS1 beschränkt. Bewusste Abweichung von assets.md §3/§4.
- **Renderer-Regeln:** Zero-Allocation im Frame-Loop bleibt; der glTF-Ladepfad ist Init-Time (Allokation dort erlaubt). Statische Meshes `matrixAutoUpdate=false` + einmal `updateMatrix()`.
- **Stil:** echte Umlaute (ä/ö/ü/ß) in deutschen Texten; keine Emojis in Code/Kommentaren; kein `any`; Biome-Format; Commits conventional + englisch.
- **Arbeitsort Teil A:** editiere die Tools im privaten Workspace (`C:\MagiPacks\_fcop_audio_privat\_tools\gfx\`, source of truth, kein git). Der Sync ins RE-Repo passiert in Task A6.
- **Erste Karte:** `Hk` (Hollywood Keys). Container-Datei: `C:\MagiPacks\Future Cop - LAPD\missions\Hk`. Terrain-JSON-id im Repo: `hollywood-keys`.

---

## Teil A — Private UV-Pipeline (`til_mesh.py`)

### Task A1: UV-Tabellen-Layout an echten Bytes verifizieren (Discovery)

Klärt die einzige echte Unbekannte, bevor Code darauf aufbaut: das Byte-Layout der `texture_cordinates`-Tabelle hinter der Tile-Liste und die Auflösung `graphics_type_index` → welche `texNN.png`.

**Files:**
- Create: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\_verify_uv.py`

**Interfaces:**
- Consumes: `fcop.parse`/`fcop.extract`, `til_mesh.parse_til` (bestehende Til-Feldparser).
- Produces: bestätigtes Layout, dokumentiert als Modulkonstanten für A2: `TEXCOORD_STRIDE` (Bytes je UV-Eintrag), `TEXCOORD_OFF(body, mesh_library_size)` (Startoffset), `UV_IS_U8` (bool), sowie die Abbildung `graphics_type_index → Cbmp-id`.

- [ ] **Step 1: Discovery-Skript schreiben**

Das Skript lokalisiert die Tabelle rechnerisch (hinter der Tile-Liste) und testet Stride-Hypothesen gegen `texcoord_amount` und die Blob-Länge, an mehreren Ctil-Ressourcen mehrerer Karten.

```python
"""Read-only: locate + validate the Til texture-coordinate table (R2)."""
import os, sys, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fcop import parse, extract
import til_mesh

SRC = r"C:\MagiPacks\Future Cop - LAPD\missions"

def u16(b, o): return struct.unpack_from('<H', b, o)[0]

def probe(cont):
    p = os.path.join(SRC, cont)
    b, res = parse(p)
    ctils = [x for x in res if x['type'] == 'Ctil']
    cbmps = [x for x in res if x['type'] == 'Cbmp']
    print(f"\n{cont}: {len(ctils)} Ctil, {len(cbmps)} Cbmp  (Cbmp ids: {[c['id'] for c in cbmps]})")
    for r in ctils[:6]:
        blob = extract(b, r)
        if blob[:4] != b'tceS':
            continue
        body = 8
        color_amount = u16(blob, body + 0)
        texcoord_amount = u16(blob, body + 2)
        mesh_lib = u16(blob, body + 962)
        tiles_off = body + 1480
        tiles_end = tiles_off + mesh_lib * 4
        rest = len(blob) - tiles_end
        # Hypotheses for the region after the tile list: [texcoords][colors]
        for uv_stride in (2, 4):
            for col_stride in (2, 4):
                used = texcoord_amount * uv_stride + color_amount * col_stride
                fit = "<-- exact" if used == rest else ("<= fits" if used <= rest else "")
                if fit:
                    print(f"  id{r['id']:>3} rest={rest:4d} tc={texcoord_amount:4d} col={color_amount:3d}"
                          f" | uv{uv_stride}+col{col_stride}={used} {fit}")
        # dump first 12 bytes after the tile list for manual inspection
        first = blob[tiles_end:tiles_end + 12]
        print(f"  id{r['id']:>3} first-after-tiles: {first.hex(' ')}")

if __name__ == '__main__':
    for c in (sys.argv[1:] or ['Hk', 'Conft', 'Mp']):
        probe(c)
```

- [ ] **Step 2: Ausführen und Layout bestimmen**

Run: `cd /c/MagiPacks/_fcop_audio_privat/_tools/gfx && python _verify_uv.py Hk Conft Mp`
Erwartet: für die meisten Ressourcen zeigt genau eine `(uv_stride, col_stride)`-Kombination `<-- exact` (Region = `texcoord_amount*uv_stride + color_amount*col_stride`). Das legt `TEXCOORD_STRIDE` fest. Bei Uneindeutigkeit die `first-after-tiles`-Hexdumps + FC:MIT `TilResource.cpp` (`Ghoster738/Future-Cop-MIT`) heranziehen (dort ist die Lade-Reihenfolge Tiles → texture-coords → colors dokumentiert).

- [ ] **Step 3: `graphics_type_index` → Cbmp auflösen**

Das Skript listet die Cbmp-ids je Karte. Prüfe, ob `graphics_type_index` (aus `parse_til`-Tiles) als 0-basierter Index in die sortierte Cbmp-Liste passt (→ `texNN.png` mit `NN = cbmp_id`). Notiere die Abbildung. Falls die Werte außerhalb liegen, ist `graphics_type_index` evtl. schon die Cbmp-id — an den echten Werten entscheiden.

- [ ] **Step 4: Layout dokumentieren**

Erweitere den Modul-Docstring von `til_mesh.py` um einen `R2`-Block (analog zum vorhandenen Sect-Layout), der das bestätigte UV-Tabellen-Layout + die Textur-Abbildung festhält. Das ist die Referenz für A2–A4.

- [ ] **Step 5: Commit (im Workspace vorerst nicht möglich — kein git). Stattdessen: Ergebnis in den Docstring geschrieben (Step 4).** Kein separater Commit; A6 synct alles ins RE-Repo.

---

### Task A2: `parse_til` um UV-Tabelle + Per-Tile-UV/Textur-ID erweitern

**Files:**
- Modify: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\til_mesh.py` (`parse_til`, ~Zeile 206-241)
- Test: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\_verify_uv.py` (erweitern)

**Interfaces:**
- Consumes: A1-Konstanten (`TEXCOORD_STRIDE`, `TEXCOORD_OFF`, Textur-Abbildung).
- Produces: `parse_til(blob)` liefert zusätzlich `'texcoords'` (Liste von `(u, v)`-Tupeln, Länge `texcoord_amount`) im Rückgabe-dict. Die Tile-dicts tragen unverändert `texture_cord_index`, `graphics_type_index`, `mesh_type`.

- [ ] **Step 1: Verifikations-Assert in `_verify_uv.py` ergänzen**

Füge eine Funktion hinzu, die für `Hk` id1 die ersten drei `texcoords` ausliest (mit dem in A1 bestätigten Stride) und plausibel prüft (Werte im Bereich 0..255 bei u8, bzw. 0..256 bei u16).

```python
def check_texcoords(cont='Hk'):
    b, res = parse(os.path.join(SRC, cont))
    r = [x for x in res if x['type'] == 'Ctil'][0]
    blob = extract(b, r)
    til = til_mesh.parse_til(blob)  # must now include 'texcoords'
    tcs = til['texcoords']
    print(f"{cont} id{r['id']}: {len(tcs)} texcoords, first 3 = {tcs[:3]}")
    assert len(tcs) == til_mesh._u16(blob, 8 + 2), "texcoord count mismatch"
    assert all(0 <= u < 512 and 0 <= v < 512 for (u, v) in tcs), "texcoords out of range"
    print("  OK")
```

- [ ] **Step 2: Ausführen — erwartet AttributeError/KeyError (`texcoords` fehlt noch)**

Run: `python -c "import _verify_uv as v; v.check_texcoords()"`
Erwartet: FAIL (`KeyError: 'texcoords'`), weil `parse_til` das Feld noch nicht liefert.

- [ ] **Step 3: `parse_til` erweitern**

Nach dem Einlesen der Tile-Liste die UV-Tabelle lesen (Offset/Stride aus A1). Beispiel für den bestätigten Fall u8-Paare, Tabelle direkt hinter der Tile-Liste:

```python
    # texture coordinates (R2): texcoord_amount entries right after the tile list.
    tex_amount = _u16(blob, body + 2)
    tex_off = tiles_off + mesh_library_size * 4        # = tiles_end
    texcoords = []
    for i in range(tex_amount):
        u = blob[tex_off + i * TEXCOORD_STRIDE]        # u8; adjust per A1
        v = blob[tex_off + i * TEXCOORD_STRIDE + 1]
        texcoords.append((u, v))
    return {'heightmap': hm, 'floor': floor, 'tiles': tiles,
            'mesh_library_size': mesh_library_size, 'texcoords': texcoords}
```

Ergänze `TEXCOORD_STRIDE` als Modulkonstante (Wert aus A1). Passe die Byte-Entnahme an, falls A1 u16 ergab.

- [ ] **Step 4: Ausführen — erwartet OK**

Run: `python -c "import _verify_uv as v; v.check_texcoords()"`
Erwartet: PASS, gibt die ersten drei `texcoords` aus.

- [ ] **Step 5: (kein Commit — Workspace ohne git; Sync in A6)**

---

### Task A3: `assemble_map` um Per-Vertex-UV + Gruppierung nach Textur

**Files:**
- Modify: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\til_mesh.py` (`_make_tri`, `build_tile_polys`, `assemble_map`)

**Interfaces:**
- Consumes: `parse_til(...).texcoords`, Tile-`texture_cord_index`/`graphics_type_index`.
- Produces: `assemble_map(...)` liefert im Rückgabe-dict zusätzlich `groups`: ein dict `texture_id -> {'positions': ndarray(N,3), 'normals': ndarray(N,3), 'uvs': ndarray(N,2)}`. Die bestehenden Felder (`positions`, `normals`, `walk_height`, `wallsV/H`, `layers`, …) bleiben unverändert (untexturierter Pfad + abgeleitete Grids intakt).

- [ ] **Step 1: Per-Tile-UV im Geometrie-Aufbau mitführen**

`build_tile_polys`/`_make_tri` bekommen Zugriff auf die Til-`texcoords` und den `texture_cord_index` des Tiles. Die vier Til-Eckpunkte mappen auf `texcoords[texture_cord_index + k]` (Reihenfolge wie die Positions-Ecken; k = Punktindex im `DEFAULT_MESH`-Polygon). UVs auf `[0,1]` normalisieren (`u/255`, `v/255` bei u8; `1 - v` falls A1 zeigt, dass FC die V-Achse invertiert speichert).

- [ ] **Step 2: In `assemble_map` nach Textur gruppieren**

Parallel zur bestehenden `positions`/`normals`-Sammlung ein `groups`-dict mit Sammel-Listen führen. Je Dreieck die `texture_id` (aus `graphics_type_index` via A1-Abbildung) bestimmen und Positions/Normals/UVs einhängen. Beispielgerüst innerhalb der Tile-Schleife:

```python
    tex_id = TEX_FROM_GRAPHICS[tile['graphics_type_index']]   # mapping from A1
    g = groups.setdefault(tex_id, {'pos': [], 'nrm': [], 'uv': []})
    for wv, uv in zip(wtri, tri_uvs):
        g['pos'].extend(wv); g['nrm'].extend((nx, ny, nz)); g['uv'].extend(uv)
```

Am Ende je Gruppe die Sammel-Listen zu den finalen ndarray-Feldern verdichten (Namen exakt wie im Interfaces-Block: `positions`/`normals`/`uvs`), id-sortiert:

```python
    groups = {tid: {'positions': np.array(g['pos'], np.float32).reshape(-1, 3),
                    'normals':   np.array(g['nrm'], np.float32).reshape(-1, 3),
                    'uvs':       np.array(g['uv'],  np.float32).reshape(-1, 2)}
              for tid, g in sorted(groups.items())}
```

- [ ] **Step 3: Sim-Alignment sicherstellen**

Die Weltkoordinaten der Vertices entstehen bereits über dieselbe `finalX/finalZ`-Transform, die `walk_height`/`wallsV/H` erzeugt (Zeile 379-381). Um die `.glb` deckungsgleich mit dem Repo-`MapData` zu machen, dieselbe Ecke-(0,0)-Konvention wie das Greybox-Terrain anlegen: prüfen, ob die Grid-Indizes `(row, col)` direkt three-`(x=col*cell, z=row*cell)` ergeben; falls die aktuelle Transform origin-zentriert ist, den konstanten Offset `(+extent/2)` je Achse in den Vertex-Positionen ergänzen, sodass `min == 0`. Verifikation in A5.

- [ ] **Step 4: Smoke-Check**

Run: `python -c "import til_mesh, fcop, os; b,res=fcop.parse(r'C:\MagiPacks\Future Cop - LAPD\missions\Hk'); m=til_mesh.assemble_map(res,b,fcop.extract); print(sorted(m['groups']), [ (t, m['groups'][t]['pos'].shape) for t in sorted(m['groups']) ][:3])"`
Erwartet: eine Liste von Textur-ids mit je (N,3)-Positions-Arrays; Summe der N == alte `positions`-Länge.

- [ ] **Step 5: (kein Commit — Sync in A6)**

---

### Task A4: `write_glb` — texturiert (Weg A), indexiert, externe PNG-URIs

**Files:**
- Modify: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\til_mesh.py` (`write_glb` → neue Funktion `write_glb_textured`)

**Interfaces:**
- Consumes: `groups` aus A3.
- Produces: `write_glb_textured(path, groups, tex_names)` schreibt eine `.glb` mit einem Primitiv je Gruppe (`POSITION`+`NORMAL`+`TEXCOORD_0`, **indexiert**), je Primitiv ein Material mit `baseColorTexture`, deren `image.uri` auf `tex_names[texture_id]` (relativer PNG-Name) zeigt. `tex_names`: dict `texture_id -> "texNN.png"`.

- [ ] **Step 1: Indexierung pro Gruppe**

Hilfsfunktion: dedupliziert `(pos, nrm, uv)`-Vertices innerhalb einer Gruppe zu einem Index-Buffer.

```python
def _index_group(pos, nrm, uv):
    seen = {}
    out_p, out_n, out_u, idx = [], [], [], []
    for k in range(pos.shape[0]):
        key = (round(float(pos[k,0]),4), round(float(pos[k,1]),4), round(float(pos[k,2]),4),
               round(float(uv[k,0]),4), round(float(uv[k,1]),4))
        j = seen.get(key)
        if j is None:
            j = len(out_p); seen[key] = j
            out_p.append(pos[k]); out_n.append(nrm[k]); out_u.append(uv[k])
        idx.append(j)
    import numpy as np
    return (np.array(out_p, np.float32), np.array(out_n, np.float32),
            np.array(out_u, np.float32), np.array(idx, np.uint32))
```

- [ ] **Step 2: `write_glb_textured` schreiben**

Je Gruppe zuerst indexieren: `p, n, u, idx = _index_group(g['positions'], g['normals'], g['uvs'])`.
glTF mit: je Gruppe ein `bufferView`-Satz (POSITION/NORMAL/TEXCOORD_0/indices), ein `accessor`-Satz, ein `mesh.primitive` mit `material`, `attributes`, `indices`; je Material `pbrMetallicRoughness.baseColorTexture`; `textures`/`samplers`/`images` (Sampler mit `magFilter=9729`/`minFilter=9987` = Linear/Mipmap für modernen Look; `image.uri = "texNN.png"`, extern). Struktur analog zum vorhandenen `write_glb` (nur ein Puffer, 4-Byte-Alignment beachten). BIN-Puffer = Konkatenation aller Gruppen-Buffer, `byteOffset`/`byteLength` je bufferView korrekt setzen.

- [ ] **Step 3: Verifikation — struktureller Selbsttest**

Run: `python _verify_uv.py glbcheck Hk` (Modus ergänzen: schreibt `/tmp/Hk.glb`, liest den JSON-Chunk zurück, prüft `images`/`materials`/`textures` > 0, jedes Primitiv hat `TEXCOORD_0` + `indices` + `material`).
Erwartet: `meshes=1? primitives=<#gruppen> materials=<#gruppen> images=<#texturen> uri=texNN.png` und keine eingebetteten Bilder.

- [ ] **Step 4: In einem externen glTF-Viewer sichtprüfen** (z.B. https://gltf-viewer.donmccurdy.com/ lokal, oder Blender-Import): Texturen sitzen, keine offensichtliche UV-Verzerrung. Die `texNN.png` müssen dafür neben der `.glb` liegen (A5).

- [ ] **Step 5: (kein Commit — Sync in A6)**

---

### Task A5: `extract_gfx.do_terrain` — texturierte Assets je Karte ausgeben (Hk zuerst)

**Files:**
- Modify: `C:\MagiPacks\_fcop_audio_privat\_tools\gfx\extract_gfx.py` (`do_terrain`, ~Zeile 137-185)

**Interfaces:**
- Consumes: `til_mesh.assemble_map(...).groups`, `write_glb_textured`, die Textur-Extraktion aus `do_textures`.
- Produces: je Karte einen Ordner `meshes/<cont>/` mit `<cont>.glb` (texturiert, referenziert die PNGs relativ) + Kopien der verwendeten `texNN.png`. Terrain-JSON-Ausgabe bleibt unverändert.

- [ ] **Step 1: `do_terrain` auf den Gruppen-Pfad umstellen**

`write_glb_textured(os.path.join(mdir, cont, f"{cont}.glb"), m['groups'], tex_names)` statt `write_glb`; die verwendeten `texNN.png` aus `textures/<cont>/` in `meshes/<cont>/` kopieren; `tex_names` je Gruppe = `texNN.png`. Den bisherigen untexturierten `write_glb` als Fallback behalten (falls `groups` leer).

- [ ] **Step 2: Für Hollywood Keys laufen lassen**

Run: `cd /c/MagiPacks/_fcop_audio_privat && python _tools/gfx/extract_gfx.py Hk`
Erwartet: `Hk` verarbeitet, `meshes/Hk/Hk.glb` + `meshes/Hk/texNN.png` existieren.

- [ ] **Step 3: Sim-Alignment gegen das Repo-`MapData` verifizieren**

Schreibe ein Vergleichs-Skript, das die `.glb`-bbox (min/max XZ) gegen die erwartete Repo-Ausdehnung prüft: `hollywood-keys` hat `size=289`, `cellSize=1` → `extent = 288`. Die `.glb`-XZ-min muss `≈ 0`, XZ-max `≈ 288` sein (nicht origin-zentriert).

Erweitere `_verify_uv.py` um einen `bbox`-Modus, der die Vereinigungs-bbox aller POSITION-Accessor-`min`/`max` aus der `.glb` ausgibt.

Run: `cd /c/MagiPacks/_fcop_audio_privat && python _tools/gfx/_verify_uv.py bbox meshes/Hk/Hk.glb`
Erwartet: `bbox min=[~0, *, ~0] max=[~288, *, ~288]`. Falls origin-zentriert (`min≈-144`) → A3 Step 3 Offset korrigieren und A5 wiederholen.

- [ ] **Step 4: Alle 6 Karten erzeugen**

Run: `cd /c/MagiPacks/_fcop_audio_privat && python _tools/gfx/extract_gfx.py Conft Slim Mp Joke Hk Ovmp`
Erwartet: je Karte `meshes/<cont>/<cont>.glb` + PNGs.

- [ ] **Step 5: (kein Commit — Sync in A6)**

---

### Task A6: RE-Repo synchronisieren

**Files:**
- Modify: RE-Repo-Arbeitskopie (Tools + `meshes/`), Push nach `amigo-labs/fcop-reverse-engineering`.

- [ ] **Step 1: Geänderte Tools + neue Meshes in die Repo-Arbeitskopie kopieren**

`til_mesh.py`, `extract_gfx.py`, `_verify_uv.py` nach `tools/gfx/`; `meshes/<cont>/` nach `extracted/meshes/`.

- [ ] **Step 2: Commit + Push**

```bash
git add -A && git commit -m "feat(gfx): textured Til .glb export (UVs + per-texture primitives, indexed)"
git push
```

Erwartet: Push ok; `gh repo view amigo-labs/fcop-reverse-engineering` zeigt den neuen Commit.

---

## Teil B — Client-Renderpfad (`packages/client`)

### Task B1: Assets ablegen + `?render`-Param lesen

**Files:**
- Create: `packages/client/public/models/hollywood-keys/` (`.glb` + `texNN.png`, kopiert aus Teil A)
- Modify: `packages/client/src/main.ts` (~Zeile 69)

**Interfaces:**
- Produces: Modul-Konstante `renderMode: "mesh" | "greybox"` in `main.ts`, gelesen aus `?render=`.

- [ ] **Step 1: Assets kopieren**

Kopiere `C:\MagiPacks\_fcop_audio_privat\meshes\Hk\` nach `packages/client/public/models/hollywood-keys/` (Datei umbenennen zu `hollywood-keys.glb`, PNG-URIs in der `.glb` passen relativ — ggf. beim Export in A4 schon `hollywood-keys.glb` + gleiche PNG-Namen wählen). Erreichbar unter `/models/hollywood-keys/hollywood-keys.glb`.

- [ ] **Step 2: `renderMode` lesen**

In `main.ts` nach Zeile 83 (`aimAssist.mode = ...`):

```typescript
// Stufe 4: ?render=mesh lädt die texturierten Karten-Meshes; Default greybox
// bleibt der verlässliche Debug-/Fallback-Pfad (assets.md, HANDOFF).
const renderMode: "mesh" | "greybox" = params.get("render") === "mesh" ? "mesh" : "greybox";
```

- [ ] **Step 3: typecheck**

Run: `cd packages/client && bun run typecheck`
Erwartet: PASS (keine Fehler).

- [ ] **Step 4: Commit**

```bash
git add packages/client/public/models packages/client/src/main.ts
git commit -m "feat(client): add textured hollywood-keys mesh asset + ?render flag"
```

---

### Task B2: glTF-Karten-Ladepfad (`meshMap.ts`)

**Files:**
- Create: `packages/client/src/render/meshMap.ts`

**Interfaces:**
- Consumes: `MapData` (für `id`), Achsen/Extent-Konventionen.
- Produces: `loadMapMesh(map: MapData, group: THREE.Group): void` — lädt asynchron `/models/<map.id>/<map.id>.glb`, setzt moderne Sampler/Material, hängt das Mesh in `group` ein. Fällt still auf nichts zurück, wenn kein Asset existiert (Greybox-Karten ohne Mesh).

- [ ] **Step 1: `meshMap.ts` schreiben**

```typescript
// Stufe 4: texturierter Karten-Renderpfad. Lädt die aus den FCOP-Til-Daten
// erzeugte .glb (Teil A) und hängt sie in die Arena-Group. Init-time only;
// GLTFLoader ist async, daher füllt der .then() die (leere) Group nach.
import type { MapData } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

/** Lädt das Karten-Mesh für map.id nach group. No-op, wenn kein Asset da ist. */
export function loadMapMesh(map: MapData, group: THREE.Group): void {
  const url = `/models/${map.id}/${map.id}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const tex = mat.map;
        if (tex) {
          // Moderner Look: Linear + Mipmaps + anisotrop (assets.md §3 bewusst gelockert).
          tex.magFilter = THREE.LinearFilter;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
        }
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      });
      gltf.scene.matrixAutoUpdate = false;
      gltf.scene.updateMatrix();
      group.add(gltf.scene);
    },
    () => {
      // Kein Mesh-Asset für diese Karte: Greybox-Terrain zeigt sie weiter.
      console.warn(`[meshMap] no mesh asset at ${url}, staying greybox for terrain`);
    },
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd packages/client && bun run typecheck`
Erwartet: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/render/meshMap.ts
git commit -m "feat(client): glTF map-mesh loader (meshMap.ts)"
```

---

### Task B3: `buildArenaGroup` verzweigen + Dispose erweitern

**Files:**
- Modify: `packages/client/src/main.ts` (`buildArenaGroup` ~219-229, `rebuildArena` ~241-255, Import ~60-65)

**Interfaces:**
- Consumes: `loadMapMesh` (B2), `renderMode` (B1).
- Produces: im `mesh`-Modus baut die Arena das Terrain aus der `.glb` (kein Greybox-Terrain/Walls/Decks), Basen kommen aus B4.

- [ ] **Step 1: Import ergänzen**

```typescript
import { loadMapMesh } from "./render/meshMap";
```

- [ ] **Step 2: `buildArenaGroup` verzweigen**

```typescript
function buildArenaGroup(m: typeof map): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  if (renderMode === "mesh") {
    loadMapMesh(m, group); // async: terrain mesh (incl. decks) is added when loaded
  } else {
    group.add(buildTerrainMesh(m));
    const walls = buildWallMesh(m);
    if (walls) group.add(walls);
    for (const deck of buildDeckMeshes(m)) group.add(deck);
  }
  group.add(buildWaterPlane(m));
  buildBaseStructures(group, m); // B4 upgrades this; placement identical in both modes
  return group;
}
```

- [ ] **Step 3: Dispose um Texturen erweitern**

In `rebuildArena` die Dispose-Schleife (Zeile 246-252) ergänzen, sodass auch `material.map` freigegeben wird:

```typescript
  arenaGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
```

- [ ] **Step 4: typecheck**

Run: `cd packages/client && bun run typecheck`
Erwartet: PASS.

- [ ] **Step 5: Browser-Verifikation (Alignment)**

Dev-Server starten, `/?map=hollywood-keys&render=mesh&debug` öffnen. Prüfen (read_console_messages, Screenshot): das texturierte Mesh erscheint, keine Loader-/GL-Fehler, und es liegt deckungsgleich über der Greybox-Fläche (zum Vergleich `render=greybox` gegenchecken). Bei Versatz → Teil A A3/A5-Alignment korrigieren.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/main.ts
git commit -m "feat(client): render textured map mesh under ?render=mesh"
```

---

### Task B4: Aufgewertete Basis- und Spawn-Meshes

**Files:**
- Modify: `packages/client/src/render/structures.ts`

**Interfaces:**
- Consumes: `MapData` (`bases`, `spawns`, `outpostSpots`), `sampleHeight`, `teamRamp`.
- Produces: `buildBaseStructures` liefert modernere Basis-Geometrie (Fasen + PBR + Team-Emissive); neue `buildSpawnMarkers(scene, map)` setzt Marker an `spawns`/`outpostSpots`. Beide statisch.

- [ ] **Step 1: Basis-Material modernisieren**

Das `MeshStandardMaterial` je Basis um PBR-Anmutung + Team-Emissive erweitern (kein `flatShading`; leichte Metalness/Roughness; `emissive = teamRamp(team).base` mit kleiner `emissiveIntensity`):

```typescript
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(teamRamp(team).dark),
      metalness: 0.3,
      roughness: 0.55,
      emissive: new THREE.Color(teamRamp(team).base),
      emissiveIntensity: 0.25,
    }),
```

Und die Core-/Gate-Geometrie leicht aufwerten: statt reiner `BoxGeometry` für den Core-Cap eine abgeschrägte Form (z.B. zusätzliche schmalere Box als Kante). Positionen/Größen unverändert (Platzierung bleibt identisch zur Kollision/Greybox).

- [ ] **Step 2: `buildSpawnMarkers` hinzufügen**

```typescript
/** Static markers at avatar spawns + neutral outposts (render-only). */
export function buildSpawnMarkers(scene: THREE.Object3D, map: MapData): void {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of map.spawns) {
    const h = sampleHeight(map, s.x, s.y);
    const ring = new THREE.CylinderGeometry(1.6, 1.8, 0.3, 20);
    ring.translate(s.x, h + 0.15, s.y);
    parts.push(ring);
  }
  for (const o of map.outpostSpots) {
    const h = sampleHeight(map, o.x, o.y);
    const post = new THREE.CylinderGeometry(0.6, 0.8, 3.2, 12);
    post.translate(o.x, h + 1.6, o.y);
    parts.push(post);
  }
  if (parts.length === 0) return;
  const mesh = new THREE.Mesh(
    mergeGeometries(parts),
    new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.2, roughness: 0.6 }),
  );
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
}
```

- [ ] **Step 3: In `buildArenaGroup` aufrufen** (`main.ts`, nach `buildBaseStructures`):

```typescript
  buildSpawnMarkers(group, m);
```

Import in `main.ts` ergänzen: `import { buildBaseStructures, buildSpawnMarkers } from "./render/structures";` (der bestehende `buildBaseStructures`-Import wird erweitert).

- [ ] **Step 4: typecheck**

Run: `cd packages/client && bun run typecheck`
Erwartet: PASS.

- [ ] **Step 5: Browser-Verifikation**

`/?map=hollywood-keys&render=mesh&debug`: Basen wirken modern (nicht flach-grau), Spawn-Ringe + Outpost-Pfosten sitzen an den richtigen Stellen (mit `render=greybox` gegenprüfen — identische Positionen).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/render/structures.ts packages/client/src/main.ts
git commit -m "feat(client): modern base structures + spawn/outpost markers"
```

---

### Task B5: Übrige Karten ausrollen + Abschluss-Verifikation

**Files:**
- Create: `packages/client/public/models/<karte>/` für die übrigen 5 (aus Teil A A5 Step 4).

**Interfaces:**
- Consumes: die Terrain-JSON-ids der 6 Karten (`urban-jungle`, `proving-ground`, `la-cantina`, `bug-hunt`, `hollywood-keys`, `venice-beach`).

- [ ] **Step 1: Assets für alle Karten ablegen**

Je Karte den `meshes/<cont>/`-Ordner aus Teil A nach `public/models/<karten-id>/` kopieren, `.glb` auf `<karten-id>.glb` benennen (die Container→id-Abbildung: `Conft`=urban-jungle, `Slim`=proving-ground, `Mp`=la-cantina, `Joke`=bug-hunt, `Hk`=hollywood-keys, `Ovmp`=venice-beach).

- [ ] **Step 2: Jede Karte im Browser prüfen**

Für jede id `/?map=<id>&render=mesh&debug`: Mesh lädt, texturiert, aligned; keine Konsolenfehler. Bei der zweiten mehrstöckigen Karte (`venice-beach`) besonders die Decks prüfen.

- [ ] **Step 3: Abschluss-Screenshot je Karte** als Nachweis (computer screenshot), Greybox↔Mesh-Vergleich für mindestens Hollywood Keys.

- [ ] **Step 4: Commit**

```bash
git add packages/client/public/models
git commit -m "feat(client): textured meshes for all 6 arenas"
```

- [ ] **Step 5: Branch-Abschluss** — siehe superpowers:finishing-a-development-branch (PR gegen `main`).
