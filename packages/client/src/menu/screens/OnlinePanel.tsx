// Online panel: join by 5-char relay code, plus the P2P lobby browser
// (hosting.spec.md §3.1).
//
// Lobby names are other players' text. They are rendered as JSX children, which
// escapes them; nothing here may reach for dangerouslySetInnerHTML
// (docs/specs/ui.md §1).

import { useEffect, useState } from "preact/hooks";
import { hashLobbyPassword, storeP2pBootstrap } from "../../net/p2pSession";
import { apiBase, type MenuChoice, normalizeRoomCode, randomRoomCode } from "../routing";
import type { MenuState } from "../state";

interface Props {
  state: MenuState;
  update(patch: Partial<MenuState>): void;
  go(choice: MenuChoice): void;
}

interface Lobby {
  lobbyId: string;
  name: string;
  hasPassword: boolean;
}

export function OnlinePanel({ state, update, go }: Props) {
  const [lobbies, setLobbies] = useState<Lobby[] | null>(null);
  const [listHint, setListHint] = useState("Loading lobbies…");
  const [budgetHint, setBudgetHint] = useState("");
  const [soldOut, setSoldOut] = useState(false);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState("");

  const load = async (): Promise<void> => {
    try {
      const res = await fetch(`${apiBase()}/api/lobbies`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { lobbies: Lobby[] };
      setLobbies(data.lobbies);
      setListHint(data.lobbies.length ? "" : "No open lobbies right now — host one below.");
    } catch {
      setLobbies([]);
      setListHint("Lobby list unavailable (offline or the server is asleep).");
    }
    // "Sold out" path (hosting.spec.md §6): if the budget gatekeeper has no
    // capacity left, grey out hosting up front instead of failing the create.
    try {
      const res = await fetch(`${apiBase()}/api/budget`);
      if (!res.ok) return;
      const budget = (await res.json()) as { available: boolean; retryAtMs: number | null };
      setSoldOut(!budget.available);
      setBudgetHint(
        budget.available ? "" : "Sold out for today — free capacity resets at midnight UTC.",
      );
    } catch {
      // no budget info — leave hosting enabled; the server still enforces it
    }
  };

  // Mount-only: refreshing the list is an explicit button, not a reaction to
  // state, and re-fetching on every keystroke in the code field would be worse
  // than useless.
  useEffect(() => {
    void load();
  }, []);

  const joinLobby = async (lobbyId: string, password?: string): Promise<void> => {
    const passwordHash = password ? await hashLobbyPassword(lobbyId, password) : undefined;
    storeP2pBootstrap(lobbyId, { role: "join", passwordHash });
    go({ mode: "p2p", code: lobbyId });
  };

  const tryJoinByCode = (): void => {
    const code = normalizeRoomCode(state.roomCode);
    if (!code) {
      update({ roomError: "Enter a 5-character room code." });
      return;
    }
    go({ mode: "online", code });
  };

  const createLobby = async (): Promise<void> => {
    const code = randomRoomCode();
    const passwordHash = state.lobbyPassword
      ? await hashLobbyPassword(code, state.lobbyPassword)
      : undefined;
    storeP2pBootstrap(code, {
      role: "host",
      name: state.lobbyName.trim() || `Lobby ${code}`,
      visibility: state.lobbyPublic ? "public" : "private",
      passwordHash,
    });
    go({ mode: "p2p", code });
  };

  return (
    <>
      <h2 class="menu-h2">Join by code</h2>
      <div class="menu-row">
        <input
          class="menu-code"
          type="text"
          maxLength={5}
          placeholder="CODE"
          aria-label="Room code"
          autocapitalize="characters"
          spellcheck={false}
          value={state.roomCode}
          onInput={(e) =>
            update({
              roomCode: (e.currentTarget as HTMLInputElement).value.toUpperCase(),
              roomError: "",
            })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") tryJoinByCode();
          }}
        />
        <button type="button" class="menu-go" onClick={tryJoinByCode}>
          Join
        </button>
      </div>
      {state.roomError ? <div class="menu-err">{state.roomError}</div> : null}

      <button
        type="button"
        class="menu-go menu-go--ghost"
        onClick={() => go({ mode: "online", code: randomRoomCode() })}
      >
        Host a new room
      </button>
      <p class="menu-hint">
        Host, then share the 5-character code. Both players enter the same code to join the same
        room.
      </p>

      <h2 class="menu-h2">Public lobbies</h2>
      <div class="menu-lobbies">
        {(lobbies ?? []).map((lobby) => (
          <div class="menu-lobby" key={lobby.lobbyId}>
            <span class="menu-lobby-name">
              {lobby.hasPassword ? "\u{1F512} " : ""}
              {lobby.name || lobby.lobbyId}
            </span>
            {pwFor === lobby.lobbyId ? (
              <input
                class="menu-code"
                type="password"
                placeholder="password"
                aria-label={`Password for ${lobby.name}`}
                value={pwValue}
                // Appears in response to clicking Join and is the only thing
                // left to do, so taking focus is the expected move rather than
                // a hijack.
                autofocus
                onInput={(e) => setPwValue((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void joinLobby(lobby.lobbyId, pwValue);
                }}
              />
            ) : null}
            <button
              type="button"
              class="menu-go"
              onClick={() => {
                if (!lobby.hasPassword) {
                  void joinLobby(lobby.lobbyId);
                } else if (pwFor === lobby.lobbyId) {
                  void joinLobby(lobby.lobbyId, pwValue);
                } else {
                  setPwFor(lobby.lobbyId);
                  setPwValue("");
                }
              }}
            >
              {pwFor === lobby.lobbyId ? "Go" : "Join"}
            </button>
          </div>
        ))}
      </div>
      {listHint ? <div class="menu-hint">{listHint}</div> : null}
      <button type="button" class="menu-go menu-go--ghost" onClick={() => void load()}>
        Refresh list
      </button>

      <h2 class="menu-h2">Host a lobby</h2>
      <div class="menu-row">
        <input
          class="menu-code menu-code--text"
          type="text"
          maxLength={40}
          placeholder="Lobby name"
          aria-label="Lobby name"
          value={state.lobbyName}
          onInput={(e) => update({ lobbyName: (e.currentTarget as HTMLInputElement).value })}
        />
      </div>
      <div class="menu-row">
        <input
          class="menu-code menu-code--text"
          type="password"
          placeholder="Password (optional)"
          aria-label="Lobby password (optional)"
          value={state.lobbyPassword}
          onInput={(e) => update({ lobbyPassword: (e.currentTarget as HTMLInputElement).value })}
        />
      </div>
      <label class="menu-check">
        <input
          type="checkbox"
          checked={state.lobbyPublic}
          onChange={(e) => update({ lobbyPublic: (e.currentTarget as HTMLInputElement).checked })}
        />
        List publicly (else share the code)
      </label>
      <button type="button" class="menu-go" disabled={soldOut} onClick={() => void createLobby()}>
        Create lobby
      </button>
      {budgetHint ? <p class="menu-err">{budgetHint}</p> : null}
      <p class="menu-hint">
        P2P matches connect directly between both browsers. Private lobbies are joined by sharing
        the code; passwords are checked by the server and never sent in plain text.
      </p>
    </>
  );
}
