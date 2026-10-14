import { describe, expect, it } from "bun:test";
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_GUN,
  BTN_JUMP,
  BTN_TURN_LEFT,
  createTickInputs,
} from "../src/inputs";
import {
  createReplayData,
  decodeReplay,
  encodeReplay,
  FRAME_BYTES,
  REPLAY_FORMAT_VERSION,
  readFrame,
  writeFrame,
} from "../src/replay";
import { SIM_VERSION } from "../src/version";

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

  it("refuses format 1 and 2 replays (stick and aim axes, 5 bytes a player)", () => {
    // No sim since the button word reads their axes, so both are refused rather
    // than replayed wrong. Build the legacy layouts synthetically: a format 3
    // header stamped 2 with three 10-byte frames, and that file with the two
    // Warden config bytes (16/17) stripped, stamped 1.
    const header = encodeReplay(createReplayData("test-128", 0xc0ffee, 0));
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
    expect(REPLAY_FORMAT_VERSION).toBe(3);
    expect(FRAME_BYTES).toBe(4);
    const replay = createReplayData("m", 1, 7);
    expect(encodeReplay(replay).length).toBe(19 + 1 + 7 * FRAME_BYTES);
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
    bytes[19] = 0xff; // corrupt the first mapId byte past the encoder's check
    expect(() => decodeReplay(bytes)).toThrow("mapId must be ASCII");
  });
});
