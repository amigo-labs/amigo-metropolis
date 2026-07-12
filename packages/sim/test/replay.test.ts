import { describe, expect, it } from "bun:test";
import { BUTTON_FIRE1, BUTTON_JUMP, createTickInputs } from "../src/inputs";
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
    inputs.players[0].moveX = -127;
    inputs.players[0].moveY = 5;
    inputs.players[0].aimX = 127;
    inputs.players[0].aimY = -1;
    inputs.players[0].buttons = BUTTON_FIRE1 | BUTTON_JUMP;
    inputs.players[1].moveX = 33;
    writeFrame(replay, 1, inputs);

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
    expect(out.players[0]).toEqual({
      moveX: -127,
      moveY: 5,
      aimX: 127,
      aimY: -1,
      buttons: BUTTON_FIRE1 | BUTTON_JUMP,
    });
    expect(out.players[1].moveX).toBe(33);
    readFrame(decoded, 0, out);
    expect(out.players[0].moveX).toBe(0);
  });

  it("round-trips the Warden config (format 2 header)", () => {
    const replay = createReplayData("district-01", 7, 2, { player: 1, difficulty: 8 });
    const decoded = decodeReplay(encodeReplay(replay));
    expect(decoded.wardenPlayer).toBe(1);
    expect(decoded.wardenDifficulty).toBe(8);
    expect(decoded.mapId).toBe("district-01");
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

  it("still decodes format 1 replays (pre-Warden header, no config bytes)", () => {
    // The goldens were re-recorded as format 2 with the v8 bump, so build the
    // legacy layout synthetically: encode format 2 without a Warden, strip
    // the two config bytes (16/17) and stamp format 1.
    const f2 = encodeReplay(createReplayData("test-128", 0xc0ffee, 3));
    const f1 = new Uint8Array(f2.length - 2);
    f1.set(f2.subarray(0, 16), 0); // magic, format, simVersion, seed, tickCount
    f1.set(f2.subarray(18), 16); // mapId length + mapId + frames
    f1[4] = 1; // format 1
    f1[5] = 0;
    const decoded = decodeReplay(f1);
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.mapId).toBe("test-128");
    expect(decoded.wardenPlayer).toBe(-1);
    expect(decoded.wardenDifficulty).toBe(0);
    expect(decoded.tickCount).toBe(3);
  });

  it("frames are 5 bytes per player (network format contract)", () => {
    expect(FRAME_BYTES).toBe(10);
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
