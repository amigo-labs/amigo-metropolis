# SPEC — Camera System (amigo-metropolis)

> Ziel-Repo: `amigo-metropolis` · Ort: `docs/specs/camera.spec.md`
> Status: Draft v0.1 · Go-Gate offen (siehe §11)
> Verwandt: `rules`, `architecture`, `input` (TBD)

---

## 1. Ziel & Leitidee

Modern lesbare Kamera für einen Precinct-Assault-Nachfolger. Vorlage ist die **Vertikal-Sichtänderung** von *Future Cop: L.A.P.D.* (dort ein `SELECT`-Zyklus über feste Presets: standard → close-up → side → sky).

Design-Übersetzung:
- **Behalten:** die *Idee* eines Kontinuums von „taktisch oben" (Precinct-Assault-Überblick) bis „nah dran" (Action). Das ist die eigentliche DNA.
- **Verwerfen:** diskrete Preset-Stufen und die an die Bewegung gekoppelte „drunken camera", die automatisch hinter den Spieler schwenkt. Das war der PS1-Kompromiss und die Hauptschwäche.
- **Neu:** ein **stufenloser Pitch-+-Zoom-Rig** mit einem einzigen Steuerparameter, dämpfungsgeglättet, mit fixer Weltausrichtung als Default.

---

## 2. Architektur-Grundsatz (nicht verhandelbar)

**Die Kamera ist zu 100 % Client-lokaler Render-State.**

- [ ] Kein Teil der Simulation. Die Kamera liest niemals in den Sim-State und schreibt niemals hinein.
- [ ] Nicht im Lockstep. Kamera-State wird **nie** serialisiert, **nie** über die Durable-Object-Relay geschickt, **nie** in Snapshots/Inputs aufgenommen.
- [ ] Determinismus-neutral: Zwei Clients mit völlig unterschiedlichem Kamera-State (Zoom, Pan, Pitch) müssen eine **byte-identische** Simulation erzeugen. Die Kamera berührt keine RNG, keinen Tick, keine Reihenfolge.
- [ ] Kein kamera-getriebenes Gameplay: keine Sichtbarkeit/Fog, kein Aim-Assist, keine Trefferlogik, die vom Kamerawinkel abhängt. Alles Sim-autoritativ.

### Sim/Render-Taktung
- Simulation: fixer **30-Hz-Tick** (Lockstep).
- Render: `requestAnimationFrame`, variable `dt`.
- Die Kamera folgt der **interpolierten** Render-Transform des Ziel-Units (Alpha-Blend zwischen den zwei jüngsten Sim-Snapshots) — **nie** der rohen Sim-Position (sonst 30-Hz-Ruckeln).
- Kamera-Update läuft pro Render-Frame mit echtem `dt`. Alle Dämpfungen sind **framerate-stabil** (exponentiell/Feder mit `dt`, kein fixes Lerp pro Frame).

---

## 3. Kamera-Modell

Orbit-Follow-Rig um einen Fokuspunkt (`focus`), gerendert über eine `THREE.PerspectiveCamera`.

Ableitbare Parameter:

| Parameter | Bedeutung |
| --- | --- |
| `focus: Vec3` | Zielpunkt am Boden (interpolierte Unit-Position + `focusHeight`) |
| `t: number ∈ [0,1]` | **Sicht-Kontinuum**: `0` = ACTION (tief, nah), `1` = TACTICAL (hoch, fern) |
| `pitch` | aus `t` interpoliert (Elevation über Horizont) |
| `distance` | aus `t` interpoliert (Dolly) |
| `fov` | aus `t` interpoliert |
| `yaw` | Azimut; **Default weltfixiert (north-up)**, optional manuell |
| `lookAhead: Vec3` | Fokus-Versatz Richtung Bewegung/Aim |

`t` ist der einzige „Sicht"-Regler des Spielers — die stufenlose Ablösung des `SELECT`-Zyklus. `pitch`, `distance`, `fov` werden aus `t` per Easing gemeinsam gezogen (ein Regler, kohärentes Framing).

### Yaw-Politik
- **Default: weltfixiert** (Karte immer gleich orientiert, MOBA-typisch). Löst das FC-Aim/Facing-Problem: Kamera dreht **nicht** automatisch hinter die Bewegung.
- **Optional: manuelle Rotation** (Tastendruck/Drag). Nie automatisch bewegungsgekoppelt.

---

## 4. Verhalten

### 4.1 Follow & Dämpfung
- `focus` folgt dem interpolierten Unit-Punkt über eine **kritisch gedämpfte Feder** (oder exponentielle Glättung), `dt`-basiert.
- `t`, `yaw` ebenfalls gedämpft gegen ihre Zielwerte (`tTarget`, `yawTarget`).
- Kleine **Deadzone** um `focus`, um Mikro-Jitter bei Stillstand zu vermeiden.

### 4.2 Look-Ahead
- Versatz des Fokus in Richtung der Unit-Velocity (aus zwei interpolierten Positionen) und/oder Aim-Richtung, skaliert bis `lookAheadMax` bei Höchsttempo. Gibt dem Spieler mehr Sicht in Laufrichtung.

### 4.3 Transform-Awareness (walker vs pursuit)
- Additiver **Bias** auf `tTarget`, nicht Override:
  - **Pursuit/Hover (schnell):** leicht Richtung TACTICAL + mehr Look-Ahead (Speed-Framing).
  - **Walker (präzise):** leicht Richtung ACTION (näher, für Nahkampf-Genauigkeit).
- Spieler-Input auf `t` gewinnt immer gegen den Bias (Bias verschiebt nur den Ruhepunkt).

### 4.4 Tactical Free-Look (MOBA)
- Im oberen `t`-Bereich (`t ≥ tFreeLookThreshold`): Fokus darf **vom Unit entkoppelt** werden — RTS-artiges Edge-Pan / Drag / Tasten, um Lanes, Türme und Basen zu überblicken (Käufe, Deploys).
- **Recenter**-Taste snappt `focus` zurück auf den Unit (gedämpft).
- Unterhalb der Schwelle bleibt der Fokus hart am Unit.

---

## 5. Eingabe-Kopplung

Die Kamera liefert der Input/Movement-Schicht nur eine **read-only Basis** (Yaw-Frame). Sie steuert selbst keine Unit-Bewegung.

- **Bewegung = kamera-relativ:** Movement-Input wird gegen den Kamera-`yaw` in Weltrichtung übersetzt (Screen-relativ „hoch = weg von der Kamera").
- **Aim = unabhängig:** Ziel über Maus-Raycast auf die Bodenebene (bzw. rechter Stick). **Aim ist von Facing/Kamera entkoppelt** — die zentrale Modernisierung ggü. FC.
- Grenze: Kamera → stellt `yaw`/Basis bereit. Aim & Bewegung → gehören zu Input+Sim, nicht in diese Spec.

---

## 6. Datentypen (Contract)

```ts
// docs/specs/camera — Referenz-Typen (Render-Layer, NICHT im Sim-Modul)
export type Vec3 = { x: number; y: number; z: number };

/** Anker eines Sicht-Endes; ACTION = t0, TACTICAL = t1. */
export interface ViewAnchor {
  readonly pitchDeg: number;   // Elevation über Horizont
  readonly distance: number;   // Weltmeter Dolly
  readonly fovDeg: number;
}

export interface CameraRigConfig {
  readonly action: ViewAnchor;        // t = 0
  readonly tactical: ViewAnchor;      // t = 1
  readonly focusHeight: number;       // Anhebung des Fokus über Boden
  readonly yawLocked: boolean;        // Default true (north-up)
  readonly followSmoothTime: number;  // s, Feder-Zeitkonstante focus
  readonly paramSmoothTime: number;   // s, für t/pitch/distance/fov
  readonly yawSmoothTime: number;     // s
  readonly lookAheadMax: number;      // Weltmeter bei Höchsttempo
  readonly tFreeLookThreshold: number;// ab hier Edge-Pan erlaubt
  readonly transformBias: number;     // +/- auf tTarget je Modus
  readonly deadzone: number;          // Weltmeter
}

export interface CameraState {
  readonly focus: Vec3;      // gedämpfter Fokus (Welt)
  readonly t: number;        // aktueller Sichtwert [0,1]
  readonly yaw: number;      // rad
  readonly panOffset: Vec3;  // Free-Look-Versatz vom Unit (nur Tactical)
}

export interface CameraInput {
  readonly zoomDelta: number;    // Wheel/Pinch → verschiebt tTarget
  readonly yawDelta: number;     // optional, nur wenn !yawLocked
  readonly panDelta: Vec3;       // Edge/Drag (nur Tactical)
  readonly recenter: boolean;    // snappt panOffset → 0
  readonly snapPreset: number | null; // optionales tTarget-Snap
}

/**
 * Pro Render-Frame. Liest INTERPOLIERTE Zielwerte (Render-Layer),
 * nie rohen Sim-State. Kein Effekt auf Simulation/Determinismus.
 */
export function updateCamera(
  prev: CameraState,
  input: CameraInput,
  followTargetInterpolated: Vec3,
  followVelocity: Vec3,
  isPursuitMode: boolean,
  cfg: CameraRigConfig,
  dt: number,
): CameraState;
```

Der Rig-Output (Kamera-Position/-Rotation) wird aus `CameraState` + `cfg` deterministisch für den Renderer berechnet und auf die `PerspectiveCamera` geschrieben.

---

## 7. Default-Parameter (Startwerte, im Playtest zu tunen)

| Feld | Wert | Notiz |
| --- | --- | --- |
| `action.pitchDeg` | 30 | tiefer Action-Winkel |
| `action.distance` | 14 | nah |
| `action.fovDeg` | 55 | |
| `tactical.pitchDeg` | 62 | hoher Überblick, nicht ganz Top-down (Lesbarkeit) |
| `tactical.distance` | 34 | fern |
| `tactical.fovDeg` | 50 | |
| `focusHeight` | 1.0 | ~Unit-Mitte |
| `followSmoothTime` | 0.12 | s |
| `paramSmoothTime` | 0.18 | s |
| `yawSmoothTime` | 0.15 | s |
| `lookAheadMax` | 4.0 | Weltmeter |
| `tFreeLookThreshold` | 0.7 | |
| `transformBias` | 0.15 | Pursuit +, Walker − |
| `deadzone` | 0.15 | Weltmeter |

> Zahlen sind bewusst Startwerte. `pitch`/`distance` gemeinsam justieren, `t`-Kurve ggf. mit Easing (z. B. smoothstep) statt linear.

---

## 8. Occlusion / Collision (später, optional)

Bei überwiegend top-down-lastigem Framing zweitrangig. Bei tiefem `t` (ACTION) kann Geometrie den Unit verdecken:
- Option A: weicher Dolly-in bei Occluder-Raycast Kamera→Unit.
- Option B: Occluder faden/dithern.
- Für v1 zurückstellen; als eigenes Ticket führen.

---

## 9. Non-Goals (v1)

- Keine skriptgesteuerte/cinematische Kamera.
- Keine First-Person-/Cockpit-Sicht.
- **Kein** automatisches Yaw-Schwenken hinter die Bewegung (bewusst gegen FC).
- Kein Split-Screen (Netz-Titel über DO-Relay → eine Kamera pro Client).

---

## 10. Test / DoD

- [ ] `updateCamera` unit-getestet: Dämpfung bei 30/60/144 fps `dt` konvergiert gleich (framerate-stabil).
- [ ] Determinismus-Test: identische Sim-Inputs → identischer Sim-Hash, unabhängig von Kamera-Aktionen zweier Clients.
- [ ] Kein Import aus dem Sim-Modul in das Kamera-Modul (Lint-Boundary/Dependency-Regel).
- [ ] Kamera liest ausschließlich interpolierte Render-Transforms.
- [ ] Free-Look-Recenter, Zoom, Transform-Bias visuell verifiziert.

---

## 11. Offene Fragen (Go-Gate)

- [ ] Yaw-Default **weltfixiert** bestätigen (Empfehlung: ja), manuelle Rotation als Option ja/nein?
- [ ] `t`-Kurve linear oder smoothstep? (Empfehlung: smoothstep für weicheres Framing)
- [ ] Free-Look-Modell: Edge-Pan, Drag, oder beides?
- [ ] Aim-Modell final: Maus-Raycast auf Bodenebene als Primär, rechter Stick als Gamepad-Äquivalent — hier fixieren oder in eigene `input.spec` auslagern?
- [ ] Occlusion in v1 oder v2?
