# SPEC — Netcode & Determinism (amigo-metropolis)

> Ziel-Repo: `amigo-metropolis` · Ort: `docs/specs/netcode.spec.md`
> Status: Draft v0.1 · Go-Gate offen (§9)
> Verwandt: `input.spec` (definiert `InputCommand`), `camera.spec` (render-only, nie synchronisiert)

---

## 1. Ziel & Modell

Deterministisches **Lockstep** über eine **Cloudflare Durable Object**-Relay. Kern-Setup ist 1v1 (Precinct Assault). Die Sim läuft **auf den Clients**; die DO koordiniert Inputs und ordnet Ticks. Bei Lockstep synchronisieren wir **nur Inputs**, nie Weltzustand — das setzt **harten Determinismus** voraus. Ein Desync = ruiniertes Match, daher ist Determinismus Entscheidung Nr. 1.

---

## 2. Determinismus-Substrat (die kritische Entscheidung)

### Problem
- IEEE-754-Grundoperationen (`+ − × ÷ sqrt`) sind spezifiziert und plattformübergreifend konsistent.
- **Transzendente Funktionen** (`Math.sin/cos/tan/atan2/exp/pow/hypot`) sind **nicht** bit-identisch über JS-Engines/OS/CPU — die Spec erlaubt implementierungsdefinierte Ergebnisse. Genau hier desyncen Lockstep-Titel still.

### Empfehlung: **Fixed-Point-Integer-Simulation**
Der einzige Ansatz mit **harter** Cross-Plattform-Garantie.

- Sim-State vollständig in **Integern** (kein Float im Sim-Pfad).
- Repräsentation: **Q16.16** (32-bit) als Default. Multiplikation braucht 64-bit-Zwischenschritt → `BigInt` **oder** High/Low-Split; Addition/Subtraktion in `| 0`-Range, `Math.imul` wo sinnvoll. Wertebereiche/Overflow explizit dokumentieren.
- **Winkel als 16-bit brads** (0..65535 = ein Turn) — passt zum `aimYaw` aus `input.spec`.
- Deterministische Mathe-Lib:
  - `sqrt`: Integer-Newton-Raphson.
  - `sin/cos`: **LUT** mit fixed-point-Interpolation (identische Tabelle auf allen Clients).
  - `atan2`: fixed-point-Approx/LUT.
- **RNG**: geseedeter Integer-PRNG (PCG/xorshift), **Teil des Sim-State**, nur im Sim-Tick fortgeschrieben. Kein `Math.random` in der Sim.

### Starke Alternative: **Rust → WASM als Sim-Core**
Empfohlen zu prüfen, weil es exzellent zu deinem Stack passt:
- Integer-Fixed-Point in Rust ist trivial deterministisch, portabel und schnell.
- Wiederverwendbar in der DO (Workers unterstützen WASM) für einen späteren **server-seitigen Shadow-Sim** (Anti-Cheat).
- Synergie mit `amigo-engine` (deterministische Rust-Sim, dein bestehender Muskel).
- Trade-off: WASM/JS-Bridge + Build-Komplexität vs. reiner TS-Sim. Bei „TS-Sim" bleibt Fixed-Point Pflicht.

### Determinismus-Hygiene (gilt für beide Wege)
- Keine `Date.now()`/`performance.now()`/Locale/Async-Reihenfolge im Sim-Pfad.
- **Stabile Iterationsreihenfolge**: nur Arrays mit deterministischer Sortierung; Entity-IDs deterministisch vergeben; keine Ordnung über unsortierte Strukturen.
- Kosmetik (Partikel, Audio, UI) nutzt eine **separate** Nicht-Sim-RNG, damit sie die Sim niemals stören kann.

---

## 3. Sim/Render-Schleife (Client)

- **Fixer 30-Hz-Akkumulator** für die Sim. Render über `rAF` mit variablem `dt`.
- Render **interpoliert** zwischen den zwei jüngsten Sim-Snapshots (Alpha) — Kamera folgt dem interpolierten Zustand (`camera.spec`).
- Die Sim läuft **nie** direkt auf `rAF`-`dt`.

---

## 4. Lockstep-Verfahren

### Empfehlung: **Delay-based Lockstep, rollback-ready** (v1)
- Alle Clients rücken Tick `N` erst vor, wenn die Inputs **aller** Spieler für `N` vorliegen.
- **Input-Delay** `D` (Ticks) versteckt Latenz: lokaler Input für jetzt gilt für Tick `T + D`. Start: **D = 2–3** (≈ 66–100 ms). Später adaptiv möglich.
- Begründung: Precinct Assault ist Action, aber kein Frame-1-Twitch, und der Kern ist 1v1 — delay-based ist einfacher **korrekt** hinzubekommen als Rollback und hat bei niedrigem `D` akzeptables Gefühl.

### Rollback-ready von Tag 1
Auch wenn v1 nicht zurückrollt: Die Sim **muss** von Anfang an unterstützen:
- **Save/Restore** des kompletten Sim-State in O(kompakt) — bei Fixed-Point-Integer-State trivial serialisierbar.
- **Re-Simulation** ab einem Snapshot über einen Input-Log.

Damit ist der Upgrade auf **GGPO-artiges Rollback** (Prädiktion remoter Inputs → bei Abweichung zurückrollen + neu simulieren) später ein additiver Schritt, kein Rewrite. Das entschärft dann auch den Input-Delay.

---

## 5. Rolle des Durable Object

Die DO ist **autoritativer Relay + Input-Orderer + Tick-Barriere**, **kein** vollwertiger Sim-Server (Sim bleibt auf den Clients, DO bleibt billig).

Verantwortlich für:
- Match-/Session-Lifecycle, Mitgliedschaft, **Seed- und Config-Verteilung** (beide Clients starten bit-identisch).
- Empfang der per-Tick-`InputCommand`s, Ordnung/Stempelung, **Broadcast des bestätigten Input-Sets** je Tick.
- Tick-Kadenz/Laggard-Handling (Input-Timeout → definierter Fallback: „letzten Input wiederholen" oder kurz pausieren).
- **Desync-Detection** (§7): periodische State-Hashes einsammeln und vergleichen.
- **Input-Log** für Reconnect/Late-Join (§8).

Transport: **WebSocket** zur DO (Hibernation-API für Kosten prüfen).

### Sicherheits-Trade-off (bewusst)
- Reines Relay heißt: ein Client könnte illegale Inputs senden. v1 akzeptiert das (Vertrauensmodell).
- Upgrade-Pfad: DO validiert Input-**Ranges** (leichtgewichtig) oder betreibt einen **Shadow-Sim** mit demselben deterministischen Core (WASM in der DO). Deshalb ist der Rust→WASM-Core (§2) auch hier attraktiv.

---

## 6. Was synchronisiert wird — und was nicht

| Synchronisiert (deterministisch, Lockstep) | Lokal (nie synchronisiert) |
| --- | --- |
| `InputCommand`s (siehe `input.spec`) | Kamera (`camera.spec`) |
| Seed, Match-Config | Audio, Partikel, kosmetische RNG |
| Tick-Nummern | UI, lokale Config/Keybindings |
| periodische State-Hashes | Sicht-Prädiktion (falls, render-only) |

---

## 7. Desync-Detection & Recovery

- Alle **N Ticks** (Start: N = 30 ≈ 1 s) berechnet jeder Client einen **Hash des vollständigen Sim-State** (Fixed-Point → stabiler Hash, z. B. FNV-1a/xxhash über den serialisierten Integer-State) und schickt ihn an die DO.
- DO vergleicht. **Mismatch → Desync**: Match abbrechen, beide States für Diffing dumpen (Dev-Tooling).
- Billig, aber essentiell — die einzige verlässliche Sicherung gegen stillen Determinismus-Drift.

---

## 8. Reconnect / Late-Join

- Da die Sim deterministisch ist und die DO **Seed + Config + Input-Log** hält, holt ein zurückkehrender Client auf, indem er ab dem letzten **Checkpoint-Snapshot** den Input-Log **schnell durchsimuliert** (Fast-Forward).
- Periodische Checkpoints (State-Snapshot alle K Sekunden) begrenzen die Replay-Länge.
- Spectator-Late-Join analog.

---

## 9. Offene Fragen (Go-Gate)

- [ ] Substrat final: **TS-Fixed-Point** oder **Rust→WASM-Core**? (Empfehlung: Rust→WASM prüfen — Determinismus-Garantie, DO-Wiederverwendung, `amigo-engine`-Synergie.)
- [ ] Lockstep: delay-based v1 mit `D = 2–3` bestätigen; Rollback als v2 einplanen?
- [ ] Laggard-Fallback: Input-Wiederholung vs. Pause?
- [ ] Fixed-Point-Format: Q16.16 ausreichend, oder brauchen große Karten/Präzision Q-größer bzw. 64-bit?
- [ ] Checkpoint-Intervall K und Hash-Intervall N festlegen.
- [ ] Anti-Cheat: v1 reines Vertrauens-Relay akzeptieren, Shadow-Sim als v2?
