// A binary duplex channel abstraction. NetLockstep talks only to this, so the
// deterministic lockstep can be driven by a real WebSocket in the browser
// (wsTransport.ts) or by an in-memory hub in tests — the exact same code path.

export interface Transport {
  /** Send one framed message (already encoded via protocol.encodeMessage). */
  send(bytes: Uint8Array): void;
  /** Register the sole message handler (last registration wins). */
  onMessage(cb: (bytes: Uint8Array) => void): void;
  /** Register the close handler (fires once when the channel drops). */
  onClose(cb: () => void): void;
  /** Close the channel from our side. */
  close(): void;
}
