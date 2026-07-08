// Browser WebSocket implementation of Transport. Kept deliberately thin — all
// lockstep logic lives in NetLockstep, which talks only to the Transport
// interface, so this file has no game knowledge and is not part of any test
// (it needs a real socket). Binary frames only (binaryType = "arraybuffer").

import type { Transport } from "./transport";

export class WsTransport implements Transport {
  private readonly ws: WebSocket;
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  /** Sends issued before the socket opens (e.g. HELLO) wait here, then flush. */
  private readonly outbox: Uint8Array[] = [];
  private open = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.open = true;
      for (const b of this.outbox) this.raw(b);
      this.outbox.length = 0;
    });
    this.ws.addEventListener("message", (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.msgCb?.(new Uint8Array(e.data));
    });
    this.ws.addEventListener("close", () => this.closeCb?.());
    this.ws.addEventListener("error", () => this.closeCb?.());
  }

  send(bytes: Uint8Array): void {
    if (this.open) this.raw(bytes);
    else this.outbox.push(bytes);
  }

  /**
   * WebSocket.send wants ArrayBufferView<ArrayBuffer>, but a Uint8Array is typed
   * over ArrayBufferLike (could be shared) since TS 5.7. Our buffers are never
   * shared, so the cast is safe; runtime sends the bytes as-is.
   */
  private raw(bytes: Uint8Array): void {
    this.ws.send(bytes as unknown as ArrayBufferView<ArrayBuffer>);
  }
  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.ws.close();
  }
}
