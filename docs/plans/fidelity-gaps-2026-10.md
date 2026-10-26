# Fidelity gaps after the open items (2026-10-26)

> Status: collected 2026-10-26 after amigo-metropolis#73 (SIM_VERSION 104), when
> `open-items-2026-10.md` groups A–E were worked through. Source: every
> "Not modelled", "Could not establish" and "waits on RE" in
> `docs/specs/fcop-fidelity.md` on `main` fd89483. Each item names its ledger row;
> the row stays the record, this list only orders the work.

The owner's rule stands: only the original counts. Of the ledger's 148 rows, 116
are adopted outright; what follows is what still keeps Metropolis apart from the
original. The order is by how much a player would notice it in a match: first what
changes who wins a fight (the sim, hash-moving), then what changes what one sees,
then what the binary cannot answer.

## 1. Gameplay — the sim (each one a SIM_VERSION bump)

1. **The sustained weapons' damage over time** (W1). The Flamethrower's trail of
   nodes (6 / B 10 per node, ~6.2 m reach, every body in the stream), the
   Concussion Beam's segment hitting every body on it (B adding a 50-point shell
   at each), the Shockwave's expanding band (three to five falling hits). The RE
   has all of it (M3-OR) but the Shockwave's start radius (M3-OK).
   In progress.
2. **Aircraft altitude** (U4, U3). The altitude controller (heading Y, 7/8 decay,
   pitch clamp) in place of the fixed `AIR_ALTITUDE` 6 m, the launch climb (spawn
   flag 4), the bank's speed penalty `(0x200 - tilt) >> 9`; Slim's and Joke's
   accelerating captain missile (0x7a).
3. **The Sky Captain's crash tumble** (U3, A19, V7). The tumble after its down;
   with it the death effects on impact instead of at the death, and the results
   page's serial resolved at its end. The counts' drift from refused spawns.
4. **Ground units on the road net** (U1). The corner window's heading blend and
   inward cut, the one-leg look-ahead, the rear-end contact transfer
   (`cnet_route_contact`), the script-closed node bit.
5. **The X1-Alpha's movement and body** (P4, P5). The head-height ceiling check,
   surface-material damage beyond the bases' floors, the facing snap and the
   wall-hit snap, the contacts' push, the slow row's hold, the legs' model box per
   frame, the crouch's lowered hit box (its bounds pair is open in the RE).
6. **Collision shapes** (G1, I6). The sweep's coarse cylinder and oriented-box
   test in place of one flat circle; a round's own radius in the contact sweep
   (Metropolis 0.5 m); the cockpit partner's sphere; the Dreadnought's reference
   point and cylinder walking with its frame.
7. **Gun pitch** (G12, I6). Turrets and the Dreadnought's guns turn in yaw only.
8. **Smaller sim gaps.** The powered Electric Gun's two extra arcs (P8); type 7's
   range kill for arced rounds (E20); the broad phase's 4 m cell clipping on Hk
   (R12); turrets targeting turrets "by team" (U4, waits on RE).

## 2. Presentation — what one sees (client only, no hash)

9. **Lighting and colour** (G13). The X1's parts under the original's lighting
   (`render/avatarRig.ts` keeps three's); the damaged arms' red (table
   0x00428ff0); the facers' depth sort, the DCSQuads' drawer depth and the frame
   buffer's additive sum.
10. **The console's death on the claim** (G5): sound 83 and its death effects.
11. **The lock beam** (V2): its depth sort and its start on the partner's point 0.
12. **Radar and map screen** (V1, V3, V4). The see-through material bit, the
    record order, the "P" marker's position (RE open), the window's clamp.
13. **Front end** (F10, F16). What surrounds HELP's box; Bug Hunt's finished map
    on "another round"; the online link bit behind the in-game menu.

## 3. Not answerable from the executable

14. **Could not establish** — Metropolis' value stays until someone measures the
    original: the homing turn rate (180°/s) and the HVR's lead (W1); the Sky
    Captain's altitude (7 m) and `word_30/32` (U3); the Shockwave's start radius
    (M3-OK).
15. **Outside the binary**: the dialog fonts' metrics (F14, a Windows 9x
    measurement), the voice lines' text (a listener), and the owner's side-by-side
    look against the original (open item 25), the only check that would show what
    the disassembly cannot.
