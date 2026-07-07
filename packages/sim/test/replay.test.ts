import { describe, expect, it } from "bun:test";
import { BUTTON_FIRE1, BUTTON_JUMP, createTickInputs } from "../src/inputs";
import {
  createReplayData,
  decodeReplay,
  encodeReplay,
  FRAME_BYTES,
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
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.simVersion).toBe(SIM_VERSION);
    expect(decoded.seed).toBe(0xdeadbeef);
    expect(decoded.mapId).toBe("test-128");
    expect(decoded.tickCount).toBe(3);
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

  it("frames are 5 bytes per player (network format contract)", () => {
    expect(FRAME_BYTES).toBe(10);
    const replay = createReplayData("m", 1, 7);
    expect(encodeReplay(replay).length).toBe(17 + 1 + 7 * FRAME_BYTES);
  });

  it("rejects bad magic and truncated files", () => {
    const good = encodeReplay(createReplayData("test-128", 1, 2));
    const badMagic = good.slice();
    badMagic[0] = 0x58;
    expect(() => decodeReplay(badMagic)).toThrow("not a MREP replay file");
    expect(() => decodeReplay(good.slice(0, good.length - 1))).toThrow("length mismatch");
  });
});
