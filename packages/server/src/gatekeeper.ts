// Pure budget-gatekeeper logic — the brain of the GatekeeperDO
// (hosting.spec.md §3.4, §4), Cloudflare-free and unit-tested. It rations
// match sessions against the free tier so overload degrades to a graceful
// "sold out for today", never a bill. THE SOURCE OF TRUTH IS THIS COUNTER,
// not the Cloudflare API — the optional analytics reconciliation (H5+) is a
// drift safety net, never in the hot path.
//
// Two quotas, different units (hosting.spec.md §4):
//  - Durable Object requests per UTC DAY — the binding constraint. Guarded by
//    a token bucket (continuous refill at budget/day, cap = budget) layered
//    over a per-UTC-day hard counter. The bucket rations bursts (a busy
//    morning leaves the evening refill-limited; a quiet morning banks tokens
//    for the evening — but never across midnight, the cap sees to that), and
//    the hard counter is the absolute ceiling a full bucket cannot pierce at
//    the day boundary.
//  - TURN egress per MONTH — uncritical (≈75k match-hours free), tracked
//    coarsely per session so a pathological month still closes the gate.
//
// A session is RESERVED up front at an estimated cost and RECONCILED at match
// end; a reconciliation that never arrives (crashed client) simply leaves the
// conservative estimate charged. All clocks are injected (wall-clock ms, UTC).

const DAY_MS = 86_400_000;

/**
 * Daily DO-request budget the gatekeeper hands out. Deliberately below the
 * 100K free-tier line: client-facing reads it cannot see (directory list
 * fetches, stray requests) share the same Cloudflare quota.
 */
export const GATE_DAILY_REQUESTS = 80_000;
/** Estimated DO requests one match session costs (signaling + directory + gate). */
export const GATE_SESSION_REQUESTS = 40;
/** Estimated TURN egress one session costs (≈30 min × ~13 MB/h, spec §4). */
export const GATE_SESSION_TURN_MB = 7;
/** Monthly TURN budget in MB — 900 GB of the 1000 GB tier, with headroom. */
export const GATE_MONTHLY_TURN_MB = 900 * 1024;

export type GateDenial = "day" | "bucket" | "turn";

export type GateReserve =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: GateDenial; readonly retryAtMs: number };

export interface GateStatus {
  readonly available: boolean;
  /** When capacity returns (next refill / midnight / month roll), if blocked. */
  readonly retryAtMs: number | null;
  /** Fraction of today's hard budget already spent (0–1, for dashboards). */
  readonly dayUsedFraction: number;
}

export interface GateConfig {
  readonly dailyRequests: number;
  readonly sessionRequests: number;
  readonly sessionTurnMb: number;
  readonly monthlyTurnMb: number;
}

const DEFAULTS: GateConfig = {
  dailyRequests: GATE_DAILY_REQUESTS,
  sessionRequests: GATE_SESSION_REQUESTS,
  sessionTurnMb: GATE_SESSION_TURN_MB,
  monthlyTurnMb: GATE_MONTHLY_TURN_MB,
};

interface Reservation {
  readonly requests: number;
  readonly turnMb: number;
}

/** Persisted shape (one small record in the DO). */
export interface GateSnapshot {
  readonly bucket: number;
  readonly refillAtMs: number;
  readonly dayKey: number;
  readonly dayUsed: number;
  readonly monthKey: number;
  readonly monthTurnMb: number;
  readonly seq: number;
  readonly reservations: [string, Reservation][];
}

function utcDayKey(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

function utcMonthKey(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function nextUtcMidnight(nowMs: number): number {
  return (utcDayKey(nowMs) + 1) * DAY_MS;
}

function nextUtcMonth(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export class GatekeeperLogic {
  private readonly cfg: GateConfig;
  private bucket: number;
  private refillAtMs = 0;
  private dayKey = -1;
  private dayUsed = 0;
  private monthKey = -1;
  private monthTurnMb = 0;
  private seq = 0;
  private readonly reservations = new Map<string, Reservation>();

  constructor(config?: Partial<GateConfig>) {
    this.cfg = { ...DEFAULTS, ...config };
    this.bucket = this.cfg.dailyRequests; // a fresh deploy starts unconstrained
  }

  /** Reserves one session's estimated cost, or says when to try again. */
  reserve(nowMs: number): GateReserve {
    this.advance(nowMs);
    const { sessionRequests, sessionTurnMb, dailyRequests, monthlyTurnMb } = this.cfg;
    // Hard per-day ceiling first: it resets on a fixed clock the UI can show.
    if (this.dayUsed + sessionRequests > dailyRequests) {
      return { ok: false, reason: "day", retryAtMs: nextUtcMidnight(nowMs) };
    }
    if (this.bucket < sessionRequests) {
      // Continuous refill: enough tokens for one session exist at a known time.
      const deficit = sessionRequests - this.bucket;
      const msPerToken = DAY_MS / dailyRequests;
      return { ok: false, reason: "bucket", retryAtMs: Math.ceil(nowMs + deficit * msPerToken) };
    }
    if (this.monthTurnMb + sessionTurnMb > monthlyTurnMb) {
      return { ok: false, reason: "turn", retryAtMs: nextUtcMonth(nowMs) };
    }
    this.bucket -= sessionRequests;
    this.dayUsed += sessionRequests;
    this.monthTurnMb += sessionTurnMb;
    this.seq++;
    const sessionId = `s${this.seq}`;
    this.reservations.set(sessionId, { requests: sessionRequests, turnMb: sessionTurnMb });
    return { ok: true, sessionId };
  }

  /**
   * Settles a reservation against actual usage; the delta is refunded (or the
   * overrun charged). Unknown/duplicate ids return false — a reservation that
   * is never reconciled just keeps its conservative estimate.
   */
  reconcile(
    sessionId: string,
    actualRequests: number,
    actualTurnMb: number,
    nowMs: number,
  ): boolean {
    this.advance(nowMs);
    const r = this.reservations.get(sessionId);
    if (!r) return false;
    this.reservations.delete(sessionId);
    const reqDelta = r.requests - Math.max(0, actualRequests);
    this.bucket = Math.min(this.cfg.dailyRequests, Math.max(0, this.bucket + reqDelta));
    this.dayUsed = Math.min(this.cfg.dailyRequests, Math.max(0, this.dayUsed - reqDelta));
    const turnDelta = r.turnMb - Math.max(0, actualTurnMb);
    this.monthTurnMb = Math.min(this.cfg.monthlyTurnMb, Math.max(0, this.monthTurnMb - turnDelta));
    return true;
  }

  /** For the UI's "sold out" panel and /api/budget. */
  status(nowMs: number): GateStatus {
    this.advance(nowMs);
    const probe = this.peekDenial(nowMs);
    return {
      available: probe === null,
      retryAtMs: probe?.retryAtMs ?? null,
      dayUsedFraction: this.dayUsed / this.cfg.dailyRequests,
    };
  }

  private peekDenial(nowMs: number): { reason: GateDenial; retryAtMs: number } | null {
    const { sessionRequests, sessionTurnMb, dailyRequests, monthlyTurnMb } = this.cfg;
    if (this.dayUsed + sessionRequests > dailyRequests) {
      return { reason: "day", retryAtMs: nextUtcMidnight(nowMs) };
    }
    if (this.bucket < sessionRequests) {
      const msPerToken = DAY_MS / dailyRequests;
      return {
        reason: "bucket",
        retryAtMs: Math.ceil(nowMs + (sessionRequests - this.bucket) * msPerToken),
      };
    }
    if (this.monthTurnMb + sessionTurnMb > monthlyTurnMb) {
      return { reason: "turn", retryAtMs: nextUtcMonth(nowMs) };
    }
    return null;
  }

  /** Rolls the clock forward: bucket refill, day reset, month reset. */
  private advance(nowMs: number): void {
    if (this.refillAtMs === 0) this.refillAtMs = nowMs;
    if (nowMs > this.refillAtMs) {
      const refill = ((nowMs - this.refillAtMs) / DAY_MS) * this.cfg.dailyRequests;
      this.bucket = Math.min(this.cfg.dailyRequests, this.bucket + refill);
      this.refillAtMs = nowMs;
    }
    const day = utcDayKey(nowMs);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayUsed = 0; // aligned with Cloudflare's own 00:00 UTC reset
    }
    const month = utcMonthKey(nowMs);
    if (month !== this.monthKey) {
      this.monthKey = month;
      this.monthTurnMb = 0;
    }
  }

  // --- persistence (survives DO eviction as one small record) -----------------

  snapshot(): GateSnapshot {
    return {
      bucket: this.bucket,
      refillAtMs: this.refillAtMs,
      dayKey: this.dayKey,
      dayUsed: this.dayUsed,
      monthKey: this.monthKey,
      monthTurnMb: this.monthTurnMb,
      seq: this.seq,
      reservations: [...this.reservations],
    };
  }

  hydrate(snap: GateSnapshot): void {
    this.bucket = snap.bucket;
    this.refillAtMs = snap.refillAtMs;
    this.dayKey = snap.dayKey;
    this.dayUsed = snap.dayUsed;
    this.monthKey = snap.monthKey;
    this.monthTurnMb = snap.monthTurnMb;
    this.seq = snap.seq;
    this.reservations.clear();
    for (const [id, r] of snap.reservations) this.reservations.set(id, r);
  }
}
