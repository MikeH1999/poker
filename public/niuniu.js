const socket = io();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roomMatch = location.pathname.match(/^\/niuniu\/([A-Za-z0-9_-]+)/);
let roomId = roomMatch?.[1]?.toUpperCase() || null;
let state = null;
let me = null;
let selectedSeat = null;
let toastTimer;
let serverClockOffset = 0;
let marqueeTimer = null;
let marqueePlayerId = null;
const bubbles = new Map();
const bubbleTimers = new Map();
const nameKey = "riverclub:niu:name";
const tokenKey = (id) => `riverclub:niu:token:${id}`;
const emit = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const escapeHTML = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function toast(text) {
  $("#niu-toast").textContent = text;
  $("#niu-toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#niu-toast").classList.remove("show"), 2300);
}

$("#niu-create-name").value = localStorage.getItem(nameKey) || "";
$("#niu-join-name").value = localStorage.getItem(nameKey) || "";

$("#niu-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#niu-create-name").value.trim();
  if (!name) return toast("请输入昵称");
  localStorage.setItem(nameKey, name);
  const response = await emit("niu:create", { name, settings: {
    startingPoints: $("#niu-starting-points").value,
    baseScore: $("#niu-base-score").value,
    maxPlayers: $("#niu-max-players").value,
    decisionTimeSeconds: $("#niu-decision-time").value,
  } });
  if (!response.ok) return toast(response.error);
  localStorage.setItem(tokenKey(response.roomId), response.token);
  location.href = `/niuniu/${response.roomId}`;
});

function showRoom() {
  $(".niu-header").classList.add("hidden");
  $("#niu-lobby").classList.add("hidden");
  $("#niu-room").classList.remove("hidden");
  $("#niu-room-id").textContent = roomId;
}

async function joinRoom(name = localStorage.getItem(nameKey) || "", points = $("#niu-join-points").value, seat = selectedSeat) {
  const response = await emit("niu:join", { roomId, name, points, seat, token: localStorage.getItem(tokenKey(roomId)) });
  if (!response.ok) {
    if (response.needsSeat) return openSeatModal(true);
    toast(response.error);
    if (response.error.includes("座位")) openSeatModal(Boolean(localStorage.getItem(tokenKey(roomId))));
    return false;
  }
  localStorage.setItem(tokenKey(roomId), response.token);
  localStorage.setItem(nameKey, name || localStorage.getItem(nameKey) || "玩家");
  me = response.playerId;
  $("#niu-join-modal").classList.add("hidden");
  return true;
}

async function openSeatModal(reseat = false) {
  selectedSeat = null;
  $("#niu-join-title").textContent = reseat ? "重新坐下" : "选择牛牛座位";
  $("#niu-seat-step").classList.remove("hidden");
  $("#niu-join-details").classList.add("hidden");
  $("#niu-join-modal").classList.remove("hidden");
  const preview = await emit("niu:preview", { roomId });
  if (!preview.ok) return toast(preview.error);
  $("#niu-picker-code").textContent = `ROOM ${preview.roomId}`;
  $("#niu-join-points").value = preview.defaultPoints || 1000;
  const occupied = new Map(preview.occupiedSeats.map((player) => [player.seat, player]));
  $("#niu-seat-options").innerHTML = Array.from({ length: 6 }, (_, seat) => {
    const player = occupied.get(seat);
    const full = !player && preview.remainingSlots === 0;
    return `<button type="button" class="niu-seat-choice ${player ? "occupied" : full ? "unavailable" : "available"}" data-seat="${seat}" data-pos="${seat}" ${player || full ? "disabled" : ""}><strong>${seat + 1}</strong><small>${player ? escapeHTML(player.name) : full ? "已满" : "空位"}</small></button>`;
  }).join("");
  $("#niu-seat-status").textContent = preview.inProgress ? `本局进行中，可入座并从下一局加入 · 剩余 ${preview.remainingSlots} 个名额` : `剩余 ${preview.remainingSlots} 个入座名额`;
}

$("#niu-seat-options").addEventListener("click", (event) => {
  const button = event.target.closest(".niu-seat-choice.available");
  if (!button) return;
  selectedSeat = Number(button.dataset.seat);
  $("#niu-selected-seat").textContent = selectedSeat + 1;
  $("#niu-seat-step").classList.add("hidden");
  $("#niu-join-details").classList.remove("hidden");
  $("#niu-join-name").focus();
});
$("#niu-back-seats").addEventListener("click", () => openSeatModal(Boolean(state?.viewer && !state.viewer.seated)));
$("#niu-join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (selectedSeat === null) return toast("请先选择座位");
  const name = $("#niu-join-name").value.trim();
  if (!name) return toast("请输入昵称");
  await joinRoom(name, $("#niu-join-points").value, selectedSeat);
});

if (roomId) {
  showRoom();
  if (localStorage.getItem(tokenKey(roomId))) joinRoom(); else openSeatModal(false);
}

socket.on("connect", () => { if (roomId && state) joinRoom(); });
socket.on("niu:state", (nextState) => {
  serverClockOffset = (nextState.serverTime || Date.now()) - Date.now();
  state = nextState;
  if (!me) me = state.viewer?.id;
  updateMarquee();
  render();
});
socket.on("niu:chat-bubble", ({ playerId, text, expiresAt }) => {
  bubbles.set(playerId, { text, expiresAt });
  clearTimeout(bubbleTimers.get(playerId));
  bubbleTimers.set(playerId, setTimeout(() => { if (bubbles.get(playerId)?.expiresAt === expiresAt) { bubbles.delete(playerId); renderSeats(); } }, Math.max(0, expiresAt - Date.now())));
  if (state) renderSeats();
});
socket.on("niu:kicked", ({ message }) => { localStorage.removeItem(tokenKey(roomId)); toast(message); setTimeout(() => location.href = "/niuniu", 1300); });

function render() {
  const player = state.players.find((candidate) => candidate.id === me);
  const isHost = me === state.hostId;
  const needsReseat = state.viewer && !state.viewer.seated;
  $("#niu-room-id").textContent = state.id;
  $("#niu-round").textContent = state.roundNumber ? `ROUND #${String(state.roundNumber).padStart(3, "0")} · ${phaseName(state.phase)}` : "等待开局";
  $("#niu-base").textContent = `底注 ${state.settings.baseScore}`;
  $("#niu-phase").textContent = phasePrompt(state.phase);
  const banker = state.players.find((candidate) => candidate.id === state.bankerId);
  $("#niu-banker-info").textContent = banker ? `庄家 ${banker.name} · 抢庄 ${state.bankerBid} 倍` : state.phase === "banker_select" ? `${state.bankerCandidates.length} 位最高倍数玩家中随机定庄` : "先发四张 · 再抢庄";
  $("#niu-player-count").textContent = state.players.filter((player) => player.seated !== false).length;
  $$(".host-only").forEach((element) => element.classList.toggle("hidden", !isHost));
  $("#niu-pause").textContent = state.paused ? "恢复" : "暂停";
  $("#niu-auto-start").textContent = `自动下一局：${state.settings.autoStartNextRound ? "开" : "关"}`;
  $("#niu-admin-auto").textContent = `自动下一局：${state.settings.autoStartNextRound ? "开" : "关"}`;
  $("#niu-away").textContent = player?.away ? "我回来了" : "暂时离座";
  $("#niu-away").classList.toggle("hidden", Boolean(needsReseat));
  $("#niu-mobile-away").classList.toggle("hidden", Boolean(needsReseat));
  renderSeats();
  renderOwnCards(player);
  renderSidebar();
  renderAdmin();
  const canStart = isHost && !state.paused && ["waiting", "result"].includes(state.phase);
  $("#niu-start").classList.toggle("hidden", !canStart);
  $("#niu-start").innerHTML = `${state.phase === "result" ? "开始下一局" : "开始发四张"} <b>→</b>`;
  $("#niu-reseat").classList.toggle("hidden", !needsReseat);
  const canBid = player && state.phase === "bid" && player.cardCount === 4 && player.bid === null && !state.paused;
  const canBet = player && state.phase === "bet" && player.id !== state.bankerId && player.cardCount === 4 && player.bet === null && !state.paused;
  $$('[data-niu-bid]').forEach((button) => { const multiplier = Number(button.dataset.niuBid); button.disabled = !canBid || (multiplier > 0 && player.points < state.settings.baseScore * multiplier); button.title = button.disabled && canBid ? "积分不足" : ""; });
  $$('[data-niu-bet]').forEach((button) => { const multiplier = Number(button.dataset.niuBet); button.disabled = !canBet || player.points < state.settings.baseScore * state.bankerBid * multiplier; button.title = button.disabled && canBet ? "积分不足" : ""; });
  $("#niu-bid-actions").classList.toggle("hidden", !canBid);
  $("#niu-bet-actions").classList.toggle("hidden", !canBet);
  $("#niu-action-message").classList.toggle("hidden", canBid || canBet || canStart || needsReseat);
  if (!canBid && !canBet && !canStart && !needsReseat) $("#niu-action-message").textContent = state.paused ? "游戏已暂停" : state.nextRoundAt ? "5 秒后自动开始下一局" : player?.status || "等待其他玩家";
  updatePhaseTimer();
}

function renderSeats() {
  if (!state) return;
  const viewerSeat = state.players.find((player) => player.id === me)?.seat;
  $("#niu-seats").innerHTML = state.players.map((player) => {
    const pos = viewerSeat === undefined ? player.seat : (player.seat - viewerSeat + 6) % 6;
    const dealing = state.phase === "deal" || state.phase === "fifth_deal";
    const cards = player.cards.length ? player.cards.map((card, index) => cardHTML(card, dealing && index === player.cardCount - 1)).join("") : Array.from({ length: player.cardCount }, (_, index) => cardHTML(null, dealing && index === player.cardCount - 1)).join("");
    const bubble = bubbles.get(player.id);
    const selecting = player.id === marqueePlayerId;
    const statusText = !player.connected ? "离线" : player.away ? "暂时离座" : player.status;
    const handBadge = player.hand ? `<div class="niu-hand-badge ${player.delta > 0 ? "win" : player.delta < 0 ? "lose" : ""}">${escapeHTML(player.hand.name)} <b>×${player.hand.multiplier}</b></div>` : "";
    return `<div class="niu-seat ${player.id === state.bankerId ? "banker" : ""} ${selecting ? "banker-marquee" : ""} ${player.delta > 0 ? "round-winner" : player.delta < 0 ? "round-loser" : ""}" data-pos="${pos}" data-seat="${player.seat}">${bubble && bubble.expiresAt > Date.now() ? `<div class="niu-bubble">${escapeHTML(bubble.text)}</div>` : ""}<div class="niu-seat-cards">${cards}</div><div class="niu-avatar">${escapeHTML(player.name[0] || "牛")}${selecting ? '<i class="floating-banker">庄</i>' : ""}</div><div class="niu-seat-box"><div class="niu-seat-name"><span>${escapeHTML(player.name)}</span>${player.id === state.bankerId ? '<i class="banker-tag">庄</i>' : ""}${player.rejoinCount ? `<i class="rebuy-tag">重坐×${player.rejoinCount}</i>` : ""}</div><div class="niu-seat-points">◆ ${player.points.toLocaleString()}${player.delta ? ` · ${player.delta > 0 ? "+" : ""}${player.delta}` : ""}</div>${handBadge}<div class="niu-seat-status">${escapeHTML(statusText)}</div></div></div>`;
  }).join("");
}

function renderOwnCards(player) {
  const dealing = state.phase === "deal" || state.phase === "fifth_deal";
  $("#niu-own-cards").innerHTML = (player?.cards || []).map((card, index, cards) => cardHTML(card, dealing && index === cards.length - 1)).join("");
  $("#niu-hand-name").textContent = player?.hand ? `${player.hand.name} ×${player.hand.multiplier}` : player?.cardCount === 4 ? "已看四张" : "等待发牌";
}

function renderSidebar() {
  const chats = state.messages.filter((message) => message.type === "chat");
  const logs = state.messages.filter((message) => message.type === "system");
  $("#niu-chat-count").textContent = chats.length;
  $("#niu-chat-list").innerHTML = chats.length ? chats.map((message) => `<div class="niu-message chat"><b>${escapeHTML(message.name)}</b>${escapeHTML(message.text)}</div>`).join("") : '<div class="niu-message">还没有聊天消息</div>';
  $("#niu-activity-list").innerHTML = logs.map((message) => `<div class="niu-message system">${escapeHTML(message.text)}</div>`).join("");
  $("#niu-player-list").innerHTML = state.players.map((player) => `<div class="niu-player-row"><div><strong>${escapeHTML(player.name)}${player.id === state.hostId ? " · 房主" : ""}</strong><span>${escapeHTML(player.status)}</span></div><b>◆ ${player.points.toLocaleString()}</b></div>`).join("");
  $("#niu-chat-list").scrollTop = $("#niu-chat-list").scrollHeight;
  $("#niu-activity-list").scrollTop = $("#niu-activity-list").scrollHeight;
}

function renderAdmin() {
  if (!state || me !== state.hostId) return;
  $("#niu-admin-list").innerHTML = state.players.filter((player) => player.seated !== false).map((player) => `<div class="admin-player-row" data-player-id="${player.id}"><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}</strong><input data-niu-points type="number" min="0" value="${player.points}" /><button data-niu-kick ${player.id === me ? "disabled" : ""}>${player.id === me ? "房主" : "剔除"}</button></div>`).join("");
}

function cardHTML(card, dealing = false) {
  if (!card) return `<div class="niu-card back ${dealing ? "dealing" : ""}"></div>`;
  const red = card.suit === "h" || card.suit === "d";
  return `<div class="niu-card ${red ? "red" : ""} ${dealing ? "dealing" : ""}">${card.rank === "T" ? "10" : card.rank}<small>${({ s: "♠", h: "♥", d: "♦", c: "♣" })[card.suit]}</small></div>`;
}
function phaseName(phase) { return ({ waiting: "等待", deal: "发四张", bid: "抢庄", banker_select: "随机定庄", bet: "下注", fifth_deal: "发第五张", reveal: "亮牌", result: "结算" })[phase] || phase; }
function phasePrompt(phase) { return ({ waiting: "等待房主开始", deal: "正在一张张发出四张牌", bid: "看四张 · 开始抢庄", banker_select: "同倍抢庄 · 随机定庄中", bet: "庄家已定 · 闲家下注", fifth_deal: "正在翻开第 5 张牌", reveal: "第五张已发 · 自动拼牌", result: "本局结算完成" })[phase] || "等待"; }

function updateMarquee() {
  const active = state?.phase === "banker_select" && state.bankerCandidates?.length;
  if (!active) {
    clearInterval(marqueeTimer);
    marqueeTimer = null;
    marqueePlayerId = null;
    return;
  }
  if (marqueeTimer) return;
  let index = 0;
  marqueePlayerId = state.bankerCandidates[0];
  marqueeTimer = setInterval(() => {
    if (state?.phase !== "banker_select") return updateMarquee();
    marqueePlayerId = state.bankerCandidates[index++ % state.bankerCandidates.length];
    renderSeats();
  }, 170);
}

function updatePhaseTimer() {
  const timer = $("#niu-phase-timer");
  if (!state?.phaseDeadline || state.paused || !["bid", "bet"].includes(state.phase)) return timer.classList.add("hidden");
  const total = state.settings.decisionTimeSeconds || 30;
  const remaining = Math.max(0, Math.ceil((state.phaseDeadline - (Date.now() + serverClockOffset)) / 1000));
  timer.querySelector("span").textContent = state.phase === "bid" ? "抢庄剩余" : "下注剩余";
  timer.querySelector("strong").textContent = remaining;
  timer.style.setProperty("--progress", `${Math.max(0, Math.min(100, remaining / total * 100))}%`);
  timer.classList.toggle("warning", remaining <= 10);
  timer.classList.remove("hidden");
}
setInterval(updatePhaseTimer, 250);

$$('[data-niu-bid]').forEach((button) => button.addEventListener("click", async () => { const response = await emit("niu:bid", { multiplier: button.dataset.niuBid }); if (!response.ok) toast(response.error); }));
$$('[data-niu-bet]').forEach((button) => button.addEventListener("click", async () => { const response = await emit("niu:bet", { multiplier: button.dataset.niuBet }); if (!response.ok) toast(response.error); }));
$("#niu-start").addEventListener("click", async () => { const response = await emit("niu:start"); if (!response.ok) toast(response.error); });
$("#niu-reseat").addEventListener("click", () => openSeatModal(true));
$("#niu-away").addEventListener("click", async () => { const player = state.players.find((candidate) => candidate.id === me); if (!player) return; const response = await emit("niu:away", { away: !player.away }); if (!response.ok) toast(response.error); });
$("#niu-mobile-away").addEventListener("click", () => $("#niu-away").click());
$("#niu-pause").addEventListener("click", async () => { const response = await emit("niu:pause", { paused: !state.paused }); if (!response.ok) toast(response.error); });
async function toggleAutoStart() { const response = await emit("niu:auto-start", { enabled: !state.settings.autoStartNextRound }); if (!response.ok) toast(response.error); }
$("#niu-auto-start").addEventListener("click", toggleAutoStart);
$("#niu-admin-auto").addEventListener("click", toggleAutoStart);

$("#niu-chat-form").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#niu-chat-input"); const response = await emit("niu:chat", { text: input.value }); if (response.ok) input.value = ""; else toast(response.error); });
function switchTab(tab) { $$('[data-niu-tab]').forEach((button) => button.classList.toggle("active", button.dataset.niuTab === tab)); ["chat", "players", "activity"].forEach((name) => $(`#niu-${name}-pane`).classList.toggle("hidden", name !== tab)); }
$$('[data-niu-tab]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.niuTab)));
$$('[data-niu-mobile]').forEach((button) => button.addEventListener("click", () => { $$('[data-niu-mobile]').forEach((item) => item.classList.toggle("active", item === button)); const tab = button.dataset.niuMobile; $("#niu-sidebar").classList.toggle("open", tab !== "table"); if (tab === "chat" || tab === "players") switchTab(tab); }));
$("#niu-close-sidebar").addEventListener("click", () => $("#niu-sidebar").classList.remove("open"));

$("#rules-button").addEventListener("click", () => $("#niu-rules").classList.remove("hidden"));
$("#close-rules").addEventListener("click", () => $("#niu-rules").classList.add("hidden"));
$("#niu-manage").addEventListener("click", () => $("#niu-admin").classList.remove("hidden"));
$("#niu-mobile-manage").addEventListener("click", () => $("#niu-admin").classList.remove("hidden"));
$("#close-niu-admin").addEventListener("click", () => $("#niu-admin").classList.add("hidden"));
$("#niu-admin-list").addEventListener("change", async (event) => { if (!event.target.matches("[data-niu-points]")) return; const row = event.target.closest("[data-player-id]"); const response = await emit("niu:host-points", { playerId: row.dataset.playerId, points: event.target.value }); if (!response.ok) toast(response.error); });
$("#niu-admin-list").addEventListener("click", async (event) => { if (!event.target.matches("[data-niu-kick]")) return; const row = event.target.closest("[data-player-id]"); if (!confirm("确定剔除该玩家吗？")) return; const response = await emit("niu:kick", { playerId: row.dataset.playerId }); if (!response.ok) toast(response.error); });

$("#niu-copy").addEventListener("click", async () => {
  const link = `${location.origin}/niuniu/${state?.id || roomId}`;
  let copied = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(link); copied = true; } } catch {}
  if (!copied) { const area = document.createElement("textarea"); area.value = link; area.style.cssText = "position:fixed;left:-9999px"; document.body.appendChild(area); area.select(); try { copied = document.execCommand("copy"); } catch {} area.remove(); }
  toast(copied ? "邀请链接已复制" : "浏览器禁止复制，请长按地址栏");
});
