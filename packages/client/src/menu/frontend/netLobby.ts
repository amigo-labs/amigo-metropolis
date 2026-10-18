// The original's networked lobby, the part that talks: what the two players'
// front ends tell each other between "connected" and the match (RE
// `src/game/frontend/input.c`, 0x00401990, the frontend's DirectPlay pump;
// the senders in `net_ready.c` and `panel_callbacks.c`). Pure: no DOM, no
// socket. A LobbyLink carries the messages (the relay's NetLockstep or the
// P2P control channel), and the menu draws from the fields here.
//
// What the original does, and so what this does:
//
//   - The host owns the setup and pushes it, each side owns its own name,
//     selection (HARD / NORMAL / EASY), loadout and ready bit. On the link
//     the host sends its half in the order of the hello's arm -- the map row
//     (setup choice 0), its name, its selection, its loadout, then its ready
//     bit if it is set -- and the joiner its own in the order of the ack's
//     arm: name, selection, loadout.
//   - Every change goes out when it is made: an arrow its slot's loadout, a
//     chevron the selection, the host's map press the setup choice.
//   - START sets this side's ready bit and sends it (0x00409f60); any mouse
//     button while this side is ready takes it back first and sends that
//     (0x0040bbe0, the model's "unready").
//   - A player whose bit is set shows WAITING; both set is the start
//     (frontend_ready_set answers "both", 0x00401850).
//
// Where Metropolis has to differ: the original's two machines each start the
// moment their own copy of the flags says both, and a click on one side that
// crosses the other's last ready bit on the wire leaves one in the mission
// and one in the lobby. A lockstep match must start both sides on one
// config, so the host decides: when its copy says both, it builds the agreed
// config from what it holds and begins (the relay seals it into START; P2P
// sends START itself), and the joiner starts on that START, whatever it did
// after. The map comes from the host's row, the seed from the host (as the
// original's mission handshake sends the host's, session.c 0x00406160).
//
// Not carried, because Metropolis has none of them: the Crime War pick
// (setup choice 1), the Split Screen byte (0x16), the game mode (0x17). The
// owner's "Spielregeln", the five extra-weapon switches (F23), ride on 0x20,
// host to joiner.

import {
  DIFFICULTY_NORMAL,
  isDifficulty,
  LOBBY_EXTRA_WEAPONS,
  LOBBY_NAME,
  LOBBY_NAME_BYTES,
  LOBBY_P1_LOADOUT,
  LOBBY_P1_READY,
  LOBBY_P1_SELECTION,
  LOBBY_P2_LOADOUT,
  LOBBY_P2_READY,
  LOBBY_P2_SELECTION,
  LOBBY_SETUP_CHOICE,
  type LobbyMessage,
  type MatchConfig,
  SIM_VERSION,
} from "@metropolis/sim";
import { FE_PA_MAPS } from "./frontendData.generated";
import { allowedEntries, loadoutOfEntries, PA_ROWS } from "./model";

/** What carries the lobby: the relay's lockstep or the P2P control channel. */
export interface LobbyLink {
  send(msg: LobbyMessage): void;
  /** The host's agreed config (slot 0 only). */
  begin(config: MatchConfig): void;
  close(): void;
}

/** One column: its three loadout entries (0..4 per slot) and its selection. */
export interface LobbyPicks {
  loadout: number[];
  difficulty: number;
}

export type LobbyPhase = "connecting" | "linked" | "started" | "failed" | "gone";

/** The two name buffers' start-up values (0x00405980): the host's, the joiner's. */
export const DEFAULT_NAMES: readonly string[] = ["Player1", "Player2"];
/** The dialogs' Player Name edit limit (EM_LIMITTEXT 0xf, host_dialog.c / join_dialog.c). */
export const NAME_LIMIT = 15;

/** The text that goes out as a name: 15 characters, single-byte as the original's ANSI. */
export function lobbyName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (out.length >= Math.min(NAME_LIMIT, LOBBY_NAME_BYTES)) break;
    out += ch.length === 1 && ch.charCodeAt(0) <= 0xff ? ch : "?";
  }
  return out;
}

/** A column's entries as the original's ids, `slot << 4 | entry` (0x0040c1b0's defaults 0, 0x10, 0x20). */
export function loadoutCodes(entries: readonly number[]): number[] {
  return [0, 1, 2].map((slot) => (slot << 4) | (entries[slot] & 15));
}

/** The ids back as entries. */
export function entriesOfCodes(codes: readonly number[]): number[] {
  return [0, 1, 2].map((slot) => codes[slot] & 15);
}

const SELECTION = [LOBBY_P1_SELECTION, LOBBY_P2_SELECTION] as const;
const LOADOUT = [LOBBY_P1_LOADOUT, LOBBY_P2_LOADOUT] as const;
const READY = [LOBBY_P1_READY, LOBBY_P2_READY] as const;

export interface NetLobbyOptions {
  /** This side's Player Name (the dialog's edit). */
  readonly name: string;
  /** The local config's two columns; this side's own is picked by its slot. */
  readonly picks: readonly LobbyPicks[];
  /** The local config's map row (the host's pick 0). */
  readonly mapRow: number;
  /** The local config's extra-weapons switches (the host's are the lobby's). */
  readonly extraWeapons: number;
  /** The arena when the row names none (a deep link onto a non-PA arena). */
  readonly mapId?: string;
  /** A deep link has nobody to press START: ready as soon as linked. */
  readonly autoReady?: boolean;
}

export class NetLobby {
  /** 0 the host, 1 the joiner; -1 until the transport seats us. */
  slot = -1;
  phase: LobbyPhase = "connecting";
  /** The dialog's Connection Status line. */
  status = "";
  /** Both players' names, slot-indexed: DAT_00512000 and DAT_0051201f. */
  readonly names: string[] = [...DEFAULT_NAMES];
  /** Both columns, slot-indexed. The peer's shows the defaults until it speaks. */
  readonly picks: LobbyPicks[];
  /** The lobby flag bits 0 and 1: each player's ready. */
  readonly ready: [boolean, boolean] = [false, false];
  /** The Precinct Assault map row, the host's. */
  mapRow: number;
  /** The host's extra-weapons switches (EXTRA_* mask). */
  extraWeapons: number;
  /** The agreed config, once START has it. */
  config: MatchConfig | null = null;
  /** Anything a reader draws from changed. */
  onChange: (() => void) | null = null;

  private link: LobbyLink | null = null;
  /** The peer arrived before we were seated (P2P's HELLO can beat the attach). */
  private linkPending = false;
  private seed = 0;
  /** The host has begun: its own picks are sealed. */
  private begun = false;
  private readonly ownName: string;

  constructor(private readonly opts: NetLobbyOptions) {
    this.ownName = lobbyName(opts.name);
    this.picks = opts.picks.map((p) => ({ loadout: [...p.loadout], difficulty: p.difficulty }));
    this.mapRow = opts.mapRow;
    this.extraWeapons = opts.extraWeapons;
  }

  get hosting(): boolean {
    return this.slot === 0;
  }
  get peerSlot(): number {
    return 1 - this.slot;
  }
  /** The "Connected To:" line: the other side's name buffer (0x00409e50). */
  get peerName(): string {
    return this.slot < 0 ? "" : this.names[this.peerSlot];
  }
  get bothReady(): boolean {
    return this.ready[0] && this.ready[1];
  }

  // --- the transport's side ------------------------------------------------------

  /** Seated: the slot the transport gave us (the relay's first arrival hosts) and the host's seed. */
  attach(link: LobbyLink, slot: number, seed: number): void {
    this.link = link;
    this.slot = slot;
    this.seed = seed >>> 0;
    this.names[slot] = this.ownName;
    // The peer's column starts at the defaults; ours is the local config's.
    this.picks[1 - slot] = { loadout: [0, 0, 0], difficulty: DIFFICULTY_NORMAL };
    this.changed();
    if (this.linkPending) this.linked();
  }

  setStatus(text: string): void {
    this.status = text;
    this.changed();
  }

  /** The peer is here (relay PEER present / P2P HELLO checked): push our half. */
  linked(): void {
    if (this.phase !== "connecting") return;
    if (!this.link) {
      this.linkPending = true;
      return;
    }
    this.phase = "linked";
    const s = this.slot;
    if (s === 0) {
      // The hello's arm, 0x00401990: setup choice 0, name, selection, loadout,
      // (split screen and mode: not carried), the rule, then the ready bit.
      this.send({ id: LOBBY_SETUP_CHOICE, index: 0, value: this.mapRow < 0 ? 0 : this.mapRow });
      this.send({ id: LOBBY_NAME, name: this.ownName });
      this.send({ id: SELECTION[s], selection: this.picks[s].difficulty });
      this.send({ id: LOADOUT[s], codes: loadoutCodes(this.picks[s].loadout) });
      this.send({ id: LOBBY_EXTRA_WEAPONS, mask: this.extraWeapons });
      if (this.ready[s]) this.send({ id: READY[s], ready: true });
    } else {
      // The ack's arm: name, selection, loadout.
      this.send({ id: LOBBY_NAME, name: this.ownName });
      this.send({ id: SELECTION[s], selection: this.picks[s].difficulty });
      this.send({ id: LOADOUT[s], codes: loadoutCodes(this.picks[s].loadout) });
    }
    this.changed();
    if (this.opts.autoReady) this.setReady(true);
  }

  /**
   * One of the peer's messages, through the original's role gates. The peer
   * may speak before its arrival reaches us (the relay's order), so a seated
   * lobby takes it while still connecting.
   */
  receive(m: LobbyMessage): void {
    if (this.slot < 0 || (this.phase !== "linked" && this.phase !== "connecting")) return;
    const peer = this.peerSlot;
    const joiner = this.slot === 1;
    switch (m.id) {
      case LOBBY_SETUP_CHOICE:
        // Host to joiner; index 1 is the Crime War pick Metropolis lacks.
        if (!joiner || m.index !== 0 || m.value >= PA_ROWS) return;
        this.mapRow = m.value;
        break;
      case LOBBY_NAME:
        this.names[peer] = m.name;
        break;
      case LOBBY_P1_SELECTION:
      case LOBBY_P2_SELECTION:
        // The original takes either from either side; the peer only ever sends
        // its own, so only its own is taken.
        if (m.id !== SELECTION[peer] || !isDifficulty(m.selection)) return;
        this.picks[peer].difficulty = m.selection;
        break;
      case LOBBY_P1_LOADOUT:
      case LOBBY_P2_LOADOUT:
        if (m.id !== LOADOUT[peer]) return;
        this.picks[peer].loadout = entriesOfCodes(m.codes);
        break;
      case LOBBY_P1_READY:
      case LOBBY_P2_READY:
        // 0x10 host to joiner, 0x15 joiner to host.
        if (m.id !== READY[peer]) return;
        this.ready[peer] = m.ready;
        this.maybeBegin();
        break;
      case LOBBY_EXTRA_WEAPONS:
        if (!joiner) return;
        this.extraWeapons = m.mask;
        this.reconcileRule();
        break;
    }
    this.changed();
  }

  /** START is in: the agreed config both sides build from. */
  started(config: MatchConfig): void {
    this.config = config;
    this.phase = "started";
    this.changed();
  }

  /** The session could not open (the dialog's status says why). */
  fail(text: string): void {
    if (this.phase === "started") return;
    this.phase = "failed";
    this.status = text;
    this.changed();
  }

  /** The peer left the lobby (PEER absent, the channel closed): the original's 0x18. */
  peerGone(): void {
    if (this.phase !== "linked") return;
    this.phase = "gone";
    this.changed();
  }

  /** CANCEL: this side leaves (frontend_begin(1)); the peer sees it go. */
  close(): void {
    if (this.phase === "connecting" || this.phase === "linked") this.phase = "gone";
    this.link?.close();
    this.link = null;
  }

  // --- the screen's side ---------------------------------------------------------

  /** START (ready) or a click while ready (taken back). */
  setReady(on: boolean): void {
    if (this.phase !== "linked" || this.begun || this.ready[this.slot] === on) return;
    this.ready[this.slot] = on;
    this.send({ id: READY[this.slot], ready: on });
    this.maybeBegin();
    this.changed();
  }

  /** This side's column, after an arrow. */
  setLoadout(entries: readonly number[]): void {
    if (!this.mayEdit()) return;
    this.picks[this.slot].loadout = [...entries];
    this.send({ id: LOADOUT[this.slot], codes: loadoutCodes(entries) });
    this.changed();
  }

  /** This side's selection, after a chevron. */
  setDifficulty(difficulty: number): void {
    if (!this.mayEdit()) return;
    this.picks[this.slot].difficulty = difficulty;
    this.send({ id: SELECTION[this.slot], selection: difficulty });
    this.changed();
  }

  /** The host's map press (frontend_send_setup_choice, 0x00401920). */
  setMapRow(row: number): void {
    if (!this.mayEdit() || !this.hosting) return;
    this.mapRow = row;
    this.send({ id: LOBBY_SETUP_CHOICE, index: 0, value: row });
    this.changed();
  }

  /** The host's "Spielregeln" switches. */
  setExtraWeapons(mask: number): void {
    if (!this.mayEdit() || !this.hosting || this.extraWeapons === mask) return;
    this.extraWeapons = mask;
    this.send({ id: LOBBY_EXTRA_WEAPONS, mask });
    this.reconcileRule();
    this.changed();
  }

  // --- internals -----------------------------------------------------------------

  private mayEdit(): boolean {
    return this.phase === "linked" && !this.begun && this.slot >= 0;
  }

  private send(m: LobbyMessage): void {
    this.link?.send(m);
  }

  private changed(): void {
    this.onChange?.();
  }

  /** A switch went off: this side's weapon it hung on goes back to entry 0, and the peer is told. */
  private reconcileRule(): void {
    const own = this.picks[this.slot];
    const kept = allowedEntries(own.loadout, this.extraWeapons);
    if (kept.some((e, i) => e !== own.loadout[i])) this.setLoadout(kept);
  }

  /** The host's copy of the flags says both: build the agreed config and begin. */
  private maybeBegin(): void {
    if (!this.hosting || this.begun || !this.bothReady || !this.link) return;
    this.begun = true;
    this.link.begin(this.agreedConfig());
  }

  /** What the host holds, as the match: its map and seed, each column's picks, its switches. */
  agreedConfig(): MatchConfig {
    const row = this.mapRow >= 0 && this.mapRow < PA_ROWS ? FE_PA_MAPS[this.mapRow] : undefined;
    return {
      simVersion: SIM_VERSION,
      seed: this.seed,
      mapId: row?.mapId ?? this.opts.mapId ?? FE_PA_MAPS[1].mapId,
      wardenPlayer: -1,
      wardenDifficulty: 0,
      difficulties: [this.picks[0].difficulty, this.picks[1].difficulty],
      loadouts: [loadoutOfEntries(this.picks[0].loadout), loadoutOfEntries(this.picks[1].loadout)],
      extraWeapons: this.extraWeapons,
    };
  }
}
