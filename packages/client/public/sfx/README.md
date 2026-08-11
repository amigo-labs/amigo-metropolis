# Sound-effect assets

One `.wav` per game cue, named after the cue in
`packages/client/src/audio/presets.ts` — `shot.wav`, `capture.wav` and so on.
Fetched at runtime, so adding one needs no rebuild, exactly like `../music/`.

**This directory is empty, and that is the working state.** Every cue is
rendered at unlock by the clean-room sfxr synth (`src/audio/sfxr.ts`), and the
synth remains the fallback forever. `audio/engine.ts` `loadSfxFiles()` then
replaces only the cues listed in `src/audio/sfxFiles.generated.ts`; a cue with
no file, or one whose file 404s or fails to decode, keeps its synth. So real
sounds can arrive one cue at a time with nothing else to change.

Do not drop files here by hand. They are built from committed raws by
`bun run gen:sfx` (`tools/generators/genSfx.ts`, driven by
`tools/generators/sfx/manifest.ts`), which trims, downmixes to mono and
peak-normalises to −3 dBFS — loudness is baked in, so the runtime only swaps a
buffer. `tools/generators/test/sfxCues.test.ts` asserts the generated lookup
still matches the manifest, so editing the manifest without re-running the
generator fails the suite.

Why the manifest is empty: the 348 unique sounds extracted from the original
game carry no semantic labels, and the chain that would tell us which is which
(`Cshd` sound events → `Cfun` script table) is still open. `Cfun` itself is no
longer the blocker — it has been disassembled against the retail interpreter —
but none of its opcodes is a proven sound-play op, so nothing yet binds an event
to a sound id. Picking is a listening pass — see the manifest header for the
shortlists in the RE repo that narrow 348 down, and issue #27.

The service worker needs no change: `sw.js` applies stale-while-revalidate to
every same-origin GET, so `/sfx/*.wav` is cached on first play. It is
deliberately not added to the `SHELL` precache list, whose `install` fails
wholesale on a single 404 — the opposite of what a per-cue, tolerate-missing
rollout wants.

Licensing follows `docs/specs/assets.md` §2 (no restriction on committed
assets, original Future Cop material explicitly permitted), with provenance in
`CREDITS.md`.
