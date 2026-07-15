const socket = io();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const roomMatch = location.pathname.match(/^\/doudizhu\/([A-Za-z0-9_-]+)/);
let roomId = roomMatch?.[1]?.toUpperCase() || null;
let state = null;
let me = null;
let selectedSeat = null;
let serverClockOffset = 0;
let toastTimer;
const selectedCards = new Set();
const bubbles = new Map();
const bubbleTimers = new Map();
const nameKey = "riverclub:ddz:name";
const tokenKey = (id) => `riverclub:ddz:token:${id}`;
const emit = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const escapeHTML = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);

function toast(text) {
  const element = $("#ddz-toast"); element.textContent = text; element.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
}

$("#ddz-create-name").value = localStorage.getItem(nameKey) || "";
$("#ddz-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#ddz-create-name").value.trim();
  const response = await emit("ddz:create", { name, settings: { startingPoints: $("#ddz-starting-points").value, baseScore: $("#ddz-base-score").value, decisionTimeSeconds: $("#ddz-decision-time").value } });
  if (!response.ok) return toast(response.error);
  roomId = response.roomId; me = response.playerId;
  localStorage.setItem(nameKey, name); localStorage.setItem(tokenKey(roomId), response.token);
  history.replaceState({}, "", `/doudizhu/${roomId}`); showRoom(); if (state) render();
});

function showRoom() { $("#ddz-lobby").classList.add("hidden"); $(".niu-header").classList.add("hidden"); $("#ddz-room").classList.remove("hidden"); }

async function joinRoom(name = localStorage.getItem(nameKey) || "", points = $("#ddz-join-points").value, seat = selectedSeat) {
  const response = await emit("ddz:join", { roomId, name, points, seat, token: localStorage.getItem(tokenKey(roomId)) });
  if (!response.ok) return toast(response.error);
  me = response.playerId; localStorage.setItem(nameKey, name); localStorage.setItem(tokenKey(roomId), response.token);
  $("#ddz-join-modal").classList.add("hidden"); showRoom(); if (state) render();
}

async function openSeatModal(reseat = false) {
  const preview = await emit("ddz:preview", { roomId });
  if (!preview.ok) { toast(preview.error); if (!reseat) setTimeout(() => location.href = "/doudizhu", 1200); return; }
  selectedSeat = null; $("#ddz-picker-code").textContent = roomId;
  $("#ddz-seat-step").classList.remove("hidden"); $("#ddz-join-details").classList.add("hidden");
  $("#ddz-join-points").value = preview.defaultPoints; $("#ddz-join-points").min = preview.baseScore;
  $("#ddz-join-name").value = localStorage.getItem(nameKey) || "";
  const occupied = new Map(preview.occupiedSeats.map((item) => [item.seat, item.name]));
  $("#ddz-seat-options").innerHTML = Array.from({ length: 3 }, (_, seat) => { const name = occupied.get(seat); return `<button type="button" class="ddz-seat-choice ${name ? "occupied" : "available"}" data-seat="${seat}" data-pos="${seat}" ${name ? "disabled" : ""}><strong>${seat + 1}</strong><small>${name ? escapeHTML(name) : "空位"}</small></button>`; }).join("");
  $("#ddz-seat-status").textContent = preview.remainingSlots ? `还有 ${preview.remainingSlots} 个空位${preview.inProgress ? " · 本局进行中，下局加入" : ""}` : "房间已满";
  $("#ddz-join-modal").classList.remove("hidden");
}

$("#ddz-seat-options").addEventListener("click", (event) => { const button = event.target.closest("[data-seat]"); if (!button || button.disabled) return; selectedSeat = Number(button.dataset.seat); $("#ddz-selected-seat").textContent = selectedSeat + 1; $("#ddz-seat-step").classList.add("hidden"); $("#ddz-join-details").classList.remove("hidden"); $("#ddz-join-name").focus(); });
$("#ddz-back-seats").addEventListener("click", () => openSeatModal(Boolean(state?.viewer && !state.viewer.seated)));
$("#ddz-close-join").addEventListener("click", () => { if (state) $("#ddz-join-modal").classList.add("hidden"); });
$("#ddz-join-form").addEventListener("submit", async (event) => { event.preventDefault(); if (selectedSeat === null) return toast("请先选择座位"); await joinRoom($("#ddz-join-name").value.trim(), $("#ddz-join-points").value, selectedSeat); });

socket.on("connect", () => { if (roomId && state) joinRoom(); });
socket.on("ddz:state", (nextState) => {
  state = nextState; serverClockOffset = nextState.serverTime - Date.now();
  if (!me && nextState.viewer?.id) me = nextState.viewer.id;
  const ownIds = new Set(nextState.players.find((player) => player.id === me)?.cards.map((card) => card.id) || []);
  for (const id of selectedCards) if (!ownIds.has(id)) selectedCards.delete(id);
  showRoom(); render();
});
socket.on("ddz:chat-bubble", ({ playerId, text, expiresAt }) => { bubbles.set(playerId, { text, expiresAt }); clearTimeout(bubbleTimers.get(playerId)); bubbleTimers.set(playerId, setTimeout(() => { bubbles.delete(playerId); if (state) renderSeats(); }, Math.max(0, expiresAt - Date.now()))); if (state) renderSeats(); });
socket.on("ddz:kicked", ({ message }) => { localStorage.removeItem(tokenKey(roomId)); toast(message); setTimeout(() => location.href = "/doudizhu", 1300); });

function render() {
  if (!state) return;
  const player = state.players.find((candidate) => candidate.id === me);
  const isHost = me === state.hostId;
  const needsReseat = state.viewer && !state.viewer.seated;
  const myBid = state.phase === "bidding" && state.bidPlayerId === me && !state.paused;
  const myTurn = state.phase === "playing" && state.actionPlayerId === me && !state.paused;
  $("#ddz-room-id").textContent = state.id;
  $("#ddz-round").textContent = state.handNumber ? `HAND #${String(state.handNumber).padStart(3,"0")} · ${phaseName(state.phase)}` : "等待开局";
  $("#ddz-base-info").textContent = `底分 ${state.settings.baseScore} · 叫分 ${state.highestBid || "—"}`;
  $("#ddz-multiplier").textContent = `倍数 ×${state.multiplier}`;
  $("#ddz-phase-label").textContent = phaseName(state.phase);
  $("#ddz-center-title").textContent = state.result?.text || (state.phase === "bidding" ? `当前最高 ${state.highestBid || 0} 分` : state.phase === "playing" ? state.previousPlay ? "请压过上一手" : "新一轮 · 请领出" : "等待房主开始");
  $("#ddz-center-message").textContent = state.phase === "bidding" ? `${state.players.find((item) => item.id === state.bidPlayerId)?.name || "玩家"} 正在叫地主` : state.phase === "playing" ? `${state.players.find((item) => item.id === state.actionPlayerId)?.name || "玩家"} 正在出牌` : state.nextHandAt ? "5 秒后自动开始下一局" : "凑齐三人即可开局";
  $("#ddz-player-count").textContent = state.players.length;
  $$(".host-only").forEach((element) => element.classList.toggle("hidden", !isHost));
  $("#ddz-pause").textContent = state.paused ? "恢复" : "暂停";
  $("#ddz-auto-start").textContent = `自动下一局：${state.settings.autoStartNextHand ? "开" : "关"}`;
  $("#ddz-admin-auto").textContent = `自动下一局：${state.settings.autoStartNextHand ? "开" : "关"}`;
  $("#ddz-away").textContent = player?.away ? "我回来了" : "暂时离座";
  $("#ddz-away").classList.toggle("hidden", Boolean(needsReseat) || ["bidding","playing"].includes(state.phase));
  $("#ddz-mobile-away").classList.toggle("hidden", Boolean(needsReseat) || ["bidding","playing"].includes(state.phase));
  renderSeats(); renderCenter(); renderOwnCards(player); renderSidebar(); renderAdmin();
  const canStart = isHost && !state.paused && ["waiting","result"].includes(state.phase);
  $("#ddz-start").classList.toggle("hidden", !canStart); $("#ddz-start").innerHTML = `${state.phase === "result" ? "开始下一局" : "开始发牌"} <b>→</b>`;
  $("#ddz-reseat").classList.toggle("hidden", !needsReseat);
  $("#ddz-bid-actions").classList.toggle("hidden", !myBid);
  $$('[data-bid]').forEach((button) => { const score = Number(button.dataset.bid); button.disabled = !myBid || score > 0 && score <= state.highestBid; });
  $("#ddz-play-actions").classList.toggle("hidden", !myTurn);
  $("#ddz-pass").disabled = !state.previousPlay || state.previousPlay.playerId === me;
  $("#ddz-play").disabled = selectedCards.size === 0;
  $("#ddz-action-message").classList.toggle("hidden", myBid || myTurn || canStart || needsReseat);
  if (!myBid && !myTurn && !canStart && !needsReseat) $("#ddz-action-message").textContent = state.paused ? "游戏已暂停" : player?.status || "等待其他玩家";
  updateTurnTimer();
}

function renderSeats() {
  const viewerSeat = state.players.find((player) => player.id === me)?.seat;
  $("#ddz-seats").innerHTML = state.players.map((player) => {
    const pos = viewerSeat === undefined ? player.seat : (player.seat - viewerSeat + 3) % 3;
    const bubble = bubbles.get(player.id); const role = state.landlordId ? player.id === state.landlordId ? "地主" : "农民" : null;
    const reveal = state.phase === "result" && player.cards.length ? `<div class="ddz-seat-reveal">${player.cards.map(cardHTML).join("")}</div>` : "";
    return `<div class="ddz-seat ${player.id === state.landlordId ? "landlord" : ""} ${player.id === (state.actionPlayerId || state.bidPlayerId) ? "turn" : ""} ${player.id === state.result?.winnerId ? "winner" : ""}" data-pos="${pos}">${bubble && bubble.expiresAt > Date.now() ? `<div class="ddz-bubble">${escapeHTML(bubble.text)}</div>` : ""}${reveal}<div class="ddz-avatar">${escapeHTML(player.name[0] || "斗")}<i class="ddz-card-count">${player.cardCount}</i></div><div class="ddz-seat-box"><div class="ddz-seat-name"><span>${escapeHTML(player.name)}</span>${role ? `<i class="ddz-role-tag ${role === "农民" ? "farmer" : ""}">${role}</i>` : ""}</div><div class="ddz-seat-points">◆ ${player.points.toLocaleString()}${player.delta ? ` · ${player.delta > 0 ? "+" : ""}${player.delta}` : ""}</div><div class="ddz-seat-status">${escapeHTML(!player.connected ? "离线" : player.status)}</div></div></div>`;
  }).join("");
}

function renderCenter() {
  $("#ddz-bottom-cards").innerHTML = state.bottomCardCount ? (state.bottomCards.length ? state.bottomCards.map(cardHTML).join("") : Array.from({ length: state.bottomCardCount }, () => cardHTML(null)).join("")) : "";
  $("#ddz-last-play").innerHTML = state.previousPlay ? state.previousPlay.cards.map(cardHTML).join("") : "";
}

function renderOwnCards(player) {
  $("#ddz-own-cards").innerHTML = (player?.cards || []).map((card) => `<button class="ddz-card ${cardClass(card)} ${selectedCards.has(card.id) ? "selected" : ""}" data-card-id="${card.id}">${cardContent(card)}</button>`).join("");
}

function renderSidebar() {
  const chats = state.messages.filter((message) => message.type === "chat"), logs = state.messages.filter((message) => message.type === "system");
  $("#ddz-chat-count").textContent = chats.length;
  $("#ddz-chat-list").innerHTML = chats.length ? chats.map((message) => `<div class="niu-message chat"><b>${escapeHTML(message.name)}</b>${escapeHTML(message.text)}</div>`).join("") : '<div class="niu-message">还没有聊天消息</div>';
  $("#ddz-activity-list").innerHTML = logs.map((message) => `<div class="niu-message system">${escapeHTML(message.text)}</div>`).join("");
  $("#ddz-player-list").innerHTML = state.players.map((player) => `<div class="niu-player-row"><div><strong>${escapeHTML(player.name)}${player.id === state.hostId ? " · 房主" : ""}</strong><span>${escapeHTML(player.status)}</span></div><b>◆ ${player.points.toLocaleString()}</b></div>`).join("");
  $("#ddz-chat-list").scrollTop = $("#ddz-chat-list").scrollHeight; $("#ddz-activity-list").scrollTop = $("#ddz-activity-list").scrollHeight;
}

function renderAdmin() { if (!state || me !== state.hostId) return; $("#ddz-admin-list").innerHTML = state.players.map((player) => `<div class="admin-player-row" data-player-id="${player.id}"><strong>${escapeHTML(player.name)}${player.id === me ? "（你）" : ""}</strong><input data-ddz-points type="number" min="0" value="${player.points}" /><button data-ddz-kick ${player.id === me ? "disabled" : ""}>${player.id === me ? "房主" : "剔除"}</button></div>`).join(""); }

function cardClass(card) { return !card ? "back" : card.suit === "joker" ? `joker ${card.rank === "RJ" ? "red" : ""}` : card.suit === "h" || card.suit === "d" ? "red" : ""; }
function cardContent(card) { if (card.suit === "joker") return card.rank === "RJ" ? "大王" : "小王"; return `${card.rank === "T" ? "10" : card.rank}<small>${({s:"♠",h:"♥",d:"♦",c:"♣"})[card.suit]}</small>`; }
function cardHTML(card) { if (!card) return '<div class="ddz-card back"></div>'; return `<div class="ddz-card ${cardClass(card)}">${cardContent(card)}</div>`; }
function phaseName(phase) { return ({waiting:"等待",bidding:"叫地主",playing:"出牌中",result:"结算"})[phase] || phase; }

function updateTurnTimer() { const timer=$("#ddz-turn-timer"); if(!state?.actionDeadline||state.paused||!["bidding","playing"].includes(state.phase))return timer.classList.add("hidden"); const total=state.settings.decisionTimeSeconds||30; const remaining=Math.max(0,Math.ceil((state.actionDeadline-(Date.now()+serverClockOffset))/1000)); timer.querySelector("strong").textContent=remaining; timer.style.setProperty("--progress",`${Math.max(0,Math.min(100,remaining/total*100))}%`); timer.classList.toggle("warning",remaining<=10); timer.classList.remove("hidden"); }
setInterval(updateTurnTimer,250);

$("#ddz-own-cards").addEventListener("click", (event) => { const card=event.target.closest("[data-card-id]"); if(!card)return; const id=card.dataset.cardId; if(selectedCards.has(id))selectedCards.delete(id);else selectedCards.add(id); renderOwnCards(state.players.find((player)=>player.id===me)); $("#ddz-play").disabled=selectedCards.size===0; });
$$('[data-bid]').forEach((button)=>button.addEventListener("click",async()=>{const response=await emit("ddz:bid",{score:button.dataset.bid});if(!response.ok)toast(response.error);}));
$("#ddz-clear").addEventListener("click",()=>{selectedCards.clear();renderOwnCards(state.players.find((player)=>player.id===me));$("#ddz-play").disabled=true;});
$("#ddz-play").addEventListener("click",async()=>{const response=await emit("ddz:play",{cardIds:[...selectedCards]});if(response.ok)selectedCards.clear();else toast(response.error);});
$("#ddz-pass").addEventListener("click",async()=>{const response=await emit("ddz:pass");if(response.ok)selectedCards.clear();else toast(response.error);});
$("#ddz-start").addEventListener("click",async()=>{const response=await emit("ddz:start");if(!response.ok)toast(response.error);});
$("#ddz-reseat").addEventListener("click",()=>openSeatModal(true));
$("#ddz-away").addEventListener("click",async()=>{const player=state.players.find((item)=>item.id===me);const response=await emit("ddz:away",{away:!player.away});if(!response.ok)toast(response.error);});
$("#ddz-mobile-away").addEventListener("click",()=>$("#ddz-away").click());
$("#ddz-pause").addEventListener("click",async()=>{const response=await emit("ddz:pause",{paused:!state.paused});if(!response.ok)toast(response.error);});
async function toggleAuto(){const response=await emit("ddz:auto-start",{enabled:!state.settings.autoStartNextHand});if(!response.ok)toast(response.error);}
$("#ddz-auto-start").addEventListener("click",toggleAuto);$("#ddz-admin-auto").addEventListener("click",toggleAuto);
$("#ddz-chat-form").addEventListener("submit",async(event)=>{event.preventDefault();const input=$("#ddz-chat-input");const response=await emit("ddz:chat",{text:input.value});if(response.ok)input.value="";else toast(response.error);});
function switchTab(tab){$$('[data-ddz-tab]').forEach((button)=>button.classList.toggle("active",button.dataset.ddzTab===tab));["chat","players","activity"].forEach((name)=>$(`#ddz-${name}-pane`).classList.toggle("hidden",name!==tab));}
$$('[data-ddz-tab]').forEach((button)=>button.addEventListener("click",()=>switchTab(button.dataset.ddzTab)));
$$('[data-ddz-mobile]').forEach((button)=>button.addEventListener("click",()=>{$$('[data-ddz-mobile]').forEach((item)=>item.classList.toggle("active",item===button));const tab=button.dataset.ddzMobile;$("#ddz-sidebar").classList.toggle("open",tab!=="table");if(tab==="chat"||tab==="players")switchTab(tab);}));
$("#ddz-close-sidebar").addEventListener("click",()=>$("#ddz-sidebar").classList.remove("open"));
$("#ddz-rules-button").addEventListener("click",()=>$("#ddz-rules").classList.remove("hidden"));$("#ddz-close-rules").addEventListener("click",()=>$("#ddz-rules").classList.add("hidden"));
$("#ddz-manage").addEventListener("click",()=>$("#ddz-admin").classList.remove("hidden"));$("#ddz-mobile-manage").addEventListener("click",()=>$("#ddz-admin").classList.remove("hidden"));$("#ddz-close-admin").addEventListener("click",()=>$("#ddz-admin").classList.add("hidden"));
$("#ddz-admin-list").addEventListener("change",async(event)=>{if(!event.target.matches("[data-ddz-points]"))return;const row=event.target.closest("[data-player-id]");const response=await emit("ddz:host-points",{playerId:row.dataset.playerId,points:event.target.value});if(!response.ok)toast(response.error);});
$("#ddz-admin-list").addEventListener("click",async(event)=>{if(!event.target.matches("[data-ddz-kick]"))return;const row=event.target.closest("[data-player-id]");if(!confirm("确定剔除该玩家吗？"))return;const response=await emit("ddz:kick",{playerId:row.dataset.playerId});if(!response.ok)toast(response.error);});
$("#ddz-copy").addEventListener("click",async()=>{const link=`${location.origin}/doudizhu/${roomId}`;try{await navigator.clipboard.writeText(link);toast("邀请链接已复制");}catch{const input=document.createElement("textarea");input.value=link;document.body.appendChild(input);input.select();try{document.execCommand("copy");toast("邀请链接已复制");}catch{prompt("复制邀请链接",link);}input.remove();}});
if(roomId)openSeatModal();
