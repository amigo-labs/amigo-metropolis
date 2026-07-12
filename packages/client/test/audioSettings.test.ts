// The persisted audio settings must survive round-trips, malformed storage,
// and — critically — legacy payloads written before the music track picker
// existed (3-field JSON, no `track`): those users heard nothing (music volume
// defaulted to 0), so they must keep parsing to track "off".

import { describe, expect, test } from "bun:test";
import { parseAudioSettings } from "../src/audio/engine";
import { MUSIC_OPTIONS, parseMusicSelection } from "../src/audio/tracks";

describe("parseAudioSettings", () => {
  test("null storage yields defaults with music off and no track", () => {
    const s = parseAudioSettings(null);
    expect(s).toEqual({ master: 0.8, sfx: 1, music: 0, track: "off" });
  });

  test("legacy 3-field JSON parses with track off, volumes preserved", () => {
    const s = parseAudioSettings('{"master":0.5,"sfx":0.25,"music":0.9}');
    expect(s).toEqual({ master: 0.5, sfx: 0.25, music: 0.9, track: "off" });
  });

  test("a stored track selection round-trips", () => {
    const stored = { master: 0.8, sfx: 1, music: 0.6, track: "track2" };
    expect(parseAudioSettings(JSON.stringify(stored))).toEqual(stored);
    expect(parseAudioSettings(JSON.stringify({ ...stored, track: "synth" })).track).toBe("synth");
  });

  test("garbage track values fall back to off", () => {
    expect(parseAudioSettings('{"track":"mixtape"}').track).toBe("off");
    expect(parseAudioSettings('{"track":42}').track).toBe("off");
  });

  test("malformed JSON and wrong types yield defaults", () => {
    expect(parseAudioSettings("not json{")).toEqual(parseAudioSettings(null));
    expect(parseAudioSettings('{"master":"loud"}').master).toBe(0.8);
  });

  test("volumes are clamped to [0,1]", () => {
    const s = parseAudioSettings('{"master":7,"sfx":-3,"music":1.5}');
    expect(s.master).toBe(1);
    expect(s.sfx).toBe(0);
    expect(s.music).toBe(1);
  });
});

describe("parseMusicSelection", () => {
  test("accepts every manifest id and rejects everything else", () => {
    for (const opt of MUSIC_OPTIONS) expect(parseMusicSelection(opt.id)).toBe(opt.id);
    for (const bad of ["", "TRACK1", null, undefined, 3, {}]) {
      expect(parseMusicSelection(bad)).toBe("off");
    }
  });
});
