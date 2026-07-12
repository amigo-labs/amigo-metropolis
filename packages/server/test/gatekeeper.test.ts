// GatekeeperLogic unit tests (hosting.spec.md §3.4, §4) — the H4 gate:
// a simulated overrun rejects new sessions ("sold out") and recovers at the
// UTC-midnight reset; the token bucket rations the morning after a busy day
// and never lets a full bucket pierce the daily ceiling at the boundary.

import { describe, expect, test } from "bun:test";
import { GatekeeperLogic, type GateReserve } from "@metropolis/server/gatekeeper";

const DAY_MS = 86_400_000;
/** A fixed UTC midnight (2026-07-15) — every offset below is relative to it. */
const T0 = Date.UTC(2026, 6, 15);

// Small numbers keep the arithmetic legible: 10 sessions/day, 10 TURN-MB cap.
const CFG = { dailyRequests: 100, sessionRequests: 10, sessionTurnMb: 1, monthlyTurnMb: 1000 };

function drainDay(gate: GatekeeperLogic, atMs: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < CFG.dailyRequests / CFG.sessionRequests; i++) {
    const r = gate.reserve(atMs);
    if (!r.ok) throw new Error(`unexpected denial at session ${i}`);
    ids.push(r.sessionId);
  }
  return ids;
}

describe("GatekeeperLogic", () => {
  test("grants sessions while budget remains", () => {
    const gate = new GatekeeperLogic(CFG);
    const r = gate.reserve(T0);
    expect(r.ok).toBe(true);
    expect(gate.status(T0).available).toBe(true);
    expect(gate.status(T0).dayUsedFraction).toBeCloseTo(0.1);
  });

  test("a drained day is sold out until the UTC-midnight reset", () => {
    const gate = new GatekeeperLogic(CFG);
    drainDay(gate, T0);
    const denied = gate.reserve(T0 + 1000) as GateReserve & { ok: false };
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("day");
    expect(denied.retryAtMs).toBe(T0 + DAY_MS); // exactly the next UTC midnight
    expect(gate.status(T0 + 1000).available).toBe(false);
    // A full day later everything (hard counter + refilled bucket) recovered.
    expect(gate.reserve(T0 + DAY_MS + DAY_MS / 2).ok).toBe(true);
  });

  test("the morning after a busy day is refill-limited (token bucket)", () => {
    const gate = new GatekeeperLogic(CFG);
    drainDay(gate, T0 + DAY_MS - 10 * 60_000); // burn everything at 23:50
    // 00:10 next day: the hard counter reset, but the bucket has only
    // ~20 min × (100/day) ≈ 1.4 tokens — a session needs 10.
    const early = gate.reserve(T0 + DAY_MS + 10 * 60_000) as GateReserve & { ok: false };
    expect(early.ok).toBe(false);
    expect(early.reason).toBe("bucket");
    // The denial names the moment enough tokens exist; it works then.
    expect(early.retryAtMs).toBeGreaterThan(T0 + DAY_MS + 10 * 60_000);
    expect(gate.reserve(early.retryAtMs).ok).toBe(true);
  });

  test("a full bucket cannot pierce the daily hard counter", () => {
    const gate = new GatekeeperLogic(CFG);
    // Bucket is full at construction; the hard counter still stops session 11.
    drainDay(gate, T0);
    expect((gate.reserve(T0) as { ok: false; reason: string }).reason).toBe("day");
  });

  test("reconciling below the estimate refunds capacity", () => {
    const gate = new GatekeeperLogic({ ...CFG, dailyRequests: 20 });
    const a = gate.reserve(T0) as { ok: true; sessionId: string };
    expect(gate.reserve(T0).ok).toBe(true);
    expect(gate.reserve(T0).ok).toBe(false); // 20/20 used
    // Session A never actually ran → its full estimate comes back.
    expect(gate.reconcile(a.sessionId, 0, 0, T0 + 1000)).toBe(true);
    expect(gate.reserve(T0 + 1000).ok).toBe(true);
  });

  test("reconciling an overrun charges the difference", () => {
    const gate = new GatekeeperLogic(CFG);
    const a = gate.reserve(T0) as { ok: true; sessionId: string };
    const before = gate.status(T0).dayUsedFraction;
    gate.reconcile(a.sessionId, CFG.sessionRequests + 5, 2, T0 + 1000);
    expect(gate.status(T0 + 1000).dayUsedFraction).toBeGreaterThan(before);
  });

  test("unknown or repeated reconciliations are rejected", () => {
    const gate = new GatekeeperLogic(CFG);
    const a = gate.reserve(T0) as { ok: true; sessionId: string };
    expect(gate.reconcile("s999", 1, 0, T0)).toBe(false);
    expect(gate.reconcile(a.sessionId, 1, 0, T0)).toBe(true);
    expect(gate.reconcile(a.sessionId, 1, 0, T0)).toBe(false);
  });

  test("the monthly TURN cap closes the gate until the 1st", () => {
    const gate = new GatekeeperLogic({ ...CFG, monthlyTurnMb: 2 });
    expect(gate.reserve(T0).ok).toBe(true);
    expect(gate.reserve(T0).ok).toBe(true);
    const denied = gate.reserve(T0) as GateReserve & { ok: false };
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("turn");
    expect(denied.retryAtMs).toBe(Date.UTC(2026, 7, 1));
    // …and the month roll clears it.
    expect(gate.reserve(Date.UTC(2026, 7, 1) + 1000).ok).toBe(true);
  });

  test("snapshot/hydrate survives an eviction, reservations included", () => {
    const gate = new GatekeeperLogic(CFG);
    const a = gate.reserve(T0) as { ok: true; sessionId: string };
    gate.reserve(T0);
    const revived = new GatekeeperLogic(CFG);
    revived.hydrate(gate.snapshot());
    expect(revived.status(T0).dayUsedFraction).toBeCloseTo(0.2);
    expect(revived.reconcile(a.sessionId, 2, 0, T0 + 1)).toBe(true);
  });
});
