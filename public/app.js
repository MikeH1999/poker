const socket = io();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roomMatch = location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)/);
let roomId = roomMatch?.[1]?.toUpperCase() || null;
let state = null;
let me = null;
let toastTimer;
let lastCommunityKeys = [];
let selectedSeat = null;
let serverClockOffset = 0;
const chatBubbles = new Map();
const chatBubbleTimers = new Map();

const els = {
  landing: $("#landing"), room: $("#room"), joinModal: $("#join-modal"),
  name: $("#player-name"), joinName: $("#join-name"), roomCode: $("#room-code"),
  seats: $("#seats"), community: $("#community-cards"), myCards: $("#my-cards"),
  playerList: $("#player-list"), messages: $("#message-list"), activity: $("#activity-list"), pot: $("#pot strong"),
  start: $("#start-hand"), waiting: $("#waiting-actions"), betActions: $("#bet-actions"),
  result: $("#result-banner"), raiseRange: $("#raise-range"), raiseAmount: $("#raise-amount"),
  adminModal: $("#admin-modal"), adminPlayers: $("#admin-player-list"), sidebar: $("#sidebar"),
};

function storedName() { return localStorage.getItem("riverclub:name") || ""; }
function tokenKey(id) { return `riverclub:token:${id}`; }
els.name.value = storedName();
els.joinName.value = storedName();

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2400);
}

function getName(input) {
  const name = input.value.trim();
  if (!name) { toast("先给自己取个昵称"); input.focus(); return null; }
  localStorage.setItem("riverclub:name", name);
  return name;
}

function emit(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

$("#settings-toggle").addEventListener("click", () => $("#settings").classList.toggle("hidden"));
$("#create-room").addEventListener("click", async () => {
  const name = getName(els.name); if (!name) return;
  const response = await emit("room:create", { name, settings: {
    startingPoints: $("#starting-points").value,
    smallBlind: $("#small-blind").value,
    bigBlind: $("#big-blind").value,
    maxPlayers: $("#max-players").value,
    decisionTimeSeconds: $("#decision-time").value,
  }});
  if (!response.ok) return toast(response.error);
  localStorage.setItem(tokenKey(response.roomId), response.token);
  me = response.playerId;
  history.pushState({}, "", `/room/${response.roomId}`);
  roomId = response.roomId;
  showRoom();
});

$("#join-code").addEventListener("click", () => {
  const code = els.roomCode.value.trim().toUpperCase();
  if (code.length < 4) return toast("请输入正确的房间码");
  location.href = `/room/${code}`;
});
els.roomCode.addEventListener("keydown", (event) => { if (event.key === "Enter") $("#join-code").click(); });

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (selectedSeat === null) return toast("请先选择座位");
  const name = getName(els.joinName); if (!name) return;
  await joinRoom(name, $("#join-points").value, selectedSeat);
});

async function joinRoom(name = storedName(), points = $("#join-points").value, seat = selectedSeat) {
  const response = await emit("room:join", { roomId, name, points, seat, token: localStorage.getItem(tokenKey(roomId)) });
  if (!response.ok) {
    if (response.needsSeat) {
      openSeatModal("reseat");
      return false;
    }
    if (response.error.includes("房间不存在")) { toast(response.error); setTimeout(() => location.href = "/", 1400); }
    else {
      toast(response.error);
      if (response.error.includes("座位")) {
        selectedSeat = null;
        $("#join-details").classList.add("hidden");
        $("#seat-step").classList.remove("hidden");
        loadRoomPreview();
      }
    }
    return false;
  }
  localStorage.setItem(tokenKey(roomId), response.token);
  els.joinModal.classList.add("hidden");
  me = response.playerId;
  return true;
}

function openSeatModal(mode = "invite") {
  selectedSeat = null;
  $("#join-title").textContent = mode === "reseat" ? "重新坐下" : "你收到一张牌桌邀请";
  $("#join-subtitle").textContent = mode === "reseat" ? "你的积分已用完，请重新选择座位并设置本次积分。" : "先选择一个空位，选好后再填写入座信息。";
  $("#join-details").classList.add("hidden");
  $("#seat-step").classList.remove("hidden");
  els.joinModal.classList.remove("hidden");
  loadRoomPreview();
}

async function loadRoomPreview() {
  $("#seat-picker-status").textContent = "正在读取牌桌座位…";
  const preview = await emit("room:preview", { roomId });
  if (!preview.ok) {
    $("#seat-picker-status").textContent = preview.error;
    if (preview.error.includes("房间不存在")) setTimeout(() => { location.href = "/"; }, 1400);
    return;
  }
  $("#seat-room-code").textContent = `ROOM ${preview.roomId}`;
  $("#join-points").value = preview.defaultPoints || 1000;
  const occupied = new Map(preview.occupiedSeats.map((player) => [player.seat, player]));
  $("#seat-options").innerHTML = Array.from({ length: 8 }, (_, seat) => {
    const player = occupied.get(seat);
    const full = !player && preview.remainingSlots === 0;
    return `<button class="seat-choice ${player ? "occupied" : full ? "unavailable" : "available"}" data-seat="${seat}" data-pos="${seat}" type="button" ${player || full ? "disabled" : ""}>
      <strong>${seat + 1}</strong><small>${player ? escapeHTML(player.name) : full ? "已满" : "空位"}</small>
    </button>`;
  }).join("");
  const availableCount = 8 - occupied.size;
  $("#seat-picker-status").textContent = preview.handInProgress
    ? `本手正在进行，可立即入座并从下一手加入 · 剩余 ${preview.remainingSlots} 个名额`
    : `${availableCount} 个空位 · 剩余 ${preview.remainingSlots} 个入座名额`;
}

$("#seat-options").addEventListener("click", (event) => {
  const button = event.target.closest(".seat-choice.available");
  if (!button) return;
  selectedSeat = Number(button.dataset.seat);
  $("#selected-seat-number").textContent = selectedSeat + 1;
  $("#seat-step").classList.add("hidden");
  $("#join-details").classList.remove("hidden");
  requestAnimationFrame(() => els.joinName.focus());
});

$("#back-to-seats").addEventListener("click", () => {
  selectedSeat = null;
  $("#join-details").classList.add("hidden");
  $("#seat-step").classList.remove("hidden");
  loadRoomPreview();
});

function showRoom() {
  els.landing.classList.add("hidden");
  els.room.classList.remove("hidden");
  $(".site-header").classList.add("hidden");
  $("#room-id").textContent = roomId;
}

if (roomId) {
  showRoom();
  const token = localStorage.getItem(tokenKey(roomId));
  if (token) joinRoom();
  else openSeatModal("invite");
}

socket.on("connect", () => {
  if (roomId && state) joinRoom();
});

socket.on("room:state", (nextState) => {
  serverClockOffset = (nextState.serverTime || Date.now()) - Date.now();
  state = nextState;
  if (!me) me = state.viewer?.id || state.players.find((p) => p.cards?.length)?.id || state.players.find((p) => p.name === storedName())?.id;
  render();
});

socket.on("chat:bubble", ({ playerId, text, expiresAt }) => {
  chatBubbles.set(playerId, { text, expiresAt });
  clearTimeout(chatBubbleTimers.get(playerId));
  chatBubbleTimers.set(playerId, setTimeout(() => {
    if (chatBubbles.get(playerId)?.expiresAt !== expiresAt) return;
    chatBubbles.delete(playerId);
    chatBubbleTimers.delete(playerId);
    if (state) renderSeats();
  }, Math.max(0, expiresAt - Date.now())));
  if (state) renderSeats();
});

function render() {
  const player = state.players.find((p) => p.id === me);
  const hand = state.hand;
  const isHost = me === state.hostId;
  const needsReseat = Boolean(state.viewer && !state.viewer.seated);
  els.room.classList.toggle("is-paused", state.paused);
  $("#room-id").textContent = state.id;
  $("#player-count").textContent = state.players.filter((p) => p.connected).length;
  $("#hand-number").textContent = state.handNumber ? `HAND #${String(state.handNumber).padStart(3,"0")} · ${phaseName(hand?.phase)}` : "等待开局";
  $("#blind-info").textContent = `盲注 ${state.settings.smallBlind}/${state.settings.bigBlind}`;
  els.pot.textContent = hand?.pot || 0;
  renderCommunity(hand?.community || []);
  renderCards(els.myCards, player?.cards || []);
  $("#my-hand-rank strong").textContent = player?.handName || "等待发牌";
  renderSeats();
  renderPlayers();
  renderMessages();

  const canStart = isHost && !state.paused && (!hand || hand.result);
  const isMyTurn = !state.paused && hand?.actionPlayerId === me;
  $$(".host-only").forEach((element) => element.classList.toggle("hidden", !isHost));
  $("#away-toggle").textContent = player?.away ? "我回来了" : "暂时离座";
  $("#away-toggle").classList.toggle("active", Boolean(player?.away));
  $("#away-toggle").classList.toggle("hidden", needsReseat);
  $("#mobile-away").innerHTML = `<span>↗</span>${player?.away ? "回来" : "离座"}`;
  $("#mobile-away").classList.toggle("hidden", needsReseat);
  $("#pause-game").textContent = state.paused ? "恢复" : "暂停";
  $("#pause-game").classList.toggle("active", state.paused);
  els.start.classList.toggle("hidden", !canStart);
  $("#reseat-player").classList.toggle("hidden", !needsReseat);
  $("#reseat-count").textContent = `本房间已重新坐下 ${state.viewer?.rejoinCount || 0} 次`;
  els.waiting.classList.toggle("hidden", canStart || isMyTurn || needsReseat);
  els.betActions.classList.toggle("hidden", !isMyTurn);
  if (!canStart && !isMyTurn) els.waiting.textContent = state.paused ? "牌桌已由房主暂停" : state.nextHandAt ? "结算展示中，下一手将在 5 秒后自动开始" : hand?.runout ? "All-in 跑牌中，公共牌将逐张发出" : player?.away ? "你已暂时离座，返回后从下一手加入" : hand ? `等待 ${state.players.find((p) => p.id === hand.actionPlayerId)?.name || "牌局"} 操作` : "等待房主开始下一手";

  els.result.classList.toggle("hidden", !hand?.result);
  if (hand?.result) els.result.textContent = hand.result.text;
  configureActions(player, hand);
  updateTurnTimer();
  if (!els.adminModal.classList.contains("hidden")) renderAdmin();
}

function renderSeats() {
  const viewerSeat = state.players.find((player) => player.id === me)?.seat;
  els.seats.innerHTML = state.players.map((player) => {
    const cards = player.cards?.length ? player.cards.map(cardHTML).join("") : player.cardCount ? `${cardHTML(null)}${cardHTML(null)}` : "";
    const winner = Boolean(state.hand?.result?.winnerIds?.includes(player.id));
    const equity = state.hand?.equities?.[player.id];
    const bubble = chatBubbles.get(player.id);
    const visualPosition = viewerSeat === undefined ? player.seat : (player.seat - viewerSeat + 8) % 8;
    return `<div class="seat ${player.isTurn ? "turn" : ""} ${player.folded ? "folded" : ""} ${player.away ? "away" : ""} ${winner ? "winner" : ""} ${player.id === me ? "own" : ""}" data-pos="${visualPosition}" data-seat="${player.seat}">
      ${bubble && bubble.expiresAt > Date.now() ? `<div class="chat-bubble">${escapeHTML(bubble.text)}</div>` : ""}
      <div class="seat-cards">${cards}</div>
      ${player.folded ? '<div class="folded-tag">已弃牌</div>' : ""}
      <div class="avatar">${escapeHTML(player.name[0]?.toUpperCase() || "P")}</div>
      <div class="seat-box">
        <div class="seat-name"><span class="seat-player-name">${escapeHTML(player.name)}</span>${state.hand?.dealerId === player.id ? '<span class="dealer-chip">D</span>' : ""}${player.rejoinCount ? `<span class="reseat-tag">重坐 ×${player.rejoinCount}</span>` : ""}</div>
        <div class="seat-points">◆ ${player.points.toLocaleString()}</div>
        ${equity !== undefined ? `<div class="equity-badge"><span>胜率</span><strong>${equity}%</strong></div>` : ""}
      </div>
      ${player.bet ? `<div class="seat-bet"><span>下注</span><strong>${player.bet}</strong></div>` : ""}
    </div>`;
  }).join("");
}

$("#reseat-player").addEventListener("click", () => openSeatModal("reseat"));

function renderPlayers() {
  els.playerList.innerHTML = [...state.players].sort((a,b) => a.seat-b.seat).map((player) => `<div class="player-row">
    <div class="avatar">${escapeHTML(player.name[0]?.toUpperCase() || "P")}</div>
    <div class="player-row-info"><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}${player.id === state.hostId ? '<span class="host-tag">房主</span>' : ""}</strong><span>${player.connected ? player.status : "已离线"}</span></div>
    <div class="player-row-points">◆ ${player.points.toLocaleString()}</div>
  </div>`).join("");
}

function renderMessages() {
  const chats = state.messages.filter((message) => message.type === "chat");
  const activity = state.messages.filter((message) => message.type === "system");
  $("#chat-count").textContent = chats.length;
  els.messages.innerHTML = chats.length
    ? chats.map((msg) => `<div class="message chat-message"><strong>${escapeHTML(msg.name)}</strong>${escapeHTML(msg.text)}</div>`).join("")
    : '<div class="empty-feed">还没有聊天消息</div>';
  els.activity.innerHTML = activity.length
    ? activity.map((msg) => `<div class="message system">${escapeHTML(msg.text)}</div>`).join("")
    : '<div class="empty-feed">牌局开始后，操作记录会显示在这里</div>';
  els.messages.scrollTop = els.messages.scrollHeight;
  els.activity.scrollTop = els.activity.scrollHeight;
}

function renderCards(container, cards) { container.innerHTML = cards.map(cardHTML).join(""); }
function renderCommunity(cards) {
  const previous = new Set(lastCommunityKeys);
  const keys = cards.map((card) => `${card.rank}${card.suit}`);
  els.community.innerHTML = cards.map((card, index) => cardHTML(card, {
    animate: !previous.has(keys[index]),
    index,
  })).join("");
  lastCommunityKeys = keys;
}
function cardHTML(card, options = {}) {
  if (!card) return '<div class="card back"></div>';
  const red = card.suit === "h" || card.suit === "d";
  const animation = options.animate ? ` dealing" style="--deal-index:${options.index || 0}` : "";
  return `<div class="card ${red ? "red" : ""}${animation}">${rankName(card.rank)}<small>${suitName(card.suit)}</small></div>`;
}
function rankName(rank) { return rank === "T" ? "10" : rank; }
function suitName(suit) { return ({s:"♠",h:"♥",d:"♦",c:"♣"})[suit]; }
function phaseName(phase) { return ({preflop:"翻牌前",flop:"翻牌",turn:"转牌",river:"河牌"})[phase] || "等待"; }

function configureActions(player, hand) {
  if (!player || !hand || hand.actionPlayerId !== me) return;
  const call = Math.max(0, hand.currentBet - player.bet);
  const checkButton = $('[data-action="check"]');
  const callButton = $("#call-btn");
  checkButton.classList.toggle("hidden", call > 0);
  callButton.classList.toggle("hidden", call === 0);
  callButton.textContent = call >= player.points ? `跟注 · 全下 ${player.points}` : `跟注 · ${call}`;
  const min = Math.min(player.bet + player.points, hand.currentBet + hand.minRaise);
  const max = player.bet + player.points;
  els.raiseRange.min = min;
  els.raiseRange.max = Math.max(min, max);
  els.raiseRange.value = Math.min(Math.max(Number(els.raiseRange.value), min), max);
  els.raiseAmount.min = min;
  els.raiseAmount.max = max;
  els.raiseAmount.value = els.raiseRange.value;
  $('[data-action="raise"]').disabled = max <= hand.currentBet;
}

function renderAdmin() {
  if (!state) return;
  $("#admin-sb").value = state.settings.smallBlind;
  $("#admin-bb").value = state.settings.bigBlind;
  $("#admin-decision-time").value = state.settings.decisionTimeSeconds || 30;
  $("#admin-pause").textContent = state.paused ? "恢复游戏" : "暂停游戏";
  $("#admin-pause").classList.toggle("active", state.paused);
  $("#auto-start").textContent = `自动开始：${state.settings.autoStartNextHand ? "开" : "关"}`;
  $("#auto-start").classList.toggle("active", state.settings.autoStartNextHand);
  $("#admin-start").disabled = state.paused || Boolean(state.hand && !state.hand.result);
  els.adminPlayers.innerHTML = [...state.players].sort((a,b) => a.seat-b.seat).map((player) => `<div class="admin-player" data-player-id="${player.id}">
    <div class="admin-player-main"><div class="avatar">${escapeHTML(player.name[0]?.toUpperCase() || "P")}</div><div><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}</strong><span>${player.away ? "暂时离座" : player.connected ? player.status : "已离线"}</span></div></div>
    <div class="points-editor"><button data-points-step="-100">−</button><input data-points-input type="number" min="0" max="10000000" value="${player.points}" aria-label="${escapeHTML(player.name)}的积分" /><button data-points-step="100">＋</button></div>
    <button class="kick-button" data-kick ${player.id === me ? "disabled" : ""}>${player.id === me ? "房主" : "剔除"}</button>
  </div>`).join("");
}

els.raiseRange.addEventListener("input", () => { els.raiseAmount.value = els.raiseRange.value; });
els.raiseAmount.addEventListener("input", () => { els.raiseRange.value = els.raiseAmount.value; });
els.raiseAmount.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $('[data-action="raise"]').click();
});
$$('[data-action]').forEach((button) => button.addEventListener("click", async () => {
  const response = await emit("game:action", { action: button.dataset.action, amount: els.raiseAmount.value });
  if (!response.ok) toast(response.error);
}));

els.start.addEventListener("click", async () => {
  const response = await emit("game:start");
  if (!response.ok) toast(response.error);
});

async function toggleAway() {
  const player = state?.players.find((p) => p.id === me);
  if (!player) return;
  const response = await emit("player:away", { away: !player.away });
  if (!response.ok) toast(response.error);
  else toast(player.away ? "已登记返桌，将从下一手开始发牌" : "已暂时离座，状态会一直保留");
}

async function togglePause() {
  const response = await emit("game:pause", { paused: !state.paused });
  if (!response.ok) toast(response.error);
}

$("#away-toggle").addEventListener("click", toggleAway);
$("#mobile-away").addEventListener("click", toggleAway);
$("#pause-game").addEventListener("click", togglePause);
$("#admin-pause").addEventListener("click", togglePause);
$("#auto-start").addEventListener("click", async () => {
  const response = await emit("host:auto-start", { enabled: !state.settings.autoStartNextHand });
  if (!response.ok) toast(response.error);
  else toast(state.settings.autoStartNextHand ? "已关闭自动开始下一手" : "已开启，结算 5 秒后自动发牌");
});

function openAdmin() {
  renderAdmin();
  els.adminModal.classList.remove("hidden");
}
$("#manage-room").addEventListener("click", openAdmin);
$("#mobile-manage").addEventListener("click", openAdmin);
$("#close-admin").addEventListener("click", () => els.adminModal.classList.add("hidden"));
els.adminModal.addEventListener("click", (event) => { if (event.target === els.adminModal) els.adminModal.classList.add("hidden"); });

$$('[data-admin-tab]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-admin-tab]').forEach((tab) => tab.classList.toggle("active", tab === button));
  $("#admin-game").classList.toggle("hidden", button.dataset.adminTab !== "game");
  $("#admin-players").classList.toggle("hidden", button.dataset.adminTab !== "players");
}));

$("#save-blinds").addEventListener("click", async () => {
  const response = await emit("host:settings", { smallBlind: $("#admin-sb").value, bigBlind: $("#admin-bb").value, decisionTimeSeconds: $("#admin-decision-time").value });
  if (!response.ok) toast(response.error); else toast("盲注已更新，将从下一手生效");
});

function updateTurnTimer() {
  const timer = $("#turn-timer");
  const hand = state?.hand;
  if (!hand?.actionDeadline || hand.result || state.paused) {
    timer.classList.add("hidden");
    return;
  }
  const total = state.settings.decisionTimeSeconds || 30;
  const remaining = Math.max(0, Math.ceil((hand.actionDeadline - (Date.now() + serverClockOffset)) / 1000));
  const actionPlayer = state.players.find((player) => player.id === hand.actionPlayerId);
  timer.querySelector("span").textContent = hand.actionPlayerId === me ? "你的思考时间" : `${actionPlayer?.name || "玩家"} 思考中`;
  timer.querySelector("strong").textContent = remaining;
  timer.style.setProperty("--time-progress", `${Math.max(0, Math.min(100, remaining / total * 100))}%`);
  timer.classList.toggle("warning", remaining <= 10);
  timer.classList.remove("hidden");
}

setInterval(updateTurnTimer, 250);
$("#admin-start").addEventListener("click", () => els.start.click());

async function savePlayerPoints(row) {
  const input = row.querySelector("[data-points-input]");
  const response = await emit("host:points", { playerId: row.dataset.playerId, points: input.value });
  if (!response.ok) toast(response.error); else toast("玩家积分已更新");
}

els.adminPlayers.addEventListener("click", async (event) => {
  const row = event.target.closest(".admin-player");
  if (!row) return;
  const step = event.target.closest("[data-points-step]");
  if (step) {
    const input = row.querySelector("[data-points-input]");
    input.value = Math.max(0, Number(input.value || 0) + Number(step.dataset.pointsStep));
    await savePlayerPoints(row);
    return;
  }
  if (event.target.closest("[data-kick]")) {
    const target = state.players.find((p) => p.id === row.dataset.playerId);
    if (!target || !confirm(`确定将 ${target.name} 移出房间吗？`)) return;
    const response = await emit("host:kick", { playerId: target.id });
    if (!response.ok) toast(response.error); else toast(`${target.name} 已被移出房间`);
  }
});
els.adminPlayers.addEventListener("change", async (event) => {
  if (!event.target.matches("[data-points-input]")) return;
  await savePlayerPoints(event.target.closest(".admin-player"));
});

function switchSideTab(tabName) {
  $$('[data-side-tab]').forEach((button) => button.classList.toggle("active", button.dataset.sideTab === tabName));
  $("#players-pane").classList.toggle("hidden", tabName !== "players");
  $("#chat-pane").classList.toggle("hidden", tabName !== "chat");
  $("#activity-pane").classList.toggle("hidden", tabName !== "activity");
  if (tabName === "chat") requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  if (tabName === "activity") requestAnimationFrame(() => { els.activity.scrollTop = els.activity.scrollHeight; });
}

$$('[data-side-tab]').forEach((button) => button.addEventListener("click", () => switchSideTab(button.dataset.sideTab)));

$$('[data-mobile-panel]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-mobile-panel]').forEach((item) => item.classList.toggle("active", item === button));
  const open = button.dataset.mobilePanel !== "table";
  els.sidebar.classList.toggle("open", open);
  if (button.dataset.mobilePanel === "players") switchSideTab("players");
  if (button.dataset.mobilePanel === "chat") {
    switchSideTab("chat");
    requestAnimationFrame(() => { $("#chat-input").focus(); });
  }
}));
$("#close-sidebar").addEventListener("click", () => {
  els.sidebar.classList.remove("open");
  $$('[data-mobile-panel]').forEach((button) => button.classList.toggle("active", button.dataset.mobilePanel === "table"));
});

socket.on("room:kicked", ({ message }) => {
  localStorage.removeItem(tokenKey(roomId));
  toast(message || "你已被移出房间");
  setTimeout(() => { location.href = "/"; }, 1400);
});

$("#copy-link").addEventListener("click", async () => {
  const link = `${location.origin}/room/${state?.id || roomId}`;
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch { /* use the compatibility fallback below */ }
  if (!copied) {
    const textarea = document.createElement("textarea");
    textarea.value = link;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    textarea.remove();
  }
  toast(copied ? "邀请链接已复制" : "浏览器禁止复制，请长按地址栏复制链接");
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim(); if (!text) return;
  const response = await emit("chat:send", { text });
  if (response.ok) input.value = ""; else toast(response.error);
});

function escapeHTML(value) { return String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }
