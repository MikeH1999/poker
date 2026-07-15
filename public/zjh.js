const socket = io();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roomMatch = location.pathname.match(/^\/zjh\/([A-Za-z0-9_-]+)/);
let roomId = roomMatch?.[1]?.toUpperCase() || null;
let state = null;
let me = null;
let selectedSeat = null;
let serverClockOffset = 0;
let animatedHandNumber = null;
let toastTimer;
const bubbles = new Map();
const bubbleTimers = new Map();
const nameKey = "riverclub:zjh:name";
const tokenKey = (id) => `riverclub:zjh:token:${id}`;
const emit = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const escapeHTML = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function toast(text) {
  const element = $("#zjh-toast");
  element.textContent = text;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
}

$("#zjh-create-name").value = localStorage.getItem(nameKey) || "";
$("#zjh-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#zjh-create-name").value.trim();
  const response = await emit("zjh:create", { name, settings: {
    startingPoints: $("#zjh-starting-points").value,
    ante: $("#zjh-ante").value,
    maxPlayers: $("#zjh-max-players").value,
    decisionTimeSeconds: $("#zjh-decision-time").value,
  } });
  if (!response.ok) return toast(response.error);
  roomId = response.roomId;
  me = response.playerId;
  localStorage.setItem(nameKey, name);
  localStorage.setItem(tokenKey(roomId), response.token);
  history.replaceState({}, "", `/zjh/${roomId}`);
  showRoom();
  if (state) render();
});

function showRoom() {
  $("#zjh-lobby").classList.add("hidden");
  $(".niu-header").classList.add("hidden");
  $("#zjh-room").classList.remove("hidden");
}

async function joinRoom(name = localStorage.getItem(nameKey) || "", points = $("#zjh-join-points").value, seat = selectedSeat) {
  const response = await emit("zjh:join", { roomId, name, points, seat, token: localStorage.getItem(tokenKey(roomId)) });
  if (!response.ok) return toast(response.error);
  me = response.playerId;
  localStorage.setItem(nameKey, name);
  localStorage.setItem(tokenKey(roomId), response.token);
  $("#zjh-join-modal").classList.add("hidden");
  showRoom();
  if (state) render();
}

async function openSeatModal(reseat = false) {
  const preview = await emit("zjh:preview", { roomId });
  if (!preview.ok) { toast(preview.error); if (!reseat) setTimeout(() => location.href = "/zjh", 1200); return; }
  selectedSeat = null;
  $("#zjh-picker-code").textContent = roomId;
  $("#zjh-seat-step").classList.remove("hidden");
  $("#zjh-join-details").classList.add("hidden");
  $("#zjh-join-points").value = preview.defaultPoints;
  $("#zjh-join-points").min = preview.ante;
  $("#zjh-join-name").value = localStorage.getItem(nameKey) || "";
  const occupied = new Map(preview.occupiedSeats.map((item) => [item.seat, item.name]));
  $("#zjh-seat-options").innerHTML = Array.from({ length: preview.maxPlayers }, (_, seat) => {
    const name = occupied.get(seat);
    return `<button type="button" class="zjh-seat-choice ${name ? "occupied" : "available"}" data-seat="${seat}" data-pos="${seat}" ${name ? "disabled" : ""}><strong>${seat + 1}</strong><small>${name ? escapeHTML(name) : "空位"}</small></button>`;
  }).join("");
  $("#zjh-seat-status").textContent = preview.remainingSlots ? `还有 ${preview.remainingSlots} 个空位${preview.inProgress ? " · 本局进行中，下局加入" : ""}` : "房间已满";
  $("#zjh-join-modal").classList.remove("hidden");
}

$("#zjh-seat-options").addEventListener("click", (event) => {
  const button = event.target.closest("[data-seat]");
  if (!button || button.disabled) return;
  selectedSeat = Number(button.dataset.seat);
  $("#zjh-selected-seat").textContent = selectedSeat + 1;
  $("#zjh-seat-step").classList.add("hidden");
  $("#zjh-join-details").classList.remove("hidden");
  $("#zjh-join-name").focus();
});
$("#zjh-back-seats").addEventListener("click", () => openSeatModal(Boolean(state?.viewer && !state.viewer.seated)));
$("#zjh-close-join").addEventListener("click", () => { if (state) $("#zjh-join-modal").classList.add("hidden"); });
$("#zjh-join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (selectedSeat === null) return toast("请先选择座位");
  await joinRoom($("#zjh-join-name").value.trim(), $("#zjh-join-points").value, selectedSeat);
});

socket.on("connect", () => { if (roomId && state) joinRoom(); });
socket.on("zjh:state", (nextState) => {
  state = nextState;
  serverClockOffset = nextState.serverTime - Date.now();
  if (!me && nextState.viewer?.id) me = nextState.viewer.id;
  showRoom();
  render();
});
socket.on("zjh:chat-bubble", ({ playerId, text, expiresAt }) => {
  bubbles.set(playerId, { text, expiresAt });
  clearTimeout(bubbleTimers.get(playerId));
  bubbleTimers.set(playerId, setTimeout(() => { bubbles.delete(playerId); if (state) renderSeats(); }, Math.max(0, expiresAt - Date.now())));
  if (state) renderSeats();
});
socket.on("zjh:kicked", ({ message }) => { localStorage.removeItem(tokenKey(roomId)); toast(message); setTimeout(() => location.href = "/zjh", 1300); });

function render() {
  if (!state) return;
  const player = state.players.find((candidate) => candidate.id === me);
  const isHost = me === state.hostId;
  const needsReseat = state.viewer && !state.viewer.seated;
  const inHand = player && player.cardCount === 3 && !player.folded && state.phase === "playing";
  const myTurn = inHand && state.actionPlayerId === player.id && !state.paused;
  $("#zjh-room-id").textContent = state.id;
  $("#zjh-round").textContent = state.handNumber ? `HAND #${String(state.handNumber).padStart(3, "0")} · ${phaseName(state.phase)} · 第 ${state.bettingRound || 0} 轮` : "等待开局";
  $("#zjh-ante-info").textContent = `底注 ${state.settings.ante}`;
  $("#zjh-unit-info").textContent = `暗注 ${state.currentUnit || state.settings.ante}`;
  $("#zjh-pot").textContent = state.pot.toLocaleString();
  $("#zjh-phase-label").textContent = state.phase === "result" ? "本局结算" : state.phase === "playing" ? `${state.bettingRound}/${state.settings.maxRounds} 轮` : "炸金花";
  $("#zjh-center-message").textContent = state.result?.text || (state.phase === "playing" ? "暗牌 ×1 · 明牌 ×2 · 比牌再 ×2" : "等待房主开始");
  $("#zjh-player-count").textContent = state.players.length;
  $$(".host-only").forEach((element) => element.classList.toggle("hidden", !isHost));
  $("#zjh-pause").textContent = state.paused ? "恢复" : "暂停";
  $("#zjh-auto-start").textContent = `自动下一局：${state.settings.autoStartNextHand ? "开" : "关"}`;
  $("#zjh-admin-auto").textContent = `自动下一局：${state.settings.autoStartNextHand ? "开" : "关"}`;
  $("#zjh-away").textContent = player?.away ? "我回来了" : "暂时离座";
  $("#zjh-away").classList.toggle("hidden", Boolean(needsReseat));
  $("#zjh-mobile-away").classList.toggle("hidden", Boolean(needsReseat));
  renderSeats();
  renderOwnCards(player);
  renderSidebar();
  renderAdmin();
  const canStart = isHost && !state.paused && ["waiting", "result"].includes(state.phase);
  $("#zjh-start").classList.toggle("hidden", !canStart);
  $("#zjh-start").innerHTML = `${state.phase === "result" ? "开始下一局" : "开始游戏"} <b>→</b>`;
  $("#zjh-reseat").classList.toggle("hidden", !needsReseat);
  $("#zjh-actions").classList.toggle("hidden", !inHand);
  $("#zjh-action-message").classList.toggle("hidden", inHand || canStart || needsReseat);
  if (!inHand && !canStart && !needsReseat) $("#zjh-action-message").textContent = state.paused ? "游戏已暂停" : state.nextHandAt ? "5 秒后自动开始下一局" : player?.status || "等待其他玩家";
  const callCost = inHand ? state.currentUnit * (player.seen ? 2 : 1) : state.currentUnit;
  $("#zjh-call-cost").textContent = callCost;
  $("#zjh-look").disabled = !inHand || player.seen;
  $("#zjh-look").textContent = player?.seen ? "已看牌" : "看牌";
  $("#zjh-call").disabled = !myTurn || player.points < callCost;
  $("#zjh-fold").disabled = !myTurn;
  $("#zjh-compare").disabled = !myTurn || state.bettingRound < 2 || player.points < callCost * 2 || state.players.filter((candidate) => candidate.cardCount === 3 && !candidate.folded && candidate.id !== me).length === 0;
  const raiseInput = $("#zjh-raise-unit");
  raiseInput.min = state.currentUnit + 1;
  raiseInput.max = state.maxRoomChip;
  if (Number(raiseInput.value) <= state.currentUnit) raiseInput.value = Math.min(state.maxRoomChip, state.currentUnit + state.settings.ante);
  const raiseCost = Number(raiseInput.value) * (player?.seen ? 2 : 1);
  $("#zjh-raise").disabled = !myTurn || player.raisedThisRound || Number(raiseInput.value) <= state.currentUnit || Number(raiseInput.value) > state.maxRoomChip || player.points < raiseCost;
  updateTurnTimer();
}

function renderSeats() {
  if (!state) return;
  const viewerSeat = state.players.find((player) => player.id === me)?.seat;
  const animateDeal = state.phase === "playing" && animatedHandNumber !== state.handNumber;
  $("#zjh-seats").innerHTML = state.players.map((player) => {
    const pos = viewerSeat === undefined ? player.seat : (player.seat - viewerSeat + state.settings.maxPlayers) % state.settings.maxPlayers;
    const showCards = state.phase === "result" || player.id === me && player.seen;
    const cards = player.cardCount ? (showCards ? player.cards.map((card) => cardHTML(card, animateDeal)).join("") : Array.from({ length: player.cardCount }, () => cardHTML(null, animateDeal)).join("")) : "";
    const bubble = bubbles.get(player.id);
    const status = !player.connected ? "离线" : player.away ? "暂时离座" : player.status;
    const handBadge = state.phase === "result" && player.hand ? `<div class="zjh-hand-badge">${escapeHTML(player.hand.name)}</div>` : "";
    return `<div class="zjh-seat ${player.id === state.dealerId ? "dealer" : ""} ${player.id === state.actionPlayerId ? "turn" : ""} ${player.folded ? "folded" : ""} ${player.id === state.result?.winnerId ? "winner" : ""}" data-pos="${pos}">${bubble && bubble.expiresAt > Date.now() ? `<div class="zjh-bubble">${escapeHTML(bubble.text)}</div>` : ""}<div class="zjh-seat-cards">${cards}</div><div class="zjh-avatar">${escapeHTML(player.name[0] || "诈")}</div><div class="zjh-seat-box"><div class="zjh-seat-name"><span>${escapeHTML(player.name)}</span>${player.id === state.dealerId ? '<i class="zjh-tag">庄</i>' : ""}${player.seen ? '<i class="zjh-tag seen">明</i>' : ""}</div><div class="zjh-seat-points">◆ ${player.points.toLocaleString()} · 已投 ${player.totalBet}</div>${handBadge}<div class="zjh-seat-status">${escapeHTML(status)}</div></div></div>`;
  }).join("");
  if (animateDeal) animatedHandNumber = state.handNumber;
}

function renderOwnCards(player) {
  const showCards = state.phase === "result" || player?.seen;
  $("#zjh-own-cards").innerHTML = player?.cardCount ? (showCards ? player.cards.map(cardHTML).join("") : Array.from({ length: player.cardCount }, () => cardHTML(null)).join("")) : "";
  $("#zjh-hand-name").textContent = state.phase === "result" && player?.hand ? player.hand.name : player?.seen ? "已看牌" : player?.cardCount === 3 ? "三张暗牌" : "尚未发牌";
}

function renderSidebar() {
  const chats = state.messages.filter((message) => message.type === "chat");
  const logs = state.messages.filter((message) => message.type === "system");
  $("#zjh-chat-count").textContent = chats.length;
  $("#zjh-chat-list").innerHTML = chats.length ? chats.map((message) => `<div class="niu-message chat"><b>${escapeHTML(message.name)}</b>${escapeHTML(message.text)}</div>`).join("") : '<div class="niu-message">还没有聊天消息</div>';
  $("#zjh-activity-list").innerHTML = logs.map((message) => `<div class="niu-message system">${escapeHTML(message.text)}</div>`).join("");
  $("#zjh-player-list").innerHTML = state.players.map((player) => `<div class="niu-player-row"><div><strong>${escapeHTML(player.name)}${player.id === state.hostId ? " · 房主" : ""}</strong><span>${escapeHTML(player.status)}</span></div><b>◆ ${player.points.toLocaleString()}</b></div>`).join("");
  $("#zjh-chat-list").scrollTop = $("#zjh-chat-list").scrollHeight;
  $("#zjh-activity-list").scrollTop = $("#zjh-activity-list").scrollHeight;
}

function renderAdmin() {
  if (!state || me !== state.hostId) return;
  $("#zjh-admin-list").innerHTML = state.players.map((player) => `<div class="admin-player-row" data-player-id="${player.id}"><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}</strong><input data-zjh-points type="number" min="0" value="${player.points}" /><button data-zjh-kick ${player.id === me ? "disabled" : ""}>${player.id === me ? "房主" : "剔除"}</button></div>`).join("");
}

function cardHTML(card, dealing = false) {
  if (!card) return `<div class="zjh-card back ${dealing ? "dealing" : ""}"></div>`;
  const red = card.suit === "h" || card.suit === "d";
  return `<div class="zjh-card ${red ? "red" : ""} ${dealing ? "dealing" : ""}">${card.rank === "T" ? "10" : card.rank}<small>${({ s: "♠", h: "♥", d: "♦", c: "♣" })[card.suit]}</small></div>`;
}
function phaseName(phase) { return ({ waiting: "等待", playing: "下注中", result: "结算" })[phase] || phase; }

function updateTurnTimer() {
  const timer = $("#zjh-turn-timer");
  if (!state?.actionDeadline || state.paused || state.phase !== "playing") return timer.classList.add("hidden");
  const total = state.settings.decisionTimeSeconds || 30;
  const remaining = Math.max(0, Math.ceil((state.actionDeadline - (Date.now() + serverClockOffset)) / 1000));
  timer.querySelector("strong").textContent = remaining;
  timer.style.setProperty("--progress", `${Math.max(0, Math.min(100, remaining / total * 100))}%`);
  timer.classList.toggle("warning", remaining <= 10);
  timer.classList.remove("hidden");
}
setInterval(updateTurnTimer, 250);

$("#zjh-look").addEventListener("click", async () => { const response = await emit("zjh:look"); if (!response.ok) toast(response.error); });
$("#zjh-call").addEventListener("click", () => sendAction("call"));
$("#zjh-fold").addEventListener("click", () => sendAction("fold"));
$("#zjh-raise").addEventListener("click", () => sendAction("raise", { amount: $("#zjh-raise-unit").value }));
$("#zjh-raise-unit").addEventListener("input", render);
async function sendAction(action, extra = {}) { const response = await emit("zjh:action", { action, ...extra }); if (!response.ok) toast(response.error); }

$("#zjh-compare").addEventListener("click", () => {
  const opponents = state.players.filter((player) => player.cardCount === 3 && !player.folded && player.id !== me);
  $("#zjh-compare-list").innerHTML = opponents.map((player) => `<button class="zjh-compare-option" data-target-id="${player.id}"><strong>${escapeHTML(player.name)}</strong><span>${player.seen ? "明牌" : "暗牌"} · ◆ ${player.points}</span></button>`).join("");
  $("#zjh-compare-modal").classList.remove("hidden");
});
$("#zjh-compare-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-target-id]");
  if (!button) return;
  $("#zjh-compare-modal").classList.add("hidden");
  await sendAction("compare", { targetId: button.dataset.targetId });
});
$("#zjh-close-compare").addEventListener("click", () => $("#zjh-compare-modal").classList.add("hidden"));
$("#zjh-start").addEventListener("click", async () => { const response = await emit("zjh:start"); if (!response.ok) toast(response.error); });
$("#zjh-reseat").addEventListener("click", () => openSeatModal(true));
$("#zjh-away").addEventListener("click", async () => { const player = state.players.find((candidate) => candidate.id === me); if (!player) return; const response = await emit("zjh:away", { away: !player.away }); if (!response.ok) toast(response.error); });
$("#zjh-mobile-away").addEventListener("click", () => $("#zjh-away").click());
$("#zjh-pause").addEventListener("click", async () => { const response = await emit("zjh:pause", { paused: !state.paused }); if (!response.ok) toast(response.error); });
async function toggleAutoStart() { const response = await emit("zjh:auto-start", { enabled: !state.settings.autoStartNextHand }); if (!response.ok) toast(response.error); }
$("#zjh-auto-start").addEventListener("click", toggleAutoStart);
$("#zjh-admin-auto").addEventListener("click", toggleAutoStart);

$("#zjh-chat-form").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#zjh-chat-input"); const response = await emit("zjh:chat", { text: input.value }); if (response.ok) input.value = ""; else toast(response.error); });
function switchTab(tab) { $$('[data-zjh-tab]').forEach((button) => button.classList.toggle("active", button.dataset.zjhTab === tab)); ["chat", "players", "activity"].forEach((name) => $(`#zjh-${name}-pane`).classList.toggle("hidden", name !== tab)); }
$$('[data-zjh-tab]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.zjhTab)));
$$('[data-zjh-mobile]').forEach((button) => button.addEventListener("click", () => { $$('[data-zjh-mobile]').forEach((item) => item.classList.toggle("active", item === button)); const tab = button.dataset.zjhMobile; $("#zjh-sidebar").classList.toggle("open", tab !== "table"); if (tab === "chat" || tab === "players") switchTab(tab); }));
$("#zjh-close-sidebar").addEventListener("click", () => $("#zjh-sidebar").classList.remove("open"));

$("#zjh-rules-button").addEventListener("click", () => $("#zjh-rules").classList.remove("hidden"));
$("#zjh-close-rules").addEventListener("click", () => $("#zjh-rules").classList.add("hidden"));
$("#zjh-manage").addEventListener("click", () => $("#zjh-admin").classList.remove("hidden"));
$("#zjh-mobile-manage").addEventListener("click", () => $("#zjh-admin").classList.remove("hidden"));
$("#zjh-close-admin").addEventListener("click", () => $("#zjh-admin").classList.add("hidden"));
$("#zjh-admin-list").addEventListener("change", async (event) => { if (!event.target.matches("[data-zjh-points]")) return; const row = event.target.closest("[data-player-id]"); const response = await emit("zjh:host-points", { playerId: row.dataset.playerId, points: event.target.value }); if (!response.ok) toast(response.error); });
$("#zjh-admin-list").addEventListener("click", async (event) => { if (!event.target.matches("[data-zjh-kick]")) return; const row = event.target.closest("[data-player-id]"); if (!confirm("确定剔除该玩家吗？")) return; const response = await emit("zjh:kick", { playerId: row.dataset.playerId }); if (!response.ok) toast(response.error); });

$("#zjh-copy").addEventListener("click", async () => {
  const link = `${location.origin}/zjh/${roomId}`;
  try { await navigator.clipboard.writeText(link); toast("邀请链接已复制"); }
  catch {
    const input = document.createElement("textarea"); input.value = link; document.body.appendChild(input); input.select();
    try { document.execCommand("copy"); toast("邀请链接已复制"); } catch { prompt("复制邀请链接", link); }
    input.remove();
  }
});

if (roomId) openSeatModal();
