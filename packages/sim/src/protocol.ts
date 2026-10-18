// Online lockstep wire protocol (architecture.md §5). Binary from day one —
// tiny fixed-size buffers, no JSON on the hot path. This lives in `sim` for the
// same reason the replay frame codec does: the per-tick input frame IS the
// replay frame, and the sim owns the one canonical definition of it. Nothing
// here touches the deterministic tick — it is pure byte (de)serialization, like
// replay.ts, so it does not affect the sim hash or SIM_VERSION.
//
// A message is a u8 type tag followed by a fixed little-endian body. The tag
// namespace is split so client→server and server→client can never be confused:
// 1–9 are client-authored, 10+ are server-authored.
//
// The MatchConfig header (seed / warden / difficulties / mapId) mirrors the
// replay header body (replay.ts) field-for-field: an online match and its
// recorded replay carry the exact same match parameters, so the two definitions
// stay in lock-step. The loadouts follow the mapId (protocol 4); the replay
// header does not carry them yet (format 4), so a desync dump of an online
// match replays the default kit.
//
// Since protocol 4 a match starts in the original's networked lobby: the two
// peers exchange their names, picks and ready bits as the original's front end
// does (MSG_LOBBY, its message ids), and the host seals the agreed setup once
// both are ready (MSG_BEGIN through the relay, which answers MSG_START with it).

import { MAX_PLAYERS } from "./balance";
import type { PlayerInput } from "./inputs";
import { isDifficulty } from "./replay";
import { DEFAULT_LOADOUT, GUNS, HEAVIES, type Loadout, SPECIALS } from "./weapons";

/**
 * Wire framing version, independent of SIM_VERSION. Bumped only when the byte
 * layout below changes; SIM_VERSION handles gameplay/hash changes. A room
 * rejects clients whose SIM_VERSION differs (goldens would already be broken),
 * and this guards the framing itself.
 */
export const PROTOCOL_VERSION = 4;

// --- Message type tags -------------------------------------------------------
// Client → server (1–9).
export const MSG_HELLO = 1; // fresh join: carries the match config
export const MSG_REJOIN = 2; // reconnect: reclaim a slot, ask for history
export const MSG_INPUT = 3; // this client's input for one (future) tick
export const MSG_HASH = 4; // this client's state hash at one tick
export const MSG_BEGIN = 5; // the host: both ready — the agreed config (protocol 4)
// Server → client (10+).
export const MSG_WELCOME = 10; // slot assignment + the host's config
export const MSG_START = 11; // the agreed config — begin stepping (protocol 4: carries it)
export const MSG_FRAME = 12; // confirmed inputs for one tick (all players)
export const MSG_PEER = 13; // a peer connected / disconnected
export const MSG_DESYNC = 14; // hash mismatch — end match, dump replays
export const MSG_ERROR = 15; // join rejected
// Peer → peer (20+): the relay forwards it to the other slot unread; P2P sends
// it on the control channel.
export const MSG_LOBBY = 20; // one of the original's lobby messages (protocol 4)

// --- Error codes (MSG_ERROR body) --------------------------------------------
export const ERR_VERSION_MISMATCH = 1; // simVersion (or protocol) differs
export const ERR_ROOM_FULL = 2; // both slots already occupied
export const ERR_BAD_REJOIN = 3; // slot not reclaimable
export const ERR_PROTOCOL = 4; // malformed / unexpected message

/** Match parameters agreed at join time; superset of SimOptions + map + seed. */
export interface MatchConfig {
  /** SIM_VERSION the host is running; a joiner must match exactly. */
  readonly simVersion: number;
  readonly seed: number;
  readonly mapId: string;
  /** Player slot driven by the Warden AI, -1 for none (online 1v1 uses -1). */
  readonly wardenPlayer: number;
  /** Warden difficulty 1–10; 0 when wardenPlayer is -1. */
  readonly wardenDifficulty: number;
  /**
   * Each player's difficulty (balance.ts DIFFICULTY_*: 0 HARD, 1 NORMAL, 2
   * EASY), MAX_PLAYERS entries, slot-indexed (since protocol 3). The online
   * lobby offers no pick yet: both players NORMAL (replay.ts
   * DEFAULT_DIFFICULTIES).
   */
  readonly difficulties: readonly number[];
  /**
   * Each player's loadout (indices into GUNS / HEAVIES / SPECIALS),
   * MAX_PLAYERS entries, slot-indexed (since protocol 4): the picks the
   * networked lobby agreed.
   */
  readonly loadouts: readonly Loadout[];
  /**
   * The owner's "Spielregeln" (since protocol 4; a Metropolis decision, not
   * the original's): a u8 mask of the extra weapons the loadout columns offer,
   * bit 0 Riot Shield, 1 K-9 Drone, 2 Grenade Launcher, 3 Fusion Torpedo,
   * 4 Plasma Flare -- the five entries the original's Precinct Assault never
   * offers. The host sets it; 0 is the original's PA. Maps onto
   * SimOptions.extraWeapons.
   */
  readonly extraWeapons: number;
}

/** The extra-weapons mask's five bits (MatchConfig.extraWeapons). */
export const EXTRA_WEAPONS_MASK = 0x1f;

/** Both players on the default kit (the front end's NEW GAME columns). */
export const DEFAULT_LOADOUTS: readonly Loadout[] = new Array(MAX_PLAYERS).fill(DEFAULT_LOADOUT);

// --- The networked lobby's messages (protocol 4) -----------------------------
// The original's front end runs its two-player lobby as a DirectPlay message
// exchange (RE `src/game/frontend/input.c`, 0x00401990, ids in
// `fcop/frontend_input.h`). MSG_LOBBY carries the ones Metropolis has a use
// for under their original ids: the host's map, each side's name, its
// HARD / NORMAL / EASY "selection", its loadout and its ready bit. "P1" is the
// host (slot 0), "P2" the joiner (slot 1). Not carried: the Crime War pick
// (setup choice 1), the host's Split Screen byte (0x16) and the game mode
// (0x17) -- Metropolis has no Crime War and no split screen; the original's
// hello / ack / refusal (0x11..0x13) and "peer gone" (0x18) are the
// transports' own HELLO / WELCOME / ERROR and PEER / close.

/** Host -> joiner: setup byte `index` (0 the Precinct Assault map row) = value. */
export const LOBBY_SETUP_CHOICE = 0x09;
/** Either way: the sender's player name. */
export const LOBBY_NAME = 0x0a;
/** Host -> joiner / joiner -> host: the sender's HARD / NORMAL / EASY entry. */
export const LOBBY_P1_SELECTION = 0x0b;
export const LOBBY_P2_SELECTION = 0x0c;
/** The sender's three loadout codes, `slot << 4 | entry` (0x00, 0x10, 0x20 the defaults). */
export const LOBBY_P1_LOADOUT = 0x0d;
export const LOBBY_P2_LOADOUT = 0x0e;
/** The sender's ready bit: lobby flag bit 0 (host) or bit 1 (joiner). */
export const LOBBY_P1_READY = 0x10;
export const LOBBY_P2_READY = 0x15;

/**
 * Host -> joiner: the "Spielregeln" extra-weapons mask. Not the original's:
 * the owner's game rules (MatchConfig.extraWeapons), given an id past the
 * original's 0x09..0x18 so it can never be taken for one of them.
 */
export const LOBBY_EXTRA_WEAPONS = 0x20;

/**
 * A name's bytes on the wire: the original's 0x20-byte message less its id
 * word. Its dialogs cap the edit at 15 characters (EM_LIMITTEXT 0xf); the
 * characters are the original's single-byte ANSI, so a code point above 0xff
 * does not go out.
 */
export const LOBBY_NAME_BYTES = 28;

export type LobbyMessage =
  | { readonly id: typeof LOBBY_SETUP_CHOICE; readonly index: number; readonly value: number }
  | { readonly id: typeof LOBBY_NAME; readonly name: string }
  | {
      readonly id: typeof LOBBY_P1_SELECTION | typeof LOBBY_P2_SELECTION;
      readonly selection: number;
    }
  | {
      readonly id: typeof LOBBY_P1_LOADOUT | typeof LOBBY_P2_LOADOUT;
      /** Three codes, slot order: `slot << 4 | entry`, entry 0..4. */
      readonly codes: readonly number[];
    }
  | { readonly id: typeof LOBBY_P1_READY | typeof LOBBY_P2_READY; readonly ready: boolean }
  | { readonly id: typeof LOBBY_EXTRA_WEAPONS; readonly mask: number };

/** One player's input: the button word, u16 (inputs.ts). 5 bytes of axes before v2. */
export const PLAYER_INPUT_BYTES = 2;

export type NetMessage =
  | { readonly type: typeof MSG_HELLO; readonly protocol: number; readonly config: MatchConfig }
  | {
      readonly type: typeof MSG_REJOIN;
      readonly protocol: number;
      readonly simVersion: number;
      readonly slot: number;
      /** First tick the client still needs streamed (0 = re-sim from scratch). */
      readonly fromTick: number;
    }
  | { readonly type: typeof MSG_INPUT; readonly tick: number; readonly input: PlayerInput }
  | { readonly type: typeof MSG_HASH; readonly tick: number; readonly hash: number }
  | { readonly type: typeof MSG_BEGIN; readonly config: MatchConfig }
  | { readonly type: typeof MSG_WELCOME; readonly slot: number; readonly config: MatchConfig }
  | {
      readonly type: typeof MSG_START;
      readonly startTick: number;
      /** The agreed setup both peers build their sim from. */
      readonly config: MatchConfig;
    }
  | {
      readonly type: typeof MSG_FRAME;
      readonly tick: number;
      /** Exactly MAX_PLAYERS entries, slot-indexed. */
      readonly inputs: PlayerInput[];
    }
  | { readonly type: typeof MSG_PEER; readonly slot: number; readonly present: boolean }
  | { readonly type: typeof MSG_DESYNC; readonly tick: number }
  | { readonly type: typeof MSG_ERROR; readonly code: number }
  | { readonly type: typeof MSG_LOBBY; readonly lobby: LobbyMessage };

// --- Cursor helpers (little-endian) ------------------------------------------

class Writer {
  private readonly view: DataView;
  private o = 0;
  constructor(byteLength: number) {
    this.view = new DataView(new ArrayBuffer(byteLength));
  }
  u8(v: number): void {
    this.view.setUint8(this.o, v & 0xff);
    this.o += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.o, v & 0xffff, true);
    this.o += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  ascii(s: string): void {
    // Enforce ASCII on encode too (Reader.ascii rejects it on decode): keeps
    // the codec symmetric and never silently truncates a non-ASCII code point.
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 0x7f) throw new Error("string must be ASCII");
      this.u8(c);
    }
  }
  /** A length byte, then one byte a character (code points above 0xff refused). */
  latin1(s: string): void {
    this.u8(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 0xff) throw new Error("name must be single-byte characters");
      this.u8(c);
    }
  }
  bytes(): Uint8Array {
    if (this.o !== this.view.byteLength) {
      throw new Error(`writer underfilled: ${this.o}/${this.view.byteLength}`);
    }
    return new Uint8Array(this.view.buffer);
  }
}

class Reader {
  private readonly view: DataView;
  private o = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.o + n > this.view.byteLength) throw new Error("truncated message");
  }
  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.o);
    this.o += 1;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  ascii(len: number): string {
    this.need(len);
    let s = "";
    for (let i = 0; i < len; i++) {
      const c = this.buf[this.o + i];
      if (c > 0x7f) throw new Error("mapId must be ASCII");
      s += String.fromCharCode(c);
    }
    this.o += len;
    return s;
  }
  latin1(len: number): string {
    this.need(len);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.buf[this.o + i]);
    this.o += len;
    return s;
  }
  /** Rejects a buffer with bytes left over after the message body (§ untrusted). */
  expectEnd(): void {
    if (this.o !== this.view.byteLength) {
      throw new Error(`trailing bytes after message (${this.view.byteLength - this.o} extra)`);
    }
  }
}

// --- Config header (shared by HELLO / WELCOME / BEGIN / START) ----------------
// Bytes: simVersion u16, seed u32, wardenPlayer u8 (0xff = -1),
// wardenDifficulty u8, difficulty u8 × MAX_PLAYERS, mapIdLen u8, mapId ASCII
// (replay.ts offsets 6→), then since protocol 4 each player's loadout as
// gun / heavy / special u8, MAX_PLAYERS × 3, and the extra-weapons mask u8
// (EXTRA_WEAPONS_MASK).

const LOADOUT_LISTS = [GUNS, HEAVIES, SPECIALS] as const;

function loadoutIndexOk(slot: number, v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < LOADOUT_LISTS[slot].length;
}

function extraOk(v: unknown): boolean {
  return Number.isInteger(v) && ((v as number) & ~EXTRA_WEAPONS_MASK) === 0;
}

function configBytes(config: MatchConfig): number {
  if (config.mapId.length > 255) throw new Error("mapId too long");
  return 2 + 4 + 1 + 1 + MAX_PLAYERS + 1 + config.mapId.length + 3 * MAX_PLAYERS + 1;
}

function writeConfig(w: Writer, config: MatchConfig): void {
  // Refused on encode as on decode: a byte write would truncate a bad value.
  if (config.difficulties.length !== MAX_PLAYERS) {
    throw new Error(`difficulties needs ${MAX_PLAYERS} entries`);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (!isDifficulty(config.difficulties[p])) {
      throw new Error(`bad difficulty ${config.difficulties[p]}`);
    }
  }
  if (config.loadouts.length !== MAX_PLAYERS) {
    throw new Error(`loadouts needs ${MAX_PLAYERS} entries`);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const l = config.loadouts[p];
    if (!loadoutIndexOk(0, l.gun) || !loadoutIndexOk(1, l.heavy) || !loadoutIndexOk(2, l.special)) {
      throw new Error(`bad loadout ${l.gun}/${l.heavy}/${l.special}`);
    }
  }
  w.u16(config.simVersion);
  w.u32(config.seed);
  w.u8(config.wardenPlayer >= 0 ? config.wardenPlayer : 0xff);
  w.u8(config.wardenPlayer >= 0 ? config.wardenDifficulty : 0);
  for (let p = 0; p < MAX_PLAYERS; p++) w.u8(config.difficulties[p]);
  w.u8(config.mapId.length);
  w.ascii(config.mapId);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const l = config.loadouts[p];
    w.u8(l.gun);
    w.u8(l.heavy);
    w.u8(l.special);
  }
  if (!extraOk(config.extraWeapons)) throw new Error(`bad extraWeapons ${config.extraWeapons}`);
  w.u8(config.extraWeapons);
}

function readConfig(r: Reader): MatchConfig {
  const simVersion = r.u16();
  const seed = r.u32();
  const rawWarden = r.u8();
  const wardenPlayer = rawWarden === 0xff ? -1 : rawWarden;
  const wardenDifficulty = r.u8();
  const difficulties: number[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) difficulties.push(r.u8());
  const mapIdLen = r.u8();
  const mapId = r.ascii(mapIdLen);
  const loadouts: Loadout[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const gun = r.u8();
    const heavy = r.u8();
    const special = r.u8();
    if (!loadoutIndexOk(0, gun) || !loadoutIndexOk(1, heavy) || !loadoutIndexOk(2, special)) {
      throw new Error(`bad loadout ${gun}/${heavy}/${special}`);
    }
    loadouts.push({ gun, heavy, special });
  }
  const extraWeapons = r.u8();
  if (!extraOk(extraWeapons)) throw new Error(`bad extraWeapons ${extraWeapons}`);
  if (wardenPlayer >= MAX_PLAYERS) throw new Error(`bad wardenPlayer ${wardenPlayer}`);
  if (wardenPlayer >= 0 && (wardenDifficulty < 1 || wardenDifficulty > 10)) {
    throw new Error(`bad wardenDifficulty ${wardenDifficulty}`);
  }
  if (wardenPlayer < 0 && wardenDifficulty !== 0) {
    throw new Error("wardenDifficulty set without a wardenPlayer");
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (!isDifficulty(difficulties[p])) throw new Error(`bad difficulty ${difficulties[p]}`);
  }
  return {
    simVersion,
    seed,
    mapId,
    wardenPlayer,
    wardenDifficulty,
    difficulties,
    loadouts,
    extraWeapons,
  };
}

// --- The lobby body (MSG_LOBBY) ----------------------------------------------
// [u8 id][payload]: SETUP_CHOICE index u8, value u8 · NAME len u8, len bytes
// (single-byte characters) · SELECTION u8 · LOADOUT three u8 codes · READY u8.

/** Whether a code is entry 0..4 of `slot`, as the original's ids are. */
function loadoutCodeOk(slot: number, code: unknown): boolean {
  return Number.isInteger(code) && (code as number) >> 4 === slot && ((code as number) & 15) < 5;
}

function lobbyBytes(m: LobbyMessage): number {
  switch (m.id) {
    case LOBBY_SETUP_CHOICE:
      return 1 + 2;
    case LOBBY_NAME:
      return 1 + 1 + m.name.length;
    case LOBBY_P1_SELECTION:
    case LOBBY_P2_SELECTION:
    case LOBBY_P1_READY:
    case LOBBY_P2_READY:
    case LOBBY_EXTRA_WEAPONS:
      return 1 + 1;
    case LOBBY_P1_LOADOUT:
    case LOBBY_P2_LOADOUT:
      return 1 + 3;
  }
}

function writeLobby(w: Writer, m: LobbyMessage): void {
  w.u8(m.id);
  switch (m.id) {
    case LOBBY_SETUP_CHOICE:
      if (m.index !== 0 && m.index !== 1) throw new Error(`bad setup index ${m.index}`);
      w.u8(m.index);
      w.u8(m.value);
      return;
    case LOBBY_NAME:
      if (m.name.length > LOBBY_NAME_BYTES) throw new Error("name too long");
      w.latin1(m.name);
      return;
    case LOBBY_P1_SELECTION:
    case LOBBY_P2_SELECTION:
      if (!isDifficulty(m.selection)) throw new Error(`bad selection ${m.selection}`);
      w.u8(m.selection);
      return;
    case LOBBY_P1_LOADOUT:
    case LOBBY_P2_LOADOUT:
      for (let s = 0; s < 3; s++) {
        if (!loadoutCodeOk(s, m.codes[s])) throw new Error(`bad loadout code ${m.codes[s]}`);
        w.u8(m.codes[s]);
      }
      return;
    case LOBBY_P1_READY:
    case LOBBY_P2_READY:
      w.u8(m.ready ? 1 : 0);
      return;
    case LOBBY_EXTRA_WEAPONS:
      if (!extraOk(m.mask)) throw new Error(`bad extraWeapons ${m.mask}`);
      w.u8(m.mask);
      return;
  }
}

function readLobby(r: Reader): LobbyMessage {
  const id = r.u8();
  switch (id) {
    case LOBBY_SETUP_CHOICE: {
      const index = r.u8();
      const value = r.u8();
      if (index > 1) throw new Error(`bad setup index ${index}`);
      return { id, index, value };
    }
    case LOBBY_NAME: {
      const len = r.u8();
      if (len > LOBBY_NAME_BYTES) throw new Error("name too long");
      return { id, name: r.latin1(len) };
    }
    case LOBBY_P1_SELECTION:
    case LOBBY_P2_SELECTION: {
      const selection = r.u8();
      if (!isDifficulty(selection)) throw new Error(`bad selection ${selection}`);
      return { id, selection };
    }
    case LOBBY_P1_LOADOUT:
    case LOBBY_P2_LOADOUT: {
      const codes = [r.u8(), r.u8(), r.u8()];
      for (let s = 0; s < 3; s++) {
        if (!loadoutCodeOk(s, codes[s])) throw new Error(`bad loadout code ${codes[s]}`);
      }
      return { id, codes };
    }
    case LOBBY_P1_READY:
    case LOBBY_P2_READY: {
      const bit = r.u8();
      if (bit > 1) throw new Error(`bad ready bit ${bit}`);
      return { id, ready: bit === 1 };
    }
    case LOBBY_EXTRA_WEAPONS: {
      const mask = r.u8();
      if (!extraOk(mask)) throw new Error(`bad extraWeapons ${mask}`);
      return { id, mask };
    }
    default:
      throw new Error(`unknown lobby message 0x${id.toString(16)}`);
  }
}

function writeInput(w: Writer, input: PlayerInput): void {
  w.u16(input.buttons);
}

function readInput(r: Reader): PlayerInput {
  return { buttons: r.u16() };
}

// --- Public codec ------------------------------------------------------------

/** Reads just the type tag without decoding the body (0 for an empty buffer). */
export function messageType(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0] : 0;
}

/**
 * The protocol byte of a HELLO or REJOIN, read without decoding the body, or
 * null for any other frame. A peer on another protocol frames its config
 * differently, so its HELLO may not decode at all; this is what lets the relay
 * (and a P2P peer) refuse it as a version mismatch rather than as noise.
 */
export function peekProtocol(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;
  return bytes[0] === MSG_HELLO || bytes[0] === MSG_REJOIN ? bytes[1] : null;
}

export function encodeMessage(msg: NetMessage): Uint8Array {
  switch (msg.type) {
    case MSG_HELLO: {
      const w = new Writer(1 + 1 + configBytes(msg.config));
      w.u8(MSG_HELLO);
      w.u8(msg.protocol);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_REJOIN: {
      const w = new Writer(1 + 1 + 2 + 1 + 4);
      w.u8(MSG_REJOIN);
      w.u8(msg.protocol);
      w.u16(msg.simVersion);
      w.u8(msg.slot);
      w.u32(msg.fromTick);
      return w.bytes();
    }
    case MSG_INPUT: {
      const w = new Writer(1 + 4 + PLAYER_INPUT_BYTES);
      w.u8(MSG_INPUT);
      w.u32(msg.tick);
      writeInput(w, msg.input);
      return w.bytes();
    }
    case MSG_HASH: {
      const w = new Writer(1 + 4 + 4);
      w.u8(MSG_HASH);
      w.u32(msg.tick);
      w.u32(msg.hash);
      return w.bytes();
    }
    case MSG_BEGIN: {
      const w = new Writer(1 + configBytes(msg.config));
      w.u8(MSG_BEGIN);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_WELCOME: {
      const w = new Writer(1 + 1 + configBytes(msg.config));
      w.u8(MSG_WELCOME);
      w.u8(msg.slot);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_START: {
      const w = new Writer(1 + 4 + configBytes(msg.config));
      w.u8(MSG_START);
      w.u32(msg.startTick);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_FRAME: {
      if (msg.inputs.length !== MAX_PLAYERS) throw new Error("FRAME needs MAX_PLAYERS inputs");
      const w = new Writer(1 + 4 + MAX_PLAYERS * PLAYER_INPUT_BYTES);
      w.u8(MSG_FRAME);
      w.u32(msg.tick);
      for (let p = 0; p < MAX_PLAYERS; p++) writeInput(w, msg.inputs[p]);
      return w.bytes();
    }
    case MSG_PEER: {
      const w = new Writer(1 + 1 + 1);
      w.u8(MSG_PEER);
      w.u8(msg.slot);
      w.u8(msg.present ? 1 : 0);
      return w.bytes();
    }
    case MSG_DESYNC: {
      const w = new Writer(1 + 4);
      w.u8(MSG_DESYNC);
      w.u32(msg.tick);
      return w.bytes();
    }
    case MSG_ERROR: {
      const w = new Writer(1 + 1);
      w.u8(MSG_ERROR);
      w.u8(msg.code);
      return w.bytes();
    }
    case MSG_LOBBY: {
      const w = new Writer(1 + lobbyBytes(msg.lobby));
      w.u8(MSG_LOBBY);
      writeLobby(w, msg.lobby);
      return w.bytes();
    }
    default: {
      const _exhaustive: never = msg;
      throw new Error(`unknown message ${(_exhaustive as { type: number }).type}`);
    }
  }
}

export function decodeMessage(bytes: Uint8Array): NetMessage {
  const r = new Reader(bytes);
  const msg = decodeBody(r, r.u8());
  // Reject any bytes past the expected body — this is untrusted network data,
  // and a frame with trailing garbage is ambiguous, not "valid with extras".
  r.expectEnd();
  return msg;
}

function decodeBody(r: Reader, type: number): NetMessage {
  switch (type) {
    case MSG_HELLO:
      return { type: MSG_HELLO, protocol: r.u8(), config: readConfig(r) };
    case MSG_REJOIN:
      return {
        type: MSG_REJOIN,
        protocol: r.u8(),
        simVersion: r.u16(),
        slot: r.u8(),
        fromTick: r.u32(),
      };
    case MSG_INPUT:
      return { type: MSG_INPUT, tick: r.u32(), input: readInput(r) };
    case MSG_HASH:
      return { type: MSG_HASH, tick: r.u32(), hash: r.u32() };
    case MSG_BEGIN:
      return { type: MSG_BEGIN, config: readConfig(r) };
    case MSG_WELCOME:
      return { type: MSG_WELCOME, slot: r.u8(), config: readConfig(r) };
    case MSG_START:
      return { type: MSG_START, startTick: r.u32(), config: readConfig(r) };
    case MSG_FRAME: {
      const tick = r.u32();
      const inputs: PlayerInput[] = [];
      for (let p = 0; p < MAX_PLAYERS; p++) inputs.push(readInput(r));
      return { type: MSG_FRAME, tick, inputs };
    }
    case MSG_PEER:
      return { type: MSG_PEER, slot: r.u8(), present: r.u8() !== 0 };
    case MSG_DESYNC:
      return { type: MSG_DESYNC, tick: r.u32() };
    case MSG_ERROR:
      return { type: MSG_ERROR, code: r.u8() };
    case MSG_LOBBY:
      return { type: MSG_LOBBY, lobby: readLobby(r) };
    default:
      throw new Error(`unknown message tag ${type}`);
  }
}
