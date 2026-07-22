# Asset-Rendering (Blender via MCP)

`render_assets.py` rendert aus den ausgelieferten `.glb`-Assets zwei Dinge:

1. **QC-Ansichtsblätter** — jedes der 15 In-Game-Modelle (6 Arenen + 9 Units) in
   5 Ansichten (`front/back/left/top/iso`) nach
   `docs/renders/<kategorie>/<asset>-<view>.png`.
2. **Level-Auswahl-Previews** — pro Arena ein isometrischer Ausschnitt der
   Kampfzone nach `packages/client/public/models/<id>/preview.png`. Diese lädt das
   Menü (`packages/client/src/menu.ts`) in die Arena-Karten (Fallback: die
   prozedurale Minimap `drawArenaThumbnail`).

Das Skript läuft **in einer Blender-Instanz** und wird über das MCP-Addon
angesprochen (kein Standalone-CLI). Blender muss also laufen und der MCP-Server
gestartet sein.

## Blender anbinden (MCP)

Es wird das **offizielle MCP-Addon aus dem Blender-Lab-Extensions-Repo** benötigt
(`lab.blender.org`), **nicht** das verbreitete „Blender MCP"-Addon mit
Poly Haven / Rodin / Sketchfab / Hunyuan. Beide lauschen auf Port **9876** und
blockieren sich gegenseitig.

1. In Blender das **aktuelle „Blender MCP"-Addon deaktivieren** (das mit
   Poly Haven/Rodin/Sketchfab/Hunyuan) und dessen Server stoppen — sonst blockiert
   es weiter Port 9876.
2. **Preferences → Get Extensions → Repositories → neues Repo hinzufügen:**
   `https://lab.blender.org/`
3. Dort das **offizielle „MCP"-Addon** suchen, **installieren und aktivieren**.
4. Dessen **Server starten** (ebenfalls Port 9876) und sicherstellen, dass das alte
   Addon nicht mehr lauscht.

Verbindungs-Check (MCP): `get_objects_summary` sollte die Szene liefern. Schlägt es
mit `Cannot connect to Blender at localhost:9876` fehl, läuft der Server nicht (oder
das alte Addon blockiert den Port noch).

## Rendern

Das Skript wird nicht direkt ausgeführt, sondern per MCP-Tool `execute_blender_code`
in Blenders Python eingespielt. Robustes Muster (eigener Namespace, damit Filter/
Ergebnis sauber ein- und ausgehen):

```python
ns = {"__name__": "render_assets", "MODE": "preview", "RENDER_ONLY": ["bug-hunt"]}
with open(r"...\tools\render\render_assets.py", encoding="utf-8") as f:
    exec(compile(f.read(), "render_assets.py", "exec"), ns)
result = {"written": ns["WRITTEN"], "warnings": ns["WARNINGS"]}
```

Injizierbare Globals:

- `MODE` — `"preview"` für die Arena-Previews, sonst (weglassen) die QC-Sheets.
- `RENDER_ONLY` — Liste von Asset-Keys **oder** Kategorien
  (`arenas`, `turrets`, `units`, `figures`, `props`). Weglassen = alles.

Feintuning der Previews steht als Konstanten oben im Skript (`PREVIEW_ZOOM`,
`PREVIEW_DIR`, `PREVIEW_OVERRIDES`, `PREVIEW_RES`).

## Gotchas

- **Z-up beim Import.** Blenders glTF-Import wandelt glTF (Y-up) nach Z-up:
  `(x,y,z) → (x,-z,y)`. Kamerarichtungen sind daher in Blenders Z-up-Frame definiert
  (glTF-Forward +Z = Blender −Y, glTF-Up +Y = Blender +Z). Sonst sind alle Ansichten
  vertauscht.
- **FCOP-Materialien sind single-sided** (`doubleSided:false`) mit inkonsistenten
  Normalen → Backface-Culling reißt Löcher. Das Skript setzt daher
  `use_backface_culling = False`.
- **Neutralisierte Units rendern grau** (Team-Tint, `neutralizeColors:true` im
  Unit-Manifest); turret/console behalten Farbe. Dunkle Flächen an fortress/warden
  sind dunkle Atlas-Textur, kein Fehler.
- **Arenen in Blöcken rendern.** Alle 6 Arenen (1600px, große Meshes) in einem
  `execute_blender_code`-Aufruf sprengen das MCP-Request-Timeout (~60 s). Das Skript
  läuft in Blender zwar durch, die Antwort kommt aber nicht zurück — daher Arenen in
  Blöcken zu max. 3 (`RENDER_ONLY`) rendern.
- Engine: EEVEE (version-tolerant `BLENDER_EEVEE_NEXT` bzw. `BLENDER_EEVEE`),
  View-Transform `Standard`, neutrales Studio-Licht.
