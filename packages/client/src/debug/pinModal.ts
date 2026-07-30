// Tiny DOM modal for the verification pin: "Was ist das Problem?"
// Debug-only UI — allocates freely, not on the frame loop.

export interface PinModalHandle {
  readonly isOpen: () => boolean;
  readonly open: (opts: { onSubmit: (notes: string) => void; onCancel: () => void }) => void;
  readonly close: () => void;
}

const CSS =
  "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;" +
  "justify-content:center;background:rgba(6,10,16,.55);font:14px/1.4 system-ui,sans-serif";

const CARD_CSS =
  "width:min(440px,92vw);padding:16px 18px;border-radius:8px;" +
  "background:#141a22;color:#e8eef6;border:1px solid #2a3544;" +
  "box-shadow:0 12px 40px rgba(0,0,0,.45)";

const TA_CSS =
  "width:100%;min-height:88px;margin:10px 0 12px;padding:8px 10px;" +
  "box-sizing:border-box;resize:vertical;border-radius:4px;" +
  "border:1px solid #3a4658;background:#0c1118;color:#e8eef6;" +
  "font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace";

const BTN_CSS =
  "padding:6px 14px;border-radius:4px;border:1px solid #3a4658;" +
  "background:#1c2530;color:#e8eef6;cursor:pointer;font:13px system-ui";

const PRIMARY_CSS = `${BTN_CSS};background:#2a6df4;border-color:#2a6df4`;

export function createPinModal(): PinModalHandle {
  let open = false;
  let root: HTMLDivElement | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const close = (): void => {
    if (onKey) {
      window.removeEventListener("keydown", onKey, true);
      onKey = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
    open = false;
  };

  return {
    isOpen: () => open,
    close,
    open: ({ onSubmit, onCancel }) => {
      if (open) close();
      open = true;
      root = document.createElement("div");
      root.style.cssText = CSS;
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Verification Pin");

      const card = document.createElement("div");
      card.style.cssText = CARD_CSS;

      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;font-size:15px;margin-bottom:4px";
      title.textContent = "Verification Pin";

      const label = document.createElement("div");
      label.style.cssText = "color:#9aabbd;font-size:13px";
      label.textContent = "Was ist das Problem?";

      const ta = document.createElement("textarea");
      ta.style.cssText = TA_CSS;
      ta.placeholder =
        "z.B. Turret sitzt 1 Zelle zu weit links · Mesh schwebt über dem Pad · Lane schneidet die Wand";
      ta.rows = 4;

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.style.cssText = BTN_CSS;
      cancelBtn.textContent = "Esc · Abbrechen";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.style.cssText = PRIMARY_CSS;
      saveBtn.textContent = "Enter · Speichern";

      const submit = (): void => {
        const notes = ta.value.trim();
        close();
        onSubmit(notes);
      };
      const cancel = (): void => {
        close();
        onCancel();
      };

      cancelBtn.onclick = cancel;
      saveBtn.onclick = submit;
      root.onclick = (e) => {
        if (e.target === root) cancel();
      };
      card.onclick = (e) => e.stopPropagation();

      onKey = (e: KeyboardEvent) => {
        if (!open) return;
        if (e.code === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
          return;
        }
        // Enter without Shift submits; Shift+Enter keeps newline in textarea.
        if (e.code === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }
      };
      window.addEventListener("keydown", onKey, true);

      row.append(cancelBtn, saveBtn);
      card.append(title, label, ta, row);
      root.append(card);
      document.body.append(root);
      // Focus after paint so pointer-lock release does not steal it.
      requestAnimationFrame(() => ta.focus());
    },
  };
}

/** Brief bottom-center toast (debug UI). */
export function showPinToast(message: string, ms = 2800): void {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1001;" +
    "padding:8px 14px;border-radius:6px;background:rgba(10,14,20,.88);" +
    "color:#cfd8e3;font:12px/1.4 system-ui,sans-serif;border:1px solid #2a3544;" +
    "pointer-events:none;max-width:90vw;text-align:center";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
