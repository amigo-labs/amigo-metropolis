# Fidelity gaps after the open items (2026-10-26)

> Status: collected 2026-10-26 after amigo-metropolis#73 (SIM_VERSION 104), when
> `open-items-2026-10.md` groups A–E were worked through. Source: every
> "Not modelled", "Could not establish" and "waits on RE" in
> `docs/specs/fcop-fidelity.md` on `main` fd89483. Each item names its ledger row;
> the row stays the record, this list only orders the work.
> **Worked through 2026-10-26/27** (amigo-metropolis#74, SIM_VERSION 105-116;
> fcop-reverse-engineering#88, RE M3-OU, OV, OW, OZ, PA, PB): every item of
> groups 1 and 2 is done or answered from the binary; what remains is listed under
> "Kept" at the end and in group 3.

The owner's rule stands: only the original counts. Of the ledger's 148 rows, 116
were adopted outright when this list was made; what follows is what still kept
Metropolis apart from the original. The order is by how much a player would notice
it in a match: first what changes who wins a fight (the sim, hash-moving), then what
changes what one sees, then what the binary cannot answer.

## 1. Gameplay — the sim (each one a SIM_VERSION bump)

1. ~~**The sustained weapons' damage over time** (W1).~~ **Done** ("Spread the
   sustained weapons' damage as the original's trails and shells", SIM_VERSION
   105): the Flamethrower's trail of nodes (the lock hit twice a node, 0x0044b2fc
   then the registry loop), the Concussion Beam's segment hitting every body on it
   (B's 50-point shell at each), the Shockwave's expanding band. Its start radius
   stays the client's 0.8 m (M3-OK).
2. ~~**Aircraft altitude** (U4, U3).~~ **Done** ("Fly, climb and crash every
   aircraft as the original does", SIM_VERSION 110): the altitude controller over
   each record's band, the launch climb, the bank's speed penalty, Slim's and
   Joke's accelerating captain missile.
3. ~~**The Sky Captain's crash tumble** (U3, A19, V7).~~ **Done** (the same
   commit; the tumble drawn since SIM_VERSION 114): the tumble, the death effects
   at the landing, the serial resolved there, the count words 27..30.
4. ~~**Ground units on the road net** (U1).~~ **Done** ("Walk the road net with
   the original's route cursor", SIM_VERSION 111; RE M3-OU): the look-ahead, the
   corner window, the Dreadnought's rear-end contact, the closed-node bit (set on
   no PA node).
5. ~~**The X1-Alpha's movement and body** (P4, P5).~~ **Done** (SIM_VERSION 108,
   RE M3-OV: the ceiling, the wall push and snap, the slow row's hold; SIM_VERSION
   113, RE M3-PB: the actors' contacts' push and the player's own contact box).
   Surface damage beyond the bases' floors: none in PA.
6. ~~**Collision shapes** (G1, I6).~~ **Done** ("Meet a body by the original's
   pair test", SIM_VERSION 112; RE M3-OW): sphere, cylinder, hit boxes, each
   round's own model, the cockpit's sphere, the legs and the Dreadnought by frame;
   every collider on its body's matrix since SIM_VERSION 114.
7. ~~**Gun pitch** (G12, I6).~~ **Done** (SIM_VERSION 106): every PA turret
   pitches; no Dreadnought gun does, and their arc is tested in three dimensions.
   The hull's own tilt and Hk's bank since SIM_VERSION 114 (the ledger's surface
   blend is route flag 0x200, which no PA record carries).
8. ~~**Smaller sim gaps.**~~ **Done** (SIM_VERSION 107: the powered Electric
   Gun's jump, type 7's range kill, the capture cells, turrets against turrets;
   SIM_VERSION 109: the powered Mortar's shell flying on past its burst, the
   fragments' spread).

## 2. Presentation — what one sees (client only, no hash)

9. ~~**Lighting and colour** (G13).~~ **Done** (RE M3-OZ): the X1 under the
   original's light, a hit actor red for one frame, facers and DCSQuads at their
   sort keys' depth, the bloom frame in display values.
10. ~~**The console's death on the claim** (G5).~~ **Answered** (RE M3-PA): it
    dies silently, no effect; byte 0x53 is its radar marker, not a sound.
11. ~~**The lock beam** (V2).~~ **Done**: in the scene, additive, from the
    cockpit's point 0.
12. ~~**Radar and map screen** (V1, V3, V4).~~ **Done**: the see-through plates,
    the load's order at the frame's start, the "P" at 4x its arrow, the window's
    clamp, the arrows on the models' boxes.
13. ~~**Front end** (F10, F16).~~ **Done / answered**: HELP's surround is black
    in the original too; Bug Hunt's finished map returns to the front end; the
    link bit acts only on a next online round, which Metropolis does not have.

## 3. Not answerable from the executable

14. **Could not establish** — Metropolis' value stays until someone measures the
    original: the homing turn rate (180°/s) and the HVR's lead (W1); the Sky
    Captain's `word_30/32` (U3); the Shockwave's start radius (M3-OK). (The
    captain's altitude is the record's band since SIM_VERSION 110.)
15. **Outside the binary**: the dialog fonts' metrics (F14, a Windows 9x
    measurement), the voice lines' text (a listener), and the owner's side-by-side
    look against the original (open item 25), the only check that would show what
    the disassembly cannot.

## Kept (deliberate, written in the ledger)

- A route hold that lands exactly on zero restores the top speed (U1): at
  lockstep's fixed frame delta the original's "past zero" would never restart a
  held tank.
- THRASH's texel x colour combine is the 3D driver's, not the game's (G13).
- The in-game menu's link bit (F16): online play is a platform exception.
- Fixed-point rounding where the sim works in floating metres (each row names it).
