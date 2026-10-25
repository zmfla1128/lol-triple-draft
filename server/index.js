const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = 4000;
const HOST = "0.0.0.0";
const MATCH_MIN = 1;
const MATCH_MAX = 999;
const MATCH_CAPACITY = 2;
const DRAFT_DURATION_MS = 30 * 1000;
const SWAP_DURATION_MS = 60 * 1000;
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
    phase: "READY",
    teams: { BLUE: [], RED: [] },
    readyTeams: { BLUE: false, RED: false },
    pickOrder: PICK_ORDER,
    turnIndex: 0,
    currentTeam: PICK_ORDER[0],
    offeredChampions: firstOffer,
    unseenPool: unseenPool.filter((c) => !firstOffer.includes(c)),
    seenChampions: [...firstOffer],
    pickEndsAt: null,
    swapEndsAt: null,
    swapStartTeams: null,
    championVersion,
    championCatalog
  };
}

function createMatch(code) {
  return {
    code,
    sockets: new Set(),
    earlyFinishVotes: new Set(),
    resetVotes: new Set(),
    pickTimer: null,
    swapTimer: null,
    gameState: createInitialState()
  };
}

function getEarlyFinishVotesRequired(match) {
  return Math.floor(match.sockets.size / 2) + 1;
}

function getResetVoteTeams(match) {
  const teams = { BLUE: false, RED: false };
  for (const socketId of match.resetVotes) {
    const team = io.sockets.sockets.get(socketId)?.data.selectedTeam;
    if (team) teams[team] = true;
  }
  return teams;
}

function getClientState(match, selectedTeam = null) {
  const state = match.gameState;
  const teams = {
    BLUE: [...state.teams.BLUE],
    RED: [...state.teams.RED]
  };
  if (state.phase === "SWAP" && selectedTeam && state.swapStartTeams) {
    const opponent = selectedTeam === "BLUE" ? "RED" : "BLUE";
    teams[opponent] = [...state.swapStartTeams[opponent]];
  }
  return {
    ...state,
    teams,
    earlyFinishVoteCount: match.earlyFinishVotes.size,
    earlyFinishVotesRequired: getEarlyFinishVotesRequired(match),
    resetVoteTeams: getResetVoteTeams(match)
  };
}

function isTeamTaken(match, team, socketId) {
  return [...match.sockets].some((id) => {
    if (id === socketId) return false;
    return io.sockets.sockets.get(id)?.data.selectedTeam === team;
  });
}

function broadcastMatchState(code) {
  const match = matches.get(code);
  if (!match) return;
  for (const socketId of match.sockets) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.emit("state:update", getClientState(match, socket?.data.selectedTeam));
  }
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
  const state = match.gameState;
  const unavailable = new Set([...(state.seenChampions || []), ...state.teams.BLUE, ...state.teams.RED]);
  const candidatePool = state.unseenPool.filter((champion) => !unavailable.has(champion));
  const nextOffer = pickRandomThree(candidatePool);
  state.offeredChampions = nextOffer;
  state.seenChampions = [...new Set([...(state.seenChampions || []), ...nextOffer])];
  state.unseenPool = candidatePool.filter((champion) => !nextOffer.includes(champion));
}

function finishDraftPick(match, champion) {
  const state = match.gameState;
  if (state.phase !== "DRAFT" || !state.offeredChampions.includes(champion)) return;

  if (match.pickTimer) clearTimeout(match.pickTimer);
  match.pickTimer = null;
  state.pickEndsAt = null;
  state.teams[state.currentTeam].push(champion);
  state.turnIndex += 1;

  if (state.turnIndex >= state.pickOrder.length) {
    state.swapStartTeams = {
      BLUE: [...state.teams.BLUE],
      RED: [...state.teams.RED]
    };
    state.phase = "SWAP";
    state.currentTeam = null;
    state.offeredChampions = [];
    state.swapEndedByVote = false;
    match.earlyFinishVotes.clear();
    startSwapTimer(match);
  } else {
    state.currentTeam = state.pickOrder[state.turnIndex];
    refreshOfferedChampions(match);
    startDraftTimer(match);
  }
  broadcastMatchState(match.code);
}

function startDraftTimer(match) {
  if (match.pickTimer) clearTimeout(match.pickTimer);
  match.gameState.pickEndsAt = Date.now() + DRAFT_DURATION_MS;
  match.pickTimer = setTimeout(() => {
    const { offeredChampions } = match.gameState;
    if (offeredChampions.length) finishDraftPick(match, offeredChampions[Math.floor(Math.random() * offeredChampions.length)]);
  }, DRAFT_DURATION_MS);
}

function finishSwapPhase(match, endedByVote = false) {
  if (match.gameState.phase !== "SWAP") return;
  match.gameState.phase = "COMPLETE";
  match.gameState.swapEndsAt = null;
  match.gameState.swapEndedByVote = endedByVote;
  match.swapTimer = null;
  broadcastMatchState(match.code);
}

function startSwapTimer(match) {
  if (match.swapTimer) clearTimeout(match.swapTimer);
  match.gameState.swapEndsAt = Date.now() + SWAP_DURATION_MS;
  match.swapTimer = setTimeout(() => finishSwapPhase(match), SWAP_DURATION_MS);
}

function leaveMatch(socket) {
  const code = socket.data.matchCode;
  if (!code) return;
  const match = matches.get(code);
  const selectedTeam = socket.data.selectedTeam;
  socket.leave(getRoomName(code));
  socket.data.matchCode = null;
  socket.data.selectedTeam = null;
  if (!match) return;

  match.sockets.delete(socket.id);
  match.earlyFinishVotes.delete(socket.id);
  match.resetVotes.delete(socket.id);
  if (selectedTeam) match.gameState.readyTeams[selectedTeam] = false;
  if (match.sockets.size === 0) {
    if (match.pickTimer) clearTimeout(match.pickTimer);
    if (match.swapTimer) clearTimeout(match.swapTimer);
    matches.delete(code);
    return;
  }
  if (match.gameState.phase === "SWAP") broadcastMatchState(code);
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
      if (match.pickTimer) clearTimeout(match.pickTimer);
      if (match.swapTimer) clearTimeout(match.swapTimer);
      match.earlyFinishVotes.clear();
      match.resetVotes.clear();
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
        socket.emit("state:update", getClientState(existing, socket.data.selectedTeam));
        socket.emit("swap:vote-status", { hasVoted: existing.earlyFinishVotes.has(socket.id) });
        socket.emit("reset:vote-status", { hasVoted: existing.resetVotes.has(socket.id) });
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
      socket.emit("match:error", { message: "해당 방은 이미 2명입니다." });
      return;
    }

    match.sockets.add(socket.id);
    socket.data.matchCode = parsed;
    socket.data.selectedTeam = null;
    socket.join(getRoomName(parsed));

    socket.emit("match:joined", { code: parsed });
    socket.emit("team:selected", { team: null });
    socket.emit("state:update", getClientState(match, socket.data.selectedTeam));
    socket.emit("swap:vote-status", { hasVoted: false });
    socket.emit("reset:vote-status", { hasVoted: false });
    broadcastMatchInfo(parsed);
  });

  socket.on("match:leave", () => {
    leaveMatch(socket);
    socket.emit("match:left");
  });

  socket.on("team:select", ({ team }) => {
    if (!socket.data.matchCode) return;
    if (!["BLUE", "RED"].includes(team)) return;
    const match = matches.get(socket.data.matchCode);
    if (!match) return;
    if (isTeamTaken(match, team, socket.id)) {
      socket.emit("match:error", { message: "이미 다른 참가자가 선택한 팀입니다." });
      return;
    }
    socket.data.selectedTeam = team;
    socket.emit("team:selected", { team });
    socket.emit("state:update", getClientState(match, team));
  });

  socket.on("match:ready", () => {
    const code = socket.data.matchCode;
    const team = socket.data.selectedTeam;
    if (!code || !team) return;
    const match = matches.get(code);
    if (!match || match.gameState.phase !== "READY") return;

    match.gameState.readyTeams[team] = !match.gameState.readyTeams[team];
    if (match.gameState.readyTeams.BLUE && match.gameState.readyTeams.RED) {
      match.gameState.phase = "DRAFT";
      startDraftTimer(match);
    }
    broadcastMatchState(code);
  });

  socket.on("swap:vote", () => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match || match.gameState.phase !== "SWAP") return;

    if (match.earlyFinishVotes.has(socket.id)) {
      match.earlyFinishVotes.delete(socket.id);
    } else {
      match.earlyFinishVotes.add(socket.id);
    }

    socket.emit("swap:vote-status", { hasVoted: match.earlyFinishVotes.has(socket.id) });
    if (match.earlyFinishVotes.size >= getEarlyFinishVotesRequired(match)) {
      finishSwapPhase(match, true);
      return;
    }
    broadcastMatchState(code);
  });

  socket.on("game:reset-vote", () => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match || !["DRAFT", "SWAP"].includes(match.gameState.phase)) return;

    if (match.resetVotes.has(socket.id)) {
      match.resetVotes.delete(socket.id);
    } else {
      match.resetVotes.add(socket.id);
    }
    socket.emit("reset:vote-status", { hasVoted: match.resetVotes.has(socket.id) });

    const resetVoteTeams = getResetVoteTeams(match);
    if (resetVoteTeams.BLUE && resetVoteTeams.RED) {
      if (match.pickTimer) clearTimeout(match.pickTimer);
      if (match.swapTimer) clearTimeout(match.swapTimer);
      match.earlyFinishVotes.clear();
      match.resetVotes.clear();
      match.gameState = createInitialState();
    }
    broadcastMatchState(code);
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

    finishDraftPick(match, champion);
  });

  socket.on("swap:move", ({ team, fromIndex, toIndex }) => {
    const code = socket.data.matchCode;
    if (!code) return;
    const match = matches.get(code);
    if (!match) return;
    const state = match.gameState;

    if (state.phase !== "SWAP") return;
    if (Date.now() >= state.swapEndsAt) {
      finishSwapPhase(match);
      return;
    }
    if (!["BLUE", "RED"].includes(team)) return;
    if (socket.data.selectedTeam !== team) return;

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

