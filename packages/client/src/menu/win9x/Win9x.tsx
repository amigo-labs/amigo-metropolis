// Windows 95/98 dialog chrome in HTML/CSS: the original's dialogs are native
// Win32 templates (dialogs.json), drawn by the system in its grey 3D look.
// These are the controls the templates use, placed at their template
// rectangles (dlu.ts). Hook-free on purpose: the stateful dialogs own the
// state, and `bun test` can render these to a string.

import type { ComponentChildren, JSX } from "preact";
import type { FeControl, FeDialog } from "../frontend/types";
import {
  type BaseUnits,
  baseUnitsOf,
  centreOnScreen,
  dialogWindowSize,
  mapDialogRect,
  type PxRect,
} from "./dlu";
import "./win9x.css";

const WS_EX_CLIENTEDGE = 0x200;

function pos(r: PxRect): string {
  return `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
}

/** A template's controls by id, in pixels of its dialog font. */
export interface DialogLayout {
  readonly dialog: FeDialog;
  readonly bu: BaseUnits;
  ctl(id: number): FeControl;
  rect(id: number): PxRect;
  text(id: number): string;
  /** A rectangle given in the dialog's own units (Metropolis additions). */
  at(dlu: readonly number[]): PxRect;
}

export function dialogLayout(dialog: FeDialog): DialogLayout {
  const bu = baseUnitsOf(dialog.font);
  const byId = new Map<number, FeControl>();
  for (const c of dialog.controls) if (!byId.has(c.id)) byId.set(c.id, c);
  const ctl = (id: number): FeControl => {
    const c = byId.get(id);
    if (!c) throw new Error(`dialog ${dialog.id} has no control ${id}`);
    return c;
  };
  return {
    dialog,
    bu,
    ctl,
    rect: (id) => mapDialogRect(ctl(id).dlu, bu),
    text: (id) => ctl(id).text ?? "",
    at: (dlu) => mapDialogRect(dlu, bu),
  };
}

const stop = (e: Event): void => e.stopPropagation();

/**
 * A modal dialog window, centred on the 640 x 480 screen (DS_CENTER), with the
 * DS_MODALFRAME frame, the caption bar when the template has WS_CAPTION (and
 * its close box with WS_SYSMENU), and the sunken client edge for
 * WS_EX_CLIENTEDGE. The transparent layer under it takes every click: the
 * window behind a modal dialog gets none.
 */
export function W9Window(props: {
  layout: DialogLayout;
  caption?: string | null;
  onClose?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Extra client height in pixels, for a Metropolis addition below the template. */
  extraHeight?: number;
  label?: string;
  children?: ComponentChildren;
}) {
  const { layout } = props;
  const d = layout.dialog;
  const hasCaption = d.styles.includes("WS_CAPTION");
  const closeBox = d.styles.includes("WS_SYSMENU");
  const edge = (d.exStyle & WS_EX_CLIENTEDGE) !== 0;
  const size = dialogWindowSize(d.dlu, layout.bu, hasCaption, edge);
  const extra = props.extraHeight ?? 0;
  const at = centreOnScreen(size.width, size.height + extra);
  const caption = props.caption ?? d.caption ?? "";
  return (
    <div class="w9-modal" onPointerDown={stop} onPointerUp={stop} onPointerMove={stop}>
      <div
        class="w9 w9-window"
        role="dialog"
        aria-modal="true"
        aria-label={props.label ?? caption ?? d.what}
        data-dialog={d.id}
        style={`left:${at.left}px;top:${at.top}px;width:${size.width}px;height:${size.height + extra}px;font:${layout.bu.css}`}
        onKeyDown={props.onKeyDown as JSX.KeyboardEventHandler<HTMLDivElement> | undefined}
      >
        {hasCaption ? (
          <div class="w9-caption">
            <span class="w9-caption-text">{caption}</span>
            {closeBox ? (
              <button
                type="button"
                class="w9-close"
                aria-label="Close"
                tabIndex={-1}
                onClick={props.onClose}
              />
            ) : null}
          </div>
        ) : null}
        <div class={edge ? "w9-client w9-client--edge" : "w9-client"}>
          <div
            class="w9-client-in"
            style={`width:${size.client.width}px;height:${size.client.height + extra}px`}
          >
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function W9Button(props: {
  rect: PxRect;
  text: string;
  isDefault?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onClick?: () => void;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={props.id}
      class={props.isDefault ? "w9-btn is-default" : "w9-btn"}
      style={pos(props.rect)}
      disabled={props.disabled}
      // biome-ignore lint/a11y/noAutofocus: a Win32 dialog focuses its first control
      autoFocus={props.autoFocus}
      onClick={props.onClick}
    >
      <span class="w9-btn-text">{props.text}</span>
    </button>
  );
}

export function W9Check(props: {
  rect: PxRect;
  text: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label class={props.disabled ? "w9-check is-disabled" : "w9-check"} style={pos(props.rect)}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange?.((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="w9-check-box" aria-hidden="true" />
      <span class="w9-check-text">{props.text}</span>
    </label>
  );
}

export function W9Group(props: { rect: PxRect; text: string; disabled?: boolean }) {
  return (
    <fieldset class={props.disabled ? "w9-group is-disabled" : "w9-group"} style={pos(props.rect)}>
      {props.text ? <legend>{props.text}</legend> : null}
    </fieldset>
  );
}

export function W9Static(props: {
  rect: PxRect;
  text: string;
  align?: "left" | "center";
  /** SS_CENTERIMAGE: the text centred vertically. */
  middle?: boolean;
  /** WS_BORDER: a thin black line. */
  border?: boolean;
  /** The controls screen's selected field: drawn inverted. */
  inverted?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  id?: string;
}) {
  const cls = ["w9-static"];
  if (props.align === "center") cls.push("is-center");
  if (props.middle) cls.push("is-middle");
  if (props.border) cls.push("is-border");
  if (props.inverted) cls.push("is-inverted");
  if (props.disabled) cls.push("is-disabled");
  if (props.onClick) cls.push("is-notify");
  return (
    <div
      class={cls.join(" ")}
      id={props.id}
      style={pos(props.rect)}
      onPointerDown={props.onClick ? () => props.onClick?.() : undefined}
    >
      <span>{props.text}</span>
    </div>
  );
}

export function W9Edit(props: {
  rect: PxRect;
  value: string;
  readOnly?: boolean;
  disabled?: boolean;
  password?: boolean;
  maxLength?: number;
  label: string;
  onInput?: (v: string) => void;
  onEnter?: () => void;
}) {
  return (
    <input
      class="w9-edit"
      style={pos(props.rect)}
      type={props.password ? "password" : "text"}
      value={props.value}
      readOnly={props.readOnly}
      disabled={props.disabled}
      maxLength={props.maxLength}
      aria-label={props.label}
      spellcheck={false}
      autocomplete="off"
      onInput={(e) => props.onInput?.((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onEnter?.();
      }}
    />
  );
}

/**
 * A combo box. The template's height is the dropped list's; the closed box is
 * one line (the edit's height for the font). CBS_DROPDOWNLIST shows the pick;
 * CBS_DROPDOWN is editable.
 */
export function W9Combo(props: {
  rect: PxRect;
  items: readonly string[];
  selected: number;
  open: boolean;
  disabled?: boolean;
  editable?: boolean;
  text?: string;
  label: string;
  lineHeight: number;
  onToggle?: () => void;
  onPick?: (i: number) => void;
  onText?: (v: string) => void;
}) {
  const r = props.rect;
  const boxH = props.lineHeight + 8;
  const shown = props.editable ? (props.text ?? "") : (props.items[props.selected] ?? "");
  const listH = Math.max(boxH, r.height - boxH);
  return (
    <div
      class={props.disabled ? "w9-combo is-disabled" : "w9-combo"}
      style={`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${boxH}px`}
    >
      {props.editable ? (
        <input
          class="w9-combo-edit"
          value={shown}
          disabled={props.disabled}
          aria-label={props.label}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => props.onText?.((e.currentTarget as HTMLInputElement).value)}
        />
      ) : (
        <button
          type="button"
          class="w9-combo-shown"
          disabled={props.disabled}
          aria-label={props.label}
          aria-expanded={props.open}
          onClick={props.onToggle}
        >
          {shown}
        </button>
      )}
      <button
        type="button"
        class="w9-combo-drop"
        tabIndex={-1}
        aria-label={`Open ${props.label}`}
        disabled={props.disabled}
        onClick={props.onToggle}
      />
      {props.open && !props.disabled ? (
        <div class="w9-combo-list" role="listbox" style={`top:${boxH}px;max-height:${listH}px`}>
          {props.items.map((item, i) => (
            <div
              key={i}
              role="option"
              tabIndex={-1}
              aria-selected={i === props.selected}
              class={i === props.selected ? "w9-item is-selected" : "w9-item"}
              onPointerDown={(e) => {
                e.preventDefault();
                props.onPick?.(i);
              }}
            >
              {item || " "}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function W9List(props: {
  rect: PxRect;
  items: readonly string[];
  selected: number;
  disabled?: boolean;
  label: string;
  onPick?: (i: number) => void;
}) {
  return (
    <div
      class={props.disabled ? "w9-list is-disabled" : "w9-list"}
      style={pos(props.rect)}
      role="listbox"
      aria-label={props.label}
    >
      {props.items.map((item, i) => (
        <div
          key={i}
          role="option"
          tabIndex={-1}
          aria-selected={i === props.selected}
          class={i === props.selected && !props.disabled ? "w9-item is-selected" : "w9-item"}
          onPointerDown={props.disabled ? undefined : () => props.onPick?.(i)}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

/** msctls_trackbar32, horizontal, the thumb pointing down (the default TBS_BOTTOM). */
export function W9Trackbar(props: {
  rect: PxRect;
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  label: string;
  onChange?: (v: number) => void;
}) {
  const { min, max } = props;
  const span = Math.max(1, max - min);
  const frac = (Math.min(max, Math.max(min, props.value)) - min) / span;
  const valueAt = (e: PointerEvent): number => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    // The channel runs from half a thumb in from each end (11 px thumb, 8 px margin).
    const inset = (r.width / el.offsetWidth) * 13;
    const f = (e.clientX - r.left - inset) / Math.max(1, r.width - 2 * inset);
    return Math.round(min + Math.min(1, Math.max(0, f)) * span);
  };
  return (
    <div
      class={props.disabled ? "w9-track is-disabled" : "w9-track"}
      style={pos(props.rect)}
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={props.value}
      aria-disabled={props.disabled}
      onPointerDown={(e) => {
        if (props.disabled) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        props.onChange?.(valueAt(e as unknown as PointerEvent));
      }}
      onPointerMove={(e) => {
        if (props.disabled || !(e.buttons & 1)) return;
        props.onChange?.(valueAt(e as unknown as PointerEvent));
      }}
      onKeyDown={(e) => {
        if (props.disabled) return;
        const step = e.key === "PageUp" || e.key === "PageDown" ? Math.ceil(span / 5) : 1;
        if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp") {
          props.onChange?.(Math.min(max, props.value + step));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown") {
          props.onChange?.(Math.max(min, props.value - step));
        } else if (e.key === "Home") props.onChange?.(min);
        else if (e.key === "End") props.onChange?.(max);
      }}
    >
      <span class="w9-track-channel" />
      <span class="w9-track-tick" style="left:13px" />
      <span class="w9-track-tick" style="right:13px" />
      <span class="w9-track-thumb" style={`left:calc(8px + (100% - 27px) * ${frac.toFixed(4)})`} />
    </div>
  );
}

export type BoxIcon = "none" | "info" | "stop";

/** What a MessageBoxA shows: its text, caption, icon and buttons. */
export interface W9Box {
  readonly text: string;
  readonly caption: string;
  readonly icon: BoxIcon;
  readonly buttons: readonly string[];
}

/**
 * MessageBoxA: the caption, an icon (MB_ICONINFORMATION / MB_ICONHAND), the
 * text and its buttons, sized to the text as the system sizes it.
 */
export function W9MessageBox(props: {
  text: string;
  caption: string;
  icon: BoxIcon;
  buttons: readonly string[];
  onAnswer: (button: string) => void;
}) {
  const textW = Math.min(420, Math.max(120, Math.ceil(props.text.length * 5.6)));
  const iconW = props.icon === "none" ? 0 : 32 + 16;
  const btnW = 75;
  const btnsW = props.buttons.length * btnW + (props.buttons.length - 1) * 6;
  const clientW = Math.max(iconW + textW + 30, btnsW + 24);
  const clientH = 16 + Math.max(props.icon === "none" ? 13 : 32, 13) + 18 + 23 + 12;
  const w = clientW + 6;
  const h = clientH + 6 + 19;
  const at = centreOnScreen(w, h);
  return (
    <div class="w9-modal" onPointerDown={stop} onPointerUp={stop} onPointerMove={stop}>
      <div
        class="w9 w9-window"
        role="alertdialog"
        aria-label={props.caption}
        style={`left:${at.left}px;top:${at.top}px;width:${w}px;height:${h}px;font:11px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif`}
      >
        <div class="w9-caption">
          <span class="w9-caption-text">{props.caption}</span>
          <button
            type="button"
            class="w9-close"
            aria-label="Close"
            tabIndex={-1}
            onClick={() => props.onAnswer(props.buttons.includes("No") ? "No" : "OK")}
          />
        </div>
        <div class="w9-client-in" style={`width:${clientW}px;height:${clientH}px`}>
          {props.icon !== "none" ? (
            <span class={`w9-icon w9-icon--${props.icon}`} style="left:11px;top:11px" />
          ) : null}
          <div
            class="w9-box-text"
            style={`left:${iconW ? 11 + iconW - 4 : 18}px;top:${props.icon === "none" ? 16 : 20}px;width:${textW}px`}
          >
            {props.text}
          </div>
          {props.buttons.map((b, i) => (
            <W9Button
              key={b}
              rect={{
                left: Math.floor((clientW - btnsW) / 2) + i * (btnW + 6),
                top: clientH - 23 - 10,
                width: btnW,
                height: 23,
              }}
              text={b}
              isDefault={i === 0}
              autoFocus={i === 0}
              onClick={() => props.onAnswer(b)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
