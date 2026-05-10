import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 4000;
const LOCAL_FRONTEND_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEPLOYED_FRONTEND_ORIGINS = String(process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);
const ALLOWED_ORIGINS = [...DEPLOYED_FRONTEND_ORIGINS, ...LOCAL_FRONTEND_ORIGINS];
const REGULAR_MAX_BALLS = 30;
const SUPER_OVER_MAX_BALLS = 6;
const WICKET_LIMIT = 1;
const ROOM_CODE_LENGTH = 4;
const REVEAL_DURATION_MS = 1400;
const TEAM_ROOM_MAX_PLAYERS = 24;
const TEAM_SIDE_MAX_PLAYERS = 12;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      const normalizedOrigin = normalizeOrigin(origin);
      if (!normalizedOrigin || ALLOWED_ORIGINS.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CPL Socket.IO CORS.`));
    },
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();
const socketToRoom = new Map();
const teamRooms = new Map();
const socketToTeamRoom = new Map();

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);

    const player = createPlayer(socket.id, name);
    const code = createRoomCode();
    const room = {
      code,
      players: [player],
      phase: "waiting",
      toss: null,
      inningsIndex: 0,
      innings: [],
      current: null,
      target: null,
      pendingChoices: {},
      lastBall: null,
      isRevealing: false,
      message: "Waiting for another player.",
      winnerId: null,
      superOver: false,
    };

    rooms.set(code, room);
    socketToRoom.set(socket.id, code);
    socket.join(code);
    socket.emit("player:ready", { playerId: player.id });
    publish(room);
  });

  socket.on("room:join", ({ name, code }) => {
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);

    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) {
      socket.emit("room:error", { message: "Room not found." });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit("room:error", { message: "Room is already full." });
      return;
    }

    const player = createPlayer(socket.id, name);
    room.players.push(player);
    socketToRoom.set(socket.id, room.code);
    socket.join(room.code);
    socket.emit("player:ready", { playerId: player.id });
    startToss(room);
    publish(room);
  });

  socket.on("room:leave", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("team:joinPublic", ({ name }) => {
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);

    let room = Array.from(teamRooms.values()).find((candidate) => candidate.visibility === "public" && candidate.players.length < TEAM_ROOM_MAX_PLAYERS && candidate.phase !== "ready");
    if (!room) {
      room = createTeamRoom("public");
      teamRooms.set(room.code, room);
    }

    addPlayerToTeamRoom(socket, room, name);
  });

  socket.on("team:createPrivate", ({ name }) => {
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);

    const room = createTeamRoom("private");
    teamRooms.set(room.code, room);
    addPlayerToTeamRoom(socket, room, name);
  });

  socket.on("team:joinPrivate", ({ name, code }) => {
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);

    const room = teamRooms.get(String(code || "").toUpperCase());
    if (!room || room.visibility !== "private") {
      socket.emit("team:error", { message: "Private room not found." });
      return;
    }
    if (room.players.length >= TEAM_ROOM_MAX_PLAYERS) {
      socket.emit("team:error", { message: "This team room is full." });
      return;
    }

    addPlayerToTeamRoom(socket, room, name);
  });

  socket.on("team:leave", () => {
    leaveCurrentTeamRoom(socket);
  });

  socket.on("team:order", ({ teamId, orderType, playerIds }) => {
    const room = getSocketTeamRoom(socket);
    if (!room) return;
    if (!isValidTeamSide(teamId) || !room.teams[teamId]) {
      socket.emit("team:error", { message: "Invalid team side." });
      return;
    }
    if (room.captains[teamId] !== socket.id) {
      socket.emit("team:error", { message: "Only this side's captain can edit the order." });
      return;
    }
    if (orderType !== "order") {
      socket.emit("team:error", { message: "Invalid order type." });
      return;
    }

    const team = room.teams[teamId];
    const validIds = new Set(team.players);
    const sanitized = Array.isArray(playerIds) ? playerIds.filter((id) => validIds.has(id)) : [];
    if (sanitized.length !== team.players.length) {
      socket.emit("team:error", { message: "Order must include every player on that side." });
      return;
    }

    team.order = sanitized;
    room.ready[teamId] = false;
    room.message = `${playerName(room, socket.id)} updated ${team.name}.`;
    updateTeamRoomPhase(room);
    publishTeamRoom(room);
  });

  socket.on("team:chooseSide", ({ side }) => {
    const room = getSocketTeamRoom(socket);
    if (!room) return;
    if (!isValidTeamSide(side)) {
      socket.emit("team:error", { message: "Choose Batting Team or Bowling Team." });
      return;
    }
    if (!room.players.some((player) => player.id === socket.id)) {
      socket.emit("team:error", { message: "You are not in this room." });
      return;
    }

    const targetTeam = room.teams[side];
    if (!targetTeam || targetTeam.players.length >= TEAM_SIDE_MAX_PLAYERS) {
      socket.emit("team:error", { message: `${targetTeam?.name ?? "That team"} is full.` });
      return;
    }

    removePlayerFromTeamSetup(room, socket.id);
    targetTeam.players.push(socket.id);
    targetTeam.order = mergeOrder(targetTeam.order, targetTeam.players);
    room.ready[side] = false;
    room.message = `${playerName(room, socket.id)} joined ${targetTeam.name}.`;
    updateTeamRoomPhase(room);
    publishTeamRoom(room);
  });

  socket.on("team:selectCaptain", ({ side, playerId }) => {
    const room = getSocketTeamRoom(socket);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit("team:error", { message: "Only the host can select captains." });
      return;
    }
    if (!isValidTeamSide(side)) {
      socket.emit("team:error", { message: "Invalid team side." });
      return;
    }
    if (!room.teams[side].players.includes(playerId)) {
      socket.emit("team:error", { message: "Captain must be on that team." });
      return;
    }

    room.captains[side] = playerId;
    room.ready[side] = false;
    room.message = `${playerName(room, playerId)} is ${room.teams[side].name} captain.`;
    updateTeamRoomPhase(room);
    publishTeamRoom(room);
  });

  socket.on("team:setReady", ({ ready }) => {
    const room = getSocketTeamRoom(socket);
    if (!room) return;
    const side = getPlayerSide(room, socket.id);
    if (!side || room.captains[side] !== socket.id) return;

    room.ready[side] = Boolean(ready);
    room.message = `${playerName(room, socket.id)} marked ${room.teams[side].name} ${room.ready[side] ? "ready" : "not ready"}.`;
    updateTeamRoomPhase(room);
    publishTeamRoom(room);
  });

  socket.on("toss:choose", ({ decision }) => {
    const room = getSocketRoom(socket);
    if (!room || room.phase !== "toss-choice" || room.toss?.winnerId !== socket.id) return;
    if (decision !== "bat" && decision !== "bowl") return;

    const opponent = room.players.find((player) => player.id !== socket.id);
    const battingId = decision === "bat" ? socket.id : opponent.id;
    const bowlingId = decision === "bat" ? opponent.id : socket.id;
    startInnings(room, battingId, bowlingId);
    publish(room);
  });

  socket.on("ball:choice", ({ number }) => {
    const room = getSocketRoom(socket);
    if (!room || room.phase !== "playing") return;
    if (!room.players.some((player) => player.id === socket.id)) return;
    if (room.isRevealing) return;
    if (!Number.isInteger(number) || number < 1 || number > 6) return;
    if (room.pendingChoices[socket.id]) return;

    room.pendingChoices[socket.id] = number;
    const batterChoice = room.pendingChoices[room.current.battingId];
    const bowlerChoice = room.pendingChoices[room.current.bowlingId];

    if (batterChoice && bowlerChoice) {
      resolveBall(room, batterChoice, bowlerChoice);
    } else {
      room.message = `${playerName(room, socket.id)} locked their choice.`;
    }

    publish(room);
  });

  socket.on("disconnect", () => {
    const room = getSocketRoom(socket);
    if (room) {
      room.message = `${playerName(room, socket.id)} disconnected. Waiting for players to reconnect in a future version.`;
      publish(room);
    }
    leaveCurrentRoom(socket);
    leaveCurrentTeamRoom(socket);
  });
});

function createPlayer(id, name) {
  return {
    id,
    name: String(name || "Player").trim().slice(0, 20) || "Player",
  };
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createTeamRoom(visibility) {
  const code = createTeamRoomCode();
  return {
    code,
    visibility,
    phase: "joining",
    hostId: null,
    players: [],
    unassignedPlayers: [],
    captains: {},
    ready: {
      batting: false,
      bowling: false,
    },
    teams: {
      batting: createTeam("batting", "Batting Team"),
      bowling: createTeam("bowling", "Bowling Team"),
    },
    message: visibility === "public" ? "Public team room created." : "Private team room created.",
  };
}

function createTeam(id, name) {
  return {
    id,
    name,
    players: [],
    order: [],
  };
}

function createTeamRoomCode() {
  let code = "";
  do {
    code = `M${createRoomCode()}`;
  } while (teamRooms.has(code));
  return code;
}

function addPlayerToTeamRoom(socket, room, name) {
  const player = createPlayer(socket.id, name);
  room.players.push(player);
  room.unassignedPlayers.push(player.id);
  if (!room.hostId) room.hostId = player.id;
  socketToTeamRoom.set(socket.id, room.code);
  socket.join(`team:${room.code}`);
  socket.emit("team:ready", { playerId: player.id });
  room.message = `${player.name} joined the room.`;
  updateTeamRoomPhase(room);
  publishTeamRoom(room);
}

function removePlayerFromTeamSetup(room, playerId) {
  room.unassignedPlayers = room.unassignedPlayers.filter((id) => id !== playerId);
  for (const [side, team] of Object.entries(room.teams)) {
    team.players = team.players.filter((id) => id !== playerId);
    team.order = team.order.filter((id) => id !== playerId);
    if (room.captains[side] === playerId) {
      delete room.captains[side];
      room.ready[side] = false;
    }
  }
  updateTeamRoomPhase(room);
}

function mergeOrder(currentOrder, teamPlayers) {
  const teamSet = new Set(teamPlayers);
  const kept = currentOrder.filter((id) => teamSet.has(id));
  const added = teamPlayers.filter((id) => !kept.includes(id));
  return [...kept, ...added];
}

function isValidTeamSide(side) {
  return side === "batting" || side === "bowling";
}

function updateTeamRoomPhase(room) {
  const battingCount = room.teams.batting.players.length;
  const bowlingCount = room.teams.bowling.players.length;
  const bothSidesHavePlayers = battingCount > 0 && bowlingCount > 0;
  const bothCaptainsSelected = Boolean(room.captains.batting && room.captains.bowling);
  const bothCaptainsReady = Boolean(room.ready.batting && room.ready.bowling);

  if (bothCaptainsReady) {
    room.phase = "ready";
  } else if (bothCaptainsSelected) {
    room.phase = "order-selection";
  } else if (bothSidesHavePlayers) {
    room.phase = "captain-selection";
  } else if (room.players.length > 0) {
    room.phase = "team-selection";
  } else {
    room.phase = "joining";
  }
}

function startToss(room) {
  const winner = room.players[Math.floor(Math.random() * room.players.length)];
  room.phase = "toss-choice";
  room.toss = { winnerId: winner.id };
  room.message = `${winner.name} won the toss.`;
}

function startInnings(room, battingId, bowlingId) {
  const innings = {
    battingId,
    bowlingId,
    runs: 0,
    wickets: 0,
    balls: 0,
    events: [],
  };

  room.innings.push(innings);
  room.current = innings;
  room.phase = "playing";
  room.pendingChoices = {};
  room.lastBall = null;
  room.isRevealing = false;
  room.message = `${playerName(room, battingId)} is batting.`;
}

function resolveBall(room, batterChoice, bowlerChoice) {
  const current = room.current;
  const isOut = batterChoice === bowlerChoice;
  current.balls += 1;

  if (isOut) {
    current.wickets += 1;
  } else {
    current.runs += batterChoice;
  }

  room.lastBall = {
    batterChoice,
    bowlerChoice,
    isOut,
    runs: isOut ? 0 : batterChoice,
  };
  current.events.push(room.lastBall);
  room.pendingChoices = {};
  room.isRevealing = true;

  if (isOut) {
    room.message = `Out! Both players chose ${batterChoice}.`;
  } else {
    room.message = `${batterChoice} run${batterChoice === 1 ? "" : "s"} scored.`;
  }

  if (isChaseComplete(room)) {
    finishMatch(room, current.battingId);
    return;
  }

  if (isInningsOver(current, room)) {
    completeInnings(room);
    return;
  }

  scheduleNextBall(room);
}

function isInningsOver(innings, room) {
  const maxBalls = room.superOver ? SUPER_OVER_MAX_BALLS : REGULAR_MAX_BALLS;
  return innings.balls >= maxBalls || innings.wickets >= WICKET_LIMIT;
}

function isChaseComplete(room) {
  return room.target && room.current.runs >= room.target;
}

function completeInnings(room) {
  const firstInnings = room.innings[0];

  if (room.innings.length === 1) {
    room.target = firstInnings.runs + 1;
    room.phase = "innings-break";
    room.message = `${playerName(room, firstInnings.battingId)} made ${firstInnings.runs}. Target is ${room.target}.`;

    setTimeout(() => {
      const nextBattingId = firstInnings.bowlingId;
      const nextBowlingId = firstInnings.battingId;
      startInnings(room, nextBattingId, nextBowlingId);
      publish(room);
    }, 2500);
    return;
  }

  const secondInnings = room.innings[1];
  if (secondInnings.runs === firstInnings.runs && !room.superOver) {
    startSuperOver(room);
    return;
  }

  if (secondInnings.runs === firstInnings.runs && room.superOver) {
    finishMatch(room, null);
    return;
  }

  const winnerId = secondInnings.runs > firstInnings.runs ? secondInnings.battingId : firstInnings.battingId;
  finishMatch(room, winnerId);
}

function startSuperOver(room) {
  room.superOver = true;
  room.inningsIndex = 0;
  room.innings = [];
  room.target = null;
  room.phase = "innings-break";
  room.message = "Scores are tied. Super Over starts now.";
  const firstBattingId = room.current.bowlingId;
  const firstBowlingId = room.current.battingId;

  setTimeout(() => {
    startInnings(room, firstBattingId, firstBowlingId);
    publish(room);
  }, 2500);
}

function finishMatch(room, winnerId) {
  room.phase = "finished";
  room.winnerId = winnerId;
  room.pendingChoices = {};
  room.isRevealing = false;
  room.message = winnerId ? `${playerName(room, winnerId)} wins the match.` : "Match tied.";
}

function scheduleNextBall(room) {
  setTimeout(() => {
    if (room.phase !== "playing") return;
    room.lastBall = null;
    room.isRevealing = false;
    room.message = `${playerName(room, room.current.battingId)} is batting. Pick your number.`;
    publish(room);
  }, REVEAL_DURATION_MS);
}

function publish(room) {
  io.to(room.code).emit("room:update", serializeRoom(room));
}

function publishTeamRoom(room) {
  io.to(`team:${room.code}`).emit("team:update", serializeTeamRoom(room));
}

function serializeRoom(room) {
  return {
    code: room.code,
    players: room.players,
    phase: room.phase,
    toss: room.toss,
    inningsIndex: Math.max(0, room.innings.length - 1),
    current: room.current ? withoutEvents(room.current) : null,
    inningsSummary: room.innings.map(summarizeInnings),
    target: room.target,
    pendingChoices: Object.fromEntries(Object.keys(room.pendingChoices).map((id) => [id, true])),
    lastBall: room.lastBall,
    isRevealing: room.isRevealing,
    message: room.message,
    winnerId: room.winnerId,
    superOver: room.superOver,
  };
}

function serializeTeamRoom(room) {
  return {
    code: room.code,
    visibility: room.visibility,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players,
    unassignedPlayers: room.unassignedPlayers,
    captains: room.captains,
    ready: room.ready,
    teams: room.teams,
    message: room.message,
    maxPlayers: TEAM_ROOM_MAX_PLAYERS,
    maxPlayersPerSide: TEAM_SIDE_MAX_PLAYERS,
    minPlayers: 2,
  };
}

function withoutEvents(innings) {
  return {
    battingId: innings.battingId,
    bowlingId: innings.bowlingId,
    runs: innings.runs,
    wickets: innings.wickets,
    balls: innings.balls,
    recentEvents: innings.events.slice(-8),
  };
}

function summarizeInnings(innings) {
  return {
    battingId: innings.battingId,
    runs: innings.runs,
    wickets: innings.wickets,
    balls: innings.balls,
  };
}

function getSocketRoom(socket) {
  const code = socketToRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function leaveCurrentRoom(socket) {
  const code = socketToRoom.get(socket.id);
  if (!code) return;

  const room = rooms.get(code);
  if (room) {
    room.players = room.players.filter((player) => player.id !== socket.id);
    delete room.pendingChoices[socket.id];
    socket.leave(code);

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      room.phase = "waiting";
      room.toss = null;
      room.current = null;
      room.innings = [];
      room.target = null;
      room.lastBall = null;
      room.isRevealing = false;
      room.winnerId = null;
      room.message = "Opponent left. Waiting for another player.";
      publish(room);
    }
  }

  socketToRoom.delete(socket.id);
}

function getSocketTeamRoom(socket) {
  const code = socketToTeamRoom.get(socket.id);
  return code ? teamRooms.get(code) : null;
}

function leaveCurrentTeamRoom(socket) {
  const code = socketToTeamRoom.get(socket.id);
  if (!code) return;

  const room = teamRooms.get(code);
  if (room) {
    room.players = room.players.filter((player) => player.id !== socket.id);
    socket.leave(`team:${code}`);

    if (room.players.length === 0) {
      teamRooms.delete(code);
    } else {
      removePlayerFromTeamSetup(room, socket.id);
      if (room.hostId === socket.id) {
        room.hostId = room.players[0]?.id ?? null;
      }
      room.message = `${playerName(room, socket.id)} left the team room.`;
      updateTeamRoomPhase(room);
      publishTeamRoom(room);
    }
  }

  socketToTeamRoom.delete(socket.id);
}

function playerName(room, id) {
  return room.players.find((player) => player.id === id)?.name ?? "Player";
}

function getPlayerSide(room, playerId) {
  if (room.teams.batting.players.includes(playerId)) return "batting";
  if (room.teams.bowling.players.includes(playerId)) return "bowling";
  return null;
}

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CPL Socket.IO server running on port ${PORT}`);
});
