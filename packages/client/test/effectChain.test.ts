// effects/chain.ts: the install and the instance timers, against the records
// la-cantina (Mp) ships. Every number below is one of those records' own.

import { describe, expect, test } from "bun:test";
import {
  EffectChain,
  type EffectListener,
  fxArenaFor,
  makeRaiseAt,
  type RaiseAt,
  ROUND_TOKEN,
} from "../src/effects/chain";
import type { FxRecord } from "../src/effects/records";

interface Install {
  tick: number;
  bank: number;
  id: number;
  repeat: boolean;
  attach: number;
}

function harness() {
  const chain = new EffectChain();
  chain.begin(fxArenaFor("Mp"));
  const log: Install[] = [];
  let now = 0;
  const listener: EffectListener = {
    install(bank: number, id: number, _rec: FxRecord | undefined, at: Readonly<RaiseAt>) {
      log.push({ tick: now, bank, id, repeat: at.repeat, attach: at.attach });
    },
  };
  chain.addListener(listener);
  const at = makeRaiseAt();
  return {
    chain,
    log,
    at,
    run(ticks: number) {
      for (let i = 0; i < ticks; i++) {
        now++;
        chain.tick();
      }
    },
    ids: (id: number) => log.filter((e) => e.id === id),
  };
}

describe("the install", () => {
  test("a successor with no delay installs inside the install", () => {
    // The turrets' impact: flash 43, sparks 44 at once.
    const h = harness();
    h.chain.raise(0, 43, h.at);
    expect(h.log.map((e) => e.id)).toEqual([43, 44]);
    expect(h.chain.pending()).toBe(0);
  });

  test("a gated install is dropped whole: no picture, no sound, no successor", () => {
    const h = harness();
    h.chain.gate = () => false;
    h.chain.raise(0, 61, h.at);
    h.run(100);
    expect(h.log).toEqual([]);
    expect(h.chain.pending()).toBe(0);
  });

  test("an empty slot installs nothing a listener can draw, and nothing follows", () => {
    const h = harness();
    h.chain.raise(1, 181, h.at); // the Grenade's 180 names it; no arena fills it
    expect(h.log).toEqual([{ tick: 0, bank: 1, id: 181, repeat: false, attach: -1 }]);
    expect(h.chain.pending()).toBe(0);
  });
});

describe("the timers", () => {
  test("a spawn delay publishes after +0x24, ten engine ticks a sim tick", () => {
    // The Dreadnought's death: 61 publishes 62 after 300 ticks, 62 publishes
    // 63 after 150 more.
    const h = harness();
    h.chain.raise(0, 61, h.at);
    h.run(60);
    expect(h.ids(62)[0]?.tick).toBe(30);
    expect(h.ids(63)[0]?.tick).toBe(45);
  });

  test("repeats raise the record's own id again, one fewer times than the count", () => {
    // 61: 20 repeats every 29 ticks. The period runs out every third sim tick
    // (29 -> 19 -> 9 -> -1), the re-arm raises on the pass after, and the pass
    // that takes the count to zero re-arms nothing: 19 re-raises.
    const h = harness();
    h.chain.raise(0, 61, h.at);
    h.run(80);
    const again = h.ids(61).filter((e) => e.repeat);
    expect(again.length).toBe(19);
    expect(again[0].tick).toBe(4);
    expect(again[1].tick).toBe(7);
    expect(again[18].tick).toBe(4 + 3 * 18);
    // A re-raise is a one-shot: 62 is published once, by the first install
    // (its own repeats re-raise it after that).
    expect(h.ids(62).filter((e) => !e.repeat).length).toBe(1);
  });

  test("the timers outlive the record's lifetime", () => {
    // 61 lives 300 ticks (30 sim ticks) and still repeats to the end: the
    // retail tick parks an instance with repeats left instead of retiring it.
    const h = harness();
    h.chain.raise(0, 61, h.at);
    h.run(80);
    expect(h.ids(61).filter((e) => e.tick > 30).length).toBeGreaterThan(5);
  });

  test("bit 11 publishes the successor when the repeats run out, on a re-arm pass as a one-shot", () => {
    // The turret's death sparks 102: 20 repeats of 1 tick, successor 103 at
    // the end. A one-tick period repeats once a sim tick, so 102 is raised
    // again on ticks 2..19 and 103 is published on tick 20 — which is also a
    // re-arm pass, so retail makes it a one-shot; its at-once successors 104
    // and 105 install all the same.
    const h = harness();
    h.chain.raise(0, 102, h.at);
    h.run(40);
    const again = h.ids(102).filter((e) => e.repeat);
    expect(again.map((e) => e.tick)).toEqual(Array.from({ length: 18 }, (_, i) => i + 2));
    expect(h.ids(103).map((e) => e.tick)).toEqual([20]);
    expect(h.ids(103)[0].repeat).toBe(false);
    expect(h.ids(104).map((e) => e.tick)).toEqual([20]);
    expect(h.ids(105).map((e) => e.tick)).toEqual([20]);
    expect(h.chain.pending()).toBe(0);
  });

  test("a whole death chain: the turret's 107 -> 106 -> 108, 102 after 29 ticks", () => {
    const h = harness();
    h.chain.raise(0, 107, h.at);
    expect(h.log.map((e) => e.id)).toEqual([107, 106, 108]);
    h.run(3);
    // 108's 29-tick delay: 29 -> 19 -> 9 -> -1, published on the third pass.
    expect(h.ids(102)[0]?.tick).toBe(3);
    // 108's own three repeats: two re-raises, three ticks apart.
    h.run(20);
    expect(
      h
        .ids(108)
        .filter((e) => e.repeat)
        .map((e) => e.tick),
    ).toEqual([4, 7]);
  });

  test("a timer made during a pass waits for the next one", () => {
    const h = harness();
    h.chain.raise(0, 108, h.at);
    h.run(6);
    // 102 was installed on pass 3, by 108's timer; its own first repeat pass
    // is 4, so its first re-raise is on 5.
    expect(h.ids(102).filter((e) => e.repeat)[0]?.tick).toBe(5);
  });
});

describe("riding a round", () => {
  test("a launch's timers follow the round once it is known", () => {
    const h = harness();
    const located: number[] = [];
    h.chain.locate = (entity, at) => {
      located.push(entity);
      at.x = 7;
      return true;
    };
    h.at.attach = ROUND_TOKEN;
    h.chain.raise(0, 61, h.at); // any record with a timer
    h.chain.rebind(ROUND_TOKEN, 77);
    h.run(4);
    expect(located[0]).toBe(77);
    expect(h.ids(61).filter((e) => e.repeat)[0]?.attach).toBe(77);
  });

  test("a reference that is gone detaches the timer, and bit 12 stops it", () => {
    const h = harness();
    h.chain.locate = () => false;
    h.at.attach = 5;
    h.chain.raise(0, 61, h.at);
    h.run(10);
    // 61 has no bit 12: it carries on where the reference was.
    const again = h.ids(61).filter((e) => e.repeat);
    expect(again.length).toBeGreaterThan(1);
    expect(again[0].attach).toBe(-1);
  });
});
