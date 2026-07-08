# SPEC — Input & Aiming (amigo-metropolis)

> Ziel-Repo: `amigo-metropolis` · Ort: `docs/specs/input.spec.md`
> Status: Draft v0.1 · Go-Gate offen (§9)
> Verwandt: `camera.spec` (liefert Yaw-Basis), `netcode.spec` (konsumiert `InputCommand`)

---

## 1. Ziel

Ein Eingabemodell, das (a) die FC-Schwächen behebt — **Aim von Facing/Kamera entkoppelt**, echtes Twin-Stick statt Lock-on-Zwang — und (b) sauber in das deterministische 30-Hz-Lockstep passt.

**Kernprinzip:** Roh-Input (Maus/Tasten/Gamepad) wird **einmal pro Sim-Tick** zu einem **deterministischen, quantisierten `InputCommand`** verdichtet. Nur dieses Command wird synchronisiert und von der Sim konsumiert. Roh-Floats erreichen die Sim **nie**.

---

## 2. Die Determinismus-Grenze (das Wichtigste)

Aim und Bewegung werden lokal aus der Kamera abgeleitet — und die Kamera ist **client-lokal und nicht deterministisch** über Clients (siehe `camera.spec`). Das ist unkritisch, weil:

1. Der Raycast (Cursor → Bodenebene) und die kamera-relative Umrechnung laufen **lokal in Floats**.
2. Das **Ergebnis** (Aim-Winkel, Bewegungs-Intent in Weltkoordinaten) wird **quantisiert** (Fixed-Point) und ins `InputCommand` geschrieben.
3. Dieses Command wird übertragen. **Alle** Client-Sims verarbeiten denselben quantisierten Wert identisch.

> Merksatz: *Aim ist ein Input, keine Sim-Berechnung.* Der lokale, kamera-abhängige Weg zum Wert darf nicht-deterministisch sein — der **übertragene Wert** ist kanonisch.

---

## 3. `InputCommand` (der geteilte Contract)

Kompakt, bit-packbar (30 Hz → Bandbreite zählt). Fixed-Point-Konventionen aus `netcode.spec`.

```ts
/** Genau ein Command pro Sim-Tick, pro Spieler. */
export interface InputCommand {
  readonly tick: number;          // Sim-Tick, für den dieser Input gilt (T + delay)
  readonly moveIntent: FixVec2;   // Welt-Richtung*Magnitude, Fixed-Point, |v| ≤ 1.0
  readonly aimYaw: number;        // 16-bit "brads" (0..65535 = ein Turn), Fixed-Point-Winkel
  readonly buttons: number;       // Bitmaske, HELD-State (siehe §6)
  readonly edges: number;         // Bitmaske, im Tickfenster aufgetretene Press-Edges
  readonly deploy: DeployCommand | null; // Precinct-Assault-Kauf/Deploy, optional
  readonly lockTarget: number | null;    // optionaler Ziel-Entity-ID (Soft-Lock, §4.3)
}

export interface DeployCommand {
  readonly unitType: number;      // Enum (Hovertank/Dreadnought/Heli/Superplane…)
  readonly lane: number;          // Lane-Index aus map.spec ODER
  readonly point: FixVec2 | null; // Fixed-Point-Zielpunkt (falls frei platzierbar)
}
```

`FixVec2` = zwei Fixed-Point-Komponenten (Def. in `netcode.spec`). Wire-Encoding: Bit-Packing, nur belegte Felder; `deploy`/`lockTarget` per Flag-Bit.

---

## 4. Aim-Modell

### 4.1 Maus + Tastatur (primär)
- Ray von Kamera durch Cursor → Schnitt mit Bodenebene (`y = groundHeight`) → Welt-Zielpunkt.
- Aim = Yaw vom Unit zum Zielpunkt (um die Up-Achse), quantisiert zu **16-bit brads**. Für einen top-down-lastigen Shooter reicht der Bodenebenen-Yaw als Kern.
- Der Unit richtet sich am `aimYaw` aus — **unabhängig von Bewegungsrichtung** (das ist die FC-Modernisierung).

### 4.2 Gamepad
- **Rechter Stick = Aim-Richtung direkt** (Twin-Stick). Stick-Vektor → Yaw → brads.
- **Linker Stick = kamera-relative Bewegung** (§5).
- Das ist die saubere Zwei-Stick-Steuerung, die die PS1 mangels DualShock nicht hatte.

### 4.3 Vertikale Ziele (Helis, Superplane)
- Precinct Assault hat fliegende Einheiten. **Automatische Elevation**: Waffen zielen vertikal automatisch auf das erfasste/gelockte Ziel; der Spieler steuert nur den Boden-Yaw. Die Sim rechnet die Elevation deterministisch aus der Ziel-Entity-Position.

### 4.4 Soft-Lock — konfigurierbar, zwei Modi

Historik: Das Original hatte **kein** freies Zielen — es erfasste automatisch das nächste Ziel (rote Ziellinie), Zielwahl nur per Ziel-Wechsel-Taste. Free-Aim ist unsere Modernisierung; Soft-Lock ist der bewusste, **einstellbare** Rückgriff auf das FC-Gefühl.

Einstellung `aimAssistMode: "off" | "assist" | "lock"` — die beiden Soft-Lock-Modi sind **Assist** und **Lock**, `off` = reines Free-Aim.

| Modus | Verhalten | Übertragener Kanal | Auflösung |
| --- | --- | --- | --- |
| `off` | reines Free-Aim (Maus-Raycast / rechter Stick) | `aimYaw` | — |
| `assist` | Free-Aim primär, Aim wird lokal Richtung nächstes Ziel im Kegel gezogen (Magnetismus) | `aimYaw` (geformt) | **lokal**, vor Quantisierung |
| `lock` | harter Lock auf eine Entity, Aim trackt sie automatisch; Ziel-Zyklus per Taste | `lockTarget` (+ `aimYaw` als Fallback) | **in der Sim**, jeden Tick |

**Assist (Magnetismus):**
- Kandidat = nächstes gültiges Ziel innerhalb `assistConeDeg` um den aktuellen Free-Aim.
- Der Free-Aim-Yaw wird um bis zu `assistStrength` Richtung Kandidat interpoliert — **lokale Input-Shaping-Stufe VOR der Quantisierung**. Formt nur den eigenen, ohnehin übertragenen `aimYaw`. Kein Sim-Eingriff, keine cross-client-Divergenz.
- `lockTarget = null`. Der Spieler behält jederzeit die Kontrolle.

**Lock (Tracking):**
- Ziel-Zyklus-Taste (Bit 6) wählt/wechselt die gelockte Entity → `lockTarget = entityId` im Command.
- Die **Sim** berechnet den Aim (Yaw + Auto-Elevation) jeden Tick deterministisch aus der aktuellen Ziel-Position → perfektes Tracking in Sim-Zeit.
- **Fallback**: `aimYaw` wird weiterhin mitgesendet. Ist `lockTarget` ungültig (Ziel tot/außer Reichweite), nutzt die Sim `aimYaw` und der Lock wird freigegeben (Re-Lock per Taste).
- Ziel-Akquise-Politik (nearest / Kegel / Priorität Luft) → §9.

**Determinismus-Konsequenz:** Der *Modus* ist lokale Config; **was** übertragen wird, unterscheidet sich (`aimYaw` bei off/assist, zusätzlich `lockTarget` bei lock) — aber beide Felder existieren bereits im `InputCommand`. **Keine Protokolländerung.**

---

## 5. Bewegung (kamera-relativ)

- Input-Intent ist ein 2D-Vektor im **Screen/Kamera-Raum** (hoch = von der Kamera weg).
- Umrechnung in Weltkoordinaten über den **read-only Yaw** aus `camera.spec`, dann **quantisiert** → `moveIntent`.
- Tastatur (WASD): normalisierter Richtungsvektor, |v| = 1. Analog-Stick: Magnitude bleibt erhalten (Gehen/Rennen).
- Auch hier: die kamera-relative Umrechnung passiert **lokal vor der Quantisierung**; übertragen wird der Welt-Intent.

---

## 6. Aktionen & Buttons

`buttons` = HELD-State pro Tick, `edges` = im Tickfenster aufgetretene Press-Edges (damit schnelle Taps zwischen zwei Ticks nicht verloren gehen). Die Sim leitet Release-Edges deterministisch aus dem Tick-zu-Tick-Diff von `buttons` ab.

Bit-Belegung (Vorschlag):

| Bit | Aktion | Typ |
| --- | --- | --- |
| 0 | Fire — Gun (leicht) | held |
| 1 | Fire — Heavy | held |
| 2 | Fire — Special | held/edge (Manual-Detonation à la FC-Plasma-Flare) |
| 3 | Jump | edge |
| 4 | Transform (walker ↔ pursuit) | edge |
| 5 | Action/Interact | edge |
| 6 | Target-Cycle (Soft-Lock) | edge |

Kauf/Deploy läuft über `deploy` (diskretes Command), nicht über Bits.

---

## 7. Sampling-Disziplin

- Roh-Input wird auf **Render-Rate** gepollt, aber **ein Command pro Sim-Tick latched**.
- Press-Edges innerhalb des Tickfensters werden akkumuliert (OR in `edges`), damit ein Tap kürzer als ein Tick nicht verschwindet.
- **Quantisierung ist die Determinismus-Grenze**: Nach dem Latchen ist der Wert kanonisch. Nie Roh-Float in die Sim.
- Command gilt für Tick `T + inputDelay` (siehe `netcode.spec`).

---

## 8. Lokale Config (nie synchronisiert)

Diese betreffen nur die Produktion `Roh-Input → InputCommand`:
- Keybindings / Gamepad-Mapping
- Maus-Sensitivität, Stick-Deadzones, Invert
- **`aimAssistMode`** (`off` / `assist` / `lock`) + Parameter: `assistConeDeg`, `assistStrength`, Ziel-Akquise-Politik
- (später) weitere Aim-Assist-Feinjustierung

Sie werden **vor** der Quantisierung angewandt. Übertragen wird immer nur das fertige, quantisierte Command → kein Determinismus-Risiko. Der `lock`-Modus sendet zusätzlich `lockTarget`; die Sim löst das Tracking auf (§4.4).

---

## 9. Offene Fragen (Go-Gate)

- [ ] Aim-Repräsentation: reiner Boden-Yaw (16-bit brads) bestätigen, oder brauchen wir doch einen Pitch-Kanal für manuelles Luftzielen? (Empfehlung: Yaw + Auto-Elevation via `lockTarget`.)
- [ ] Soft-Lock: die zwei Modi als `assist` + `lock` bestätigen (neben `off`) — oder anderes Modus-Paar gemeint?
- [ ] Ziel-Akquise-Politik für beide Modi: nächstes / im Kegel / Priorität Luft — und Auto-Reacquire nach Ziel-Verlust im `lock`-Modus (Empfehlung: Freigabe → Free-Aim, Re-Lock per Taste)?
- [ ] Default-Werte für `assistConeDeg` / `assistStrength` (im Playtest zu tunen).
- [ ] Modus-Wechsel: nur im Menü, oder auch per Hotkey mitten im Match?
- [ ] Lokale Sicht-Prädiktion des eigenen Units bei Input-Delay: v1 ohne (Delay niedrig halten) — bestätigen? (Rollback-Pfad entschärft das ohnehin, siehe `netcode.spec`.)
- [ ] `deploy`: Lane-Index vs. freier Punkt — hängt an `map.spec`.
- [ ] Special-Feuer: Held oder Tap-to-fire + Tap-to-detonate (FC-Verhalten)?
