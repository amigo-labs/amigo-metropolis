// Lobby-brokered P2P session setup (hosting.spec.md §5): drives the lobby
// WebSocket JSON protocol (create/join → SDP/ICE relay → matchStarted) and
// hands back the open channel pair + the authoritative MatchConfig + slot.
// Browser-only glue like rtc.ts — every decision worth testing lives on the
// server (LobbyLogic) or in P2pLockstep; this file just sequences them.
//
// The lobby socket closes itself once the match starts (the DO's job is done);
// from then on the match runs peer-to-peer and this module is out of the loop.

import type { MatchConfig } from "@metropolis/sim";
import { connectP2p, type P2pChannels } from "./rtc";

export interface P2pIceConfig {
  readonly iceServers: RTCIceServer[];
  /** Force relay-only candidates (privacy). Off only in TURN-less dev. */
  readonly relayOnly: boolean;
}

export interface P2pHostSetup {
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly passwordHash?: string;
}

export interface P2pSessionOptions {
  /** WebSocket URL of the lobby DO (wss://…/lobby/<CODE>). */
  readonly url: string;
  readonly role: "host" | "join";
  /** Host-authored match config; a joiner passes only simVersion for the gate. */
  readonly config: MatchConfig;
  readonly hostSetup?: P2pHostSetup;
  readonly joinPasswordHash?: string;
  /** Progress line for the connection overlay. */
  readonly onStatus?: (text: string) => void;
}

export interface P2pSession {
  readonly channels: P2pChannels;
  /** Authoritative config (the host's own, or the lobby-delivered copy). */
  readonly config: MatchConfig;
  /** Lockstep slot: host = 0, joiner = 1. */
  readonly slot: number;
}

const LOBBY_ERROR_TEXT: Record<string, string> = {
  protocol: "protocol error",
  closed: "lobby not found or already closed",
  full: "lobby is full",
  versionMismatch: "version mismatch — update the game",
  badPassword: "wrong password",
  noPeer: "peer left during signaling",
};

const CLOSE_TEXT: Record<string, string> = {
  ttl: "lobby timed out",
  hostLeft: "the host left",
  matched: "match started", // not an error — arrives after matchStarted
};

// --- Bootstrap handoff (menu → ?p2p=<CODE> reload) ----------------------------
// Choosing a lobby in the menu navigates the page (like every other mode), so
// the role/name/password-hash ride sessionStorage across that reload — never
// the URL, where a shared link would leak them.

export interface P2pBootstrap {
  readonly role: "host" | "join";
  readonly name?: string;
  readonly visibility?: "public" | "private";
  readonly passwordHash?: string;
}

const BOOT_KEY = (code: string): string => `metropolis.p2p.${code}`;

export function storeP2pBootstrap(code: string, boot: P2pBootstrap): void {
  sessionStorage.setItem(BOOT_KEY(code), JSON.stringify(boot));
}

/** Absent (e.g. a pasted ?p2p link) defaults to a passwordless join. */
export function readP2pBootstrap(code: string): P2pBootstrap {
  try {
    const raw = sessionStorage.getItem(BOOT_KEY(code));
    if (raw) return JSON.parse(raw) as P2pBootstrap;
  } catch {
    // fall through to the default
  }
  return { role: "join" };
}

/** SHA-256 hex of `${lobbyId}:${password}` — the only form a password leaves the client in. */
export async function hashLobbyPassword(lobbyId: string, password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${lobbyId}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Opens (or joins) the lobby, runs WebRTC signaling through it, and resolves
 * with the live channel pair once both DataChannels are open. Rejects with a
 * human-readable Error on any lobby/RTC failure; the lobby's own TTLs bound
 * how long this can dangle.
 */
export function openP2pSession(opts: P2pSessionOptions): Promise<P2pSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url);
    let config: MatchConfig | null = opts.role === "host" ? opts.config : null;
    let ice: P2pIceConfig = { iceServers: [], relayOnly: false };
    let signalCb: ((data: unknown) => void) | null = null;
    const signalInbox: unknown[] = [];
    let rtcStarted = false;
    let done = false;

    const fail = (message: string): void => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(new Error(message));
    };

    const send = (msg: unknown): void => ws.send(JSON.stringify(msg));

    // The RTC layer registers its signal handler asynchronously; never drop a
    // blob that arrived first (e.g. the host's offer racing the joiner's setup).
    const deliverSignal = (data: unknown): void => {
      if (signalCb) signalCb(data);
      else signalInbox.push(data);
    };

    const startRtc = (): void => {
      if (rtcStarted) return;
      rtcStarted = true;
      opts.onStatus?.("Connecting to opponent…");
      connectP2p(
        opts.role === "host" ? "host" : "joiner",
        {
          send: (data) => send({ t: "signal", data }),
          onSignal: (cb) => {
            signalCb = cb;
            for (const d of signalInbox) cb(d);
            signalInbox.length = 0;
          },
        },
        ice.iceServers,
        ice.relayOnly,
      )
        .then((channels) => {
          if (done) {
            channels.close();
            return;
          }
          done = true;
          // Tell the lobby the DO's job is done; it closes both sockets.
          send({ t: "matchStarted" });
          resolve({ channels, config: config as MatchConfig, slot: opts.role === "host" ? 0 : 1 });
        })
        .catch((err: unknown) => {
          fail(err instanceof Error ? err.message : "connection failed");
        });
    };

    ws.addEventListener("open", () => {
      if (opts.role === "host") {
        const setup = opts.hostSetup ?? { name: "Metropolis lobby", visibility: "private" };
        send({
          t: "create",
          name: setup.name,
          visibility: setup.visibility,
          config: opts.config,
          ...(setup.passwordHash ? { passwordHash: setup.passwordHash } : {}),
        });
      } else {
        send({
          t: "join",
          simVersion: opts.config.simVersion,
          ...(opts.joinPasswordHash ? { passwordHash: opts.joinPasswordHash } : {}),
        });
      }
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      if (done || typeof e.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.t) {
        case "created":
          opts.onStatus?.("Lobby open — waiting for an opponent…");
          if (isIce(msg.ice)) ice = msg.ice;
          break;
        case "peerJoined": // host side: the offer can go out now
          startRtc();
          break;
        case "joined": // joiner side: authoritative config received
          config = msg.config as MatchConfig;
          if (isIce(msg.ice)) ice = msg.ice;
          startRtc();
          break;
        case "signal":
          deliverSignal(msg.data);
          break;
        case "peerLeft":
          opts.onStatus?.("Opponent left — waiting for another…");
          break;
        case "closed": {
          const reason = String(msg.reason);
          if (reason !== "matched") fail(CLOSE_TEXT[reason] ?? "lobby closed");
          break;
        }
        case "error":
          fail(LOBBY_ERROR_TEXT[String(msg.code)] ?? "lobby error");
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      // Normal once the match started; fatal while still signaling.
      if (!done) fail("lobby connection lost");
    });
    ws.addEventListener("error", () => {
      if (!done) fail("lobby connection failed");
    });
  });
}

function isIce(v: unknown): v is P2pIceConfig {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { iceServers?: unknown }).iceServers) &&
    typeof (v as { relayOnly?: unknown }).relayOnly === "boolean"
  );
}
