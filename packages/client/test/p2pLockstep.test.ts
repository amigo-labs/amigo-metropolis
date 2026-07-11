// P2P lockstep proof (Phase H2 gate, hosting.spec.md §8) — no browser, no
// TURN. Two P2pLockstep peers are wired through an in-memory channel pair
// whose "inputs" leg is deliberately hostile (seeded drops, duplicates,
// reordering — the semantics of an unordered/maxRetransmits:0 DataChannel) and
// whose "control" leg is reliable+ordered. Asserts the DoD properties:
//   1. both peers complete a match with IDENTICAL per-tick hashes, equal to
//      the canonical offline sim of the same inputs, despite heavy loss;
//   2. an induced desync is flagged within 30 ticks and BOTH replays dump;
//   3. a dropped channel surfaces as a distinct "closed" end state.

import { describe, expect, it } from "bun:test";
import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_INTERACT,
  clearTickInputs,
  createSim,
  createTickInputs,
  DISTRICT_01_ID,
  decodeReplay,
  ERR_VERSION_MISMATCH,
  getMapById,
  hash,
  type MatchConfig,
  type PlayerInput,
  SIM_VERSION,
  type SimState,
  step,
  type TickInputs,
} from "@metropolis/sim";
import { P2pLockstep } from "../src/net/p2pLockstep";
import { decodeP2pInput, encodeP2pInput } from "../src/net/p2pProtocol";
import type { Transport } from "../src/net/transport";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xbead5,
  mapId: DISTRICT_01_ID,
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

// Same scripted-1v1 approach as netLockstep.test.ts: one function authors BOTH
// slots so the offline reference and the two peers feed identical inputs.
function refScript(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p0 = out.players[0];
  p0.moveY = 110;
  p0.aimX = 70;
  if (tick % 20 < 5) p0.buttons = BUTTON_FIRE1;
  if (tick > 40 && tick % 30 < 6) p0.buttons |= BUTTON_INTERACT;
  const p1 = out.players[1];
  p1.moveX = -90;
  p1.moveY = 50;
  if (tick % 25 < 4) p1.buttons = BUTTON_FIRE2;
}

function referenceHashes(ticks: number): number[] {
  const sim = createSim(getMapById(CONFIG.mapId), CONFIG.seed);
  const inputs = createTickInputs();
  const out: number[] = [];
  for (let t = 0; t < ticks; t++) {
    refScript(t, inputs);
    step(sim, inputs);
    out[t] = hash(sim);
  }
  return out;
}

function sampler(slot: number): (tick: number) => PlayerInput {
  const tmp = createTickInputs();
  return (tick) => {
    refScript(tick, tmp);
    return { ...tmp.players[slot] };
  };
}

// --- In-memory channel pairs --------------------------------------------------

/** Deterministic PRNG for the packet-mangling schedule (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MangleOptions {
  drop: number;
  duplicate: number;
  hold: number; // probability of holding a packet back (reordering)
}

class MemTransport implements Transport {
  peer: MemTransport | null = null;
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private held: Uint8Array | null = null;
  dropped = 0;
  delivered = 0;

  constructor(
    private readonly roll: () => number,
    private readonly mangle: MangleOptions | null,
  ) {}

  send(bytes: Uint8Array): void {
    const peer = this.peer;
    if (!peer) return;
    if (!this.mangle) {
      peer.deliver(bytes);
      return;
    }
    if (this.roll() < this.mangle.drop) {
      this.dropped++;
      return;
    }
    if (this.held && this.roll() < 0.8) {
      // Deliver the newer packet first, then the held one → reordering.
      peer.deliver(bytes);
      peer.deliver(this.held);
      this.held = null;
    } else if (this.roll() < this.mangle.hold) {
      this.held = bytes;
    } else {
      peer.deliver(bytes);
      if (this.roll() < this.mangle.duplicate) peer.deliver(bytes);
    }
  }

  /** Like a real channel, bytes arriving before the handler registers wait. */
  private readonly inbox: Uint8Array[] = [];

  deliver(bytes: Uint8Array): void {
    this.delivered++;
    if (this.msgCb) this.msgCb(bytes);
    else this.inbox.push(bytes);
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
    for (const b of this.inbox) cb(b);
    this.inbox.length = 0;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closeCb?.();
  }
  /** Simulates the channel dying (fires close, like an RTC channel drop). */
  drop(): void {
    this.closeCb?.();
  }
}

interface PeerWiring {
  control: MemTransport;
  inputs: MemTransport;
}

/** control: reliable+ordered; inputs: lossy/duplicating/reordering. */
function channelPairs(seed: number, mangle: MangleOptions): [PeerWiring, PeerWiring] {
  const roll = rng(seed);
  const a: PeerWiring = {
    control: new MemTransport(roll, null),
    inputs: new MemTransport(roll, mangle),
  };
  const b: PeerWiring = {
    control: new MemTransport(roll, null),
    inputs: new MemTransport(roll, mangle),
  };
  a.control.peer = b.control;
  b.control.peer = a.control;
  a.inputs.peer = b.inputs;
  b.inputs.peer = a.inputs;
  return [a, b];
}

const HOSTILE: MangleOptions = { drop: 0.35, duplicate: 0.15, hold: 0.2 };

function drive(a: P2pLockstep, b: P2pLockstep, target: number): void {
  let guard = 0;
  while ((a.simTick < target || b.simTick < target) && guard++ < 500_000) {
    let progress = 0;
    if (a.simTick < target && a.tryStep()) progress++;
    if (b.simTick < target && b.tryStep()) progress++;
    if (progress === 0 && (a.isEnded || b.isEnded)) break;
  }
}

describe("p2p input packet codec", () => {
  it("round-trips a redundancy window", () => {
    const inputs: PlayerInput[] = [
      { moveX: -128, moveY: 127, aimX: 5, aimY: -5, buttons: 0xff },
      { moveX: 1, moveY: 2, aimX: 3, aimY: 4, buttons: 5 },
    ];
    const decoded = decodeP2pInput(encodeP2pInput(41, inputs));
    expect(decoded).toEqual({ latestTick: 41, inputs });
  });

  it("rejects malformed packets instead of throwing", () => {
    expect(decodeP2pInput(new Uint8Array(0))).toBeNull();
    expect(decodeP2pInput(new Uint8Array([0x99, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]))).toBeNull();
    const good = encodeP2pInput(3, [{ moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 }]);
    expect(decodeP2pInput(good.slice(0, good.length - 1))).toBeNull(); // truncated
    const overlong = new Uint8Array([...good, 0]); // trailing byte
    expect(decodeP2pInput(overlong)).toBeNull();
  });
});

describe("p2p lockstep (lossy in-memory channels)", () => {
  it("keeps two peers bit-identical to the offline sim through heavy loss", () => {
    const TICKS = 150;
    const [wa, wb] = channelPairs(0xfeed, HOSTILE);
    const h0: number[] = [];
    const h1: number[] = [];
    const pa = new P2pLockstep(0, CONFIG, wa.control, wa.inputs, {
      sampleInput: sampler(0),
      onStep: (t, sim) => {
        h0[t] = hash(sim);
      },
    });
    const pb = new P2pLockstep(1, CONFIG, wb.control, wb.inputs, {
      sampleInput: sampler(1),
      onStep: (t, sim) => {
        h1[t] = hash(sim);
      },
    });
    expect(pa.isStarted).toBe(true); // reliable HELLOs crossed synchronously
    expect(pb.isStarted).toBe(true);

    drive(pa, pb, TICKS);

    expect(pa.simTick).toBe(TICKS);
    expect(pb.simTick).toBe(TICKS);
    // The channel really was hostile — packets were lost, yet lockstep held.
    expect(wa.inputs.dropped + wb.inputs.dropped).toBeGreaterThan(20);
    const ref = referenceHashes(TICKS);
    expect(h0.slice(0, TICKS)).toEqual(ref);
    expect(h1.slice(0, TICKS)).toEqual(ref);
    expect(pa.isEnded).toBe(null);
    expect(pb.isEnded).toBe(null);
  });

  it("flags an induced desync within 30 ticks and dumps both replays", () => {
    const [wa, wb] = channelPairs(0xdead, HOSTILE);
    const dumps: { tick: number; bytes: Uint8Array }[] = [];
    const onDesync = (tick: number, bytes: Uint8Array) => dumps.push({ tick, bytes });
    let simB: SimState | null = null;
    const pa = new P2pLockstep(0, CONFIG, wa.control, wa.inputs, {
      sampleInput: sampler(0),
      onDesync,
    });
    const pb = new P2pLockstep(1, CONFIG, wb.control, wb.inputs, {
      sampleInput: sampler(1),
      onStep: (_t, sim) => {
        simB = sim;
      },
      onDesync,
    });

    drive(pa, pb, 33);
    expect(dumps).toHaveLength(0); // tick-30 exchange matched
    (simB as unknown as SimState).points[0] += 7;
    drive(pa, pb, 150);

    expect(pa.isEnded).toBe("desync");
    expect(pb.isEnded).toBe("desync");
    expect(dumps).toHaveLength(2);
    for (const d of dumps) {
      expect(d.tick).toBe(60); // first exchange after the corruption
      expect(d.tick - 33).toBeLessThanOrEqual(30);
      const replay = decodeReplay(d.bytes);
      expect(replay.mapId).toBe(CONFIG.mapId);
      expect(replay.tickCount).toBeGreaterThan(0);
    }
  });

  it("surfaces a channel drop as a distinct 'closed' end state", () => {
    const [wa, wb] = channelPairs(0xcafe, HOSTILE);
    let closed = false;
    const pa = new P2pLockstep(0, CONFIG, wa.control, wa.inputs, {
      sampleInput: sampler(0),
      onClose: () => {
        closed = true;
      },
    });
    const pb = new P2pLockstep(1, CONFIG, wb.control, wb.inputs, { sampleInput: sampler(1) });
    drive(pa, pb, 20);

    wa.inputs.drop(); // the unreliable channel dies on peer A

    expect(closed).toBe(true);
    expect(pa.isEnded).toBe("closed");
    expect(pa.tryStep()).toBe(false);
    expect(pb.isEnded).toBe(null); // B learns via its own channel events later
  });

  it("rejects a peer running a different sim version", () => {
    const [wa, wb] = channelPairs(0xbeef, HOSTILE);
    let errA = -1;
    let errB = -1;
    const pa = new P2pLockstep(0, CONFIG, wa.control, wa.inputs, {
      sampleInput: sampler(0),
      onError: (code) => {
        errA = code;
      },
    });
    const pb = new P2pLockstep(
      1,
      { ...CONFIG, simVersion: SIM_VERSION + 1 },
      wb.control,
      wb.inputs,
      {
        sampleInput: sampler(1),
        onError: (code) => {
          errB = code;
        },
      },
    );
    expect(errA).toBe(ERR_VERSION_MISMATCH);
    expect(errB).toBe(ERR_VERSION_MISMATCH);
    expect(pa.tryStep()).toBe(false);
    expect(pb.tryStep()).toBe(false);
  });
});
