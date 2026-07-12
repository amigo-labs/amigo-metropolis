// Browser WebRTC glue for the P2P online path (hosting.spec.md §3.1). Kept
// deliberately thin, like wsTransport.ts: all lockstep logic lives in
// P2pLockstep, which talks only to the Transport interface, so nothing here is
// part of any test (it needs a real RTCPeerConnection).
//
// Privacy stance: with `relayOnly` (the production default) the connection is
// created with iceTransportPolicy "relay" — the browser gathers NO host/srflx
// candidates, so the real IP appears neither in the SDP we signal nor on the
// data path; the opponent only ever sees the TURN server. The non-relay
// fallback exists for local development without TURN credentials.

import type { Transport } from "./transport";

/** How signaling blobs travel (the lobby WebSocket implements this in H3). */
export interface SignalPort {
  send(data: unknown): void;
  onSignal(cb: (data: unknown) => void): void;
}

export interface P2pChannels {
  readonly control: Transport;
  readonly inputs: Transport;
  /** Tears down both channels and the peer connection. */
  close(): void;
}

/** RTCDataChannel as a Transport: binary frames, sends buffered until open. */
class RtcTransport implements Transport {
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private readonly outbox: Uint8Array[] = [];
  private open = false;

  constructor(private readonly dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dc.addEventListener("open", () => {
      this.open = true;
      for (const b of this.outbox) this.raw(b);
      this.outbox.length = 0;
    });
    dc.addEventListener("message", (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.msgCb?.(new Uint8Array(e.data));
    });
    dc.addEventListener("close", () => this.closeCb?.());
    dc.addEventListener("error", () => this.closeCb?.());
  }

  send(bytes: Uint8Array): void {
    if (this.open) this.raw(bytes);
    else this.outbox.push(bytes);
  }

  /** Same TS 5.7 ArrayBufferLike story as WsTransport.raw — never shared. */
  private raw(bytes: Uint8Array): void {
    try {
      this.dc.send(bytes as unknown as ArrayBufferView<ArrayBuffer>);
    } catch {
      // an unreliable channel racing teardown may throw; the close event follows
    }
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.dc.close();
  }
}

/**
 * Opens the P2P channel pair over a signaling port. The lobby host authors the
 * offer (it created both channels); the joiner answers. Resolves once BOTH
 * channels are open — the moment to tell the lobby "matchStarted". Rejects if
 * the peer connection fails; overall timeout is the lobby's signaling TTL.
 */
export function connectP2p(
  role: "host" | "joiner",
  signal: SignalPort,
  iceServers: RTCIceServer[],
  relayOnly: boolean,
): Promise<P2pChannels> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({
      iceTransportPolicy: relayOnly ? "relay" : "all",
      iceServers,
    });

    let control: RtcTransport | null = null;
    let inputs: RtcTransport | null = null;
    let openCount = 0;
    let settled = false;

    const channels: P2pChannels = {
      get control() {
        return control as Transport;
      },
      get inputs() {
        return inputs as Transport;
      },
      close() {
        pc.close();
      },
    };

    const onChannelOpen = () => {
      openCount++;
      if (openCount === 2 && !settled) {
        settled = true;
        resolve(channels);
      }
    };
    const adopt = (dc: RTCDataChannel): RtcTransport => {
      dc.addEventListener("open", onChannelOpen);
      return new RtcTransport(dc);
    };

    if (role === "host") {
      // Both channels ride the one offer; no renegotiation ever needed.
      control = adopt(pc.createDataChannel("control", { ordered: true }));
      inputs = adopt(pc.createDataChannel("inputs", { ordered: false, maxRetransmits: 0 }));
    } else {
      pc.addEventListener("datachannel", (e: RTCDataChannelEvent) => {
        if (e.channel.label === "control") control = adopt(e.channel);
        else if (e.channel.label === "inputs") inputs = adopt(e.channel);
        // A channel can arrive already-open; count it if so.
        if (e.channel.readyState === "open") onChannelOpen();
      });
    }

    pc.addEventListener("icecandidate", (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate) signal.send({ kind: "ice", candidate: e.candidate.toJSON() });
    });
    pc.addEventListener("connectionstatechange", () => {
      if ((pc.connectionState === "failed" || pc.connectionState === "closed") && !settled) {
        settled = true;
        reject(new Error(`peer connection ${pc.connectionState}`));
      }
    });

    signal.onSignal((data) => {
      void handleSignal(data).catch(() => {
        if (!settled) {
          settled = true;
          pc.close();
          reject(new Error("signaling failed"));
        }
      });
    });

    async function handleSignal(data: unknown): Promise<void> {
      const msg = data as {
        kind?: string;
        desc?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
      if (msg?.kind === "desc" && msg.desc) {
        await pc.setRemoteDescription(msg.desc);
        if (msg.desc.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          signal.send({ kind: "desc", desc: pc.localDescription?.toJSON() });
        }
      } else if (msg?.kind === "ice" && msg.candidate) {
        await pc.addIceCandidate(msg.candidate);
      }
    }

    if (role === "host") {
      void (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        signal.send({ kind: "desc", desc: pc.localDescription?.toJSON() });
      })().catch((err) => {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error("offer failed"));
        }
      });
    }
  });
}
