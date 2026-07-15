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

const els = {
  landing: $("#landing"), room: $("#room"), joinModal: $("#join-modal"),
  name: $("#player-name"), joinName: $("#join-name"), roomCode: $("#room-code"),
  seats: $("#seats"), community: $("#community-cards"), myCards: $("#my-cards"),
  playerList: $("#player-list"), messages: $("#message-list"), pot: $("#pot strong"),
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
    ? `本手正在进行，选座后请在本手结束时确认入座 · 剩余 ${preview.remainingSlots} 个名额`
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
  else {
    els.joinModal.classList.remove("hidden");
    loadRoomPreview();
  }
}

socket.on("connect", () => {
  if (roomId && state) joinRoom();
});

socket.on("room:state", (nextState) => {
  state = nextState;
  if (!me) me = state.players.find((p) => p.cards?.length)?.id || state.players.find((p) => p.name === storedName())?.id;
  render();
});

function render() {
  const player = state.players.find((p) => p.id === me);
  const hand = state.hand;
  const isHost = me === state.hostId;
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
  $("#mobile-away").innerHTML = `<span>↗</span>${player?.away ? "回来" : "离座"}`;
  $("#pause-game").textContent = state.paused ? "恢复" : "暂停";
  $("#pause-game").classList.toggle("active", state.paused);
  els.start.classList.toggle("hidden", !canStart);
  els.waiting.classList.toggle("hidden", canStart || isMyTurn);
  els.betActions.classList.toggle("hidden", !isMyTurn);
  if (!canStart && !isMyTurn) els.waiting.textContent = state.paused ? "牌桌已由房主暂停" : state.nextHandAt ? "结算展示中，下一手将在 5 秒后自动开始" : hand?.runout ? "All-in 跑牌中，公共牌将逐张发出" : player?.away ? "你已暂时离座，返回后从下一手加入" : hand ? `等待 ${state.players.find((p) => p.id === hand.actionPlayerId)?.name || "牌局"} 操作` : "等待房主开始下一手";

  els.result.classList.toggle("hidden", !hand?.result);
  if (hand?.result) els.result.textContent = hand.result.text;
  configureActions(player, hand);
  if (!els.adminModal.classList.contains("hidden")) renderAdmin();
}

function renderSeats() {
  els.seats.innerHTML = state.players.map((player) => {
    const cards = player.cards?.length ? player.cards.map(cardHTML).join("") : player.cardCount ? `${cardHTML(null)}${cardHTML(null)}` : "";
    const winner = Boolean(state.hand?.result?.winnerIds?.includes(player.id));
    return `<div class="seat ${player.isTurn ? "turn" : ""} ${player.folded ? "folded" : ""} ${player.away ? "away" : ""} ${winner ? "winner" : ""} ${player.id === me ? "own" : ""}" data-pos="${player.seat}">
      <div class="seat-cards">${cards}</div>
      <div class="avatar">${escapeHTML(player.name[0]?.toUpperCase() || "P")}</div>
      <div class="seat-box">
        <div class="seat-name">${escapeHTML(player.name)} ${state.hand?.dealerId === player.id ? '<span class="dealer-chip">D</span>' : ""}</div>
        <div class="seat-points">◆ ${player.points.toLocaleString()}</div>
      </div>
      ${player.bet ? `<div class="seat-bet"><span>下注</span><strong>${player.bet}</strong></div>` : ""}
    </div>`;
  }).join("");
}

function renderPlayers() {
  els.playerList.innerHTML = [...state.players].sort((a,b) => a.seat-b.seat).map((player) => `<div class="player-row">
    <div class="avatar">${escapeHTML(player.name[0]?.toUpperCase() || "P")}</div>
    <div class="player-row-info"><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}${player.id === state.hostId ? '<span class="host-tag">房主</span>' : ""}</strong><span>${player.connected ? player.status : "已离线"}</span></div>
    <div class="player-row-points">◆ ${player.points.toLocaleString()}</div>
  </div>`).join("");
}

function renderMessages() {
  els.messages.innerHTML = state.messages.map((msg) => msg.type === "chat"
    ? `<div class="message"><strong>${escapeHTML(msg.name)}</strong>${escapeHTML(msg.text)}</div>`
    : `<div class="message system">${escapeHTML(msg.text)}</div>`).join("");
  els.messages.scrollTop = els.messages.scrollHeight;
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
  const response = await emit("host:settings", { smallBlind: $("#admin-sb").value, bigBlind: $("#admin-bb").value });
  if (!response.ok) toast(response.error); else toast("盲注已更新，将从下一手生效");
});
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

$$('[data-mobile-panel]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-mobile-panel]').forEach((item) => item.classList.toggle("active", item === button));
  const open = button.dataset.mobilePanel !== "table";
  els.sidebar.classList.toggle("open", open);
  if (button.dataset.mobilePanel === "chat") requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; $("#chat-input").focus(); });
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
  try { await navigator.clipboard.writeText(link); toast("邀请链接已复制"); }
  catch { prompt("复制这个邀请链接", link); }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim(); if (!text) return;
  const response = await emit("chat:send", { text });
  if (response.ok) input.value = ""; else toast(response.error);
});

function escapeHTML(value) { return String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }
