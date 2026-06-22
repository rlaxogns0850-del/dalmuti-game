const socket = io();

const AVATARS = ["🦊", "🐺", "🦅", "🐻", "🦁", "🐗", "🦉", "🐍"];
const RANK_TITLES = ["대달무티", "소달무티", "총리대신", "재판관", "기사", "성직자", "상인", "장인", "농부", "광부", "소농노", "대농노"];

const app = document.getElementById("app");
const rulesModal = document.getElementById("rulesModal");
document.getElementById("closeRulesBtn").onclick = () => rulesModal.classList.add("hidden");
document.getElementById("rulesOkBtn").onclick = () => rulesModal.classList.add("hidden");

let state = {
  userId: localStorage.getItem("dalmuti_userId") || null,
  roomCode: localStorage.getItem("dalmuti_roomCode") || null,
  nickname: localStorage.getItem("dalmuti_nickname") || "",
  avatar: localStorage.getItem("dalmuti_avatar") || AVATARS[0],
  room: null,
  myHand: [],
  selected: new Set(),
};

function saveSession() {
  if (state.userId) localStorage.setItem("dalmuti_userId", state.userId);
  if (state.roomCode) localStorage.setItem("dalmuti_roomCode", state.roomCode);
  localStorage.setItem("dalmuti_nickname", state.nickname);
  localStorage.setItem("dalmuti_avatar", state.avatar);
}

function showToast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/* ---------------- 화면: 입장 / 방 생성 ---------------- */
function renderHome() {
  app.innerHTML = `
    <div class="row"><h1 class="serif" style="color:var(--gold)">달무티</h1></div>
    <div class="panel">
      <label>닉네임</label>
      <input id="nicknameInput" type="text" placeholder="이름을 입력하세요" value="${state.nickname}" />
      <div class="avatar-grid" id="avatarGrid"></div>
      <button id="createBtn" class="btn btn-gold" style="width:100%;margin-bottom:10px;">방 만들기</button>
      <input id="roomCodeInput" type="text" placeholder="입장 코드 입력" style="text-transform:uppercase" />
      <button id="joinBtn" class="btn btn-primary" style="width:100%;">방 입장하기</button>
    </div>
  `;
  const grid = document.getElementById("avatarGrid");
  AVATARS.forEach((a) => {
    const b = document.createElement("button");
    b.className = "avatar-option" + (a === state.avatar ? " selected" : "");
    b.textContent = a;
    b.onclick = () => { state.avatar = a; renderHome(); };
    grid.appendChild(b);
  });

  document.getElementById("nicknameInput").oninput = (e) => (state.nickname = e.target.value);

  document.getElementById("createBtn").onclick = () => {
    if (!state.nickname.trim()) return showToast("닉네임을 입력해주세요");
    socket.emit("room:create", { nickname: state.nickname, avatar: state.avatar, userId: state.userId }, (res) => {
      if (!res.ok) return showToast("방 생성 실패");
      state.userId = res.userId;
      state.roomCode = res.roomCode;
      saveSession();
    });
  };

  document.getElementById("joinBtn").onclick = () => {
    const code = document.getElementById("roomCodeInput").value.trim().toUpperCase();
    if (!state.nickname.trim()) return showToast("닉네임을 입력해주세요");
    if (!code) return showToast("입장 코드를 입력해주세요");
    socket.emit("room:join", { roomCode: code, nickname: state.nickname, avatar: state.avatar, userId: state.userId }, (res) => {
      if (!res.ok) return showToast(res.code === "ROOM_FULL" ? "방이 가득 찼습니다" : "방을 찾을 수 없습니다");
      state.userId = res.userId;
      state.roomCode = res.roomCode;
      saveSession();
    });
  };
}

/* ---------------- 화면: 대기실 ---------------- */
let rulesAutoShown = false;

function renderWaitingRoom() {
  const room = state.room;
  const isHost = room.hostUserId === state.userId;
  const me = room.players.find((p) => p.userId === state.userId);

  app.innerHTML = `
    <div class="row">
      <h1 class="serif" style="color:var(--gold);font-size:22px;">달무티 대기실</h1>
      <button id="rulesBtn" class="icon-btn">❓ 규칙 보기</button>
    </div>
    <p>입장 코드 <span class="room-code">${room.roomCode}</span></p>
    <div class="player-grid" id="playerGrid"></div>
    <p style="font-size:12px;color:var(--gold);opacity:.8;">참가 인원 ${room.players.length} / ${room.maxPlayers} (최소 ${room.minPlayers}명)</p>
    <div class="actions">
      <button id="readyBtn" class="btn" style="flex:1;">${me?.isReady ? "준비 취소" : "준비완료"}</button>
      ${isHost ? `<button id="startBtn" class="btn btn-gold" style="flex:1;">게임 시작</button>` : ""}
    </div>
  `;

  const grid = document.getElementById("playerGrid");
  room.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-card";
    div.innerHTML = `
      <span class="avatar">${p.avatar}</span>
      <span class="name">${p.nickname}${p.userId === room.hostUserId ? " 👑방장" : ""}</span>
      <span class="status ${p.isReady ? "ready" : ""}">${p.connected === false ? "연결 끊김" : p.isReady ? "준비완료" : "대기중"}</span>
    `;
    grid.appendChild(div);
  });

  document.getElementById("rulesBtn").onclick = () => rulesModal.classList.remove("hidden");
  document.getElementById("readyBtn").onclick = () => socket.emit("player:ready");
  const startBtn = document.getElementById("startBtn");
  if (startBtn) {
    const canStart = room.players.length >= room.minPlayers && room.players.length <= room.maxPlayers;
    startBtn.disabled = !canStart;
    startBtn.onclick = () => socket.emit("game:start");
  }

  if (!rulesAutoShown) {
    rulesModal.classList.remove("hidden");
    rulesAutoShown = true;
  }
}

/* ---------------- 화면: 세금 징수 ---------------- */
function renderTax() {
  const room = state.room;
  const tax = room.taxExchange;
  const isKing = tax.kingId === state.userId;
  const isPeon = tax.peonId === state.userId;
  const myJokers = state.myHand.filter((c) => c.isJoker).length;

  app.innerHTML = `
    <div class="row"><h1 class="serif" style="color:var(--gold);font-size:20px;">세금 징수 (라운드 ${room.roundNumber})</h1>
      <button id="rulesBtn" class="icon-btn">❓ 규칙 보기</button></div>
    <div class="tax-box">
      ${isKing ? "<p>👑 왕입니다. 노예에게 내려줄 카드를 선택하세요.</p>" : ""}
      ${isPeon ? "<p>🪓 노예입니다. 왕에게 바칠 가장 좋은 카드를 선택하세요.</p>" : ""}
      ${!isKing && !isPeon ? "<p>왕과 노예 사이의 세금 징수가 진행 중입니다...</p>" : ""}
    </div>
    ${isKing || isPeon ? `<div class="hand" id="taxHand"></div><div class="actions"><button id="taxSubmitBtn" class="btn btn-primary">제출</button></div>` : ""}
    ${myJokers >= 2 ? `<div class="actions"><button id="revolutionBtn" class="btn btn-gold">⚡ 혁명 선언 (조커 2장 보유)</button></div>` : ""}
  `;
  document.getElementById("rulesBtn").onclick = () => rulesModal.classList.remove("hidden");

  const revBtn = document.getElementById("revolutionBtn");
  if (revBtn) revBtn.onclick = () => socket.emit("tax:declareRevolution");

  if (isKing || isPeon) {
    const handDiv = document.getElementById("taxHand");
    let picked = null;
    state.myHand.forEach((card) => {
      const b = document.createElement("button");
      b.className = "hand-card";
      b.textContent = card.isJoker ? "🃏" : card.rank;
      b.onclick = () => {
        picked = card.id;
        [...handDiv.children].forEach((c) => c.classList.remove("selected"));
        b.classList.add("selected");
      };
      handDiv.appendChild(b);
    });
    document.getElementById("taxSubmitBtn").onclick = () => {
      if (!picked) return showToast("카드를 선택해주세요");
      socket.emit(isKing ? "tax:kingSubmit" : "tax:peonSubmit", { cardId: picked });
    };
  }
}

/* ---------------- 화면: 게임 테이블 ---------------- */
let timerInterval = null;

function renderGameTable() {
  const room = state.room;
  const trick = room.currentTrick;
  const isMyTurn = trick?.currentTurnUserId === state.userId;

  app.innerHTML = `
    <div class="row">
      <div class="timer-bar-wrap">
        <div class="timer-bar"><div class="timer-bar-fill" id="timerFill" style="width:100%"></div></div>
        <span class="timer-text" id="timerText">30s</span>
      </div>
      <button id="rulesBtn" class="icon-btn">❓ 규칙 보기</button>
    </div>

    <div class="player-grid" id="playerGrid"></div>

    <div class="field" id="field"></div>

    <div class="hand" id="hand"></div>

    <div class="actions">
      <button id="passBtn" class="btn" ${isMyTurn ? "" : "disabled"}>패스</button>
      <button id="playBtn" class="btn btn-primary" ${isMyTurn ? "" : "disabled"}>카드 내기</button>
    </div>
  `;

  document.getElementById("rulesBtn").onclick = () => rulesModal.classList.remove("hidden");

  const grid = document.getElementById("playerGrid");
  room.players.forEach((p) => {
    const div = document.createElement("div");
    const level = p.rank?.level || 6;
    div.className = "player-card" + (p.rank?.isKing ? " king" : "") + (p.rank?.isPeon ? " peon" : "") +
      (trick?.currentTurnUserId === p.userId ? " current-turn" : "");
    div.innerHTML = `
      ${p.rank?.isKing ? `<span class="crown">👑</span>` : ""}
      <span class="avatar">${p.avatar}</span>
      <span class="name">${p.nickname}</span>
      <span class="title">${p.rank ? RANK_TITLES[Math.min(level, 12) - 1] : ""}</span>
      <span class="status">카드 ${p.handCount}장</span>
    `;
    grid.appendChild(div);
  });

  const fieldDiv = document.getElementById("field");
  if (!trick || trick.fieldCards.length === 0) {
    fieldDiv.innerHTML = `<span class="empty">아직 낸 카드가 없습니다</span>`;
  } else {
    trick.fieldCards.forEach((fc) => {
      const c = document.createElement("div");
      c.className = "field-card";
      c.textContent = `${fc.rank}×${fc.count}`;
      fieldDiv.appendChild(c);
    });
  }

  const handDiv = document.getElementById("hand");
  state.myHand.forEach((card) => {
    const b = document.createElement("button");
    b.className = "hand-card" + (state.selected.has(card.id) ? " selected" : "");
    b.textContent = card.isJoker ? "🃏" : card.rank;
    b.onclick = () => {
      if (state.selected.has(card.id)) state.selected.delete(card.id);
      else state.selected.add(card.id);
      renderGameTable();
    };
    handDiv.appendChild(b);
  });

  document.getElementById("passBtn").onclick = () => socket.emit("turn:pass");
  document.getElementById("playBtn").onclick = () => {
    if (state.selected.size === 0) return showToast("카드를 선택해주세요");
    socket.emit("turn:playCards", { cardIds: Array.from(state.selected) });
    state.selected.clear();
  };

  clearInterval(timerInterval);
  if (trick?.turnDeadline) {
    const update = () => {
      const remaining = Math.max(0, Math.ceil((new Date(trick.turnDeadline) - new Date()) / 1000));
      const fill = document.getElementById("timerFill");
      const text = document.getElementById("timerText");
      if (fill) fill.style.width = `${(remaining / 30) * 100}%`;
      if (text) text.textContent = `${remaining}s`;
    };
    update();
    timerInterval = setInterval(update, 250);
  }
}

/* ---------------- 라우팅 ---------------- */
function render() {
  const room = state.room;
  if (!room) return renderHome();
  if (room.status === "waiting") return renderWaitingRoom();
  if (room.status === "tax") return renderTax();
  if (room.status === "playing" || room.status === "roundEnd") return renderGameTable();
  return renderHome();
}

/* ---------------- 소켓 이벤트 ---------------- */
socket.on("connect", () => {
  if (state.userId && state.roomCode) {
    socket.emit("room:join", {
      roomCode: state.roomCode, nickname: state.nickname, avatar: state.avatar, userId: state.userId,
    }, (res) => {
      if (!res.ok) {
        state.roomCode = null;
        localStorage.removeItem("dalmuti_roomCode");
        render();
      }
    });
  } else {
    render();
  }
});

socket.on("room:state", (room) => {
  state.room = room;
  render();
});

socket.on("game:hand", ({ hand }) => {
  state.myHand = hand;
  state.selected.clear();
  render();
});

socket.on("round:ended", ({ finishOrder }) => {
  showToast("라운드 종료! 다음 라운드를 준비합니다...");
});

socket.on("tax:completed", () => showToast("세금 징수가 완료되었습니다"));
socket.on("tax:skippedByRevolution", ({ userId }) => showToast("⚡ 혁명 선언! 세금 징수를 건너뜁니다"));
socket.on("trick:allPassed", () => showToast("모두 패스! 새 턴이 시작됩니다"));
socket.on("player:disconnected", ({ userId }) => showToast("플레이어 연결이 끊겼습니다 (재접속 대기 중)"));
socket.on("player:reconnected", () => showToast("플레이어가 재접속했습니다"));
socket.on("player:finished", ({ userId, place }) => {
  if (userId === state.userId) showToast(`카드를 모두 냈습니다! ${place}등으로 마감`);
});

render();
