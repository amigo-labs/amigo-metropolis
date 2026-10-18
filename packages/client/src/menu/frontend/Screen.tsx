// The original's front-end screen as images on the 640 x 480 stage, composed
// the way frontend_first_frame draws it (screen_draw.c): per group of the set,
// in the order main, left, right, radio -- the backdrop at its origin, the
// group's extra (a portrait, the "Connected To:" caption), every panel, then
// its menus. Hook-free: a pure function of the screen.

import type { JSX } from "preact";
import { FE_CONNECTED_TO, FE_LOADING_SCREEN, FE_PORTRAITS } from "./frontendData.generated";
import {
  type FeScreen,
  FLAG_DISABLED,
  groupOf,
  menuSelection,
  panelFlags,
  panelPicture,
  ROLES,
} from "./model";
import type { FePicture } from "./types";

export const PICTURE_BASE = "/ui/frontend/";

function Pic(props: { p: FePicture; x: number; y: number; tag?: string }) {
  return (
    <img
      class="fe-pic"
      src={`${PICTURE_BASE}${props.p.file}`}
      alt=""
      width={props.p.w}
      height={props.p.h}
      draggable={false}
      data-fe={props.tag}
      style={`left:${props.x}px;top:${props.y}px`}
    />
  );
}

/**
 * The networked top's extra (0x00409e70): "Connected To:" in light blue at
 * (72, 64) and the peer two spaces in, grey, one line lower, in GDI's 16 x 12
 * fixed-pitch font.
 */
function ConnectedTo(props: { peer: string }) {
  const c = FE_CONNECTED_TO;
  const rgb = (v: readonly number[]): string => `rgb(${v[0]},${v[1]},${v[2]})`;
  return (
    <>
      <span
        class="fe-gdi"
        style={`left:${c.caption.at[0]}px;top:${c.caption.at[1]}px;color:${rgb(c.caption.rgb)}`}
      >
        {c.caption.text}
      </span>
      <span
        class="fe-gdi"
        data-fe="peer"
        style={`left:${c.peer.at[0]}px;top:${c.peer.at[1] + 16}px;color:${rgb(c.peer.rgb)}`}
      >
        {`  ${props.peer}`}
      </span>
    </>
  );
}

export function FrontScreen({ screen }: { screen: FeScreen }) {
  const items: JSX.Element[] = [];
  for (const role of ROLES) {
    const g = groupOf(screen, role);
    if (g.backdrop) {
      items.push(<Pic key={`${g.key}:b`} p={g.backdrop} x={g.origin[0]} y={g.origin[1]} />);
    }
    if (g.extra?.name === "frontend_draw_col_portrait_l") {
      const pt = FE_PORTRAITS.left;
      items.push(<Pic key={`${g.key}:x`} p={pt.pa} x={pt.at[0]} y={pt.at[1]} tag="portrait" />);
    } else if (g.extra?.name === "frontend_draw_col_portrait_r") {
      const pt = FE_PORTRAITS.right;
      items.push(<Pic key={`${g.key}:x`} p={pt.pa} x={pt.at[0]} y={pt.at[1]} tag="portrait" />);
    } else if (g.extra?.name === "frontend_group_extra_409e70") {
      items.push(<ConnectedTo key={`${g.key}:x`} peer={screen.net?.peer ?? ""} />);
    }
    for (let i = 0; i < g.panels.length; i++) {
      const f = panelFlags(screen, g, i);
      // 0x0040aa87: only the disabled bit keeps a panel off the screen; a
      // hidden one is drawn and refuses the click (the peer's arrows online).
      if (f & FLAG_DISABLED) continue;
      const p = g.panels[i];
      const pic = panelPicture(p, f);
      if (pic)
        items.push(<Pic key={`${g.key}:p${i}`} p={pic} x={p.x} y={p.y} tag={`${g.key}:${i}`} />);
    }
    for (let i = 0; i < g.menus.length; i++) {
      const sel = menuSelection(screen, g, i);
      const m = g.menus[i];
      const e = sel >= 0 ? m.entries[sel] : undefined;
      if (e)
        items.push(<Pic key={`${g.key}:m${i}`} p={e} x={m.x} y={m.y} tag={`${g.key}:m${i}`} />);
    }
  }
  return <>{items}</>;
}

/**
 * The loading screen (launch.c:288-296): the row's loading bitmap over the
 * whole screen, the bar's plate at (216, 270) and its fill at (220, 274),
 * `fill` of its 200 pixels shown.
 */
export function LoadingScreen(props: { file: string; fill: number }) {
  const f = FE_LOADING_SCREEN;
  const w = Math.max(0, Math.min(f.barFill.w, Math.floor(props.fill)));
  return (
    <div class="fe-loading" data-fe="loading">
      <img
        class="fe-pic"
        src={`${PICTURE_BASE}loading/${props.file}`}
        alt=""
        width={640}
        height={480}
        draggable={false}
        style="left:0;top:0"
      />
      <Pic p={f.barFrame as FePicture} x={f.barFrame.at[0]} y={f.barFrame.at[1]} />
      <div
        class="fe-bar"
        style={`left:${f.barFill.at[0]}px;top:${f.barFill.at[1]}px;width:${w}px;height:${f.barFill.h}px`}
      >
        <Pic p={f.barFill as FePicture} x={0} y={0} />
      </div>
    </div>
  );
}
