// Pure lockstep relay logic for one room — the brain of the Durable Object,
// with ZERO Cloudflare dependencies so it runs (and is exhaustively tested)
// under `bun test`. The DO (index.ts) is a thin adapter: it maps WebSockets to
// connection ids, hands each decoded message here, and routes the Outgoing[]
// back to sockets. This mirrors the repo's discipline of keeping the decidable
// logic pure and testable (like the sim itself).
//
// Responsibilities (architecture.md §5): slot assignment via 5-char room code
// (the code lives in the DO name, not here), simVersion handshake, per-tick
// input sequencing → FRAME broadcast, full input history for reconnect
// fast-forward, and per-tick hash comparison → desync flag. THE ROOM NEVER
// SIMULATES — it only relays bytes and compares hashes clients send it.

import {
  ERR_BAD_REJOIN,
  ERR_PROTOCOL,
  ERR_ROOM_FULL,
  ERR_VERSION_MISMATCH,
  MAX_PLAYERS,
  type MatchConfig,
  MSG_DESYNC,
  MSG_ERROR,
  MSG_FRAME,
  MSG_HASH,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PEER,
  MSG_REJOIN,
  MSG_START,
  MSG_WELCOME,
  type NetMessage,
  type PlayerInput,
  PROTOCOL_VERSION,
} from "@metropolis/sim";

/** One message to send: to a single connection, or (connId null) to everyone. */
export interface Outgoing {
  readonly connId: string | null;
  readonly msg: NetMessage;
}

const IDLE_INPUT: PlayerInput = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };

function cloneInput(i: PlayerInput): PlayerInput {
  return { moveX: i.moveX, moveY: i.moveY, aimX: i.aimX, aimY: i.aimY, buttons: i.buttons };
}

export class RoomLogic {
  /** Authoritative config, set by the first (host) HELLO. */
  private config: MatchConfig | null = null;
  /** slot → connId currently occupying it (null = vacant, kept for reconnect). */
  private readonly slotConn: (string | null)[] = new Array(MAX_PLAYERS).fill(null);
  /** connId → slot for admitted connections. */
  private readonly connSlot = new Map<string, number>();
  /** Per-slot input history, indexed by tick (grows for the whole match). */
  private readonly slotInputs: (PlayerInput | undefined)[][] = [];
  /** Lowest tick not yet confirmed+broadcast (both slots' inputs present). */
  private nextBroadcastTick = 0;
  /** Per-tick hash reports awaiting the peer's, keyed by tick. */
  private readonly hashAt = new Map<number, (number | undefined)[]>();
  private started = false;
  private desynced = false;

  constructor() {
    for (let p = 0; p < MAX_PLAYERS; p++) this.slotInputs.push([]);
  }

  /** True once both slots have been filled at least once (match is live). */
  get isStarted(): boolean {
    return this.started;
  }

  /** Highest confirmed tick + 1 (how far the relay has sequenced). */
  get sequencedTicks(): number {
    return this.nextBroadcastTick;
  }

  private firstFreeSlot(): number {
    for (let s = 0; s < MAX_PLAYERS; s++) if (this.slotConn[s] === null) return s;
    return -1;
  }

  private err(connId: string, code: number): Outgoing[] {
    return [{ connId, msg: { type: MSG_ERROR, code } }];
  }

  handleMessage(connId: string, msg: NetMessage): Outgoing[] {
    switch (msg.type) {
      case MSG_HELLO:
        return this.onHello(connId, msg);
      case MSG_REJOIN:
        return this.onRejoin(connId, msg);
      case MSG_INPUT:
        return this.onInput(connId, msg.tick, msg.input);
      case MSG_HASH:
        return this.onHash(connId, msg.tick, msg.hash);
      default:
        // Server-authored tags must never arrive from a client.
        return this.err(connId, ERR_PROTOCOL);
    }
  }

  private onHello(connId: string, msg: NetMessage & { type: typeof MSG_HELLO }): Outgoing[] {
    if (this.connSlot.has(connId)) return this.err(connId, ERR_PROTOCOL); // already admitted
    if (msg.protocol !== PROTOCOL_VERSION) return this.err(connId, ERR_VERSION_MISMATCH);
    if (this.config === null) {
      // First arrival is the host: its config is authoritative for the match.
      this.config = msg.config;
    } else if (msg.config.simVersion !== this.config.simVersion) {
      // A joiner running a different sim would desync by construction (§7).
      return this.err(connId, ERR_VERSION_MISMATCH);
    }
    const slot = this.firstFreeSlot();
    if (slot < 0) return this.err(connId, ERR_ROOM_FULL);
    return this.admit(connId, slot, /*rejoin*/ false, 0);
  }

  private onRejoin(connId: string, msg: NetMessage & { type: typeof MSG_REJOIN }): Outgoing[] {
    if (this.connSlot.has(connId)) return this.err(connId, ERR_PROTOCOL);
    if (this.config === null) return this.err(connId, ERR_BAD_REJOIN); // nothing to rejoin
    if (msg.protocol !== PROTOCOL_VERSION || msg.simVersion !== this.config.simVersion) {
      return this.err(connId, ERR_VERSION_MISMATCH);
    }
    const slot = msg.slot;
    if (slot < 0 || slot >= MAX_PLAYERS || this.slotConn[slot] !== null) {
      // Out of range, or the slot is still occupied — not reclaimable.
      return this.err(connId, ERR_BAD_REJOIN);
    }
    return this.admit(connId, slot, /*rejoin*/ true, msg.fromTick);
  }

  /** Seats connId in slot and emits WELCOME, presence, (history), and START. */
  private admit(connId: string, slot: number, rejoin: boolean, fromTick: number): Outgoing[] {
    this.slotConn[slot] = connId;
    this.connSlot.set(connId, slot);
    const config = this.config as MatchConfig;
    const out: Outgoing[] = [{ connId, msg: { type: MSG_WELCOME, slot, config } }];

    // Tell the newcomer about any peer already present, and the peer about it.
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (s === slot || this.slotConn[s] === null) continue;
      out.push({ connId, msg: { type: MSG_PEER, slot: s, present: true } });
    }
    out.push({ connId: null, msg: { type: MSG_PEER, slot, present: true } });

    if (rejoin) {
      // Fast-forward: resend every confirmed frame from the requested tick so
      // the client can re-simulate up to the live tick (architecture.md §5).
      const from = Math.max(0, Math.min(fromTick, this.nextBroadcastTick));
      for (let t = from; t < this.nextBroadcastTick; t++) {
        out.push({ connId, msg: this.frameMessage(t) });
      }
    }

    // START once both slots are filled for the first time.
    if (!this.started && this.slotConn.every((c) => c !== null)) {
      this.started = true;
      out.push({ connId: null, msg: { type: MSG_START, startTick: 0 } });
    }
    return out;
  }

  private frameMessage(tick: number): NetMessage {
    const inputs: PlayerInput[] = [];
    for (let s = 0; s < MAX_PLAYERS; s++) {
      inputs.push(this.slotInputs[s][tick] ?? IDLE_INPUT);
    }
    return { type: MSG_FRAME, tick, inputs };
  }

  private onInput(connId: string, tick: number, input: PlayerInput): Outgoing[] {
    const slot = this.connSlot.get(connId);
    if (slot === undefined) return this.err(connId, ERR_PROTOCOL);
    if (tick < 0) return this.err(connId, ERR_PROTOCOL);
    // Idempotent: a duplicate for an already-recorded tick is dropped.
    if (this.slotInputs[slot][tick] === undefined) {
      this.slotInputs[slot][tick] = cloneInput(input);
    }
    // Confirm and broadcast every newly-complete tick, in order.
    const out: Outgoing[] = [];
    while (this.bothPresentAt(this.nextBroadcastTick)) {
      out.push({ connId: null, msg: this.frameMessage(this.nextBroadcastTick) });
      this.nextBroadcastTick++;
    }
    return out;
  }

  private bothPresentAt(tick: number): boolean {
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (this.slotInputs[s][tick] === undefined) return false;
    }
    return true;
  }

  private onHash(connId: string, tick: number, hash: number): Outgoing[] {
    const slot = this.connSlot.get(connId);
    if (slot === undefined) return this.err(connId, ERR_PROTOCOL);
    if (this.desynced) return [];
    let slots = this.hashAt.get(tick);
    if (!slots) {
      slots = new Array(MAX_PLAYERS).fill(undefined);
      this.hashAt.set(tick, slots);
    }
    slots[slot] = hash >>> 0;
    // Compare only once every slot has reported this tick.
    let complete = true;
    let mismatch = false;
    const ref = slots[0];
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (slots[s] === undefined) {
        complete = false;
        break;
      }
      if (slots[s] !== ref) mismatch = true;
    }
    if (!complete) return [];
    this.hashAt.delete(tick);
    if (mismatch) {
      this.desynced = true;
      return [{ connId: null, msg: { type: MSG_DESYNC, tick } }];
    }
    return [];
  }

  // --- Hibernation restore (used by the DO after an eviction) ----------------
  // The Durable Object may be evicted between events while its WebSockets live
  // on (Hibernation API). On wake the DO reloads the persisted config + frame
  // history here, then re-seats each surviving socket, so RoomLogic is exactly
  // where it left off. All of this is plain in-memory bookkeeping — no messages
  // are emitted — which keeps it unit-testable without a Workers runtime.

  /**
   * Restores config and the confirmed frame history (index = tick). Only the
   * CONTIGUOUS prefix from tick 0 is trusted: if persisted storage is sparse
   * (a missing/corrupt tick), we stop at the gap rather than claim to have
   * sequenced through it — the room then resumes from the last solid tick.
   */
  hydrate(config: MatchConfig, started: boolean, frames: PlayerInput[][]): void {
    this.config = config;
    this.started = started;
    let next = 0;
    while (next < frames.length && frames[next]) {
      const players = frames[next];
      for (let s = 0; s < MAX_PLAYERS; s++) this.slotInputs[s][next] = cloneInput(players[s]);
      next++;
    }
    this.nextBroadcastTick = next;
  }

  /** Re-associates a surviving socket with its slot (no output). */
  reseat(connId: string, slot: number): void {
    if (slot < 0 || slot >= MAX_PLAYERS) return;
    this.slotConn[slot] = connId;
    this.connSlot.set(connId, slot);
  }

  /** A socket dropped: vacate its slot (history kept) and flag the peer. */
  handleDisconnect(connId: string): Outgoing[] {
    const slot = this.connSlot.get(connId);
    if (slot === undefined) return [];
    this.connSlot.delete(connId);
    this.slotConn[slot] = null;
    return [{ connId: null, msg: { type: MSG_PEER, slot, present: false } }];
  }
}
