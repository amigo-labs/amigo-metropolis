// The alert events speak the original's voice lines (fcop-fidelity.md R15,
// docs/specs/fcop-re/ai-and-rules.md §6). Speech id N is the RE repo's
// extracted/voice/wav/v{N+1:03d}.wav; the lines are per side, and the client plays
// the one for the side the event concerns, as the original's scripts do.

import { describe, expect, test } from "bun:test";
import {
  EV_ALARM,
  EV_BREACH,
  EV_HIT,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_SHOT,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
} from "@metropolis/sim";
import { cueForEvent, voiceForEvent } from "../src/audio/engine";
import { GLOBAL_CUES, PRESETS } from "../src/audio/presets";
import { SFX_FILES } from "../src/audio/sfxFiles.generated";

describe("alert cues", () => {
  test("intrusion speaks the intruded side's line (speech 2 / 3)", () => {
    expect(cueForEvent(EV_ALARM, 0, 0, 0)).toBe("vo_intrusion_0");
    expect(cueForEvent(EV_ALARM, 0, 0, 1)).toBe("vo_intrusion_1");
  });

  test("a base turret under fire / lost speaks its side's line (4 / 5, 0 / 1)", () => {
    expect(cueForEvent(EV_TURRET_UNDER_FIRE, 7, 0, 0)).toBe("vo_turret_fire_0");
    expect(cueForEvent(EV_TURRET_UNDER_FIRE, 7, 1, 0)).toBe("vo_turret_fire_1");
    expect(cueForEvent(EV_TURRET_LOST, 7, 0, 3)).toBe("vo_turret_lost_0");
    expect(cueForEvent(EV_TURRET_LOST, 7, 1, 3)).toBe("vo_turret_lost_1");
  });

  test("a breach keeps its fanfare and adds the reached gate's line (6 / 19)", () => {
    expect(cueForEvent(EV_BREACH, 5, 0, 0)).toBe("breach");
    // b is the WINNING team: team 0 winning means slot 1's gate was reached.
    expect(voiceForEvent(EV_BREACH, 5, 0, 0)).toBe("vo_gate_1");
    expect(voiceForEvent(EV_BREACH, 5, 1, 0)).toBe("vo_gate_0");
    expect(voiceForEvent(EV_SHOT, 0, 0, 0)).toBe("");
    expect(cueForEvent(EV_HIT, 0, 0, 0)).toBe("hit");
  });

  test("a purchase press is answered with an accept or a refuse sound (R17)", () => {
    expect(cueForEvent(EV_PURCHASE, 9, 0, 1)).toBe("purchase");
    expect(cueForEvent(EV_PURCHASE_REFUSED, 0, 0, 1)).toBe("refuse");
    expect(cueForEvent(EV_PURCHASE_REFUSED, 0, 1, -1)).toBe("refuse"); // a claim
    expect(PRESETS.refuse).toBeDefined();
    expect(GLOBAL_CUES.has("refuse")).toBe(true); // UI feedback, like the accept
  });

  test("every voice cue has a synth stand-in, plays centred and has its original file", () => {
    const voices = [
      "vo_intrusion_0",
      "vo_intrusion_1",
      "vo_turret_fire_0",
      "vo_turret_fire_1",
      "vo_turret_lost_0",
      "vo_turret_lost_1",
      "vo_gate_0",
      "vo_gate_1",
    ];
    for (const cue of voices) {
      expect(PRESETS[cue]).toBeDefined();
      expect(GLOBAL_CUES.has(cue)).toBe(true);
      expect(SFX_FILES[cue]).toBe(`/sfx/${cue}.wav`);
    }
  });
});
