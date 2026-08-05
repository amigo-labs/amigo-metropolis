// Menu -> URL mapping. Pure by design: no DOM, no Preact, so `bun test` can
// drive it directly (test/menu.test.ts). This is the part the deep-link
// harnesses depend on — main.ts's `explicitMode` path reads exactly these
// query strings, and the menu is only one of the ways to produce them
// (docs/specs/ui.md §5).
//
// Moved out of the old single-file menu.ts unchanged. Behaviour here is
// deliberately frozen: a change to a query string is a change to every shared
// link and every recorded test invocation.

import { type Loadout, normalizeLoadout } from "@metropolis/sim";

export type MenuChoice =
  | { mode: "solo" } // sandbox vs the scripted feeder opponent
  | { mode: "warden"; difficulty: number } // vs the Phase 4 AI
  | { mode: "online"; code: string } // 1v1 lockstep via the relay
  | { mode: "p2p"; code: string } // 1v1 lockstep, lobby-brokered P2P
  | { mode: "fly" } // localhost debug: free-fly cam + mesh units (incl. turrets)
  | { mode: "sandbox" }; // debug test bench: spawn panel + live weapon swap

/**
 * Pure mapping from a menu choice to the query string main.ts understands.
 * `mapId` (the picker's arena) rides along as the ?map= deep-link param main.ts
 * already reads. Loadout rides as ?gun=&heavy=&special= (omitted when all
 * default 0).
 */
export function buildModeQuery(choice: MenuChoice, mapId?: string, loadout?: Loadout): string {
  let query: string;
  switch (choice.mode) {
    case "solo":
      query = "?play=1";
      break;
    case "fly":
      // Sandbox match + free-fly debug cam; mesh render so unit/turret GLBs show.
      query = "?play=1&cam=fly";
      break;
    case "sandbox":
      // Test bench: fly cam to get an angle on what you spawned, and the idle
      // opponent so a feeder's runners do not walk through the shot.
      query = "?play=1&sandbox=1&cam=fly&opponent=idle";
      break;
    case "warden": {
      const d = Math.max(1, Math.min(10, Math.trunc(choice.difficulty) || 1));
      query = `?warden=${d}`;
      break;
    }
    case "online":
      // Encode defensively: valid codes are unaffected, but an unexpected value
      // can't smuggle extra query params (& / =) into the URL.
      query = `?online=${encodeURIComponent(choice.code.toUpperCase())}`;
      break;
    case "p2p":
      query = `?p2p=${encodeURIComponent(choice.code.toUpperCase())}`;
      break;
  }
  if (mapId) query += `&map=${encodeURIComponent(mapId)}`;
  const kit = normalizeLoadout(loadout);
  if (kit.gun !== 0 || kit.heavy !== 0 || kit.special !== 0) {
    query += `&gun=${kit.gun}&heavy=${kit.heavy}&special=${kit.special}`;
  }
  return query;
}

/** Parse ?gun=&heavy=&special= from a URLSearchParams (defaults on garbage). */
export function loadoutFromParams(params: URLSearchParams): Loadout {
  return normalizeLoadout({
    gun: Number(params.get("gun") ?? 0),
    heavy: Number(params.get("heavy") ?? 0),
    special: Number(params.get("special") ?? 0),
  });
}

/** Gates localhost-only debug UI (Fly cam button). */
export function isLocalhost(hostname: string = location.hostname): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** 5 upper-case alphanumerics, matching main.ts's room-code validation. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5}$/.test(code) ? code : null;
}

// Ambiguous glyphs (0/O, 1/I) dropped so spoken/typed codes survive.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomRoomCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return code;
}

/** HTTP(S) base for /api reads: the ?relay ws override translated, else same-origin. */
export function apiBase(): string {
  const relay = new URLSearchParams(location.search).get("relay");
  if (!relay) return "";
  return relay.replace(/\/+$/, "").replace(/^ws(s?):/, "http$1:");
}
