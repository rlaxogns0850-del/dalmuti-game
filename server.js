const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const { dealCards } = require("./deck");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const TURN_TIME_LIMIT_SEC = 30;
const RECONNECT_GRACE_MS = 60000;

const RANK_TITLES = [
  "대달무티", "소달무티", "총리대신", "재판관", "기사",
  "성직자", "상인", "장인", "농부", "광부", "소농노", "대농노",
];

/** roomCode -> room state */
const rooms = new Map();
/** userId -> { roomCode, disconnectTimer } for reconnection bookkeeping */
const sessions = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicRoomState(room) {
  return {
    roomCode: room.roomCode,
    status: room.status,
    hostUserId: room.hostUserId,
    maxPlayers: room.maxPlayers,
    minPlayers: room.minPlayers,
    turnTimeLimitSec: TURN_TIME_LIMIT_SEC,
    roundNumber: room.roundNumber,
    players: room.seatOrder
      .map((uid) => room.players.get(uid))
      .filter(Boolean)
      .map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        avatar: p.avatar,
        seatIndex: p.seatIndex,
        rank: p.rank,
        handCount: p.hand.length,
        connected: p.connected,
        isReady: p.isReady,
      })),
    currentTrick: room.currentTrick
      ? {
          fieldCards: room.currentTrick.fieldCards,
          currentTurnUserId: room.currentTrick.turnOrder[room.currentTrick.currentTurnIndex] || null,
          turnDeadline: room.currentTrick.turnDeadline,
          passedPlayers: Array.from(room.currentTrick.passedPlayers),
        }
      : null,
    taxExchange: room.taxExchange,
  };
}

function broadcastRoom(room) {
  io.to(room.roomCode).emit("room:state", publicRoomState(room));
}

function getSocketForUser(room, userId) {
  const p = room.players.get(userId);
  if (!p) return null;
  return io.sockets.sockets.get(p.socketId) || null;
}

function sendHandToPlayer(room, userId) {
  const sock = getSocketForUser(room, userId);
  const p = room.players.get(userId);
  if (sock && p) sock.emit("game:hand", { hand: p.hand });
}

function nextConnectedIndex(turnOrder, fromIndex, players) {
  const n = turnOrder.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    const uid = turnOrder[idx];
    const p = players.get(uid);
    if (p && p.hand.length > 0) return idx;
  }
  return -1;
}

function clearTurnTimer(room) {
  if (room.currentTrick?.timer) {
    clearTimeout(room.currentTrick.timer);
    room.currentTrick.timer = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.currentTrick.turnDeadline = new Date(Date.now() + TURN_TIME_LIMIT_SEC * 1000).toISOString();
  room.currentTrick.timer = setTimeout(() => handlePass(room, currentTurnUserId(room), true), TURN_TIME_LIMIT_SEC * 1000);
}

function currentTurnUserId(room) {
  const t = room.currentTrick;
  if (!t) return null;
  return t.turnOrder[t.currentTurnIndex];
}

function advanceTurn(room) {
  const t = room.currentTrick;
  const idx = nextConnectedIndex(t.turnOrder, t.currentTurnIndex, room.players);
  if (idx === -1) return; // shouldn't happen mid-trick
  t.currentTurnIndex = idx;
  startTurnTimer(room);
}

function startNewTrick(room, startUserId) {
  const order = room.seatOrder.filter((uid) => room.players.get(uid)?.hand.length > 0);
  const startIdx = order.indexOf(startUserId) >= 0 ? order.indexOf(startUserId) : 0;
  room.currentTrick = {
    fieldCards: [],
    lastPlayedBy: null,
    passedPlayers: new Set(),
    turnOrder: order,
    currentTurnIndex: startIdx,
    turnDeadline: null,
    timer: null,
  };
  startTurnTimer(room);
}

function endRound(room) {
  clearTurnTimer(room);
  // finishOrder already holds players in order they emptied their hand;
  // append any remaining player (last place) just in case
  room.seatOrder.forEach((uid) => {
    if (!room.finishOrder.includes(uid)) room.finishOrder.push(uid);
  });

  room.finishOrder.forEach((uid, i) => {
    const p = room.players.get(uid);
    if (!p) return;
    const level = i + 1;
    p.rank = {
      title: RANK_TITLES[Math.min(level, 12) - 1],
      level,
      isKing: level === 1,
      isPeon: level === room.finishOrder.length,
    };
  });

  // 시계방향 자리 재배치: 신분 순서대로 seatOrder 갱신
  room.seatOrder = [...room.finishOrder];
  room.seatOrder.forEach((uid, i) => {
    const p = room.players.get(uid);
    if (p) p.seatIndex = i;
  });

  room.status = "roundEnd";
  io.to(room.roomCode).emit("round:ended", { finishOrder: room.finishOrder });
  broadcastRoom(room);

  setTimeout(() => startNewRound(room), 4000);
}

function startNewRound(room) {
  room.roundNumber += 1;
  room.finishOrder = [];

  const playerIds = room.seatOrder;
  const { hands } = dealCards(playerIds.length);
  playerIds.forEach((uid, i) => {
    const p = room.players.get(uid);
    if (p) p.hand = hands[i];
  });
  playerIds.forEach((uid) => sendHandToPlayer(room, uid));

  if (room.roundNumber === 1) {
    // 1라운드는 무작위 신분
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
    shuffled.forEach((uid, i) => {
      const p = room.players.get(uid);
      const level = i + 1;
      p.rank = {
        title: RANK_TITLES[Math.min(level, 12) - 1],
        level,
        isKing: level === 1,
        isPeon: level === shuffled.length,
      };
    });
    room.status = "playing";
    broadcastRoom(room);
    startNewTrick(room, room.seatOrder[0]);
    broadcastRoom(room);
    return;
  }

  // 세금 징수 단계 (왕 <-> 노예)
  const kingId = room.seatOrder[0];
  const peonId = room.seatOrder[room.seatOrder.length - 1];
  room.taxExchange = { phase: "pending", kingId, peonId };
  room.status = "tax";
  broadcastRoom(room);
  io.to(room.roomCode).emit("tax:phaseStart", { kingId, peonId });
}

function finalizeTaxAndStartRound(room) {
  room.taxExchange.phase = "completed";
  room.status = "playing";
  broadcastRoom(room);
  startNewTrick(room, room.taxExchange.kingId);
  broadcastRoom(room);
}

function handlePlayCards(room, userId, cardIds) {
  if (room.status !== "playing") return;
  if (currentTurnUserId(room) !== userId) return;
  const p = room.players.get(userId);
  if (!p) return;

  const cards = p.hand.filter((c) => cardIds.includes(c.id));
  if (cards.length !== cardIds.length || cards.length === 0) return;

  const nonJokers = cards.filter((c) => !c.isJoker);
  const baseRank = nonJokers.length > 0 ? nonJokers[0].rank : 13;
  const sameRank = nonJokers.every((c) => c.rank === baseRank);
  if (!sameRank) return;

  const field = room.currentTrick.fieldCards;
  const fieldCount = field.length > 0 ? field[field.length - 1].count : null;
  const fieldRank = field.length > 0 ? field[field.length - 1].rank : null;

  if (fieldCount !== null) {
    if (cards.length !== fieldCount) return; // 장수는 동일해야 함
    if (baseRank >= fieldRank) return; // 숫자가 더 작아야(강해야) 함 (조커=같은 랭크 취급)
  }

  // 카드 제거
  p.hand = p.hand.filter((c) => !cardIds.includes(c.id));
  room.currentTrick.fieldCards.push({ rank: baseRank, count: cards.length, ownerUserId: userId });
  room.currentTrick.lastPlayedBy = userId;
  room.currentTrick.passedPlayers.clear();

  sendHandToPlayer(room, userId);
  io.to(room.roomCode).emit("turn:cardsPlayed", {
    userId, rank: baseRank, count: cards.length, remainingHandCount: p.hand.length,
  });

  if (p.hand.length === 0) {
    room.finishOrder.push(userId);
    io.to(room.roomCode).emit("player:finished", { userId, place: room.finishOrder.length });

    const remaining = room.seatOrder.filter((uid) => room.players.get(uid)?.hand.length > 0);
    if (remaining.length <= 1) {
      if (remaining.length === 1) room.finishOrder.push(remaining[0]);
      endRound(room);
      return;
    }
  }

  // 다음 턴으로 트릭 계속 진행 (필드가 비워질 때까지)
  room.currentTrick.turnOrder = room.seatOrder.filter((uid) => room.players.get(uid)?.hand.length > 0);
  const curIdx = room.currentTrick.turnOrder.indexOf(userId);
  room.currentTrick.currentTurnIndex = curIdx >= 0 ? curIdx : 0;
  advanceTurn(room);
  broadcastRoom(room);
}

function handlePass(room, userId, isTimeout = false) {
  if (room.status !== "playing") return;
  if (currentTurnUserId(room) !== userId) return;

  room.currentTrick.passedPlayers.add(userId);
  io.to(room.roomCode).emit("turn:passed", { userId, isTimeout });

  const activePlayers = room.currentTrick.turnOrder;
  const stillIn = activePlayers.filter((uid) => !room.currentTrick.passedPlayers.has(uid));

  if (stillIn.length <= 1) {
    const winner = room.currentTrick.lastPlayedBy || stillIn[0] || activePlayers[0];
    io.to(room.roomCode).emit("trick:allPassed", { winnerUserId: winner });
    if (room.players.get(winner)?.hand.length === 0) {
      // 마지막으로 카드 낸 사람이 이미 끝낸 경우, 다음 생존자가 시작
      const fallback = stillIn.find((uid) => room.players.get(uid)?.hand.length > 0) ||
        room.seatOrder.find((uid) => room.players.get(uid)?.hand.length > 0);
      if (fallback) startNewTrick(room, fallback);
    } else {
      startNewTrick(room, winner);
    }
    broadcastRoom(room);
    return;
  }

  advanceTurn(room);
  broadcastRoom(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ nickname, avatar, userId }, cb) => {
    const uid = userId || uuidv4();
    const roomCode = makeRoomCode();
    const room = {
      roomCode,
      hostUserId: uid,
      status: "waiting",
      maxPlayers: 8,
      minPlayers: 4,
      roundNumber: 0,
      players: new Map(),
      seatOrder: [],
      finishOrder: [],
      currentTrick: null,
      taxExchange: null,
    };
    rooms.set(roomCode, room);
    joinRoomInternal(room, socket, uid, nickname, avatar);
    cb?.({ ok: true, roomCode, userId: uid });
  });

  socket.on("room:join", ({ roomCode, nickname, avatar, userId }, cb) => {
    const room = rooms.get((roomCode || "").toUpperCase());
    if (!room) return cb?.({ ok: false, code: "ROOM_NOT_FOUND" });

    const uid = userId || uuidv4();
    const existing = room.players.get(uid);
    if (!existing && room.players.size >= room.maxPlayers) {
      return cb?.({ ok: false, code: "ROOM_FULL" });
    }
    joinRoomInternal(room, socket, uid, nickname, avatar);
    cb?.({ ok: true, roomCode: room.roomCode, userId: uid });
  });

  function joinRoomInternal(room, socket, uid, nickname, avatar) {
    socket.join(room.roomCode);
    socket.data.userId = uid;
    socket.data.roomCode = room.roomCode;

    const existingSession = sessions.get(uid);
    if (existingSession?.disconnectTimer) {
      clearTimeout(existingSession.disconnectTimer);
    }

    let player = room.players.get(uid);
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      if (nickname) player.nickname = nickname;
      if (avatar) player.avatar = avatar;
      io.to(room.roomCode).emit("player:reconnected", { userId: uid });
    } else {
      player = {
        userId: uid,
        socketId: socket.id,
        nickname: nickname || `손님${room.players.size + 1}`,
        avatar: avatar || "🦊",
        seatIndex: room.seatOrder.length,
        rank: null,
        hand: [],
        connected: true,
        isReady: false,
      };
      room.players.set(uid, player);
      room.seatOrder.push(uid);
    }
    sessions.set(uid, { roomCode: room.roomCode, disconnectTimer: null });

    if (room.status !== "waiting") sendHandToPlayer(room, uid);
    broadcastRoom(room);
  }

  socket.on("player:updateProfile", ({ nickname, avatar }) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.data.userId);
    if (!p) return;
    if (nickname) p.nickname = nickname;
    if (avatar) p.avatar = avatar;
    broadcastRoom(room);
  });

  socket.on("player:ready", () => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.data.userId);
    if (!p) return;
    p.isReady = !p.isReady;
    broadcastRoom(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.userId !== room.hostUserId) return;
    if (room.players.size < room.minPlayers || room.players.size > room.maxPlayers) return;
    room.status = "playing";
    startNewRound(room);
  });

  socket.on("tax:peonSubmit", ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "tax") return;
    const peon = room.players.get(room.taxExchange.peonId);
    if (!peon || socket.data.userId !== peon.userId) return;
    const card = peon.hand.find((c) => c.id === cardId);
    if (!card) return;
    room.taxExchange.peonCard = card;
    checkTaxComplete(room);
  });

  socket.on("tax:kingSubmit", ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "tax") return;
    const king = room.players.get(room.taxExchange.kingId);
    if (!king || socket.data.userId !== king.userId) return;
    const card = king.hand.find((c) => c.id === cardId);
    if (!card) return;
    room.taxExchange.kingCard = card;
    checkTaxComplete(room);
  });

  function checkTaxComplete(room) {
    const { kingId, peonId, kingCard, peonCard } = room.taxExchange;
    if (!kingCard || !peonCard) return;
    const king = room.players.get(kingId);
    const peon = room.players.get(peonId);
    king.hand = king.hand.filter((c) => c.id !== kingCard.id).concat(peonCard);
    peon.hand = peon.hand.filter((c) => c.id !== peonCard.id).concat(kingCard);
    [king, peon].forEach((p) =>
      p.hand.sort((a, b) => (a.isJoker ? 1 : 0) - (b.isJoker ? 1 : 0) || a.rank - b.rank)
    );
    sendHandToPlayer(room, kingId);
    sendHandToPlayer(room, peonId);
    io.to(room.roomCode).emit("tax:completed", { kingId, peonId });
    finalizeTaxAndStartRound(room);
  }

  socket.on("tax:declareRevolution", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "tax") return;
    const p = room.players.get(socket.data.userId);
    const jokerCount = p?.hand.filter((c) => c.isJoker).length || 0;
    if (jokerCount < 2) return;
    room.taxExchange.phase = "skipped_by_revolution";
    io.to(room.roomCode).emit("tax:skippedByRevolution", { userId: p.userId });
    room.status = "playing";
    broadcastRoom(room);
    startNewTrick(room, p.userId);
    broadcastRoom(room);
  });

  socket.on("turn:playCards", ({ cardIds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handlePlayCards(room, socket.data.userId, cardIds || []);
  });

  socket.on("turn:pass", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handlePass(room, socket.data.userId, false);
  });

  // 방 나가기 (일반 플레이어)
  socket.on("room:leave", () => {
    const room = rooms.get(socket.data.roomCode);
    const uid = socket.data.userId;
    if (!room || !uid) return;

    clearTurnTimer(room);
    room.players.delete(uid);
    room.seatOrder = room.seatOrder.filter((id) => id !== uid);
    sessions.delete(uid);
    socket.leave(room.roomCode);
    socket.data.roomCode = null;

    // 방이 비었으면 삭제
    if (room.players.size === 0) {
      rooms.delete(room.roomCode);
      return;
    }

    // 호스트가 나간 경우 다음 사람에게 호스트 이전
    if (room.hostUserId === uid) {
      room.hostUserId = room.seatOrder[0];
      const newHost = room.players.get(room.hostUserId);
      io.to(room.roomCode).emit("room:hostChanged", { newHostUserId: room.hostUserId, nickname: newHost?.nickname });
    }

    // 게임 중이었으면 대기실로 리셋
    if (room.status !== "waiting") {
      room.status = "waiting";
      room.currentTrick = null;
      room.taxExchange = null;
      room.finishOrder = [];
      room.roundNumber = 0;
      room.players.forEach((p) => { p.hand = []; p.isReady = false; p.rank = null; });
      io.to(room.roomCode).emit("room:resetToLobby", { reason: `${room.players.get(uid)?.nickname || "플레이어"}님이 나갔습니다. 대기실로 돌아갑니다.` });
    }

    io.to(room.roomCode).emit("player:left", { userId: uid });
    broadcastRoom(room);
  });

  // 방 강제 종료 (호스트 전용)
  socket.on("room:close", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.userId !== room.hostUserId) return;

    clearTurnTimer(room);
    io.to(room.roomCode).emit("room:closed", { reason: "방장이 방을 닫았습니다." });

    // 모든 소켓을 방에서 강제 퇴장
    room.players.forEach((p) => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.leave(room.roomCode); s.data.roomCode = null; }
      sessions.delete(p.userId);
    });
    rooms.delete(room.roomCode);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const uid = socket.data.userId;
    if (!room || !uid) return;
    const p = room.players.get(uid);
    if (!p) return;
    p.connected = false;
    io.to(room.roomCode).emit("player:disconnected", { userId: uid, gracePeriodSec: RECONNECT_GRACE_MS / 1000 });
    broadcastRoom(room);

    const session = sessions.get(uid) || {};
    session.disconnectTimer = setTimeout(() => {
      const stillThere = room.players.get(uid);
      if (stillThere && !stillThere.connected) {
        room.players.delete(uid);
        room.seatOrder = room.seatOrder.filter((id) => id !== uid);
        sessions.delete(uid);
        broadcastRoom(room);
        if (room.players.size === 0) {
          clearTurnTimer(room);
          rooms.delete(room.roomCode);
        }
      }
    }, RECONNECT_GRACE_MS);
    sessions.set(uid, session);
  });
});

server.listen(PORT, () => console.log(`달무티 서버 실행 중: http://localhost:${PORT}`));
