# Decoding `Cfun` — the plan (EXECUTED; three claims retracted)

Goal: recover the **Precinct Assault rule set** from the original's mission
bytecode, so rules like "how does a pad get captured" come from the game instead
of from us.

Work happens in `amigo-labs/fcop-reverse-engineering`. This document is the
plan; the findings belong in that repo's `README.md` table and its
`extracted/handoff/`, and only then flow into `docs/specs/fcop-logic.md` here.

House rule, taken from that repo's own probe tooling: *nothing here is proven —
every claim ships with its method and its counter-argument.* A statistical lead
is a lead, not a fact.

---

## Outcome — read this before the plan below

The plan ran. Findings: `extracted/handoff/cfun_decode.md` in the RE repo
(313 lines, method and counter-argument per claim), tooling
`tools/gfx/cfun_disasm.py` + `probe_cfun_rules.py`.

**The headline answer is negative, and it is the useful part: the capture rule
is not in `Cfun`.** The one `MapObjectiveNodeGroup` id per arena (263/264) does
not appear as an operand **anywhere in all six arenas' bytecode**. Whatever
governs a pad changing hands, it is not a reference to that actor. So
`rules.md` §9's "Capture rules themselves are unchanged" stays *our* rule, and
now says so with a citation instead of an open question.

The same house rule that demands a counter-argument demands retractions. Three
claims below did not survive:

1. **§1's "the reader works; the dictionary is missing" was wrong.** The reader
   did not work. The FC:MIT reading `<varlen><3 opcode bytes>` closes only
   **210 of 439** code blocks; it is not a general decoder, it is the one case
   FC:MIT needed. The correct reading — `<number> ( <variable-length opcode>
   <number> )*`, numbers 7 bits per byte MSB-first, terminated by a high-bit
   byte *or* by `0x00` which contributes 0 and is consumed — closes **431**.
   Getting that `0x00` case wrong is exactly where FC:MIT's version fails.
2. **§2's hypothesis is falsified.** The scripts do *not* differ only in base
   actor ids: Mp against Slim differs in **52 of 57** functions — shifted
   periods, different operand quartets, an extra token pair in five parameter
   blocks. They are parameterised copies of one rule set, not one file with ids
   swapped. What the hunch got right: **`fn05` carries the base actor id** in
   all six arenas (57 on Mp/Conft/Hk/Ovmp, 23 on Slim/Joke).
3. **§3's timing bands are withdrawn, not reworded.** "Band E ≈ 5 s is the
   production cadence" does not hold. Mp's `fn30`/`fn31` sit at 300/305
   (4.93 s), but the *same two functions* in the Slim/Joke script carry
   **150/153** (2.46 s) at otherwise equal structure. A cadence that doubles
   between arenas is not a global production rule — and those functions'
   operands are `type_14`/`DynamicProp` pairs, not `TeamBase` ids. The 5-second
   agreement with `spawnTicks: 300` was a coincidence I read as a cross-check.

What held: `Cfun` is overwhelmingly a multiplayer structure (§0's table), six
arenas share four byte-identical scripts (§2's table), and the disassembler's
self-test passes — Mp/Conft and Slim/Joke come out token-identical function for
function, which is the check §2 asked for.

Also found along the way, outside `Cfun` and outside this plan's scope: **the
weapon table** (EXE + `febmp.bin` front-end panels), which closes #31's
"not found". Its ids are a **different id space** from `BaseShooter.weapon_id`,
so it applies to the player's loadout and not to turrets.

The plan as written follows, unedited apart from this section, because the
retractions only make sense next to what they retract.

---

## 0. Correct a wrong claim first

`docs/specs/fcop-logic.md` currently says, twice:

> `Cfun` (mission scripting bytecode) is **not** decoded — 7-bit var-length
> encoding, deferred. **Single-player only; out of scope for Metropolis MP.**

> campaign missions and the `Cfun` mission VM are ignored.

Both halves are wrong, and the second one is why nobody looked.

Measured on the committed extract (`extracted/data/<mission>/fun.json`):

| mission | kind | functions | text bytes |
|---|---|---|---|
| Mp (la-cantina) | **MP** | **57** | 1972 |
| Conft (urban-jungle) | **MP** | **57** | 1972 |
| Slim (proving-ground) | **MP** | **57** | 1956 |
| Joke (bug-hunt) | **MP** | **57** | 1956 |
| Ovmp (venice-beach) | **MP** | **57** | 1988 |
| Hk (hollywood-keys) | **MP** | **59** | 1992 |
| M1a1 | campaign | 3 | 40 |
| Lax1 | campaign | 1 | 56 |

`Cfun` is overwhelmingly a **multiplayer** structure. The campaign missions
carry 1–3 functions; every PA arena carries 57–59. Whatever drives Precinct
Assault is in there.

Fix the two sentences as part of this work, with the table as the evidence.

---

## 1. What is already done, and what is actually open

From the RE repo's own status table:

- **Done:** the `Cfun` container. `parse_cfun` in `tools/gfx/extract_data.py`
  reads the `NUFt` header and the 20-byte function records
  (`repeat`, `time_units`, `param_offset`, `code_offset`) into `fun.json`.
- **Done:** the bytecode *walk*. `tools/gfx/probe_sfx_triggers.py` implements
  the FC:MIT `FUNResource.cpp` layout — `tEXT` blob, instruction stream of
  `<7-bit varlen number><3 opcode bytes>` — and validates the walk against the
  one documented opcode, `c7 80 3c` = spawn actor.
- **Done:** a precedent for reading operands statistically. That probe showed
  the operand of `27 0c 00` is a sound `script_id` at 13/13 against a 2.9 %
  base rate, p≈1e-20.
- **Open:** the opcode vocabulary. Two of them are interpreted. Everything the
  PA rule set does is in the rest.

So this is not a from-scratch format dig. The reader works; the dictionary is
missing.

---

## 2. The lever: six arenas, four scripts

Hashing the **raw `Cfun` payload** (not just the parsed table) per mission:

| mission | payload | sha (first 20) | base actor ids | neutrals |
|---|---|---|---|---|
| Mp | 3132 B | `90d770edab5a08bb90fd` | 7, 57 | 32 |
| Conft | 3132 B | `90d770edab5a08bb90fd` | 7, 57 | 32 |
| Slim | 3116 B | `bf3919de6175c44a4b06` | **17, 23** | 29 |
| Joke | 3116 B | `bf3919de6175c44a4b06` | **17, 23** | 29 |
| Hk | 3192 B | `808b03b532b397375c1a` | 7, 57 | 35 |
| Ovmp | 3148 B | `c69d03f739b0bebe738a` | 7, 57 | 39 |
| M1a1 (campaign) | 120 B | — | — | — |

**Mp and Conft are byte-identical. So are Slim and Joke.** Six arenas, four
distinct scripts.

Two things follow, and they pull in opposite directions — which is why the
disassembler has to come first.

**Mp and Conft share a script AND share their actor id layout** (bases 7/57,
spawns 12/16, and the same `NeutralTurret` ids), while their geometry is
completely different. So the script holds *rules*, not placement — and it can
still reference actors by id, because the ids are a shared template.

**The script pairing tracks the base actor ids exactly**: Mp/Conft have bases
7/57, Slim/Joke have 17/23, and that is the same split as the script hashes.
That suggests the A↔B difference might be little more than those ids.

**Attractive, and untested.** A raw byte diff of Mp against Slim shows 1759
differing positions, but that number means nothing: the payloads differ by 16
bytes in length, so everything after the first insertion is shifted and compared
against the wrong offset. Settling it needs a *structural* diff of disassembled
instruction streams, which is step 1 → step 2 below. Recorded here as the
hypothesis to test first, not as a finding.

If it holds, it hands over the base-actor-id opcode on day one with no
statistics at all. If it does not, the four scripts differ in rules too, and
that is worth knowing before anything else.

---

## 3. A second lever: the timing bands already line up with known numbers

`time_units × 0.016424851 s` (FC:MIT `FUNCTION_TIME_UNITS_TO_SECONDS`) over
Mp's 57 functions does **not** produce 57 arbitrary cadences. It produces tight
bands of near-consecutive values:

| band | values | seconds | count |
|---|---|---|---|
| A | 5 | 0.082 | 3 |
| B | 40–65 | 0.66 – 1.07 | 21 |
| C | 81–89 | 1.33 – 1.46 | 9 |
| D | 195–204 | **3.20 – 3.35** | 9 |
| E | 300, 305 | **4.93 – 5.01** | 3 |

Consecutive values inside a band (52, 53, 54, 55…) read as **stagger**: the same
logical rule instantiated per pad/team/slot with a one-unit offset so they do not
all fire on the same frame. That is a hypothesis, and §5 says how to kill it.

Two bands are worth naming out loud:

- **Band E ≈ 5 s** matches the production cadence we already import from a
  completely different place — the `TeamBase` actor's `spawnTicks: 300` at the
  original's 60 Hz. Two independent encodings landing on the same 5 s is a real
  cross-check, and it is the first thing to verify because we already know the
  answer.
- **Band D ≈ 3.2 s** is where a capture timer would sit. Our own invented rule
  (`CAPTURE_TICKS = 90`, 3 s) may be closer to the original than
  `rules.md` admits — or band D may be something else entirely. Do not write
  either into a spec until §5 has run.

`repeat` splits 44 × `-1` (run forever) against 13 × `1` (one-shot). The
one-shots are the natural candidates for mission init.

---

## 4. Work plan

**Step 1 — dump the instruction stream.** Generalise the walker out of
`probe_sfx_triggers.py` into `tools/gfx/cfun_disasm.py`: per mission, per
function, emit `[(varlen operand, opcode triple)]` plus the raw parameter block
at `param_offset`. Output `extracted/data/<mission>/fun_code.json` and a
readable listing. Validate exactly as the probe does — the walk must land on
`c7 80 3c` where the probe already finds it, and must consume each function's
code range with no trailing garbage. A walk that does not close cleanly is a
walk that is wrong.

**Step 2 — the structural diff, and §2's hypothesis.** Diff the *disassembly*
across the four distinct scripts, aligned by instruction rather than by byte
offset. Two checks, in order:

- **Self-check:** Mp against Conft must come out empty. Their payloads are
  byte-identical, so any difference means the disassembler is not deterministic
  and step 1 is broken.
- **The hypothesis:** does script A differ from script B only in operands
  carrying `7`/`57` against `17`/`23`? If yes, those opcodes take a base actor
  id, established without a single p-value. If no, record what else moves —
  that is the first real look at what varies between rule sets.

Then emit the three-way split: identical across all four scripts (the shared
rule set), varying (per-arena parameterisation), and unique to one mission.

**Step 3 — the opcode census.** Histogram every opcode triple, with its
frequency, its operand range, and which band of functions it appears in. Two
known entries anchor the table. A triple appearing exactly 32 times on Mp and 29
times on Slim is a per-pad operation and names itself.

**Step 4 — correlate operands against tables we already have.** This is the
method the sound probe proved out, applied to the structures we know:
actor ids from `actors.json`, `NeutralTurret` (36) ids, `TeamBase` (28) ids,
`MapObjectiveNodeGroup` (35) ids, `Cnet` node ids, the `Cshd` script ids. For
each opcode, test whether its operand distribution is drawn from one of those id
sets against a base rate. Report p-values, and report the misses too.

`MapObjectiveNodeGroup` deserves particular attention: `fcop-logic.md` already
describes it as a "capture/strongpoint marker group, 2 states/team variants,
confidence: medium", and it is currently **ignored** by the importer. If the
capture rule is anywhere, it touches this actor type.

**Step 5 — falsify the band hypothesis.** Band E should be the base production
rule. Check it: do the band-E functions reference `TeamBase` actor ids, and does
the count match two bases? If band E turns out to be something else, the whole
band reading in §3 is wrong and must be withdrawn, not quietly reworded.

**Step 6 — write up.** Per finding: the claim, the method, the numbers, the
counter-argument, and a confidence level. Same shape the RE repo already uses.
Only findings at high confidence cross into `fcop-logic.md` here.

---

## 5. What would make this fail

Named up front so the work can stop early instead of drifting:

- **The rules may not be in `Cfun` at all.** The 57 functions could be
  presentation — HUD, sound, camera — with the PA rules compiled into the
  executable. Step 3's census settles this quickly: no per-pad-count opcode
  means no per-pad rule, and the honest outcome is "the rule set is not in the
  data we have".
- **Operand correlation needs enough samples.** The sound probe got p≈1e-20 off
  13 hits. A rule that appears twice per mission will not reach significance,
  and a weak correlation must be reported as weak.
- **FC:MIT is a second-hand source.** The varlen codec and the 20-byte record
  come from someone else's reimplementation. The walk validating against the
  spawn opcode is good evidence it is right, not proof.
- **`time_units` may not be a cadence for every record.** §3 assumes it is. The
  stagger pattern supports it; step 5 is what tests it.

---

## 6. What this repo does with the result

Nothing automatically. Concretely, in order of likely value:

1. **The capture rule.** `rules.md` §9 says "Capture rules themselves are
   unchanged", which reads like fidelity but means "we kept our §5 invention".
   Whatever step 4 finds either replaces it or is recorded as a deliberate,
   *declared* deviation the way the weapon table and the alert cue already are.
2. **`MapObjectiveNodeGroup` (35)**, currently dropped on the floor by
   `enrichArena.ts`.
3. **Scoring and production**, against the numbers in `balance.ts`.

Every one of those moves map data or sim behaviour, so each is its own commit
with its own golden regeneration — none of it rides along with a decode.
