// HOST GAME and JOIN GAME: Metropolis' online lobby (a platform exception)
// dressed as the original's "Host Network Game" (template 0xa8,
// host_dialog.c 0x00404210) and "Join Network Game" (0xa7, join_dialog.c
// 0x00404910) dialogs.
//
// The original's Connection Type lists DirectPlay's service providers; here
// it lists Metropolis' two transports: a lobby the server brokers (WebRTC,
// hosting.spec.md §5) and a relay room joined by its 5-character code.
// Choosing one enables Host / Join, as choosing a provider does. Marked
// Metropolis additions: the lobby's password and public listing, and the room
// code's field. Split Screen Mode stays greyed (no local second player).
// Lobby names are other players' text: JSX children only (docs/specs/ui.md §1).

import { useEffect, useState } from "preact/hooks";
import { hashLobbyPassword, storeP2pBootstrap } from "../../net/p2pSession";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import { apiBase, type MenuChoice, normalizeRoomCode, randomRoomCode } from "../routing";
import {
  dialogLayout,
  W9Button,
  W9Check,
  W9Combo,
  W9Edit,
  W9Group,
  W9List,
  W9Static,
  W9Window,
} from "../win9x/Win9x";

/** Connection Type's two rows: the transports Metropolis has. */
export const CONNECTION_TYPES: readonly string[] = ["Internet Lobby", "Internet Room Code"];
const LOBBY = 0;
const ROOM = 1;
const NAME_KEY = "metropolis.playerName";

export interface NetDialogResult {
  choice: MenuChoice;
  /** The "Connected To:" line: the session's name. */
  peer: string;
  hosting: boolean;
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

interface Lobby {
  lobbyId: string;
  name: string;
  hasPassword: boolean;
}

export function HostDialog(props: { onDone(r: NetDialogResult | null): void }) {
  const L = dialogLayout(FE_DIALOGS.host);
  const [type, setType] = useState(-1);
  const [open, setOpen] = useState(false);
  const [code] = useState(() => randomRoomCode());
  const [game, setGame] = useState("");
  const [player, setPlayer] = useState(loadName);
  const [password, setPassword] = useState("");
  const [isPublic, setPublic] = useState(true);
  const [status, setStatus] = useState("");
  const [soldOut, setSoldOut] = useState(false);
  const extra = L.at([0, 0, 0, 38]).height;

  useEffect(() => {
    if (type !== LOBBY) return;
    // hosting.spec.md §6: no capacity left, no hosting.
    let live = true;
    fetch(`${apiBase()}/api/budget`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { available: boolean } | null) => {
        if (!live || !b) return;
        setSoldOut(!b.available);
        if (!b.available) setStatus("Sold out for today (midnight UTC)");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [type]);

  const host = async (): Promise<void> => {
    storeName(player);
    if (type === ROOM) {
      props.onDone({ choice: { mode: "online", code }, peer: `Room ${code}`, hosting: true });
      return;
    }
    const lobbyCode = randomRoomCode();
    const name = game.trim() || `Lobby ${lobbyCode}`;
    const passwordHash = password ? await hashLobbyPassword(lobbyCode, password) : undefined;
    storeP2pBootstrap(lobbyCode, {
      role: "host",
      name,
      visibility: isPublic ? "public" : "private",
      passwordHash,
    });
    props.onDone({ choice: { mode: "p2p", code: lobbyCode }, peer: name, hosting: true });
  };

  return (
    <W9Window layout={L} onClose={() => props.onDone(null)} extraHeight={extra}>
      <W9Group rect={L.rect(1156)} text={L.text(1156)} />
      <W9Combo
        rect={L.rect(1144)}
        items={CONNECTION_TYPES}
        selected={type}
        open={open}
        label={L.text(1156)}
        lineHeight={13}
        onToggle={() => setOpen(!open)}
        onPick={(i) => {
          setType(i);
          setOpen(false);
          setStatus(i === ROOM ? `Share the room code ${code}` : "");
        }}
      />
      <W9Group rect={L.rect(1151)} text={L.text(1151)} />
      <W9Edit
        rect={L.rect(1139)}
        label={L.text(1151)}
        value={type === ROOM ? code : game}
        readOnly={type === ROOM}
        maxLength={40}
        onInput={setGame}
      />
      <W9Group rect={L.rect(1152)} text={L.text(1152)} />
      <W9Edit
        rect={L.rect(1145)}
        label={L.text(1152)}
        value={player}
        maxLength={24}
        onInput={setPlayer}
      />
      <W9Check rect={L.rect(1158)} text={L.text(1158)} checked={false} disabled />
      <W9Group rect={L.rect(1143)} text={L.text(1143)} />
      <W9Edit rect={L.rect(1140)} label={L.text(1143)} value={status} readOnly />
      <W9Button
        rect={L.rect(1146)}
        text={L.text(1146)}
        disabled={type < 0 || (type === LOBBY && soldOut)}
        onClick={() => void host()}
      />
      <W9Button rect={L.rect(1147)} text={L.text(1147)} onClick={() => props.onDone(null)} />
      {/* Metropolis: the lobby's password and listing. */}
      <W9Group rect={L.at([7, 199, 167, 34])} text="Lobby (Metropolis)" disabled={type !== LOBBY} />
      <W9Static rect={L.at([14, 213, 36, 8])} text="Password" disabled={type !== LOBBY} />
      <W9Edit
        rect={L.at([52, 210, 70, 14])}
        label="Lobby password (optional)"
        value={password}
        password
        disabled={type !== LOBBY}
        onInput={setPassword}
      />
      <W9Check
        rect={L.at([128, 212, 44, 10])}
        text="Public"
        checked={isPublic}
        disabled={type !== LOBBY}
        onChange={setPublic}
      />
    </W9Window>
  );
}

export function JoinDialog(props: { onDone(r: NetDialogResult | null): void }) {
  const L = dialogLayout(FE_DIALOGS.join);
  const [type, setType] = useState(-1);
  const [open, setOpen] = useState(false);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [pick, setPick] = useState(-1);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [player, setPlayer] = useState(loadName);
  const [status, setStatus] = useState("");
  const extra = L.at([0, 0, 0, 22]).height;

  useEffect(() => {
    if (type !== LOBBY) return;
    let live = true;
    setStatus("Looking for games...");
    fetch(`${apiBase()}/api/lobbies`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { lobbies: Lobby[] }) => {
        if (!live) return;
        setLobbies(data.lobbies);
        setStatus(data.lobbies.length ? "" : "No games available");
      })
      .catch(() => {
        if (!live) return;
        setLobbies([]);
        setStatus("Lobby list unavailable");
      });
    return () => {
      live = false;
    };
  }, [type]);

  const chosen = pick >= 0 ? lobbies[pick] : undefined;
  const join = async (): Promise<void> => {
    storeName(player);
    if (type === ROOM) {
      const c = normalizeRoomCode(code);
      if (!c) {
        setStatus("Enter a 5-character room code");
        return;
      }
      props.onDone({ choice: { mode: "online", code: c }, peer: `Room ${c}`, hosting: false });
      return;
    }
    if (!chosen) return;
    const passwordHash =
      chosen.hasPassword && password
        ? await hashLobbyPassword(chosen.lobbyId, password)
        : undefined;
    storeP2pBootstrap(chosen.lobbyId, { role: "join", passwordHash });
    props.onDone({
      choice: { mode: "p2p", code: chosen.lobbyId },
      peer: chosen.name || chosen.lobbyId,
      hosting: false,
    });
  };

  const games = L.rect(1141);
  return (
    <W9Window layout={L} onClose={() => props.onDone(null)} extraHeight={extra}>
      <W9Group rect={L.rect(1157)} text={L.text(1157)} />
      <W9Combo
        rect={L.rect(1142)}
        items={CONNECTION_TYPES}
        selected={type}
        open={open}
        label={L.text(1157)}
        lineHeight={13}
        onToggle={() => setOpen(!open)}
        onPick={(i) => {
          setType(i);
          setOpen(false);
          setPick(-1);
          setStatus("");
        }}
      />
      <W9Group rect={L.rect(1150)} text={L.text(1150)} />
      {type === ROOM ? (
        <>
          {/* Metropolis: a relay room is joined by its code. */}
          <W9Static rect={L.at([16, 52, 40, 8])} text="Room Code" />
          <W9Edit
            rect={L.at([60, 49, 50, 14])}
            label="Room code"
            value={code}
            maxLength={5}
            onInput={(v) => setCode(v.toUpperCase())}
            onEnter={() => void join()}
          />
        </>
      ) : (
        <W9List
          rect={games}
          items={lobbies.map((l) => `${l.hasPassword ? "* " : ""}${l.name || l.lobbyId}`)}
          selected={pick}
          label={L.text(1150)}
          onPick={setPick}
        />
      )}
      <W9Group rect={L.rect(1152)} text={L.text(1152)} />
      <W9Edit
        rect={L.rect(1138)}
        label={L.text(1152)}
        value={player}
        maxLength={24}
        onInput={setPlayer}
      />
      <W9Group rect={L.rect(1144)} text={L.text(1144)} />
      <W9Edit rect={L.rect(1143)} label={L.text(1144)} value={status} readOnly />
      <W9Button
        rect={L.rect(1139)}
        text={L.text(1139)}
        disabled={type < 0 || (type === LOBBY && !chosen)}
        onClick={() => void join()}
      />
      <W9Button rect={L.rect(1140)} text={L.text(1140)} onClick={() => props.onDone(null)} />
      {/* Metropolis: a password-protected lobby's password. */}
      <W9Static
        rect={L.at([14, 227, 66, 8])}
        text="Password (Metropolis)"
        disabled={!chosen?.hasPassword}
      />
      <W9Edit
        rect={L.at([82, 224, 92, 14])}
        label="Lobby password"
        value={password}
        password
        disabled={!chosen?.hasPassword}
        onInput={setPassword}
      />
    </W9Window>
  );
}
