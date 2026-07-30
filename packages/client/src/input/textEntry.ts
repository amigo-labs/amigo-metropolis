// Shared "is the user typing?" guard.
//
// Three key handlers need it and must agree: gameplay keys (input/keyboard.ts),
// the fly cam's movement keys (render/flyCamera.ts) and the verification-pin
// hotkey (main.ts). Space used to be swallowed for jump while the pin textarea
// had focus; three copies of this check is how that bug came back once already.

/** True when the event target is a text field (pin modal, menu inputs, …). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
