// Client-side deterministic lockstep over a PEER-TO-PEER pair of channels
// (hosting.spec.md §3.1) — the serverless sibling of NetLockstep. There is no
// relay confirming frames: each peer holds its own input history and the
// remote's (from redundant packets) and steps tick T only once BOTH are
// present. Both peers step the identical byte stream through the identical
// deterministic sim, so their state (and FNV-1a hash) match tick for tick; the
// input delay hides the TURN round trip exactly as it hides the relay's.
//
// Channels (created by rtc.ts, abstracted as Transport so tests can drive the
// same code over an in-memory lossy pair):
//  - `inputs`: unreliable/unordered. Carries only P2pInputPackets, each with
//    the last k ticks of local input — a lost packet is covered by the next.
//  - `control`: reliable/ordered. Carries binary NetMessages: HELLO (config /
//    version handshake), HASH (periodic state hash), DESYNC (mismatch verdict).
//
// Desync detection is symmetric: both peers exchange hashes every
// HASH_INTERVAL_TICKS and compare locally; whoever sees a mismatch ends the
// match and tells the peer via DESYNC, and both dump their replays.

import {
  createReplayData,
  createSim,
  createTickInputs,
  decodeMessage,
  ERR_VERSION_MISMATCH,
  encodeMessage,
  encodeReplay,
  getMapById,
  hash,
  type MatchConfig,
  MSG_DESYNC,
  MSG_HASH,
  MSG_HELLO,
  ONLINE_INPUT_DELAY_TICKS,
  P2P_INPUT_REDUNDANCY_TICKS,
  type PlayerInput,
  PROTOCOL_VERSION,
  type ReplayData,
  type SimState,
  step,
  type TickInputs,
  writeFrame,
} from "@metropolis/sim";
import { HASH_INTERVAL_TICKS, type NetEnded } from "./lockstep";
import { decodeP2pInput, encodeP2pInput } from "./p2pProtocol";
import type { Transport } from "./transport";

/**
 * While stalled on the peer, re-send the newest input packet every Nth failed
 * tryStep. Both peers pump packets only as their sim advances, so if the last
 * packets of both were lost simultaneously, nobody would ever send again —
 * this keepalive breaks that deadlock. At 60 fps render loops it retries
 * ~15 times/s, a negligible ~1 kB/s worst case.
 */
export const P2P_RESEND_EVERY_TRIES = 4;

export interface P2pCallbacks {
  /** This client's own input for the given (future) tick — device state now. */
  sampleInput(tick: number): PlayerInput;
  /** After a confirmed tick is applied to the sim (drive render/HUD from here). */
  onStep?(tick: number, sim: SimState): void;
  /** Handshake complete — both peers verified and stepping. */
  onStart?(): void;
  /** Hash mismatch at `tick`; `replay` is this client's dumped .mrep bytes. */
  onDesync?(tick: number, replay: Uint8Array): void;
  /** Peer runs an incompatible protocol/sim (should be caught in the lobby). */
  onError?(code: number): void;
  /** A channel dropped — the session is over. */
  onClose?(): void;
}

function copyInput(dst: PlayerInput, src: PlayerInput): void {
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.aimX = src.aimX;
  dst.aimY = src.aimY;
  dst.buttons = src.buttons;
}

export class P2pLockstep {
  private readonly delay = ONLINE_INPUT_DELAY_TICKS;
  private readonly redundancy = P2P_INPUT_REDUNDANCY_TICKS;
  private readonly sim: SimState;
  private started = false;
  private waitingForPeer = false;
  private ended: NetEnded = null;
  /** Highest tick we've sampled local input for (−1 = none yet). */
  private sentUpTo = -1;
  private readonly localInputs: (PlayerInput | undefined)[] = [];
  private readonly remoteInputs: (PlayerInput | undefined)[] = [];
  /** tick → [ownHash, peerHash]; compared and deleted once both are present. */
  private readonly hashAt = new Map<number, (number | undefined)[]>();
  private readonly scratch: TickInputs = createTickInputs();
  private stallTries = 0;

  constructor(
    /** 0 = lobby host, 1 = joiner — fixed slot assignment, both peers agree. */
    readonly slot: number,
    private readonly config: MatchConfig,
    private readonly control: Transport,
    private readonly inputs: Transport,
    private readonly cb: P2pCallbacks,
  ) {
    this.sim = createSim(getMapById(config.mapId), config.seed);
    control.onMessage((bytes) => this.onControl(bytes));
    inputs.onMessage((bytes) => this.onInputPacket(bytes));
    control.onClose(() => this.handleClose());
    inputs.onClose(() => this.handleClose());
    // Handshake: both peers introduce themselves; a valid peer HELLO starts us.
    control.send(encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config }));
  }

  get simTick(): number {
    return this.sim.tick;
  }
  get isWaiting(): boolean {
    return this.waitingForPeer;
  }
  get isStarted(): boolean {
    return this.started;
  }
  get isEnded(): NetEnded {
    return this.ended;
  }

  /**
   * Attempts to advance the sim by exactly one confirmed tick; returns true if
   * it stepped. Keeps local input flowing `delay` ticks ahead and re-sends the
   * newest packet while stalled (see P2P_RESEND_EVERY_TRIES). Call in a loop.
   */
  tryStep(): boolean {
    if (!this.started || this.ended) return false;
    const sim = this.sim;
    this.pumpInput(sim.tick);
    const tick = sim.tick;
    const local = this.localInputs[tick];
    const remote = this.remoteInputs[tick];
    if (!local || !remote) {
      this.waitingForPeer = true;
      if (++this.stallTries % P2P_RESEND_EVERY_TRIES === 0) this.sendWindow();
      return false;
    }
    this.waitingForPeer = false;
    this.stallTries = 0;
    copyInput(this.scratch.players[this.slot], local);
    copyInput(this.scratch.players[1 - this.slot], remote);
    step(sim, this.scratch);
    this.cb.onStep?.(tick, sim);
    if (tick % HASH_INTERVAL_TICKS === 0) {
      const h = hash(sim);
      this.recordHash(tick, /*own*/ true, h);
      this.control.send(encodeMessage({ type: MSG_HASH, tick, hash: h }));
    }
    return true;
  }

  close(): void {
    this.control.close();
    this.inputs.close();
  }

  // --- internals -------------------------------------------------------------

  /** Samples and sends local input for every tick up to sim tick + delay. */
  private pumpInput(simTick: number): void {
    const target = simTick + this.delay;
    let pumped = false;
    while (this.sentUpTo < target) {
      this.sentUpTo++;
      const input = this.cb.sampleInput(this.sentUpTo);
      this.localInputs[this.sentUpTo] = {
        moveX: input.moveX,
        moveY: input.moveY,
        aimX: input.aimX,
        aimY: input.aimY,
        buttons: input.buttons,
      };
      pumped = true;
    }
    if (pumped) this.sendWindow();
  }

  /**
   * Sends the newest redundancy window over the unreliable channel. Besides
   * the last k ticks, the window always reaches back to (own tick − delay − 1):
   * a stalled peer can lag our sim by at most delay + 1 ticks, so this bound
   * guarantees every resend covers the exact tick the peer is blocked on — a
   * plain trailing-k window can deadlock when one side runs ahead.
   */
  private sendWindow(): void {
    if (this.sentUpTo < 0) return;
    const from = Math.max(
      0,
      Math.min(this.sentUpTo - this.redundancy + 1, this.sim.tick - this.delay - 1),
    );
    const window: PlayerInput[] = [];
    for (let t = from; t <= this.sentUpTo; t++) {
      window.push(this.localInputs[t] as PlayerInput);
    }
    this.inputs.send(encodeP2pInput(this.sentUpTo, window));
  }

  private onInputPacket(bytes: Uint8Array): void {
    const packet = decodeP2pInput(bytes);
    if (!packet) return; // unreliable channel: drop junk silently
    const oldest = packet.latestTick - packet.inputs.length + 1;
    for (let i = 0; i < packet.inputs.length; i++) {
      const tick = oldest + i;
      if (tick < 0 || this.remoteInputs[tick] !== undefined) continue;
      this.remoteInputs[tick] = packet.inputs[i];
    }
  }

  private onControl(bytes: Uint8Array): void {
    let msg: ReturnType<typeof decodeMessage>;
    try {
      msg = decodeMessage(bytes);
    } catch {
      return; // a garbled control message can't be actioned; hashes still guard
    }
    switch (msg.type) {
      case MSG_HELLO:
        if (this.started) return;
        if (msg.protocol !== PROTOCOL_VERSION || msg.config.simVersion !== this.config.simVersion) {
          this.ended = "closed";
          this.cb.onError?.(ERR_VERSION_MISMATCH);
          return;
        }
        this.started = true;
        this.cb.onStart?.();
        break;
      case MSG_HASH:
        this.recordHash(msg.tick, /*own*/ false, msg.hash);
        break;
      case MSG_DESYNC:
        this.endDesync(msg.tick, /*notifyPeer*/ false);
        break;
      default:
        break; // anything else is not part of the P2P control plane
    }
  }

  /** Stores one side's hash for a tick; compares once both sides reported. */
  private recordHash(tick: number, own: boolean, h: number): void {
    if (this.ended) return;
    let pair = this.hashAt.get(tick);
    if (!pair) {
      pair = [undefined, undefined];
      this.hashAt.set(tick, pair);
    }
    pair[own ? 0 : 1] = h >>> 0;
    if (pair[0] === undefined || pair[1] === undefined) return;
    this.hashAt.delete(tick);
    if (pair[0] !== pair[1]) this.endDesync(tick, /*notifyPeer*/ true);
  }

  private endDesync(tick: number, notifyPeer: boolean): void {
    if (this.ended) return;
    this.ended = "desync";
    if (notifyPeer) this.control.send(encodeMessage({ type: MSG_DESYNC, tick }));
    this.cb.onDesync?.(tick, this.dumpReplay());
  }

  private handleClose(): void {
    if (this.ended) return;
    this.ended = "closed";
    this.waitingForPeer = false;
    this.cb.onClose?.();
  }

  /** Builds an .mrep from the frames simulated so far (netcode.spec §7). */
  dumpReplay(): Uint8Array {
    const tickCount = this.sim.tick;
    const replay: ReplayData = createReplayData(this.config.mapId, this.config.seed, tickCount);
    for (let t = 0; t < tickCount; t++) {
      const local = this.localInputs[t];
      const remote = this.remoteInputs[t];
      if (!local || !remote) continue; // stepped ticks always have both
      copyInput(this.scratch.players[this.slot], local);
      copyInput(this.scratch.players[1 - this.slot], remote);
      writeFrame(replay, t, this.scratch);
    }
    return encodeReplay(replay);
  }
}
