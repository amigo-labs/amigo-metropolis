// End-to-end netcode proof (Phase 6 DoD) — no browser, no Workers runtime.
//
// Two NetLockstep clients are wired through the REAL relay (RoomLogic) by an
// in-memory hub that delivers messages synchronously. This exercises the whole
// online path (handshake → input send → frame confirm → step → hash exchange)
// and asserts the properties the DoD names:
//   1. two "machines" complete a match with IDENTICAL per-tick hashes, equal to
//      the canonical offline sim of the same inputs;
//   2. an induced desync is flagged within 30 ticks and BOTH replays are dumped;
//   3. a dropped client reconnects and fast-forwards to the same state.

import { describe, expect, it } from "bun:test";
import { type Outgoing, RoomLogic } from "@metropolis/server/room";
import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_INTERACT,
  clearTickInputs,
  createSim,
  createTickInputs,
  DISTRICT_01_ID,
  decodeMessage,
  decodeReplay,
  encodeMessage,
  getMapById,
  hash,
  type MatchConfig,
  type PlayerInput,
  SIM_VERSION,
  type SimState,
  step,
  type TickInputs,
} from "@metropolis/sim";
import { NetLockstep } from "../src/net/lockstep";
import type { Transport } from "../src/net/transport";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xc0ffee,
  mapId: DISTRICT_01_ID,
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

// A scripted 1v1: both avatars move and shoot so the hash stream is non-trivial
// (idle inputs would make the "identical hashes" check vacuous). One function
// authors BOTH slots so the offline reference and the two clients feed the exact
// same inputs tick for tick.
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

/** Canonical offline hashes for `refScript` — the ground truth to match. */
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

// --- In-memory hub: clients ↔ RoomLogic, synchronous delivery ----------------

class HubTransport implements Transport {
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  constructor(
    private readonly hub: TestHub,
    readonly connId: string,
  ) {}
  send(bytes: Uint8Array): void {
    this.hub.fromClient(this.connId, bytes);
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.hub.disconnect(this.connId);
    this.closeCb?.();
  }
  deliver(bytes: Uint8Array): void {
    this.msgCb?.(bytes);
  }
}

class TestHub {
  readonly room = new RoomLogic();
  private readonly transports = new Map<string, HubTransport>();
  newClient(connId: string): HubTransport {
    const t = new HubTransport(this, connId);
    this.transports.set(connId, t);
    return t;
  }
  fromClient(connId: string, bytes: Uint8Array): void {
    this.route(this.room.handleMessage(connId, decodeMessage(bytes)));
  }
  disconnect(connId: string): void {
    this.transports.delete(connId);
    this.route(this.room.handleDisconnect(connId));
  }
  private route(out: Outgoing[]): void {
    for (const o of out) {
      const bytes = encodeMessage(o.msg);
      if (o.connId === null) {
        for (const t of this.transports.values()) t.deliver(bytes);
      } else {
        this.transports.get(o.connId)?.deliver(bytes);
      }
    }
  }
}

/** A per-slot sampler that returns fresh input objects from the shared script. */
function sampler(slot: number): (tick: number) => PlayerInput {
  const tmp = createTickInputs();
  return (tick) => {
    refScript(tick, tmp);
    return { ...tmp.players[slot] };
  };
}

/** Runs both clients forward until each reaches `target` (or a guard trips). */
function drive(a: NetLockstep, b: NetLockstep, target: number): void {
  let guard = 0;
  while ((a.simTick < target || b.simTick < target) && guard++ < 200_000) {
    let stepped = 0;
    if (a.simTick < target && a.tryStep()) stepped++;
    if (b.simTick < target && b.tryStep()) stepped++;
    if (stepped === 0) break; // ended, or no progress possible in a sync hub
  }
}

describe("online lockstep (in-memory relay)", () => {
  it("keeps two clients bit-identical and equal to the offline sim", () => {
    const TICKS = 150;
    const hub = new TestHub();
    const h0: number[] = [];
    const h1: number[] = [];
    const net0 = new NetLockstep(hub.newClient("c0"), {
      sampleInput: sampler(0),
      onStep: (t, sim) => {
        h0[t] = hash(sim);
      },
    });
    const net1 = new NetLockstep(hub.newClient("c1"), {
      sampleInput: sampler(1),
      onStep: (t, sim) => {
        h1[t] = hash(sim);
      },
    });
    net0.start(CONFIG);
    net1.start(CONFIG);
    expect(net0.slot).toBe(0);
    expect(net1.slot).toBe(1);

    drive(net0, net1, TICKS);

    expect(net0.simTick).toBe(TICKS);
    expect(net1.simTick).toBe(TICKS);
    const ref = referenceHashes(TICKS);
    expect(h0.slice(0, TICKS)).toEqual(ref);
    expect(h1.slice(0, TICKS)).toEqual(ref);
  });

  it("flags a desync within 30 ticks and dumps both replays", () => {
    const hub = new TestHub();
    let sim1: SimState | null = null;
    const dumps: { tick: number; bytes: Uint8Array }[] = [];
    const onDesync = (tick: number, bytes: Uint8Array) => dumps.push({ tick, bytes });
    const net0 = new NetLockstep(hub.newClient("c0"), { sampleInput: sampler(0), onDesync });
    const net1 = new NetLockstep(hub.newClient("c1"), {
      sampleInput: sampler(1),
      onWelcome: (_slot, sim) => {
        sim1 = sim;
      },
      onDesync,
    });
    net0.start(CONFIG);
    net1.start(CONFIG);

    // Run past the tick-30 exchange (which matches), then corrupt client 1 so
    // the next exchange (tick 60) disagrees.
    drive(net0, net1, 33);
    expect(dumps).toHaveLength(0); // still in sync at tick 30
    (sim1 as unknown as SimState).points[0] += 7;
    drive(net0, net1, 150);

    expect(net0.isEnded).toBe("desync");
    expect(net1.isEnded).toBe("desync");
    expect(dumps).toHaveLength(2); // both clients dumped a replay
    for (const d of dumps) {
      expect(d.tick).toBe(60); // detected at the first exchange after corruption
      expect(d.tick - 33).toBeLessThanOrEqual(30); // "within 30 ticks"
      const replay = decodeReplay(d.bytes);
      expect(replay.mapId).toBe(CONFIG.mapId);
      expect(replay.tickCount).toBeGreaterThan(0);
    }
  });

  it("reconnects a dropped client and fast-forwards it to the same state", () => {
    const hub = new TestHub();
    const h0: number[] = [];
    const net0 = new NetLockstep(hub.newClient("c0"), {
      sampleInput: sampler(0),
      onStep: (t, sim) => {
        h0[t] = hash(sim);
      },
    });
    const c1 = hub.newClient("c1");
    const net1 = new NetLockstep(c1, { sampleInput: sampler(1) });
    net0.start(CONFIG);
    net1.start(CONFIG);
    drive(net0, net1, 50);
    const droppedAt = net1.simTick;
    expect(droppedAt).toBeGreaterThanOrEqual(49);

    // Client 1 drops; the relay keeps the full history.
    net1.close();

    // A fresh client reclaims slot 1 and re-simulates from scratch.
    const h1: number[] = [];
    const net1b = new NetLockstep(
      hub.newClient("c1b"),
      {
        sampleInput: sampler(1),
        onStep: (t, sim) => {
          h1[t] = hash(sim);
        },
      },
      { config: CONFIG, slot: 1 },
    );
    net1b.start(CONFIG);
    expect(net1b.slot).toBe(1);

    drive(net0, net1b, 100);

    expect(net1b.simTick).toBe(100);
    expect(net0.simTick).toBe(100);
    // The reconnected client re-derived every tick it missed, bit-for-bit.
    expect(h1.slice(0, 100)).toEqual(h0.slice(0, 100));
  });
});
