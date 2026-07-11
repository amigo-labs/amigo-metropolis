// Pure directory logic — the brain of the DirectoryDO (hosting.spec.md §3.3),
// Cloudflare-free and unit-tested like RoomLogic/LobbyLogic. It is nothing but
// the list of open PUBLIC lobbies: lobby DOs register on create and unregister
// on join/close (2 requests per lobby), clients GET the list. Private lobbies
// are shared by code and never pass through here.
//
// Entries also carry a timestamp so a lobby that died without unregistering
// (crashed DO, lost request) ages out on the next list() — the directory never
// trusts lobbies to clean up perfectly.

/** A registration older than this is stale — the lobby's own open TTL is 10 min. */
export const DIRECTORY_ENTRY_TTL_MS = 11 * 60_000;
/** Hard cap; beyond it the oldest entries are evicted first. */
export const DIRECTORY_MAX_ENTRIES = 50;

const LOBBY_ID = /^[A-Z0-9]{5}$/;
const NAME_MAX = 40;

export interface DirectoryEntry {
  readonly lobbyId: string;
  readonly name: string;
  readonly hasPassword: boolean;
  /** Registration wall-clock (ms) — drives staleness eviction. */
  readonly atMs: number;
}

/** What clients see (no timestamps — nothing to fingerprint). */
export interface PublicLobby {
  readonly lobbyId: string;
  readonly name: string;
  readonly hasPassword: boolean;
}

/** Validates an untrusted register body; null = malformed. */
export function parseRegister(v: unknown): Omit<DirectoryEntry, "atMs"> | null {
  if (typeof v !== "object" || v === null) return null;
  const { lobbyId, name, hasPassword } = v as Record<string, unknown>;
  if (typeof lobbyId !== "string" || !LOBBY_ID.test(lobbyId)) return null;
  if (typeof name !== "string" || name.length > NAME_MAX) return null;
  if (typeof hasPassword !== "boolean") return null;
  return { lobbyId, name, hasPassword };
}

/** Validates an untrusted unregister body; null = malformed. */
export function parseUnregister(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return null;
  const { lobbyId } = v as Record<string, unknown>;
  return typeof lobbyId === "string" && LOBBY_ID.test(lobbyId) ? lobbyId : null;
}

export class DirectoryLogic {
  private readonly entries = new Map<string, DirectoryEntry>();

  /** Adds or refreshes a listing. Returns true if the stored set changed. */
  register(entry: Omit<DirectoryEntry, "atMs">, nowMs: number): boolean {
    this.prune(nowMs);
    // Map.set on an existing key keeps its ORIGINAL insertion slot, and list()
    // orders by insertion — delete first so a refresh really moves to newest.
    this.entries.delete(entry.lobbyId);
    this.entries.set(entry.lobbyId, { ...entry, atMs: nowMs });
    // Cap: evict the oldest listings first (they are closest to their TTL).
    while (this.entries.size > DIRECTORY_MAX_ENTRIES) {
      let oldest: DirectoryEntry | null = null;
      for (const e of this.entries.values()) {
        if (!oldest || e.atMs < oldest.atMs) oldest = e;
      }
      this.entries.delete((oldest as DirectoryEntry).lobbyId);
    }
    return true;
  }

  /** Returns true if the lobby was listed. */
  unregister(lobbyId: string): boolean {
    return this.entries.delete(lobbyId);
  }

  /** Open public lobbies, newest first, stale entries pruned. */
  list(nowMs: number): PublicLobby[] {
    this.prune(nowMs);
    const out: PublicLobby[] = [];
    for (const e of this.entries.values()) {
      out.push({ lobbyId: e.lobbyId, name: e.name, hasPassword: e.hasPassword });
    }
    return out.reverse(); // Map iterates in insertion order → newest last
  }

  private prune(nowMs: number): void {
    for (const [id, e] of this.entries) {
      if (nowMs - e.atMs >= DIRECTORY_ENTRY_TTL_MS) this.entries.delete(id);
    }
  }

  // --- persistence (survives DO eviction as one small record) -----------------

  snapshot(): DirectoryEntry[] {
    return [...this.entries.values()];
  }

  hydrate(entries: DirectoryEntry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.lobbyId, e);
  }
}
