// Pan/gain slot ownership (audio/engine.ts).
//
// The engine needs a real AudioContext to construct, so its node graph is not
// unit-testable here — but the rule that matters is: never hand out a slot whose
// previous source is still playing. Doing so rewrites that sound's pan and volume
// mid-playback, which is how a one-second alarm ends up lurching sideways when a
// burst of shots cycles past it.

import { describe, expect, test } from "bun:test";
import { claimVoiceSlot } from "../src/audio/engine";

describe("voice slot ownership", () => {
  test("hands out the first free slot", () => {
    expect(claimVoiceSlot([null, null, null])).toBe(0);
    expect(claimVoiceSlot(["busy", null, null])).toBe(1);
    expect(claimVoiceSlot(["busy", "busy", null])).toBe(2);
  });

  test("never hands out a slot a live source still owns", () => {
    const owners: (string | null)[] = ["a", "b", "c"];
    expect(claimVoiceSlot(owners)).toBe(-1);
    // -1 makes play() fall back to the unpanned bus: a centred cue rather than a
    // playing cue being stolen out from under itself.
    owners[1] = null;
    expect(claimVoiceSlot(owners)).toBe(1);
  });

  test("reuses a slot only after its source released it", () => {
    const owners: (string | null)[] = [null, null];
    const first = claimVoiceSlot(owners);
    owners[first] = "long-alarm";
    const second = claimVoiceSlot(owners);
    expect(second).not.toBe(first); // the alarm keeps its slot
    owners[second] = "shot";
    expect(claimVoiceSlot(owners)).toBe(-1);
    owners[second] = null; // the shot ended
    expect(claimVoiceSlot(owners)).toBe(second);
  });
});
