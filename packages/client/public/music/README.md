# Music tracks

The menu's Sound drawer offers three file-based music slots. Drop the actual
files in here as:

- `track1.mp3`
- `track2.mp3`
- `track3.mp3`

They are fetched at runtime (`packages/client/src/audio/tracks.ts` is the
manifest), so adding a file needs no rebuild. Until a file exists, picking its
slot shows a "not found" hint and the selection falls back to Off.

## Licensing — required before committing any file

This repository is public. Per `docs/specs/assets.md` §5, committed tracks must
be **CC0 or CC-BY** only:

1. Add a row to `CREDITS.md` naming the track, author, source URL, and license.
2. Update the display name in `packages/client/src/audio/tracks.ts` to the
   track's real title.

No purchased packs, no ripped material, no modified Future Cop assets.
