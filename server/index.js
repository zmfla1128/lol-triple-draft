const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = 4000;
const HOST = "0.0.0.0";
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

let gameState = createInitialState();

function broadcastState() {
  io.emit("state:update", gameState);
}

function refreshOfferedChampions() {
  const nextOffer = pickRandomThree(gameState.unseenPool);
  gameState.offeredChampions = nextOffer;
  gameState.unseenPool = gameState.unseenPool.filter((c) => !nextOffer.includes(c));
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
    gameState = createInitialState();
    broadcastState();
    console.log(`Champion data loaded: ${latest}, ${ids.length} champions (with custom)`);
  } catch (error) {
    console.error("Failed to load champion data from Data Dragon. Using fallback list.", error?.message || error);
  }
}

io.on("connection", (socket) => {
  socket.data.selectedTeam = null;
  socket.emit("state:update", gameState);
  socket.emit("team:selected", { team: null });

  socket.on("team:select", ({ team }) => {
    if (!["BLUE", "RED"].includes(team)) return;
    socket.data.selectedTeam = team;
    socket.emit("team:selected", { team });
  });

  socket.on("draft:pick", ({ champion }) => {
    if (gameState.phase !== "DRAFT") return;
    if (!socket.data.selectedTeam) return;
    if (socket.data.selectedTeam !== gameState.currentTeam) return;
    if (!gameState.offeredChampions.includes(champion)) return;

    const team = gameState.currentTeam;
    gameState.teams[team].push(champion);
    gameState.turnIndex += 1;

    if (gameState.turnIndex >= gameState.pickOrder.length) {
      gameState.phase = "SWAP";
      gameState.currentTeam = null;
      gameState.offeredChampions = [];
    } else {
      gameState.currentTeam = gameState.pickOrder[gameState.turnIndex];
      refreshOfferedChampions();
    }

    broadcastState();
  });

  socket.on("swap:move", ({ team, fromIndex, toIndex }) => {
    if (gameState.phase !== "SWAP") return;
    if (!["BLUE", "RED"].includes(team)) return;

    const arr = gameState.teams[team];
    if (!Array.isArray(arr)) return;
    if (fromIndex < 0 || fromIndex >= arr.length) return;
    if (toIndex < 0 || toIndex >= arr.length) return;
    if (fromIndex === toIndex) return;

    const next = [...arr];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    gameState.teams[team] = next;
    broadcastState();
  });

  socket.on("game:reset", () => {
    gameState = createInitialState();
    broadcastState();
  });
});

app.get("/", (req, res) => {
  res.send("Triple Draft Server is running");
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  loadChampionData();
});
