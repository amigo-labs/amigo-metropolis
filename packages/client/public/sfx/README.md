# The original's sounds

Future Cop: L.A.P.D.'s own sound files, unchanged:

- `sNNN.wav` — every sample a Precinct Assault sound bank registers: the raw
  `Cwav` RIFF images (22050 Hz, 16-bit, mono, with their `smpl` loop chunks),
  named as the RE repo's `extracted/sfx_v2/` names them.
- `voice/vNNN.wav` — the 86 speech lines of the six arenas' shared voice bank;
  speech id N is `v{N+1:03d}.wav` (8-bit, 22050 Hz, mono).

They are copied byte for byte by `tools/generators/importFcopAudio.ts` from a
checkout of `amigo-labs/fcop-reverse-engineering`. Nothing is trimmed,
normalised or re-encoded: the original has no per-sound level, so a file's own
level is the level it plays at. Which file plays for which event — the script
tables A, B and high, each slot's priority, polyphony, loop, lead-in head and
round-robin variants — comes from the RE's simulation of the retail loader
(`docs/specs/fcop-re/pa-audio.json`), turned into
`src/audio/fcopAudio.generated.ts` by `bun run gen:sfx`, which also fails if a
file the tables name is missing here.

Do not drop files here by hand; re-run the import.

The service worker needs no change: `sw.js` applies stale-while-revalidate to
every same-origin GET, so `/sfx/*` is cached on first use. It is deliberately
not in the `SHELL` precache list, whose `install` fails wholesale on a single
404.

Licensing follows `docs/specs/assets.md` §2 (original Future Cop material
explicitly permitted), with provenance in `CREDITS.md`.
