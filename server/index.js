const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = 4000;
const HOST = "0.0.0.0";
const MATCH_MIN = 1;
const MATCH_MAX = 999;
const MATCH_CAPACITY = 10;
const PICK_ORDER = ["BLUE", "RED", "RED", "BLUE", "BLUE", "RED", "RED", "BLUE", "BLUE", "RED"];
const FALLBACK_VERSION = "16.9.1";
const FALLBACK_CHAMPIONS = [
  "Ahri", "Yasuo", "Zed", "Lux", "LeeSin", "Jinx", "Thresh", "Orianna", "Ezreal", "Katarina",
  "Leblanc", "Darius", "Garen", "Riven", "Vayne", "Kaisa", "Ashe", "Caitlyn", "Akali", "Irelia",
  "Aatrox", "Renekton", "Camille", "Sejuani", "Nidalee", "Graves", "Syndra", "Viktor", "Fizz", "Lissandra"
];
const CUSTOM_CHAMPIONS = [
  { id: "Zahen", en: "Zaahen", kr: "자헨", image: "/zahen.png" }
];

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let championVersion = FALLBACK_VERSION;
let championPool = [...FALLBACK_CHAMPIONS];
let championCatalog = Object.fromEntries(
  FALLBACK_CHAMPIONS.map((id) => [id, { id, kr: id, en: id }])
);
for (const custom of CUSTOM_CHAMPIONS) {
  championCatalog[custom.id] = custom;
  if (!championPool.includes(custom.id)) championPool.push(custom.id);
}

const matches = new Map();

function getRoomName(code) {
  return `match:${code}`;
}

function pickRandomThree(pool) {
  const copy = [...pool];
  const result = [];
  const count = Math.min(3, copy.length);
  for (let i = 0; i < count; i += 1) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

function createInitialState() {
  const unseenPool = [...championPool];
  const firstOffer = pickRandomThree(unseenPool);
  return {
    phase: "DRAFT",
    teams: { BLUE: [], RED: [] },
    pickOrder: PICK_ORDER,
    turnIndex: 0,
    currentTeam: PICK_ORDER[0],
    offeredChampions: firstOffer,
    unseenPool: unseenPool.filter((c) => !firstOffer.includes(c)),
    championVersion,
    championCatalog
  };
}

function createMatch(code) {
  return {
    code,
    sockets: new Set(),
    gameState: createInitialState()
  };
}

function broadcastMatchState(code) {
  const match = matches.get(code);
  if (!match) return;
  io.to(getRoomName(code)).emit("state:update", match.gameState);
}

function broadcastMatchInfo(code) {
  const match = matches.get(code);
  if (!match) return;
  io.to(getRoomName(code)).emit("match:update", {
    code,
    participantCount: match.sockets.size,
    capacity: MATCH_CAPACITY
  });
}

function refreshOfferedChampions(match) {
  const nextOffer = pickRandomThree(match.gameState.unseenPool);
  match.gameState.offeredChampions = nextOffer;
  match.gameState.unseenPool = match.gameState.unseenPool.filter((c) => !nextOffer.includes(c));
}

function leaveMatch(socket) {
  const code = socket.data.matchCode;
  if (!code) return;
  const match = matches.get(code);
  socket.leave(getRoomName(code));
  socket.data.matchCode = null;
  socket.data.selectedTeam = null;
  if (!match) return;

  match.sockets.delete(socket.id);
  if (match.sockets.size === 0) {
    matches.delete(code);
    return;
  }
  broadcastMatchInfo(code);
}

async function loadChampionData() {
  try {
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then((r) => r.json());
    const latest = versions[0];
    const en = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`).then((r) => r.json());
    const ko = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ko_KR/champion.json`).then((r) => r.json());

    const ids = Object.keys(en.data);
    const nextCatalog = {};
    for (const id of ids) {
      nextCatalog[id] = {
        id,
        en: en.data[id]?.name || id,
        kr: ko.data[id]?.name || en.data[id]?.name || id
      };
    }
    for (const custom of CUSTOM_CHAMPIONS) {
      nextCatalog[custom.id] = custom;
      if (!ids.includes(custom.id)) ids.push(custom.id);
    }

    championVersion = latest;
    championPool = ids;
    championCatalog = nextCatalog;

    for (const match of matches.values()) {
      match.gameState = createInitialState();
      broadcastMatchState(match.code);
    }

    console.log(`Champion data loaded: ${latest}, ${ids.length} champions (with custom)`);
  } catch (error) {
    console.error("Failed to load champion data from Data Dragon. Using fallback list.", error?.message || error);
  }
}

io.on("connection", (socket) => {
  socket.data.matchCode = null;
  socket.data.selectedTeam = null;

  socket.on("match:join", ({ code }) => {
    const parsed = Number(code);
    if (!Number.isInteger(parsed) || parsed < MATCH_MIN || parsed > MATCH_MAX) {
      socket.emit("match:error", { message: "방 번호는 1~999 사이 숫자여야 합니다." });
      return;
    }

    if (socket.data.matchCode === parsed) {
      const existing = matches.get(parsed);
      if (existing) {
        socket.emit("match:joined", { code: parsed });
        socket.emit("state:update", existing.gameState);
        broadcastMatchInfo(parsed);
      }
      return;
    }

    leaveMatch(socket);

    let match = matches.get(parsed);
    if (!match) {
      match = createMatch(parsed);
      matches.set(parsed, match);
    }
    if (match.sockets.size >= MATCH_CAPACITY) {
      socket.emit("match:error", { message: "해당 방은 이미 10명입니다." });
      return;
    }

    match.sockets.add(socket.id);
    socket.data.matchCode = parsed;
    socket.data.selectedTeam = null;
    socket.join(getRoomName(parsed));

    socket.emit("match:joined", { code: parsed });
    socket.emit("team:selected", { team: null });
    socket.emit("state:update", match.gameState);
    broadcastMatchInfo(parsed);
  });

  socket.on("team:select", ({ team }) => {
    if (!socket.data.matchCode) return;
    if (!["BLUE", "RED"].includes(team)) return;
    socket.data.selectedTeam = team;
    socket.emit("team:selected", { team });
  });

  socket.on("draft:pick", ({ champion }) => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match) return;
    const state = match.gameState;

    if (state.phase !== "DRAFT") return;
    if (!socket.data.selectedTeam) return;
    if (socket.data.selectedTeam !== state.currentTeam) return;
    if (!state.offeredChampions.includes(champion)) return;

    const team = state.currentTeam;
    state.teams[team].push(champion);
    state.turnIndex += 1;

    if (state.turnIndex >= state.pickOrder.length) {
      state.phase = "SWAP";
      state.currentTeam = null;
      state.offeredChampions = [];
    } else {
      state.currentTeam = state.pickOrder[state.turnIndex];
      refreshOfferedChampions(match);
    }

    broadcastMatchState(code);
  });

  socket.on("swap:move", ({ team, fromIndex, toIndex }) => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match) return;
    const state = match.gameState;

    if (state.phase !== "SWAP") return;
    if (!["BLUE", "RED"].includes(team)) return;

    const arr = state.teams[team];
    if (!Array.isArray(arr)) return;
    if (fromIndex < 0 || fromIndex >= arr.length) return;
    if (toIndex < 0 || toIndex >= arr.length) return;
    if (fromIndex === toIndex) return;

    const next = [...arr];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    state.teams[team] = next;

    broadcastMatchState(code);
  });

  socket.on("game:reset", () => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match) return;
    match.gameState = createInitialState();
    broadcastMatchState(code);
  });

  socket.on("disconnect", () => {
    leaveMatch(socket);
  });
});

app.get("/", (req, res) => {
  res.send("Triple Draft Server is running");
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  loadChampionData();
});
