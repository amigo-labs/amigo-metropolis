# Music tracks

The menu's Sound drawer offers three file-based music slots. Drop the actual
files in here as:

- `track1.mp3`
- `track2.mp3`
- `track3.mp3`

They are fetched at runtime (`packages/client/src/audio/tracks.ts` is the
manifest), so adding a file needs no rebuild. Until a file exists, picking its
slot shows a "not found" hint and the selection falls back to Off.

## Licensing

Per `docs/specs/assets.md` §2 there is no license restriction on committed
assets. Still record provenance:

1. Add a row to `CREDITS.md` naming the track, author, source and license.
2. Update the display name in `packages/client/src/audio/tracks.ts` to the
   track's real title, so the Sound drawer shows something meaningful.

The three shipped slots are the tracks that had been sitting unreferenced in
`assets/audio/` — the manifest pointed at files that did not exist, so every
file-music option silently fell back to Off.
