# Music

Each Precinct Assault arena's own track, as the original plays it:
`<Mission>.wav` for Conft, Slim, Mp, Joke, Hk and Ovmp. The engine's format,
unchanged — 8-bit unsigned PCM, stereo, 14260 Hz (`snd_music_open` 0x004324a0
creates the buffer so; the RE repo's `extract_music.py` writes the stream's
bytes as they are fed to it).

Copied byte for byte by `tools/generators/importFcopAudio.ts`; the arena that
plays each is in `src/audio/fcopAudio.generated.ts`. The music starts when a
match has loaded, loops without a fade, stops in the pause and is ducked under
speech, as the original's does.

Provenance in `CREDITS.md`.
