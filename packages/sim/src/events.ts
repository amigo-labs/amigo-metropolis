// Per-tick event ring buffer (architecture.md §3): things that don't
// interpolate — shots, hits, explosions, deaths — flow to renderer/audio/UI
// through here. Events are TRANSIENT: cleared at the start of every tick,
// never part of the state hash (they are derived from state transitions).

export const EVENT_CAPACITY = 256;
export const EVENT_STRIDE = 4; // [type, a, b, c]

export const EV_SHOT = 1; //      a=shooter id, b=weapon slot (0/1/2)
export const EV_EXPLOSION = 2; // a=x*16, b=y*16 (quantized), c=weapon slot
export const EV_HIT = 3; //       a=target id, b=attacker player, c=damage
export const EV_DEATH = 4; //     a=victim id, b=killer player (-1 none), c=archetype
export const EV_RESPAWN = 5; //   a=entity id, b=player
export const EV_PURCHASE = 6; //  a=entity id, b=player, c=archetype
export const EV_BREACH = 7; //    a=unit id, b=winning team

export interface EventBuffer {
  count: number;
  readonly data: Int32Array;
}

export function createEventBuffer(): EventBuffer {
  return { count: 0, data: new Int32Array(EVENT_CAPACITY * EVENT_STRIDE) };
}

export function clearEvents(buf: EventBuffer): void {
  buf.count = 0;
}

/** Appends an event; silently drops when full (renderer-only data). */
export function pushEvent(buf: EventBuffer, type: number, a: number, b: number, c: number): void {
  if (buf.count === EVENT_CAPACITY) return;
  const o = buf.count * EVENT_STRIDE;
  buf.data[o] = type;
  buf.data[o + 1] = a;
  buf.data[o + 2] = b;
  buf.data[o + 3] = c;
  buf.count += 1;
}
