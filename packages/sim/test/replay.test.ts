import { describe, expect, it } from "bun:test";
import { DIFFICULTY_EASY, DIFFICULTY_HARD, DIFFICULTY_NORMAL } from "../src/balance";
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_GUN,
  BTN_HEAVY,
  BTN_JUMP,
  BTN_TURN_LEFT,
  createTickInputs,
} from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import {
  createReplayData,
  decodeReplay,
  encodeReplay,
  FRAME_BYTES,
  REPLAY_FORMAT_VERSION,
  readFrame,
  writeFrame,
} from "../src/replay";
import { simulateReplayHashes } from "../src/runner";
import { createSim, hash, step } from "../src/sim";
import { SIM_VERSION } from "../src/version";
import { EXTRA_WEAPON_K9_DRONE, EXTRA_WEAPON_PLASMA_FLARE } from "../src/weapons";

describe("replay format", () => {
  it("round-trips header and frames byte-exactly", () => {
    const replay = createReplayData("test-128", 0xdeadbeef, 3);
    const inputs = createTickInputs();
    // Move Backward is the word's top bit: the u16 must survive whole.
    inputs.players[0].buttons = BTN_BACK | BTN_GUN | BTN_JUMP;
    inputs.players[1].buttons = BTN_FORWARD | BTN_TURN_LEFT;
    writeFrame(replay, 1, inputs);
    // Little-endian, two bytes a player: 0x8c00 is 00 8c.
    expect([...replay.frames.subarray(FRAME_BYTES, 2 * FRAME_BYTES)]).toEqual([
      0x00, 0x8c, 0x00, 0x50,
    ]);

    const decoded = decodeReplay(encodeReplay(replay));
    expect(decoded.formatVersion).toBe(REPLAY_FORMAT_VERSION);
    expect(decoded.simVersion).toBe(SIM_VERSION);
    expect(decoded.seed).toBe(0xdeadbeef);
    expect(decoded.mapId).toBe("test-128");
    expect(decoded.tickCount).toBe(3);
    expect(decoded.wardenPlayer).toBe(-1);
    expect(decoded.wardenDifficulty).toBe(0);
    expect(decoded.difficulties).toEqual([DIFFICULTY_NORMAL, DIFFICULTY_NORMAL]);
    expect(decoded.frames).toEqual(replay.frames);

    const out = createTickInputs();
    readFrame(decoded, 1, out);
    expect(out.players[0]).toEqual({ buttons: BTN_BACK | BTN_GUN | BTN_JUMP });
    expect(out.players[1].buttons).toBe(BTN_FORWARD | BTN_TURN_LEFT);
    readFrame(decoded, 0, out);
    expect(out.players[0].buttons).toBe(0);
  });

  it("round-trips the Warden config (in the header since format 2)", () => {
    const replay = createReplayData("la-cantina", 7, 2, { player: 1, difficulty: 8 });
    const decoded = decodeReplay(encodeReplay(replay));
    expect(decoded.wardenPlayer).toBe(1);
    expect(decoded.wardenDifficulty).toBe(8);
    expect(decoded.mapId).toBe("la-cantina");
    expect(decoded.tickCount).toBe(2);
  });

  it("round-trips each player's difficulty (in the header since format 4)", () => {
    const replay = createReplayData("venice-beach", 9, 2, undefined, [
      DIFFICULTY_HARD,
      DIFFICULTY_EASY,
    ]);
    const bytes = encodeReplay(replay);
    // One byte a player after the Warden's two, then the extra weapons (20).
    expect([bytes[18], bytes[19], bytes[20]]).toEqual([0, 2, 0]);
    const decoded = decodeReplay(bytes);
    expect(decoded.difficulties).toEqual([DIFFICULTY_HARD, DIFFICULTY_EASY]);
    expect(decoded.mapId).toBe("venice-beach");
    // A missing slot is NORMAL, the original's default.
    expect(createReplayData("m", 1, 0, undefined, [DIFFICULTY_HARD]).difficulties).toEqual([
      DIFFICULTY_HARD,
      DIFFICULTY_NORMAL,
    ]);
  });

  it("rejects a difficulty off the three rows, on either side", () => {
    // Row 3 is the original's debug row: not offered, not carried.
    expect(() => encodeReplay(createReplayData("m", 1, 0, undefined, [3, 1]))).toThrow(
      "bad difficulty 3",
    );
    expect(() => encodeReplay(createReplayData("m", 1, 0, undefined, [1, 0.5]))).toThrow(
      "bad difficulty 0.5",
    );
    expect(() => encodeReplay({ ...createReplayData("m", 1, 0), difficulties: [1] })).toThrow(
      "difficulties needs 2 entries",
    );
    const bytes = encodeReplay(createReplayData("m", 1, 0));
    bytes[19] = 3;
    expect(() => decodeReplay(bytes)).toThrow("bad difficulty 3");
  });

  it("replays a HARD / EASY match from its header alone", () => {
    const replay = createReplayData(LA_CANTINA_ID, 5, 120, undefined, [
      DIFFICULTY_HARD,
      DIFFICULTY_EASY,
    ]);
    const sim = createSim(getMapById(LA_CANTINA_ID), 5, { difficulties: replay.difficulties });
    const inputs = createTickInputs();
    const live: number[] = [];
    for (let t = 0; t < replay.tickCount; t++) {
      inputs.players[0].buttons = t % 40 < 20 ? BTN_FORWARD | BTN_GUN : BTN_TURN_LEFT;
      inputs.players[1].buttons = t % 30 < 15 ? BTN_BACK : BTN_GUN;
      writeFrame(replay, t, inputs);
      step(sim, inputs);
      live.push(hash(sim));
    }
    const decoded = decodeReplay(encodeReplay(replay));
    expect(Array.from(simulateReplayHashes(decoded))).toEqual(live);
    // The same frames as a NORMAL match hash otherwise.
    const normal = { ...decoded, difficulties: [DIFFICULTY_NORMAL, DIFFICULTY_NORMAL] };
    expect(simulateReplayHashes(normal)[0]).not.toBe(live[0]);
  });

  it("rejects out-of-range Warden configs", () => {
    expect(() => encodeReplay(createReplayData("m", 1, 0, { player: 2, difficulty: 5 }))).toThrow(
      "bad wardenPlayer",
    );
    expect(() => encodeReplay(createReplayData("m", 1, 0, { player: 0, difficulty: 11 }))).toThrow(
      "bad wardenDifficulty",
    );
    // Hand-built inconsistent/non-integer headers must throw, not silently
    // normalize (byte writes would truncate fractional values).
    expect(() => encodeReplay({ ...createReplayData("m", 1, 0), wardenDifficulty: 3 })).toThrow(
      "wardenDifficulty set without",
    );
    expect(() =>
      encodeReplay({
        ...createReplayData("m", 1, 0, { player: 0, difficulty: 5 }),
        wardenDifficulty: 5.5,
      }),
    ).toThrow("bad wardenDifficulty");
    expect(() =>
      encodeReplay({ ...createReplayData("m", 1, 0), wardenPlayer: Number.NaN }),
    ).toThrow("bad wardenPlayer");
    const bytes = encodeReplay(createReplayData("m", 1, 0));
    bytes[17] = 3; // difficulty without a warden player (0xff)
    expect(() => decodeReplay(bytes)).toThrow("wardenDifficulty set without");
  });

  it("refuses format 3 replays (no difficulty: every sim since SIM_VERSION 72 reads one)", () => {
    // Format 3 is format 4 without the two difficulty bytes (18/19).
    const f4 = encodeReplay(createReplayData("test-128", 0xc0ffee, 2));
    const f3 = new Uint8Array(f4.length - 2);
    f3.set(f4.subarray(0, 18), 0);
    f3.set(f4.subarray(20), 18);
    f3[4] = 3;
    expect(() => decodeReplay(f3)).toThrow("unsupported replay format version 3");
  });

  it("refuses format 1 and 2 replays (stick and aim axes, 5 bytes a player)", () => {
    // No sim since the button word reads their axes, so both are refused rather
    // than replayed wrong. Build the legacy layouts synthetically: a format 3
    // header (format 4's without its difficulty bytes) stamped 2 with three
    // 10-byte frames, and that file with the two Warden config bytes (16/17)
    // stripped, stamped 1.
    const f4 = encodeReplay(createReplayData("test-128", 0xc0ffee, 0));
    const header = new Uint8Array(f4.length - 2);
    header.set(f4.subarray(0, 18), 0);
    header.set(f4.subarray(20), 18);
    const f2 = new Uint8Array(header.length + 3 * 10);
    f2.set(header, 0);
    f2[4] = 2; // format 2
    f2[5] = 0;
    expect(() => decodeReplay(f2)).toThrow("unsupported replay format version 2");
    const f1 = new Uint8Array(f2.length - 2);
    f1.set(f2.subarray(0, 16), 0); // magic, format, simVersion, seed, tickCount
    f1.set(f2.subarray(18), 16); // mapId length + mapId + frames
    f1[4] = 1; // format 1
    expect(() => decodeReplay(f1)).toThrow("unsupported replay format version 1");
  });

  it("frames are 2 bytes per player, the u16 button word (network format contract)", () => {
    expect(REPLAY_FORMAT_VERSION).toBe(5);
    expect(FRAME_BYTES).toBe(4);
    const replay = createReplayData("m", 1, 7);
    expect(encodeReplay(replay).length).toBe(28 + 1 + 7 * FRAME_BYTES);
  });

  it("rejects bad magic and truncated files", () => {
    const good = encodeReplay(createReplayData("test-128", 1, 2));
    const badMagic = good.slice();
    badMagic[0] = 0x58;
    expect(() => decodeReplay(badMagic)).toThrow("not a MREP replay file");
    expect(() => decodeReplay(good.slice(0, good.length - 1))).toThrow("length mismatch");
  });

  it("rejects over-long and non-ASCII mapIds", () => {
    expect(() => encodeReplay(createReplayData("x".repeat(256), 1, 0))).toThrow("mapId too long");
    expect(() => encodeReplay(createReplayData("täst", 1, 0))).toThrow("must be ASCII");
    const bytes = encodeReplay(createReplayData("test-128", 1, 0));
    bytes[28] = 0xff; // corrupt the first mapId byte past the encoder's check
    expect(() => decodeReplay(bytes)).toThrow("mapId must be ASCII");
  });

  it("round-trips the extra weapons and the loadouts (in the header since format 5)", () => {
    const replay = createReplayData("la-cantina", 3, 1, undefined, undefined, {
      extraWeapons: EXTRA_WEAPON_K9_DRONE | EXTRA_WEAPON_PLASMA_FLARE,
      loadouts: [{ gun: 4, heavy: 3, special: 4 }],
    });
    const bytes = encodeReplay(replay);
    expect(bytes[20]).toBe(0x12);
    expect(Array.from(bytes.subarray(21, 27))).toEqual([4, 3, 4, 0, 0, 0]);
    const decoded = decodeReplay(bytes);
    expect(decoded.extraWeapons).toBe(0x12);
    expect(decoded.loadouts).toEqual([
      { gun: 4, heavy: 3, special: 4 },
      { gun: 0, heavy: 0, special: 0 },
    ]);
    // Bits past the five, and an index past a slot's catalogue, are refused.
    const bad = bytes.slice();
    bad[20] = 0x20;
    expect(() => decodeReplay(bad)).toThrow("bad extraWeapons");
    const badLoadout = bytes.slice();
    badLoadout[21] = 5;
    expect(() => decodeReplay(badLoadout)).toThrow("bad loadout");
    expect(() => encodeReplay({ ...replay, extraWeapons: 0x40 })).toThrow("bad extraWeapons");
  });

  it("replays a match with an extra weapon through the header", () => {
    // The runner hands the header's weapons to createSim: a K-9 Drone is in
    // the air on the replay as it was in the match.
    const replay = createReplayData("test-128", 5, 40, undefined, undefined, {
      extraWeapons: EXTRA_WEAPON_K9_DRONE,
      loadouts: [{ gun: 0, heavy: 3, special: 0 }],
    });
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_HEAVY;
    for (let t = 0; t < 40; t++) writeFrame(replay, t, inputs);
    const decoded = decodeReplay(encodeReplay(replay));
    const sim = createSim(getMapById("test-128"), 5, {
      extraWeapons: decoded.extraWeapons,
      loadouts: decoded.loadouts,
    });
    const want: number[] = [];
    for (let t = 0; t < 40; t++) {
      readFrame(decoded, t, inputs);
      step(sim, inputs);
      want.push(hash(sim));
    }
    expect(Array.from(simulateReplayHashes(decoded))).toEqual(want);
    expect(sim.loadoutHeavy[0]).toBe(3);
    // Without the bit the same header's pick would have been refused.
    const off = createSim(getMapById("test-128"), 5, { loadouts: decoded.loadouts });
    expect(off.loadoutHeavy[0]).toBe(2);
  });
});
