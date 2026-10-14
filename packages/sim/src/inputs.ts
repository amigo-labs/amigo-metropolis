// Tick inputs (architecture.md §2, input.spec.md): per player, the original's
// button word. Future Cop samples fourteen binding slots into a 32-bit word and
// permutes it (RE docs/behavior/camera-and-movement.md "Input"); every game bit
// lies in the upper half, so the sim's u16 is that word shifted down sixteen.
// All movement is digital, as in the original: its stick path is dead.

import { MAX_PLAYERS } from "./balance";

/** Move Forward (slot 0). */
export const BTN_FORWARD = 0x4000;
/** Move Backward (slot 1). */
export const BTN_BACK = 0x8000;
/** Turn Right (slot 2): the facing grows, clockwise seen from above. */
export const BTN_TURN_RIGHT = 0x2000;
/** Turn Left (slot 3). */
export const BTN_TURN_LEFT = 0x1000;
/** Gun Weapon (slot 4): weapon slot 0, fires while held. */
export const BTN_GUN = 0x0400;
/**
 * Action Key (slot 5): held, the slow row; pressed, "use" — capture, claim,
 * buy, ride a lift; with Change Target, the transform chord.
 */
export const BTN_ACTION = 0x0200;
/** Special Weapon (slot 6): weapon slot 2. */
export const BTN_SPECIAL = 0x0100;
/** Jump (slot 7): the walker's jumps, the hover's brake. */
export const BTN_JUMP = 0x0800;
/** Jink Left (slot 10): strafe left. */
export const BTN_JINK_LEFT = 0x0010;
/** Jink Right (slot 11): strafe right. */
export const BTN_JINK_RIGHT = 0x0020;
/** Heavy Weapon (slot 12): weapon slot 1, fires while held. */
export const BTN_HEAVY = 0x0040;
/** Change Target (slot 13): the lock cycle; with Action, the transform chord. */
export const BTN_CHANGE_TARGET = 0x0080;
/** Map Key (slot 8): read by the client (pause), never sent to the sim. */
export const BTN_MAP = 0x0008;
/** Camera Key (slot 9): read by the client, never sent to the sim. */
export const BTN_CAMERA = 0x0004;
/** Escape (the fixed binding): read by the client, never sent to the sim. */
export const BTN_ESCAPE = 0x0001;

/** The bits the sim reads; the client's own keys (Map, Camera, Escape) are cut. */
export const SIM_BUTTONS =
  BTN_FORWARD |
  BTN_BACK |
  BTN_TURN_RIGHT |
  BTN_TURN_LEFT |
  BTN_GUN |
  BTN_ACTION |
  BTN_SPECIAL |
  BTN_JUMP |
  BTN_JINK_LEFT |
  BTN_JINK_RIGHT |
  BTN_HEAVY |
  BTN_CHANGE_TARGET;

/** The transform chord: Change Target and Action held together (no own key). */
export const TRANSFORM_CHORD = BTN_CHANGE_TARGET | BTN_ACTION;
/** What a running transform leaves of the word: the three fire buttons. */
export const TRANSFORM_KEEPS = BTN_GUN | BTN_HEAVY | BTN_SPECIAL;
/** The two jinks; held together they cancel. */
export const JINKS = BTN_JINK_LEFT | BTN_JINK_RIGHT;

/** One player's tick input: the button word, a u16. */
export interface PlayerInput {
  buttons: number;
}

export interface TickInputs {
  /** Always MAX_PLAYERS entries; unused players stay all-zero. */
  readonly players: PlayerInput[];
}

export function createTickInputs(): TickInputs {
  const players: PlayerInput[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) players.push({ buttons: 0 });
  return { players };
}

export function clearTickInputs(t: TickInputs): void {
  for (const p of t.players) p.buttons = 0;
}

export function copyTickInputs(dst: TickInputs, src: TickInputs): void {
  for (let i = 0; i < dst.players.length; i++) dst.players[i].buttons = src.players[i].buttons;
}
