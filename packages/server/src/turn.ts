/// <reference types="@cloudflare/workers-types" />
// Short-lived TURN credentials (hosting.spec.md §6): issued server-side by the
// LobbyDO through the Cloudflare Realtime TURN API, never baked into the
// client. Each peer gets fresh credentials with its created/joined message and
// connects relay-only, so the opponent only ever sees the TURN edge.
//
// Without TURN_KEY_ID / TURN_KEY_API_TOKEN (local dev, previews) the lobby
// sends no ICE config and the client falls back to non-relay host candidates —
// fine on a LAN, never what production does.

/** What rides the created/joined messages; mirrored client-side (p2pSession). */
export interface LobbyIceConfig {
  readonly iceServers: unknown[];
  readonly relayOnly: boolean;
}

/** Credential lifetime. Generous: TURN allocations outlive their credential. */
export const TURN_CREDENTIAL_TTL_S = 3600;

/**
 * Normalizes the Realtime API response body into an RTCIceServer array. The
 * API has answered with both `{ iceServers: {…} }` (object) and
 * `{ iceServers: [{…}] }` (array) across versions — accept either; null means
 * an unusable body (treated as "no TURN", never an exception).
 */
export function normalizeIceServers(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { iceServers?: unknown }).iceServers;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : null;
  if (!list || list.length === 0) return null;
  for (const server of list) {
    if (typeof server !== "object" || server === null) return null;
    const urls = (server as { urls?: unknown }).urls;
    const urlList = Array.isArray(urls) ? urls : typeof urls === "string" ? [urls] : null;
    if (!urlList || urlList.some((u) => typeof u !== "string")) return null;
  }
  return list;
}

/**
 * Fetches fresh credentials; null on any failure (missing key, API error) —
 * the lobby then simply omits the ICE config rather than failing signaling.
 */
export async function issueTurnCredentials(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LobbyIceConfig | null> {
  try {
    const res = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_S }),
      },
    );
    if (!res.ok) return null;
    const iceServers = normalizeIceServers(await res.json());
    if (!iceServers) return null;
    return { iceServers, relayOnly: true };
  } catch {
    return null;
  }
}
