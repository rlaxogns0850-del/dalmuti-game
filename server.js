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
const BOT_THINK_MS = 1500; // 봇이 생각하는 척하는 딜레이

const RANK_TITLES = [
  "대달무티", "소달무티", "총리대신", "재판관", "기사",
  "성직자", "상인", "장인", "농부", "광부", "소농노", "대농노",
];

const BOT_NAMES   = ["루피봇", "조로봇", "나미봇", "상디봇", "쵸파봇", "로빈봇", "프랑키봇", "브룩봇"];
const BOT_AVATARS = ["🤖", "👾", "🎮", "🃏", "♟️", "🎲", "🦾", "🧠"];

const rooms   = new Map(); // roomCode -> room
const sessions = new Map(); // userId  -> { roomCode, disconnectTimer }

/* ====================================================
   유틸
   ==================================================== */
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
    roomCode:       room.roomCode,
    status:         room.status,
    hostUserId:     room.hostUserId,
    maxPlayers:     room.maxPlayers,
    minPlayers:     room.minPlayers,
    turnTimeLimitSec: TURN_TIME_LIMIT_SEC,
    roundNumber:    room.roundNumber,
    players: room.seatOrder
      .map((uid) => room.players.get(uid))
      .filter(Boolean)
      .map((p) => ({
        userId:    p.userId,
        nickname:  p.nickname,
        avatar:    p.avatar,
        isBot:     p.isBot || false,
        seatIndex: p.seatIndex,
        rank:      p.rank,
        handCount: p.hand.length,
        connected: p.connected,
        isReady:   p.isReady,
      })),
    currentTrick: room.currentTrick ? {
      fieldCards:        room.currentTrick.fieldCards,
      currentTurnUserId: room.currentTrick.turnOrder[room.currentTrick.currentTurnIndex] || null,
      turnDeadline:      room.currentTrick.turnDeadline,
      passedPlayers:     Array.from(room.currentTrick.passedPlayers),
    } : null,
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
  const p    = room.players.get(userId);
  if (sock && p) sock.emit("game:hand", { hand: p.hand });
}

function currentTurnUserId(room) {
  const t = room.currentTrick;
  if (!t) return null;
  return t.turnOrder[t.currentTurnIndex];
}

/* ====================================================
   타이머 — 핵심 버그 수정:
   setTimeout 콜백 시점에 uid를 새로 읽지 않고
   타이머 시작 시점의 uid를 클로저로 캡처
   ==================================================== */
function clearTurnTimer(room) {
  if (room.currentTrick?.timer) {
    clearTimeout(room.currentTrick.timer);
    room.currentTrick.timer = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const expectedUserId = currentTurnUserId(room); // ← 지금 이 순간의 uid 캡처
  room.currentTrick.turnDeadline = new Date(Date.now() + TURN_TIME_LIMIT_SEC * 1000).toISOString();
  room.currentTrick.timer = setTimeout(() => {
    // 타이머가 만료될 때 여전히 같은 사람 차례인지 재확인
    if (currentTurnUserId(room) === expectedUserId) {
      handlePass(room, expectedUserId, true);
    }
  }, TURN_TIME_LIMIT_SEC * 1000);
}

/* ====================================================
   트릭 진행
   ==================================================== */
function nextConnectedIndex(turnOrder, fromIndex, players) {
  const n = turnOrder.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    const uid = turnOrder[idx];
    const p   = players.get(uid);
    if (p && p.hand.length > 0) return idx;
  }
  return -1;
}

function advanceTurn(room) {
  const t   = room.currentTrick;
  const idx = nextConnectedIndex(t.turnOrder, t.currentTurnIndex, room.players);
  if (idx === -1) return;
  t.currentTurnIndex = idx;
  startTurnTimer(room);
  // 봇 차례면 자동 행동 스케줄
  scheduleBotActionIfNeeded(room);
}

function startNewTrick(room, startUserId) {
  clearTurnTimer(room);
  const order    = room.seatOrder.filter((uid) => room.players.get(uid)?.hand.length > 0);
  const startIdx = order.indexOf(startUserId) >= 0 ? order.indexOf(startUserId) : 0;
  room.currentTrick = {
    fieldCards:       [],
    lastPlayedBy:     null,
    passedPlayers:    new Set(),
    turnOrder:        order,
    currentTurnIndex: startIdx,
    turnDeadline:     null,
    timer:            null,
  };
  startTurnTimer(room);
  scheduleBotActionIfNeeded(room);
}

/* ====================================================
   카드 내기 / 패스
   ==================================================== */
function handlePlayCards(room, userId, cardIds) {
  if (room.status !== "playing") return;
  if (currentTurnUserId(room) !== userId) return;
  const p = room.players.get(userId);
  if (!p) return;

  const cards     = p.hand.filter((c) => cardIds.includes(c.id));
  if (cards.length !== cardIds.length || cards.length === 0) return;

  const nonJokers = cards.filter((c) => !c.isJoker);
  const baseRank  = nonJokers.length > 0 ? nonJokers[0].rank : 13;
  if (!nonJokers.every((c) => c.rank === baseRank)) return;

  const field      = room.currentTrick.fieldCards;
  const fieldCount = field.length > 0 ? field[field.length - 1].count : null;
  const fieldRank  = field.length > 0 ? field[field.length - 1].rank  : null;

  if (fieldCount !== null) {
    if (cards.length !== fieldCount) return;
    if (baseRank >= fieldRank) return;
  }

  clearTurnTimer(room);

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

  room.currentTrick.turnOrder = room.seatOrder.filter((uid) => room.players.get(uid)?.hand.length > 0);
  const curIdx = room.currentTrick.turnOrder.indexOf(userId);
  room.currentTrick.currentTurnIndex = curIdx >= 0 ? curIdx : 0;
  advanceTurn(room);
  broadcastRoom(room);
}

function handlePass(room, userId, isTimeout = false) {
  if (room.status !== "playing") return;
  if (currentTurnUserId(room) !== userId) return;

  clearTurnTimer(room);
  room.currentTrick.passedPlayers.add(userId);
  io.to(room.roomCode).emit("turn:passed", { userId, isTimeout });

  const activePlayers = room.currentTrick.turnOrder;
  const stillIn       = activePlayers.filter(
    (uid) => !room.currentTrick.passedPlayers.has(uid) && room.players.get(uid)?.hand.length > 0
  );

  if (stillIn.length === 0) {
    const winner   = room.currentTrick.lastPlayedBy
      || activePlayers.find((uid) => room.players.get(uid)?.hand.length > 0)
      || activePlayers[0];
    io.to(room.roomCode).emit("trick:allPassed", { winnerUserId: winner });
    const fallback = room.seatOrder.find((uid) => room.players.get(uid)?.hand.length > 0 && uid !== winner) || winner;
    const next     = room.players.get(winner)?.hand.length > 0 ? winner : fallback;
    startNewTrick(room, next);
    broadcastRoom(room);
    return;
  }

  advanceTurn(room);
  broadcastRoom(room);
}

/* ====================================================
   라운드 종료 / 신분 재배정
   ==================================================== */
function endRound(room) {
  clearTurnTimer(room);
  room.seatOrder.forEach((uid) => {
    if (!room.finishOrder.includes(uid)) room.finishOrder.push(uid);
  });

  room.finishOrder.forEach((uid, i) => {
    const p = room.players.get(uid);
    if (!p) return;
    const level = i + 1;
    p.rank = {
      title:   RANK_TITLES[Math.min(level, 12) - 1],
      level,
      isKing:  level === 1,
      isPeon:  level === room.finishOrder.length,
    };
  });

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
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
    shuffled.forEach((uid, i) => {
      const p = room.players.get(uid);
      const level = i + 1;
      p.rank = {
        title:  RANK_TITLES[Math.min(level, 12) - 1],
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

  // 세금 징수 (봇 자동 처리 포함)
  const kingId = room.seatOrder[0];
  const peonId = room.seatOrder[room.seatOrder.length - 1];
  room.taxExchange = { phase: "pending", kingId, peonId };
  room.status = "tax";
  broadcastRoom(room);
  io.to(room.roomCode).emit("tax:phaseStart", { kingId, peonId });

  // 봇이 왕이거나 노예면 자동 처리
  scheduleBotTaxIfNeeded(room);
}

function finalizeTaxAndStartRound(room) {
  room.taxExchange.phase = "completed";
  room.status = "playing";
  broadcastRoom(room);
  startNewTrick(room, room.taxExchange.kingId);
  broadcastRoom(room);
}

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

/* ====================================================
   봇 AI
   ==================================================== */

/** 봇이 낼 수 있는 최적의 카드 조합을 반환 (없으면 null) */
function botChooseCards(hand, fieldCards) {
  const field      = fieldCards;
  const fieldCount = field.length > 0 ? field[field.length - 1].count : null;
  const fieldRank  = field.length > 0 ? field[field.length - 1].rank  : null;

  // 비어있으면 → 손에서 가장 약한 카드 N장 (N=1부터)
  if (fieldCount === null) {
    // 일반 카드 중 가장 많이 모인 rank부터 시도 (전략: 많이 모인 패로 바닥 깔기)
    const groups = {};
    hand.filter((c) => !c.isJoker).forEach((c) => {
      if (!groups[c.rank]) groups[c.rank] = [];
      groups[c.rank].push(c);
    });
    const sorted = Object.values(groups).sort((a, b) => b.length - a.length || a[0].rank - b[0].rank);
    if (sorted.length > 0) return sorted[0].map((c) => c.id);
    // 조커만 있으면 조커 1장
    const joker = hand.find((c) => c.isJoker);
    if (joker) return [joker.id];
    return null;
  }

  // 필드가 있으면 → 같은 장수이면서 더 강한(숫자 작은) 카드 조합 탐색
  const nonJokers = hand.filter((c) => !c.isJoker);
  const jokers    = hand.filter((c) => c.isJoker);
  const groups    = {};
  nonJokers.forEach((c) => {
    if (!groups[c.rank]) groups[c.rank] = [];
    groups[c.rank].push(c);
  });

  // 완전히 같은 장수인 그룹 중 fieldRank보다 작은 것
  const candidates = Object.values(groups)
    .filter((g) => g.length >= fieldCount && g[0].rank < fieldRank)
    .sort((a, b) => b[0].rank - a[0].rank); // 가장 약한 것부터 (조금씩 올리기)

  if (candidates.length > 0) return candidates[0].slice(0, fieldCount).map((c) => c.id);

  // 조커를 활용: 조커 N장 + 같은 rank (N-joker)장 조합
  if (jokers.length > 0) {
    for (const jCount of [1, 2].slice(0, jokers.length)) {
      const needed = fieldCount - jCount;
      if (needed < 0) continue;
      if (needed === 0) {
        // 조커만으로 내기 (필드가 비어있을 때만 의미있지만, 단독 조커는 rank 13으로 취급)
        // 조커 단독은 가장 약하므로 fieldRank < 13 이어야 통과 가능한데, rank 13은 최약이므로 패스
        continue;
      }
      const pair = Object.values(groups)
        .filter((g) => g.length >= needed && g[0].rank < fieldRank)
        .sort((a, b) => b[0].rank - a[0].rank);
      if (pair.length > 0) {
        return [
          ...jokers.slice(0, jCount).map((c) => c.id),
          ...pair[0].slice(0, needed).map((c) => c.id),
        ];
      }
    }
  }

  return null; // 낼 카드 없음 → 패스
}

function scheduleBotActionIfNeeded(room) {
  const uid = currentTurnUserId(room);
  if (!uid) return;
  const p = room.players.get(uid);
  if (!p || !p.isBot) return;

  setTimeout(() => {
    // 여전히 이 봇 차례인지 확인
    if (!room.players.has(uid)) return;
    if (currentTurnUserId(room) !== uid) return;
    if (room.status !== "playing") return;

    const cards = botChooseCards(p.hand, room.currentTrick?.fieldCards || []);
    if (cards) {
      handlePlayCards(room, uid, cards);
    } else {
      handlePass(room, uid, false);
    }
  }, BOT_THINK_MS + Math.random() * 800);
}

function scheduleBotTaxIfNeeded(room) {
  const { kingId, peonId } = room.taxExchange;
  const king = room.players.get(kingId);
  const peon = room.players.get(peonId);

  // 봇 노예: 가장 좋은 카드(rank 최소) 자동 제출
  if (peon?.isBot) {
    setTimeout(() => {
      if (room.status !== "tax") return;
      if (room.taxExchange.peonCard) return;
      const best = peon.hand
        .filter((c) => !c.isJoker)
        .sort((a, b) => a.rank - b.rank)[0]
        || peon.hand[0];
      if (!best) return;
      room.taxExchange.peonCard = best;
      checkTaxComplete(room);
    }, BOT_THINK_MS);
  }

  // 봇 왕: 가장 쓸모없는 카드(rank 최대) 자동 제출
  if (king?.isBot) {
    setTimeout(() => {
      if (room.status !== "tax") return;
      if (room.taxExchange.kingCard) return;
      const worst = king.hand
        .filter((c) => !c.isJoker)
        .sort((a, b) => b.rank - a.rank)[0]
        || king.hand[0];
      if (!worst) return;
      room.taxExchange.kingCard = worst;
      checkTaxComplete(room);
    }, BOT_THINK_MS + 200);
  }
}

/* ====================================================
   소켓 이벤트
   ==================================================== */
io.on("connection", (socket) => {

  socket.on("room:create", ({ nickname, avatar, userId }, cb) => {
    const uid      = userId || uuidv4();
    const roomCode = makeRoomCode();
    const room = {
      roomCode,
      hostUserId:  uid,
      status:      "waiting",
      maxPlayers:  8,
      minPlayers:  4,
      roundNumber: 0,
      players:     new Map(),
      seatOrder:   [],
      finishOrder: [],
      currentTrick: null,
      taxExchange:  null,
    };
    rooms.set(roomCode, room);
    joinRoomInternal(room, socket, uid, nickname, avatar, false);
    cb?.({ ok: true, roomCode, userId: uid });
  });

  socket.on("room:join", ({ roomCode, nickname, avatar, userId }, cb) => {
    const room = rooms.get((roomCode || "").toUpperCase());
    if (!room) return cb?.({ ok: false, code: "ROOM_NOT_FOUND" });

    const uid      = userId || uuidv4();
    const existing = room.players.get(uid);
    if (!existing && room.players.size >= room.maxPlayers) {
      return cb?.({ ok: false, code: "ROOM_FULL" });
    }
    joinRoomInternal(room, socket, uid, nickname, avatar, false);
    cb?.({ ok: true, roomCode: room.roomCode, userId: uid });
  });

  // 봇 추가 (호스트 전용, 대기실에서만)
  socket.on("room:addBot", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.userId !== room.hostUserId) return;
    if (room.status !== "waiting") return;
    if (room.players.size >= room.maxPlayers) return;

    const botIdx = [...room.players.values()].filter((p) => p.isBot).length;
    const botId  = `bot_${uuidv4()}`;
    const bot = {
      userId:    botId,
      socketId:  null,
      nickname:  BOT_NAMES[botIdx % BOT_NAMES.length],
      avatar:    BOT_AVATARS[botIdx % BOT_AVATARS.length],
      isBot:     true,
      seatIndex: room.seatOrder.length,
      rank:      null,
      hand:      [],
      connected: true,
      isReady:   true, // 봇은 항상 준비완료
    };
    room.players.set(botId, bot);
    room.seatOrder.push(botId);
    broadcastRoom(room);
  });

  // 봇 제거 (호스트 전용)
  socket.on("room:removeBot", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.userId !== room.hostUserId) return;
    if (room.status !== "waiting") return;

    const botId = [...room.seatOrder].reverse().find((uid) => room.players.get(uid)?.isBot);
    if (!botId) return;
    room.players.delete(botId);
    room.seatOrder = room.seatOrder.filter((id) => id !== botId);
    broadcastRoom(room);
  });

  function joinRoomInternal(room, socket, uid, nickname, avatar, isBot) {
    socket.join(room.roomCode);
    socket.data.userId   = uid;
    socket.data.roomCode = room.roomCode;

    const existingSession = sessions.get(uid);
    if (existingSession?.disconnectTimer) clearTimeout(existingSession.disconnectTimer);

    let player = room.players.get(uid);
    if (player) {
      player.socketId  = socket.id;
      player.connected = true;
      if (nickname) player.nickname = nickname;
      if (avatar)   player.avatar   = avatar;
      io.to(room.roomCode).emit("player:reconnected", { userId: uid });
    } else {
      player = {
        userId:    uid,
        socketId:  socket.id,
        nickname:  nickname || `손님${room.players.size + 1}`,
        avatar:    avatar   || "🦊",
        isBot:     false,
        seatIndex: room.seatOrder.length,
        rank:      null,
        hand:      [],
        connected: true,
        isReady:   false,
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
    const p    = room?.players.get(socket.data.userId);
    if (!p) return;
    if (nickname) p.nickname = nickname;
    if (avatar)   p.avatar   = avatar;
    broadcastRoom(room);
  });

  socket.on("player:ready", () => {
    const room = rooms.get(socket.data.roomCode);
    const p    = room?.players.get(socket.data.userId);
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

  // 혁명 선언 — 전체에게 화려한 알림 포함
  socket.on("tax:declareRevolution", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== "tax") return;
    const p = room.players.get(socket.data.userId);
    const jokerCount = p?.hand.filter((c) => c.isJoker).length || 0;
    if (jokerCount < 2) return;

    room.taxExchange.phase = "skipped_by_revolution";
    // 전체 플레이어에게 혁명 상세 정보 (닉네임 포함)
    io.to(room.roomCode).emit("tax:revolution", {
      userId:   p.userId,
      nickname: p.nickname,
      avatar:   p.avatar,
    });
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

  // 방 나가기
  socket.on("room:leave", () => {
    const room = rooms.get(socket.data.roomCode);
    const uid  = socket.data.userId;
    if (!room || !uid) return;

    clearTurnTimer(room);
    room.players.delete(uid);
    room.seatOrder = room.seatOrder.filter((id) => id !== uid);
    sessions.delete(uid);
    socket.leave(room.roomCode);
    socket.data.roomCode = null;

    if (room.players.size === 0) { rooms.delete(room.roomCode); return; }

    if (room.hostUserId === uid) {
      // 봇이 아닌 첫 번째 사람에게 호스트 이전
      const newHostId = room.seatOrder.find((id) => !room.players.get(id)?.isBot) || room.seatOrder[0];
      room.hostUserId = newHostId;
      const newHost   = room.players.get(newHostId);
      io.to(room.roomCode).emit("room:hostChanged", { newHostUserId: newHostId, nickname: newHost?.nickname });
    }

    if (room.status !== "waiting") {
      room.status      = "waiting";
      room.currentTrick = null;
      room.taxExchange  = null;
      room.finishOrder  = [];
      room.roundNumber  = 0;
      room.players.forEach((p) => { p.hand = []; p.isReady = false; p.rank = null; });
      io.to(room.roomCode).emit("room:resetToLobby", { reason: "플레이어가 나가 대기실로 돌아갑니다." });
    }

    io.to(room.roomCode).emit("player:left", { userId: uid });
    broadcastRoom(room);
  });

  // 방 삭제 (호스트 전용)
  socket.on("room:close", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.userId !== room.hostUserId) return;

    clearTurnTimer(room);
    io.to(room.roomCode).emit("room:closed", { reason: "방장이 방을 닫았습니다." });

    room.players.forEach((p) => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.leave(room.roomCode); s.data.roomCode = null; }
      sessions.delete(p.userId);
    });
    rooms.delete(room.roomCode);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const uid  = socket.data.userId;
    if (!room || !uid) return;
    const p = room.players.get(uid);
    if (!p || p.isBot) return;

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
        if (room.players.size === 0) { clearTurnTimer(room); rooms.delete(room.roomCode); }
      }
    }, RECONNECT_GRACE_MS);
    sessions.set(uid, session);
  });
});

server.listen(PORT, () => console.log(`달무티 서버 실행 중: http://localhost:${PORT}`));
