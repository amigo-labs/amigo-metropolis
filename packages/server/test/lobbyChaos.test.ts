// Chaos test (Phase H5 gate, hosting.spec.md §8): aborts in EVERY lifecycle
// phase must leave no ghost lobbies. A harness executes LobbyLogic's effects
// like the DO adapter would — tracking directory registrations and the armed
// alarm — then a seeded generator throws hundreds of hostile event sequences
// (disconnects, garbage, early alarms, late joins) at fresh lobbies. After
// each run the world must settle to: lobby closed, directory registration
// balanced out, alarm disarmed.
//
// Also pins the turn.ts response normalizer (both API shapes, junk-safe).

import { describe, expect, test } from "bun:test";
import { LOBBY_OPEN_TTL_MS, LobbyLogic, type LobbyResult } from "@metropolis/server/lobby";
import { normalizeIceServers } from "@metropolis/server/turn";
import type { MatchConfig } from "@metropolis/sim";

const T0 = 9_000_000;
const CFG: MatchConfig = {
  simVersion: 7,
  seed: 1,
  mapId: "district01",
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

/** Executes effects the way lobbyDo.ts does, with invariant checks. */
class Harness {
  readonly logic = new LobbyLogic();
  /** Live sockets (an out.close drops them, like the adapter). */
  readonly conns = new Set<string>();
  registered = false;
  registrations = 0; // lifetime register count — must equal unregister count at rest
  unregistrations = 0;
  alarmAt: number | null = null;
  now = T0;
  private nextConn = 0;

  apply(result: LobbyResult): void {
    for (const o of result.out) {
      if (o.close) this.conns.delete(o.connId);
    }
    for (const e of result.effects) {
      switch (e.kind) {
        case "register":
          // Double-listing would leave an un-unregisterable ghost entry.
          expect(this.registered).toBe(false);
          this.registered = true;
          this.registrations++;
          break;
        case "unregister":
          expect(this.registered).toBe(true);
          this.registered = false;
          this.unregistrations++;
          break;
        case "setAlarm":
          this.alarmAt = e.atMs;
          break;
        case "clearAlarm":
          this.alarmAt = null;
          break;
      }
    }
  }

  open(): string {
    const id = `c${this.nextConn++}`;
    this.conns.add(id);
    this.apply(this.logic.handleOpen(id, "ABCDE", this.now));
    return id;
  }
  msg(connId: string, m: unknown): void {
    this.apply(this.logic.handleMessage(connId, m, this.now));
  }
  disconnect(connId: string): void {
    if (!this.conns.delete(connId)) return;
    this.apply(this.logic.handleDisconnect(connId, this.now));
  }
  fireAlarm(): void {
    if (this.alarmAt === null) return;
    this.now = Math.max(this.now, this.alarmAt);
    this.alarmAt = null; // a fired alarm is consumed; the logic may re-arm it
    this.apply(this.logic.handleAlarm(this.now));
  }

  /**
   * What the real world does after any abort: sockets die, time passes, the
   * armed alarm fires. Afterwards NOTHING may linger.
   */
  settle(): void {
    for (const c of [...this.conns]) this.disconnect(c);
    let guard = 0;
    while (this.logic.status !== "closed" && guard++ < 5) this.fireAlarm();
    expect(this.logic.status).toBe("closed");
    expect(this.registered).toBe(false);
    expect(this.registrations).toBe(this.unregistrations);
    expect(this.alarmAt).toBeNull();
  }
}

const createMsg = { t: "create", name: "Chaos", visibility: "public", config: CFG };
const joinMsg = { t: "join", simVersion: 7 };

describe("lobby chaos — no ghost lobbies", () => {
  test("abort at every deterministic lifecycle stage settles clean", () => {
    const stages: ((h: Harness) => void)[] = [
      () => {}, // connected, never created
      (h) => h.msg(h.open(), createMsg), // open
      (h) => {
        const host = h.open();
        h.msg(host, createMsg);
        h.msg(h.open(), joinMsg); // signaling
      },
      (h) => {
        const host = h.open();
        h.msg(host, createMsg);
        const joiner = h.open();
        h.msg(joiner, joinMsg);
        h.msg(host, { t: "signal", data: { sdp: "offer" } }); // mid-handshake
        h.msg(joiner, { t: "signal", data: { sdp: "answer" } });
      },
      (h) => {
        const host = h.open();
        h.msg(host, createMsg);
        h.msg(h.open(), joinMsg);
        h.msg(host, { t: "matchStarted" }); // matched → already closed
      },
    ];
    for (const stage of stages) {
      const h = new Harness();
      h.open(); // an extra bystander socket in every scenario
      stage(h);
      h.settle();
    }
  });

  test("joiner churn relists exactly once per vacancy", () => {
    const h = new Harness();
    const host = h.open();
    h.msg(host, createMsg);
    for (let i = 0; i < 3; i++) {
      const joiner = h.open();
      h.msg(joiner, joinMsg);
      h.disconnect(joiner); // bail mid-signaling → relist
    }
    expect(h.registrations).toBe(4); // create + 3 relists, never double-listed
    h.settle();
  });

  test("seeded random chaos always settles clean", () => {
    for (let seed = 1; seed <= 300; seed++) {
      let s = seed >>> 0;
      const rand = (): number => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const h = new Harness();
      const live = (): string[] => [...h.conns];
      const pick = (): string | null => {
        const c = live();
        return c.length ? c[Math.floor(rand() * c.length)] : null;
      };
      const messages: unknown[] = [
        createMsg,
        joinMsg,
        { t: "signal", data: { x: 1 } },
        { t: "matchStarted" },
        { t: "join", simVersion: 99 }, // version mismatch
        { nonsense: true }, // protocol garbage
        "not even json-shaped",
      ];
      for (let step = 0; step < 40; step++) {
        const roll = rand();
        if (roll < 0.25) {
          if (h.conns.size < 5) h.open();
        } else if (roll < 0.7) {
          const c = pick();
          if (c) h.msg(c, messages[Math.floor(rand() * messages.length)]);
        } else if (roll < 0.85) {
          const c = pick();
          if (c) h.disconnect(c);
        } else if (roll < 0.95) {
          h.now += Math.floor(rand() * LOBBY_OPEN_TTL_MS * 0.2);
        } else {
          h.fireAlarm();
        }
      }
      h.settle();
    }
  });
});

describe("normalizeIceServers", () => {
  test("accepts both Realtime API response shapes", () => {
    const single = {
      iceServers: { urls: ["turn:x?transport=udp"], username: "u", credential: "c" },
    };
    expect(normalizeIceServers(single)).toHaveLength(1);
    const arr = { iceServers: [{ urls: "stun:x" }, { urls: ["turn:x"], username: "u" }] };
    expect(normalizeIceServers(arr)).toHaveLength(2);
  });

  test("rejects junk without throwing", () => {
    expect(normalizeIceServers(null)).toBeNull();
    expect(normalizeIceServers({})).toBeNull();
    expect(normalizeIceServers({ iceServers: [] })).toBeNull();
    expect(normalizeIceServers({ iceServers: [{ urls: 42 }] })).toBeNull();
    expect(normalizeIceServers({ iceServers: [{}] })).toBeNull();
  });
});
