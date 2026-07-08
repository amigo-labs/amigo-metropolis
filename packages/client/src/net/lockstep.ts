// Client-side deterministic lockstep over a Transport (architecture.md §5).
//
// The contract that keeps two machines in perfect sync: a client NEVER applies
// its own input directly. It sends its input for a FUTURE tick (T + delay) and
// only steps tick T once it receives the server's confirmed FRAME for T — which
// carries BOTH players' inputs. Since both peers step the identical byte stream
// through the identical deterministic sim, their state (and hash) match tick
// for tick. The 3-tick delay hides the round trip.
//
// This owns the SimState and the net concerns (send input, receive frames, hash
// exchange, replay capture, stall/desync signalling). The host frame loop drives
// it by calling tryStep() repeatedly — one confirmed tick per call — which also
// gives reconnect fast-forward for free (call it until it stops returning true).

import {
  createReplayData,
  createSim,
  createTickInputs,
  decodeMessage,
  encodeMessage,
  encodeReplay,
  getMapById,
  hash,
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
  ONLINE_INPUT_DELAY_TICKS,
  type PlayerInput,
  PROTOCOL_VERSION,
  type ReplayData,
  SIM_VERSION,
  type SimState,
  step,
  type TickInputs,
  writeFrame,
} from "@metropolis/sim";
import type { Transport } from "./transport";

/** How often (in ticks) each client attaches a state hash for desync checks. */
export const HASH_INTERVAL_TICKS = 30;

export interface NetCallbacks {
  /** This client's own input for the given (future) tick — device state now. */
  sampleInput(tick: number): PlayerInput;
  /** After a confirmed tick is applied to the sim (drive render/HUD from here). */
  onStep?(tick: number, sim: SimState): void;
  /** Slot assigned + authoritative config received; the sim now exists. */
  onWelcome?(slot: number, sim: SimState, config: MatchConfig): void;
  /** Both slots filled — the match is live. */
  onStart?(): void;
  /** A peer connected (true) or dropped (false) — drives the stall overlay. */
  onPeer?(slot: number, present: boolean): void;
  /** Hash mismatch at `tick`; `replay` is this client's dumped .mrep bytes. */
  onDesync?(tick: number, replay: Uint8Array): void;
  /** Join rejected (version mismatch, room full, …). */
  onError?(code: number): void;
  /**
   * The transport dropped (socket close/error). Distinct from a peer-input
   * stall: the session is over unless the host starts a fresh one (a new
   * NetLockstep with the rejoin option). Lets the UI show "disconnected".
   */
  onClose?(): void;
}

export type NetEnded = "desync" | "closed" | null;

function copyInput(dst: PlayerInput, src: PlayerInput): void {
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.aimX = src.aimX;
  dst.aimY = src.aimY;
  dst.buttons = src.buttons;
}

export class NetLockstep {
  private readonly delay = ONLINE_INPUT_DELAY_TICKS;
  private sim: SimState | null = null;
  private config: MatchConfig | null = null;
  private slotIdx = -1;
  private started = false;
  private waitingForPeer = false;
  private ended: NetEnded = null;
  /** Highest tick we've sent local input for (−1 = none yet). */
  private sentUpTo = -1;
  /** Confirmed inputs keyed by tick (index = tick), each MAX_PLAYERS entries. */
  private readonly confirmed: (PlayerInput[] | undefined)[] = [];
  private readonly scratch: TickInputs = createTickInputs();

  constructor(
    private readonly transport: Transport,
    private readonly cb: NetCallbacks,
    /** Present only when reconnecting: the config + slot held before the drop. */
    private readonly rejoin?: { config: MatchConfig; slot: number },
  ) {
    transport.onMessage((bytes) => this.onMessage(bytes));
    transport.onClose(() => this.handleClose());
  }

  /** Transport dropped: end the session (unless a desync already ended it). */
  private handleClose(): void {
    if (this.ended) return;
    this.ended = "closed";
    this.waitingForPeer = false;
    this.cb.onClose?.();
  }

  get slot(): number {
    return this.slotIdx;
  }
  get simTick(): number {
    return this.sim ? this.sim.tick : 0;
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

  /** Opens the session: HELLO for a fresh join, REJOIN to reclaim a slot. */
  start(config: MatchConfig): void {
    this.config = config;
    if (this.rejoin) {
      // Rebuild the sim from scratch and re-simulate the whole match from the
      // server's full frame history (architecture.md §5 "re-simulating"). We
      // hold no local frames across a reconnect, so ask for everything.
      this.buildSim(this.rejoin.slot, this.rejoin.config);
      this.started = true; // the server won't re-send START to a rejoiner
      this.send({
        type: MSG_REJOIN,
        protocol: PROTOCOL_VERSION,
        simVersion: SIM_VERSION,
        slot: this.rejoin.slot,
        fromTick: 0,
      });
    } else {
      this.send({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config });
    }
  }

  /**
   * Attempts to advance the sim by exactly one confirmed tick. Returns true if
   * it stepped. Also keeps local input flowing `delay` ticks ahead. Call in a
   * loop: it steps as long as frames are ready (normal cadence and catch-up).
   */
  tryStep(): boolean {
    const sim = this.sim;
    if (!sim || !this.started || this.ended) return false;
    this.pumpInput(sim.tick);
    const frame = this.confirmed[sim.tick];
    if (!frame) {
      this.waitingForPeer = true;
      return false;
    }
    this.waitingForPeer = false;
    const tick = sim.tick;
    for (let p = 0; p < this.scratch.players.length; p++)
      copyInput(this.scratch.players[p], frame[p]);
    step(sim, this.scratch);
    this.cb.onStep?.(tick, sim);
    if (tick % HASH_INTERVAL_TICKS === 0) {
      this.send({ type: MSG_HASH, tick, hash: hash(sim) });
    }
    return true;
  }

  close(): void {
    this.transport.close();
  }

  // --- internals -------------------------------------------------------------

  /** Sends local input for every tick up to sim tick + delay (once each). */
  private pumpInput(simTick: number): void {
    const target = simTick + this.delay;
    while (this.sentUpTo < target) {
      this.sentUpTo++;
      // Skip ticks the server already holds (their frame has come back to us):
      // avoids a redundant input burst while fast-forwarding after a reconnect.
      if (this.confirmed[this.sentUpTo]) continue;
      this.send({
        type: MSG_INPUT,
        tick: this.sentUpTo,
        input: this.cb.sampleInput(this.sentUpTo),
      });
    }
  }

  private onMessage(bytes: Uint8Array): void {
    const msg = decodeMessage(bytes);
    switch (msg.type) {
      case MSG_WELCOME:
        if (!this.sim) this.buildSim(msg.slot, msg.config);
        this.slotIdx = msg.slot;
        this.cb.onWelcome?.(msg.slot, this.sim as SimState, msg.config);
        break;
      case MSG_START:
        this.started = true;
        this.cb.onStart?.();
        break;
      case MSG_FRAME:
        this.confirmed[msg.tick] = msg.inputs;
        break;
      case MSG_PEER:
        this.cb.onPeer?.(msg.slot, msg.present);
        break;
      case MSG_DESYNC:
        this.ended = "desync";
        this.cb.onDesync?.(msg.tick, this.dumpReplay());
        break;
      case MSG_ERROR:
        this.cb.onError?.(msg.code);
        break;
      default:
        // Client-authored tags coming back from the server are ignored.
        break;
    }
  }

  private buildSim(slot: number, config: MatchConfig): void {
    this.slotIdx = slot;
    this.config = config;
    const map = getMapById(config.mapId);
    this.sim = createSim(
      map,
      config.seed,
      config.wardenPlayer >= 0
        ? { wardenPlayer: config.wardenPlayer, wardenDifficulty: config.wardenDifficulty }
        : undefined,
    );
  }

  /** Builds an .mrep from the confirmed frames simulated so far (§6). */
  dumpReplay(): Uint8Array {
    const config = this.config;
    const tickCount = this.sim ? this.sim.tick : 0;
    if (!config) return new Uint8Array(0);
    const warden =
      config.wardenPlayer >= 0
        ? { player: config.wardenPlayer, difficulty: config.wardenDifficulty }
        : undefined;
    const replay: ReplayData = createReplayData(config.mapId, config.seed, tickCount, warden);
    for (let t = 0; t < tickCount; t++) {
      const frame = this.confirmed[t];
      if (!frame) continue;
      for (let p = 0; p < this.scratch.players.length; p++)
        copyInput(this.scratch.players[p], frame[p]);
      writeFrame(replay, t, this.scratch);
    }
    return encodeReplay(replay);
  }

  private send(msg: Parameters<typeof encodeMessage>[0]): void {
    this.transport.send(encodeMessage(msg));
  }
}
