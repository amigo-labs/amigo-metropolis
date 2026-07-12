// Codec for the ONE packet that rides the unreliable P2P DataChannel: a
// redundant input bundle (hosting.spec.md §3.1). The reliable control channel
// reuses the binary NetMessage codec from @metropolis/sim (HELLO/HASH/DESYNC);
// this file only covers the 30 Hz hot-path packet, which exists nowhere else.
//
// Layout (little-endian):
//   [u8 tag=P2P_INPUT_TAG][u32 latestTick][u8 count][count × 5 B PlayerInput]
// inputs[i] is the local input for tick (latestTick - count + 1 + i), i.e.
// oldest first. Every packet re-carries the previous k−1 ticks, so any single
// lost/reordered packet is covered by its successors — effectively guaranteed
// delivery without reliable-mode head-of-line blocking.

import { PLAYER_INPUT_BYTES, type PlayerInput } from "@metropolis/sim";

/** Distinct from every NetMessage tag so a misrouted packet can't be confused. */
export const P2P_INPUT_TAG = 0x21;

export interface P2pInputPacket {
  /** The newest tick covered by this packet. */
  readonly latestTick: number;
  /** Inputs for ticks (latestTick − length + 1) … latestTick, oldest first. */
  readonly inputs: PlayerInput[];
}

export function encodeP2pInput(latestTick: number, inputs: PlayerInput[]): Uint8Array {
  if (inputs.length < 1 || inputs.length > 255) throw new Error("bad redundancy count");
  const bytes = new Uint8Array(1 + 4 + 1 + inputs.length * PLAYER_INPUT_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = P2P_INPUT_TAG;
  view.setUint32(1, latestTick >>> 0, true);
  bytes[5] = inputs.length;
  let o = 6;
  for (const input of inputs) {
    view.setInt8(o, input.moveX);
    view.setInt8(o + 1, input.moveY);
    view.setInt8(o + 2, input.aimX);
    view.setInt8(o + 3, input.aimY);
    view.setUint8(o + 4, input.buttons);
    o += PLAYER_INPUT_BYTES;
  }
  return bytes;
}

/**
 * Null on any malformation — the channel is unreliable and unauthenticated
 * (the peer), so a bad packet is dropped, never thrown on.
 */
export function decodeP2pInput(bytes: Uint8Array): P2pInputPacket | null {
  if (bytes.length < 6 || bytes[0] !== P2P_INPUT_TAG) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latestTick = view.getUint32(1, true);
  const count = bytes[5];
  if (count < 1 || bytes.length !== 6 + count * PLAYER_INPUT_BYTES) return null;
  const inputs: PlayerInput[] = [];
  let o = 6;
  for (let i = 0; i < count; i++) {
    inputs.push({
      moveX: view.getInt8(o),
      moveY: view.getInt8(o + 1),
      aimX: view.getInt8(o + 2),
      aimY: view.getInt8(o + 3),
      buttons: view.getUint8(o + 4),
    });
    o += PLAYER_INPUT_BYTES;
  }
  return { latestTick, inputs };
}
