// The networked lobby, two clients over a loopback (PLAN.md Phase 14 wave 7,
// fcop-fidelity.md F9): both sides pick, each sees the other's picks, START
// sets this side's ready bit and the peer sees it (WAITING), and the match
// starts when both are ready -- on one agreed config, bit-identical on both.
// Once through the real relay (RoomLogic + NetLockstep), once peer to peer
// (P2pLockstep over in-memory channels).

import { describe, expect, it } from "bun:test";
import { type Outgoing, RoomLogic } from "@metropolis/server/room";
import {
  createSim,
  createTickInputs,
  DEFAULT_DIFFICULTIES,
  DEFAULT_LOADOUTS,
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  decodeMessage,
  encodeMessage,
  GUNS,
  getMapById,
  HEAVIES,
  hash,
  LOBBY_EXTRA_WEAPONS,
  LOBBY_NAME,
  LOBBY_P1_LOADOUT,
  LOBBY_P1_SELECTION,
  LOBBY_P2_LOADOUT,
  LOBBY_P2_READY,
  LOBBY_P2_SELECTION,
  LOBBY_SETUP_CHOICE,
  type LobbyMessage,
  type MatchConfig,
  MSG_LOBBY,
  type PlayerInput,
  SIM_VERSION,
  SPECIALS,
  step,
} from "@metropolis/sim";
import { FE_PA_MAPS } from "../src/menu/frontend/frontendData.generated";
import { entryWeapon, loadoutOfEntries } from "../src/menu/frontend/model";
import {
  DEFAULT_NAMES,
  entriesOfCodes,
  type LobbyLink,
  loadoutCodes,
  lobbyName,
  NetLobby,
  type NetLobbyOptions,
} from "../src/menu/frontend/netLobby";
import { NetLockstep } from "../src/net/lockstep";
import { P2pLockstep } from "../src/net/p2pLockstep";
import type { Transport } from "../src/net/transport";

const SEED = 0x5eed;
const HELLO_CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: SEED,
  mapId: FE_PA_MAPS[1].mapId,
  wardenPlayer: -1,
  wardenDifficulty: 0,
  difficulties: DEFAULT_DIFFICULTIES,
  loadouts: DEFAULT_LOADOUTS,
  extraWeapons: 0,
};

/** A local config's two columns: the host edits 0, the joiner 1. */
function opts(name: string, own: number, loadout: number[], difficulty: number): NetLobbyOptions {
  const picks = [
    { loadout: [0, 0, 0], difficulty: DIFFICULTY_NORMAL },
    { loadout: [0, 0, 0], difficulty: DIFFICULTY_NORMAL },
  ];
  picks[own] = { loadout, difficulty };
  return { name, picks, mapRow: own === 0 ? 4 : 2, extraWeapons: 0 };
}

/** Both locksteps carry the lobby the same way. */
function linkOf(net: {
  sendLobby(m: LobbyMessage): void;
  begin(c: MatchConfig): void;
  close(): void;
}): LobbyLink {
  return {
    send: (m) => net.sendLobby(m),
    begin: (c) => net.begin(c),
    close: () => net.close(),
  };
}

// --- the relay loopback --------------------------------------------------------

class HubTransport implements Transport {
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  constructor(
    private readonly hub: Hub,
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

class Hub {
  readonly room = new RoomLogic();
  /** Every lobby message the relay forwarded, by receiving conn. */
  readonly lobbyTo: Record<string, LobbyMessage[]> = {};
  private readonly transports = new Map<string, HubTransport>();
  client(connId: string): HubTransport {
    const t = new HubTransport(this, connId);
    this.transports.set(connId, t);
    this.lobbyTo[connId] = [];
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
      const to =
        o.connId === null ? [...this.transports.values()] : [this.transports.get(o.connId)];
      for (const t of to) {
        if (!t) continue;
        if (o.msg.type === MSG_LOBBY) this.lobbyTo[t.connId].push(o.msg.lobby);
        t.deliver(bytes);
      }
    }
  }
}

interface Side {
  lobby: NetLobby;
  net: NetLockstep;
  hashes: number[];
}

/** One client: its lobby wired to NetLockstep as main.ts wires it. */
function relaySide(hub: Hub, connId: string, o: NetLobbyOptions, slotOf: number): Side {
  const lobby = new NetLobby(o);
  const hashes: number[] = [];
  let mySlot = -1;
  const net: NetLockstep = new NetLockstep(hub.client(connId), {
    sampleInput: script(slotOf),
    onWelcome: (slot) => {
      mySlot = slot;
      lobby.attach(linkOf(net), slot, SEED);
    },
    onPeer: (slot, present) => {
      if (slot === mySlot) return;
      if (present) lobby.linked();
      else lobby.peerGone();
    },
    onLobby: (m) => lobby.receive(m),
    onStart: (_sim, config) => lobby.started(config),
    onStep: (t, sim) => {
      hashes[t] = hash(sim);
    },
  });
  net.start(HELLO_CONFIG);
  return { lobby, net, hashes };
}

/** A scripted fight, so equal hashes mean something. */
function script(slot: number): (tick: number) => PlayerInput {
  return (tick) => ({ buttons: slot === 0 ? 0x0001 | (tick % 20 < 5 ? 0x0010 : 0) : 0x0004 });
}

function referenceHashes(config: MatchConfig, ticks: number): number[] {
  const sim = createSim(getMapById(config.mapId), config.seed, {
    difficulties: config.difficulties,
    loadouts: config.loadouts,
  });
  const inputs = createTickInputs();
  const a = script(0);
  const b = script(1);
  const out: number[] = [];
  for (let t = 0; t < ticks; t++) {
    inputs.players[0].buttons = a(t).buttons;
    inputs.players[1].buttons = b(t).buttons;
    step(sim, inputs);
    out[t] = hash(sim);
  }
  return out;
}

function drive(a: { tryStep(): boolean; simTick: number }, b: typeof a, target: number): void {
  let guard = 0;
  while ((a.simTick < target || b.simTick < target) && guard++ < 200_000) {
    let n = 0;
    if (a.simTick < target && a.tryStep()) n++;
    if (b.simTick < target && b.tryStep()) n++;
    if (n === 0) break;
  }
}

describe("the networked lobby through the relay", () => {
  it("exchanges the original's messages in the original's order on the link", () => {
    const hub = new Hub();
    relaySide(hub, "h", opts("Ryan", 0, [1, 2, 0], DIFFICULTY_HARD), 0);
    relaySide(hub, "j", opts("Jurgen", 1, [3, 0, 1], DIFFICULTY_EASY), 1);
    // The host's half, as the hello's arm sends it (the rule is Metropolis').
    expect(hub.lobbyTo.j).toEqual([
      { id: LOBBY_SETUP_CHOICE, index: 0, value: 4 },
      { id: LOBBY_NAME, name: "Ryan" },
      { id: LOBBY_P1_SELECTION, selection: DIFFICULTY_HARD },
      { id: LOBBY_P1_LOADOUT, codes: [0x02, 0x13, 0x20] },
      { id: LOBBY_EXTRA_WEAPONS, mask: 0 },
    ]);
    // The joiner's, as the ack's arm sends it.
    expect(hub.lobbyTo.h).toEqual([
      { id: LOBBY_NAME, name: "Jurgen" },
      { id: LOBBY_P2_SELECTION, selection: DIFFICULTY_EASY },
      { id: LOBBY_P2_LOADOUT, codes: [0x03, 0x10, 0x22] },
    ]);
  });

  it("shows each side the other's picks and name, live", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", opts("Ryan", 0, [1, 2, 0], DIFFICULTY_HARD), 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [3, 0, 1], DIFFICULTY_EASY), 1);
    expect(h.lobby.peerName).toBe("Jurgen");
    expect(j.lobby.peerName).toBe("Ryan");
    expect(j.lobby.picks[0]).toEqual({ loadout: [1, 2, 0], difficulty: DIFFICULTY_HARD });
    expect(h.lobby.picks[1]).toEqual({ loadout: [3, 0, 1], difficulty: DIFFICULTY_EASY });
    // The joiner shows the host's map, as setup choice 0 sets its pick.
    expect(j.lobby.mapRow).toBe(4);
    // A change goes out when it is made.
    j.lobby.setLoadout([2, 1, 3]);
    h.lobby.setDifficulty(DIFFICULTY_NORMAL);
    h.lobby.setMapRow(0);
    expect(h.lobby.picks[1].loadout).toEqual([2, 1, 3]);
    expect(j.lobby.picks[0].difficulty).toBe(DIFFICULTY_NORMAL);
    expect(j.lobby.mapRow).toBe(0);
  });

  it("START sets this side's ready bit, the peer sees it, a click takes it back", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", opts("Ryan", 0, [0, 0, 0], DIFFICULTY_NORMAL), 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [0, 0, 0], DIFFICULTY_NORMAL), 1);
    j.lobby.setReady(true);
    expect(h.lobby.ready).toEqual([false, true]); // WAITING over the joiner's column
    expect(hub.lobbyTo.h.at(-1)).toEqual({ id: LOBBY_P2_READY, ready: true });
    j.lobby.setReady(false);
    expect(h.lobby.ready).toEqual([false, false]);
    expect(h.net.isStarted || j.net.isStarted).toBe(false);
  });

  it("starts both on one agreed config once both are ready, and they stay bit-identical", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", opts("Ryan", 0, [1, 2, 3], DIFFICULTY_HARD), 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [3, 1, 1], DIFFICULTY_EASY), 1);
    h.lobby.setReady(true);
    expect(j.lobby.ready).toEqual([true, false]);
    expect(h.net.isStarted).toBe(false);
    j.lobby.setReady(true); // the second ready bit: the host begins
    expect(h.net.isStarted && j.net.isStarted).toBe(true);
    const agreed = h.lobby.config as MatchConfig;
    expect(j.lobby.config).toEqual(agreed);
    expect(agreed).toEqual({
      simVersion: SIM_VERSION,
      seed: SEED,
      mapId: FE_PA_MAPS[4].mapId,
      wardenPlayer: -1,
      wardenDifficulty: 0,
      difficulties: [DIFFICULTY_HARD, DIFFICULTY_EASY],
      loadouts: [loadoutOfEntries([1, 2, 3]), loadoutOfEntries([3, 1, 1])],
      extraWeapons: 0,
    });
    drive(h.net, j.net, 90);
    const ref = referenceHashes(agreed, 90);
    expect(h.hashes.slice(0, 90)).toEqual(ref);
    expect(j.hashes.slice(0, 90)).toEqual(ref);
  });

  it("a joiner's take-back that crosses the host's start changes nothing: START is the match", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", opts("Ryan", 0, [0, 0, 0], DIFFICULTY_NORMAL), 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [1, 0, 0], DIFFICULTY_NORMAL), 1);
    j.lobby.setReady(true);
    h.lobby.setReady(true); // the host begins at once
    j.lobby.setReady(false); // too late: the lobby is over
    j.lobby.setLoadout([2, 2, 2]);
    expect(j.lobby.config).toEqual(h.lobby.config);
    expect(j.lobby.config?.loadouts[1]).toEqual(loadoutOfEntries([1, 0, 0]));
  });

  it("carries the host's extra-weapon switches; the joiner cannot change them", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", { ...opts("Ryan", 0, [0, 0, 0], 1), extraWeapons: 0b11 }, 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [0, 0, 0], 1), 1);
    expect(j.lobby.extraWeapons).toBe(0b11);
    j.lobby.setExtraWeapons(0);
    expect(h.lobby.extraWeapons).toBe(0b11);
    h.lobby.setExtraWeapons(0b10);
    expect(j.lobby.extraWeapons).toBe(0b10);
    h.lobby.setReady(true);
    j.lobby.setReady(true);
    expect(j.lobby.config?.extraWeapons).toBe(0b10);
  });

  it("the peer's CANCEL reads as gone on both sides", () => {
    const hub = new Hub();
    const h = relaySide(hub, "h", opts("Ryan", 0, [0, 0, 0], 1), 0);
    const j = relaySide(hub, "j", opts("Jurgen", 1, [0, 0, 0], 1), 1);
    j.lobby.close();
    expect(h.lobby.phase).toBe("gone");
    expect(j.lobby.phase).toBe("gone");
  });
});

// --- the P2P loopback --------------------------------------------------------------

class Mem implements Transport {
  peer: Mem | null = null;
  private cb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private readonly inbox: Uint8Array[] = [];
  send(bytes: Uint8Array): void {
    this.peer?.deliver(bytes);
  }
  deliver(bytes: Uint8Array): void {
    if (this.cb) this.cb(bytes);
    else this.inbox.push(bytes);
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.cb = cb;
    for (const b of this.inbox) cb(b);
    this.inbox.length = 0;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closeCb?.();
    this.peer?.closeCb?.();
  }
}

function pair(): [Mem, Mem] {
  const a = new Mem();
  const b = new Mem();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function p2pSide(
  slot: number,
  control: Mem,
  inputs: Mem,
  o: NetLobbyOptions,
): { lobby: NetLobby; net: P2pLockstep; hashes: number[] } {
  const lobby = new NetLobby(o);
  const hashes: number[] = [];
  // The session resolved with the slot: seat the lobby before the channels
  // carry anything (the link reaches the lockstep once it exists).
  let net: P2pLockstep | null = null;
  lobby.attach(
    {
      send: (m) => net?.sendLobby(m),
      begin: (c) => net?.begin(c),
      close: () => net?.close(),
    },
    slot,
    SEED,
  );
  const lockstep = new P2pLockstep(slot, HELLO_CONFIG, control, inputs, {
    sampleInput: script(slot),
    onLinked: () => lobby.linked(),
    onLobby: (m) => lobby.receive(m),
    onStart: (_sim, config) => lobby.started(config),
    onClose: () => lobby.peerGone(),
    onStep: (t, sim) => {
      hashes[t] = hash(sim);
    },
  });
  net = lockstep;
  lockstep.start();
  return { lobby, net: lockstep, hashes };
}

describe("the networked lobby peer to peer", () => {
  it("links, exchanges, readies and starts both on the host's START", () => {
    const [ca, cb] = pair();
    const [ia, ib] = pair();
    // Attach before either HELLO lands: the joiner is built first, then the host.
    const j = p2pSide(1, cb, ib, opts("Jurgen", 1, [3, 1, 1], DIFFICULTY_EASY));
    const h = p2pSide(0, ca, ia, opts("Ryan", 0, [1, 2, 3], DIFFICULTY_HARD));
    expect(h.lobby.phase).toBe("linked");
    expect(j.lobby.phase).toBe("linked");
    expect(j.lobby.peerName).toBe("Ryan");
    expect(h.lobby.picks[1]).toEqual({ loadout: [3, 1, 1], difficulty: DIFFICULTY_EASY });
    j.lobby.setReady(true);
    expect(h.lobby.ready).toEqual([false, true]);
    h.lobby.setReady(true);
    expect(h.net.isStarted && j.net.isStarted).toBe(true);
    expect(j.lobby.config).toEqual(h.lobby.config);
    const agreed = h.lobby.config as MatchConfig;
    drive(h.net, j.net, 60);
    const ref = referenceHashes(agreed, 60);
    expect(h.hashes.slice(0, 60)).toEqual(ref);
    expect(j.hashes.slice(0, 60)).toEqual(ref);
  });

  it("a deep link readies as soon as it is linked", () => {
    const [ca, cb] = pair();
    const [ia, ib] = pair();
    const j = p2pSide(1, cb, ib, { ...opts("", 1, [0, 0, 0], 1), autoReady: true });
    const h = p2pSide(0, ca, ia, { ...opts("", 0, [0, 0, 0], 1), autoReady: true });
    expect(h.net.isStarted && j.net.isStarted).toBe(true);
  });
});

describe("the lobby's wire values", () => {
  it("a name is 15 single-byte characters; the defaults are Player1 / Player2", () => {
    expect(lobbyName("A very long player name")).toBe("A very long pla");
    expect(lobbyName("Jürgen 世界")).toBe("Jürgen ??");
    expect(DEFAULT_NAMES).toEqual(["Player1", "Player2"]);
  });

  it("a loadout's ids are the original's codes, not slot << 4 | entry (F7)", () => {
    expect(loadoutCodes([0, 0, 0])).toEqual([0x00, 0x10, 0x20]);
    // frontend_commit_loadout's table (0x0040c2d0): entries 1 and 2 swap in
    // the gun and special menus, the heavy menu skips 0x11.
    const table = [0, 1, 2, 3, 4].map((e) => loadoutCodes([e, e, e]));
    expect(table).toEqual([
      [0x00, 0x10, 0x20],
      [0x02, 0x12, 0x22],
      [0x01, 0x13, 0x21],
      [0x03, 0x14, 0x23],
      [0x05, 0x15, 0x24],
    ]);
    for (let e = 0; e < 5; e++) expect(entriesOfCodes(loadoutCodes([e, e, e]))).toEqual([e, e, e]);
    expect(entriesOfCodes([0x03, 0x13, 0x24])).toEqual([3, 2, 4]);
    // Each code names the weapon the entry's picture does in the sim's
    // catalogue, whose `code` is the type-99 key: the menu's by-name map and
    // the wire's code agree on all fifteen.
    const lists = [GUNS, HEAVIES, SPECIALS];
    for (let slot = 0; slot < 3; slot++) {
      for (let e = 0; e < 5; e++) {
        const code = loadoutCodes([e, e, e])[slot];
        expect(lists[slot].find((w) => w.code === code)?.name).toBe(entryWeapon(slot, e));
      }
    }
  });
});
