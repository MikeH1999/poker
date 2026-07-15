import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import { evaluateZjhHand, compareZjhCards } from "./game/zjh-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "portal.html")));
app.get("/holdem", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/room/:id", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/niuniu", (_req, res) => res.sendFile(join(__dirname, "public", "niuniu.html")));
app.get("/niuniu/:id", (_req, res) => res.sendFile(join(__dirname, "public", "niuniu.html")));
app.get("/zjh", (_req, res) => res.sendFile(join(__dirname, "public", "zjh.html")));
app.get("/zjh/:id", (_req, res) => res.sendFile(join(__dirname, "public", "zjh.html")));
app.use(express.static(join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size, holdemRooms: rooms.size, niuniuRooms: niuRooms.size, zjhRooms: zjhRooms.size }));

const rooms = new Map();
const niuRooms = new Map();
const zjhRooms = new Map();
const suits = ["s", "h", "d", "c"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

function roomId() {
  return randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();
}

function cleanName(name) {
  return String(name || "玩家").trim().replace(/[<>]/g, "").slice(0, 16) || "玩家";
}

function createDeck() {
  const deck = suits.flatMap((suit) => ranks.map((rank) => ({ rank, suit })));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom(ownerName, settings = {}) {
  let id;
  do id = roomId(); while (rooms.has(id));
  const room = {
    id,
    createdAt: Date.now(),
    hostId: null,
    players: [],
    messages: [],
    paused: false,
    autoStartTimer: null,
    nextHandAt: null,
    settings: {
      startingPoints: clamp(settings.startingPoints, 100, 100000, 1000),
      smallBlind: clamp(settings.smallBlind, 5, 1000, 10),
      bigBlind: clamp(settings.bigBlind, 10, 2000, 20),
      maxPlayers: clamp(settings.maxPlayers, 2, 8, 8),
      decisionTimeSeconds: clamp(settings.decisionTimeSeconds, 5, 120, 30),
      autoStartNextHand: Boolean(settings.autoStartNextHand),
    },
    hand: null,
    dealerSeat: -1,
    handNumber: 0,
  };
  const player = addPlayer(room, ownerName);
  room.hostId = player.id;
  rooms.set(id, room);
  return { room, player };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function addPlayer(room, name, requestedPoints, requestedSeat) {
  const taken = new Set(room.players.filter((p) => p.seated).map((p) => p.seat));
  let seat;
  if (requestedSeat === undefined || requestedSeat === null || requestedSeat === "") {
    seat = 0;
    while (taken.has(seat)) seat += 1;
  } else {
    seat = Number(requestedSeat);
    if (!Number.isInteger(seat) || seat < 0 || seat > 7) throw new Error("请选择有效座位");
    if (taken.has(seat)) throw new Error("该座位已被占用，请重新选择");
  }
  const player = {
    id: randomUUID(),
    token: randomBytes(18).toString("base64url"),
    socketId: null,
    name: cleanName(name),
    seat,
    points: clamp(requestedPoints, 100, 100000, room.settings.startingPoints),
    connected: true,
    holeCards: [],
    folded: false,
    bet: 0,
    totalBet: 0,
    acted: false,
    status: "等待中",
    away: false,
    seated: true,
    rejoinCount: 0,
  };
  room.players.push(player);
  return player;
}

function publicState(room, viewerId) {
  const hand = room.hand;
  const viewer = room.players.find((player) => player.id === viewerId);
  return {
    id: room.id,
    hostId: room.hostId,
    paused: room.paused,
    serverTime: Date.now(),
    nextHandAt: room.nextHandAt,
    settings: room.settings,
    handNumber: room.handNumber,
    viewer: viewer ? {
      id: viewer.id,
      seated: viewer.seated,
      rejoinCount: viewer.rejoinCount,
      status: viewer.status,
    } : null,
    players: room.players.filter((player) => player.seated).map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      points: player.points,
      connected: player.connected,
      folded: Boolean(hand && player.folded),
      bet: hand ? player.bet : 0,
      status: player.status,
      away: player.away,
      isTurn: Boolean(hand && hand.actionPlayerId === player.id),
      cards: player.id === viewerId ? player.holeCards : hand?.revealed?.[player.id] || [],
      cardCount: hand ? player.holeCards.length : 0,
      handName: player.id === viewerId || hand?.revealed?.[player.id] ? describeHand(player, hand) : null,
      rejoinCount: player.rejoinCount,
    })),
    hand: hand ? {
      phase: hand.phase,
      pot: hand.potTotal ?? room.players.reduce((sum, p) => sum + p.totalBet, 0),
      community: hand.community,
      currentBet: hand.currentBet,
      minRaise: hand.minRaise,
      actionPlayerId: hand.actionPlayerId,
      actionDeadline: hand.actionDeadline,
      dealerId: hand.dealerId,
      smallBlindId: hand.smallBlindId,
      bigBlindId: hand.bigBlindId,
      result: hand.result,
      runout: Boolean(hand.runout),
      equities: hand.equities || {},
    } : null,
    messages: room.messages.slice(-40),
  };
}

function broadcast(room) {
  for (const player of room.players) {
    if (player.socketId) io.to(player.socketId).emit("room:state", publicState(room, player.id));
  }
}

function systemMessage(room, text) {
  room.messages.push({ id: randomUUID(), type: "system", text, at: Date.now() });
}

function seated(room) {
  return room.players.filter((p) => p.seated && p.connected && !p.away && p.points > 0).sort((a, b) => a.seat - b.seat);
}

function nextFrom(list, startIndex, predicate = () => true) {
  for (let offset = 1; offset <= list.length; offset += 1) {
    const index = (startIndex + offset) % list.length;
    if (predicate(list[index])) return { player: list[index], index };
  }
  return null;
}

function takeBet(player, amount) {
  const paid = Math.max(0, Math.min(player.points, amount));
  player.points -= paid;
  player.bet += paid;
  player.totalBet += paid;
  return paid;
}

function clearActionTimer(hand) {
  if (!hand) return;
  if (hand.actionTimer) clearTimeout(hand.actionTimer);
  hand.actionTimer = null;
  hand.actionDeadline = null;
}

function armActionTimer(room) {
  const hand = room.hand;
  if (!hand || hand.result || !hand.actionPlayerId || room.paused) return;
  clearActionTimer(hand);
  const playerId = hand.actionPlayerId;
  hand.actionDeadline = Date.now() + room.settings.decisionTimeSeconds * 1000;
  hand.actionTimer = setTimeout(() => {
    if (room.hand !== hand || hand.result || hand.actionPlayerId !== playerId || room.paused) return;
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.folded) return;
    const action = hand.currentBet === player.bet ? "check" : "fold";
    try {
      act(room, player, action, undefined, { timedOut: true });
      broadcast(room);
    } catch { /* state changed at the deadline */ }
  }, room.settings.decisionTimeSeconds * 1000);
}

function setActionPlayer(room, player) {
  const hand = room.hand;
  clearActionTimer(hand);
  hand.actionPlayerId = player?.id || null;
  if (player) {
    player.status = "轮到你";
    armActionTimer(room);
  }
}

function startHand(room) {
  clearAutoStart(room);
  const active = seated(room);
  if (active.length < 2) throw new Error("至少需要 2 位有积分的在线玩家");
  room.handNumber += 1;
  room.dealerSeat = active.find((p) => p.seat > room.dealerSeat)?.seat ?? active[0].seat;
  const dealerIndex = active.findIndex((p) => p.seat === room.dealerSeat);
  const smallBlindIndex = active.length === 2 ? dealerIndex : (dealerIndex + 1) % active.length;
  const bigBlindIndex = (smallBlindIndex + 1) % active.length;
  const deck = createDeck();

  for (const player of room.players) {
    player.holeCards = active.includes(player) ? [deck.pop(), deck.pop()] : [];
    player.folded = !active.includes(player);
    player.bet = 0;
    player.totalBet = 0;
    player.acted = false;
    player.status = active.includes(player) ? "思考中" : !player.seated ? "积分耗尽，等待重新坐下" : player.away ? "暂时离座" : player.points <= 0 ? "积分不足" : "离线";
  }

  takeBet(active[smallBlindIndex], room.settings.smallBlind);
  takeBet(active[bigBlindIndex], room.settings.bigBlind);
  room.hand = {
    deck,
    phase: "preflop",
    community: [],
    currentBet: active[bigBlindIndex].bet,
    minRaise: room.settings.bigBlind,
    dealerId: active[dealerIndex].id,
    smallBlindId: active[smallBlindIndex].id,
    bigBlindId: active[bigBlindIndex].id,
    actionPlayerId: null,
    actionDeadline: null,
    actionTimer: null,
    result: null,
    revealed: {},
    runout: false,
    equities: {},
    potTotal: null,
  };
  const firstPlayer = active.length === 2
    ? active[dealerIndex]
    : nextFrom(active, bigBlindIndex, (p) => !p.folded && p.points > 0)?.player;
  setActionPlayer(room, firstPlayer);
  systemMessage(room, `第 ${room.handNumber} 手开始，盲注 ${room.settings.smallBlind}/${room.settings.bigBlind}`);
}

function contenders(room) {
  return room.players.filter((p) => room.hand && p.holeCards.length && !p.folded);
}

function pendingPlayers(room) {
  const hand = room.hand;
  return contenders(room).filter((p) => p.points > 0 && (!p.acted || p.bet !== hand.currentBet));
}

function nextAction(room, currentId) {
  const ordered = room.players.filter((p) => p.holeCards.length).sort((a, b) => a.seat - b.seat);
  const start = Math.max(0, ordered.findIndex((p) => p.id === currentId));
  return nextFrom(ordered, start, (p) => pendingPlayers(room).some((x) => x.id === p.id))?.player || null;
}

function act(room, player, action, amount, options = {}) {
  const hand = room.hand;
  if (!hand || hand.result) throw new Error("当前没有进行中的牌局");
  if (hand.actionPlayerId !== player.id) throw new Error("还没轮到你");
  if (player.folded) throw new Error("你已经弃牌");
  const callAmount = Math.max(0, hand.currentBet - player.bet);
  let label = "";

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
    player.status = "已弃牌";
    label = "弃牌";
  } else if (action === "check") {
    if (callAmount > 0) throw new Error("当前不能过牌");
    player.acted = true;
    player.status = "已过牌";
    label = "过牌";
  } else if (action === "call") {
    const paid = takeBet(player, callAmount);
    player.acted = true;
    player.status = player.points === 0 ? "全下" : "已跟注";
    label = paid < callAmount ? `全下 ${paid}` : `跟注 ${paid}`;
  } else if (action === "raise") {
    const maxTarget = player.bet + player.points;
    const target = clamp(amount, 0, maxTarget, hand.currentBet + hand.minRaise);
    const minTarget = hand.currentBet + hand.minRaise;
    if (target <= hand.currentBet) throw new Error("加注额必须高于当前下注");
    if (target < minTarget && target !== maxTarget) throw new Error(`最小加注到 ${minTarget}`);
    const previous = hand.currentBet;
    takeBet(player, target - player.bet);
    hand.currentBet = player.bet;
    hand.minRaise = Math.max(hand.minRaise, hand.currentBet - previous);
    for (const other of contenders(room)) if (other.id !== player.id && other.points > 0) other.acted = false;
    player.acted = true;
    player.status = player.points === 0 ? "全下" : "已加注";
    label = `${player.points === 0 ? "全下" : "加注到"} ${player.bet}`;
  } else if (action === "allin") {
    const target = player.bet + player.points;
    if (target <= hand.currentBet) {
      const paid = takeBet(player, player.points);
      player.acted = true;
      label = `全下 ${paid}`;
    } else {
      const previous = hand.currentBet;
      takeBet(player, player.points);
      hand.currentBet = player.bet;
      hand.minRaise = Math.max(hand.minRaise, hand.currentBet - previous);
      for (const other of contenders(room)) if (other.id !== player.id && other.points > 0) other.acted = false;
      player.acted = true;
      label = `全下到 ${player.bet}`;
    }
    player.status = "全下";
  } else {
    throw new Error("未知操作");
  }

  systemMessage(room, options.timedOut ? `${player.name} 思考超时，系统自动${label}` : `${player.name} ${label}`);
  progressHand(room, player.id);
}

function progressHand(room, currentId) {
  const hand = room.hand;
  const alive = contenders(room);
  if (alive.length === 1) {
    const winner = alive[0];
    const pot = room.players.reduce((sum, p) => sum + p.totalBet, 0);
    winner.points += pot;
    finishHand(room, `${winner.name} 赢得 ${pot} 积分`, [winner.id]);
    return;
  }

  if (pendingPlayers(room).length) {
    const next = nextAction(room, currentId);
    setActionPlayer(room, next);
    return;
  }

  if (hand.phase === "river") {
    showdown(room);
    return;
  }

  if (alive.filter((player) => player.points > 0).length <= 1) {
    scheduleRunout(room);
    return;
  }

  advanceStreet(room);

  const ordered = room.players.filter((p) => p.holeCards.length).sort((a, b) => a.seat - b.seat);
  const dealerIndex = ordered.findIndex((p) => p.id === hand.dealerId);
  const first = nextFrom(ordered, dealerIndex, (p) => !p.folded && p.points > 0)?.player;
  setActionPlayer(room, first);
}

function scheduleRunout(room) {
  const hand = room.hand;
  if (!hand || hand.result || hand.runout) return;
  clearActionTimer(hand);
  hand.runout = true;
  hand.actionPlayerId = null;
  for (const player of contenders(room)) {
    player.status = "等待逐张跑牌";
    hand.revealed[player.id] = player.holeCards;
  }
  hand.equities = calculateEquities(room);

  const tasks = [];
  if (hand.phase === "preflop") {
    tasks.push(
      { phase: "flop", burn: true, announce: "翻牌" },
      { phase: "flop" },
      { phase: "flop" },
    );
  }
  if (hand.phase === "preflop" || hand.phase === "flop") tasks.push({ phase: "turn", burn: true, announce: "转牌" });
  if (hand.phase !== "river") tasks.push({ phase: "river", burn: true, announce: "河牌" });

  let index = 0;
  const revealNext = () => {
    if (room.hand !== hand || hand.result) return;
    if (room.paused) {
      hand.runoutTimer = setTimeout(revealNext, 300);
      return;
    }
    const task = tasks[index];
    if (!task) {
      showdown(room);
      broadcast(room);
      return;
    }
    if (task.burn) hand.deck.pop();
    hand.phase = task.phase;
    hand.community.push(hand.deck.pop());
    hand.equities = calculateEquities(room);
    if (task.announce) systemMessage(room, task.announce);
    index += 1;
    broadcast(room);
    hand.runoutTimer = setTimeout(revealNext, 850);
  };

  systemMessage(room, "All-in，公共牌将逐张发出");
  hand.runoutTimer = setTimeout(revealNext, 600);
}

function calculateEquities(room) {
  const hand = room.hand;
  const players = contenders(room);
  if (!hand || players.length < 2) return {};
  const cardsNeeded = Math.max(0, 5 - hand.community.length);
  const deck = [...hand.deck];
  const simulations = cardsNeeded === 0 ? 1 : cardsNeeded === 1 ? deck.length : 1500;
  const shares = new Map(players.map((player) => [player.id, 0]));

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const pool = [...deck];
    const drawn = [];
    for (let index = 0; index < cardsNeeded; index += 1) {
      const randomIndex = index + Math.floor(Math.random() * (pool.length - index));
      [pool[index], pool[randomIndex]] = [pool[randomIndex], pool[index]];
      drawn.push(pool[index]);
    }
    const board = [...hand.community, ...drawn];
    const results = players.map((player) => ({ player, score: evaluateSeven([...player.holeCards, ...board]) }));
    results.sort((a, b) => compareScore(b.score, a.score));
    const winners = results.filter((result) => compareScore(result.score, results[0].score) === 0);
    for (const winner of winners) shares.set(winner.player.id, shares.get(winner.player.id) + 1 / winners.length);
  }

  return Object.fromEntries([...shares].map(([playerId, share]) => [playerId, Math.round(share / simulations * 1000) / 10]));
}

function advanceStreet(room, runout = false) {
  const hand = room.hand;
  for (const player of room.players) {
    player.bet = 0;
    player.acted = false;
    if (!player.folded && player.points > 0) player.status = runout ? "等待摊牌" : "思考中";
  }
  hand.currentBet = 0;
  hand.minRaise = room.settings.bigBlind;
  if (hand.phase === "preflop") {
    hand.deck.pop();
    hand.community.push(hand.deck.pop(), hand.deck.pop(), hand.deck.pop());
    hand.phase = "flop";
  } else if (hand.phase === "flop") {
    hand.deck.pop();
    hand.community.push(hand.deck.pop());
    hand.phase = "turn";
  } else if (hand.phase === "turn") {
    hand.deck.pop();
    hand.community.push(hand.deck.pop());
    hand.phase = "river";
  }
  systemMessage(room, ({ flop: "翻牌", turn: "转牌", river: "河牌" })[hand.phase]);
}

function showdown(room) {
  const hand = room.hand;
  clearActionTimer(hand);
  const alive = contenders(room);
  for (const player of alive) hand.revealed[player.id] = player.holeCards;
  const scores = new Map(alive.map((p) => [p.id, evaluateSeven([...p.holeCards, ...hand.community])]));
  const levels = [...new Set(room.players.map((p) => p.totalBet).filter(Boolean))].sort((a, b) => a - b);
  let previous = 0;
  const winIds = new Set();
  const payouts = new Map();

  for (const level of levels) {
    const contributors = room.players.filter((p) => p.totalBet >= level);
    const pot = (level - previous) * contributors.length;
    if (contributors.length === 1) {
      const uncalled = level - previous;
      contributors[0].points += uncalled;
      contributors[0].totalBet -= uncalled;
      systemMessage(room, `${contributors[0].name} 收回未被跟注的 ${uncalled} 积分`);
      previous = level;
      continue;
    }
    const eligible = alive.filter((p) => p.totalBet >= level);
    if (!eligible.length) continue;
    eligible.sort((a, b) => compareScore(scores.get(b.id), scores.get(a.id)));
    const best = scores.get(eligible[0].id);
    const winners = eligible.filter((p) => compareScore(scores.get(p.id), best) === 0);
    const share = Math.floor(pot / winners.length);
    let remainder = pot - share * winners.length;
    for (const winner of winners) {
      const awarded = share + (remainder-- > 0 ? 1 : 0);
      winner.points += awarded;
      payouts.set(winner.id, (payouts.get(winner.id) || 0) + awarded);
      winIds.add(winner.id);
    }
    previous = level;
  }
  const summaries = [...payouts].map(([playerId, amount]) => {
    const player = room.players.find((candidate) => candidate.id === playerId);
    return `${player.name} 以${scores.get(playerId).name}赢得 ${amount}`;
  });
  finishHand(room, summaries.join("；"), [...winIds]);
}

function finishHand(room, text, winnerIds) {
  clearActionTimer(room.hand);
  room.hand.actionPlayerId = null;
  room.hand.potTotal = room.players.reduce((sum, player) => sum + player.totalBet, 0);
  for (const player of room.players) {
    if (player.holeCards.length === 2) room.hand.revealed[player.id] = player.holeCards;
  }
  room.hand.result = { text, winnerIds };
  for (const player of room.players) {
    player.bet = 0;
    player.status = player.away ? "暂时离座" : winnerIds.includes(player.id) ? "本手获胜" : "等待下一手";
  }
  systemMessage(room, text);
  for (const player of room.players) {
    if (player.seated && player.points <= 0) unseatPlayer(room, player);
  }
  scheduleAutoStart(room);
}

function unseatPlayer(room, player) {
  if (!player.seated) return;
  player.seated = false;
  player.seat = null;
  player.away = false;
  player.status = "积分耗尽，等待重新坐下";
  systemMessage(room, `${player.name} 积分耗尽，座位已释放`);
}

function reseatPlayer(room, player, { name, points, seat }) {
  if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
  const numericSeat = Number(seat);
  if (!Number.isInteger(numericSeat) || numericSeat < 0 || numericSeat > 7) throw new Error("请选择有效座位");
  if (room.players.some((candidate) => candidate.seated && candidate.seat === numericSeat)) throw new Error("该座位已被占用，请重新选择");
  player.seated = true;
  player.seat = numericSeat;
  player.name = cleanName(name || player.name);
  player.points = clamp(points, 100, 100000, room.settings.startingPoints);
  player.rejoinCount += 1;
  player.away = false;
  player.holeCards = [];
  player.folded = Boolean(room.hand && !room.hand.result);
  player.bet = 0;
  player.totalBet = 0;
  player.acted = false;
  player.status = room.hand && !room.hand.result ? "下一手入座" : "等待中";
  systemMessage(room, `${player.name} 第 ${player.rejoinCount} 次重新坐下${player.status === "下一手入座" ? "，将从下一手加入" : ""}`);
}

function clearAutoStart(room) {
  if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
  room.autoStartTimer = null;
  room.nextHandAt = null;
}

function scheduleAutoStart(room) {
  clearAutoStart(room);
  if (!room.settings.autoStartNextHand || room.paused || !room.hand?.result) return;
  room.nextHandAt = Date.now() + 5000;
  systemMessage(room, "已开启自动发牌，5 秒后开始下一手");
  room.autoStartTimer = setTimeout(() => {
    room.autoStartTimer = null;
    room.nextHandAt = null;
    if (!room.settings.autoStartNextHand || room.paused || !room.hand?.result) return;
    try {
      startHand(room);
    } catch (error) {
      systemMessage(room, `自动发牌等待中：${error.message}`);
    }
    broadcast(room);
  }, 5000);
}

function describeHand(player, hand) {
  if (!hand || player.holeCards.length !== 2) return null;
  const cards = [...player.holeCards, ...hand.community];
  if (cards.length >= 5) return evaluateSeven(cards).name;
  if (hand.community.length > 0) return "等待完整翻牌";
  if (player.holeCards[0].rank === player.holeCards[1].rank) return `口袋对${displayRank(player.holeCards[0].rank)}`;
  const high = player.holeCards.reduce((best, card) => ranks.indexOf(card.rank) > ranks.indexOf(best.rank) ? card : best);
  return `${displayRank(high.rank)} 高牌`;
}

function displayRank(rank) {
  return ({ T: "10", J: "J", Q: "Q", K: "K", A: "A" })[rank] || rank;
}

function evaluateSeven(cards) {
  let best = null;
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) {
            const score = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(score, best) > 0) best = score;
          }
  return best;
}

function evaluateFive(cards) {
  const values = cards.map((c) => ranks.indexOf(c.rank) + 2).sort((a, b) => b - a);
  const counts = new Map(values.map((v) => [v, values.filter((x) => x === v).length]));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const unique = [...new Set(values)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let i = 0; i <= unique.length - 5; i += 1) if (unique[i] - unique[i + 4] === 4) straightHigh = Math.max(straightHigh, unique[i]);
  if (flush && straightHigh) return { category: 8, kickers: [straightHigh], name: "同花顺" };
  if (groups[0][1] === 4) return { category: 7, kickers: [groups[0][0], groups[1][0]], name: "四条" };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { category: 6, kickers: [groups[0][0], groups[1][0]], name: "葫芦" };
  if (flush) return { category: 5, kickers: values, name: "同花" };
  if (straightHigh) return { category: 4, kickers: [straightHigh], name: "顺子" };
  if (groups[0][1] === 3) return { category: 3, kickers: [groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)], name: "三条" };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { category: 2, kickers: [Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]], name: "两对" };
  if (groups[0][1] === 2) return { category: 1, kickers: [groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)], name: "一对" };
  return { category: 0, kickers: values, name: "高牌" };
}

function compareScore(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < length; i += 1) if ((a.kickers[i] || 0) !== (b.kickers[i] || 0)) return (a.kickers[i] || 0) - (b.kickers[i] || 0);
  return 0;
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, settings }, reply = () => {}) => {
    try {
      const { room, player } = createRoom(name, settings);
      player.socketId = socket.id;
      socket.join(room.id);
      socket.data = { roomId: room.id, playerId: player.id };
      reply({ ok: true, roomId: room.id, token: player.token, playerId: player.id });
      broadcast(room);
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("room:preview", ({ roomId: rawId }, reply = () => {}) => {
    try {
      const id = String(rawId || "").toUpperCase();
      const room = rooms.get(id);
      if (!room) throw new Error("房间不存在或已关闭");
      reply({
        ok: true,
        roomId: room.id,
        maxPlayers: room.settings.maxPlayers,
        remainingSlots: Math.max(0, room.settings.maxPlayers - room.players.filter((player) => player.seated).length),
        defaultPoints: room.settings.startingPoints,
        handInProgress: Boolean(room.hand && !room.hand.result),
        occupiedSeats: room.players.filter((player) => player.seated).map((player) => ({
          seat: player.seat,
          name: player.name,
          connected: player.connected,
        })),
      });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("room:join", ({ roomId: rawId, name, token, points, seat }, reply = () => {}) => {
    try {
      const id = String(rawId || "").toUpperCase();
      const room = rooms.get(id);
      if (!room) throw new Error("房间不存在或已关闭");
      let player = room.players.find((p) => p.token === token);
      if (player && !player.seated) {
        if (seat === undefined || seat === null || seat === "") return reply({ ok: false, needsSeat: true, error: "请重新选择座位" });
        reseatPlayer(room, player, { name, points, seat });
      } else if (!player) {
        if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
        if (seat === undefined || seat === null || seat === "") throw new Error("请先选择座位");
        player = addPlayer(room, name, points, seat);
        if (room.hand && !room.hand.result) {
          player.folded = true;
          player.status = "下一手入座";
          systemMessage(room, `${player.name} 已入座，将从下一手加入`);
        } else {
          systemMessage(room, `${player.name} 加入了牌桌`);
        }
      }
      player.socketId = socket.id;
      player.connected = true;
      if (name) player.name = cleanName(name);
      socket.join(room.id);
      socket.data = { roomId: room.id, playerId: player.id };
      reply({ ok: true, roomId: room.id, token: player.token, playerId: player.id, rejoinCount: player.rejoinCount });
      broadcast(room);
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("game:start", (_, reply = () => {}) => {
    try {
      const { room, player } = identify(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以发牌");
      if (room.paused) throw new Error("牌桌已暂停，请先恢复游戏");
      if (room.hand && !room.hand.result) throw new Error("当前牌局尚未结束");
      startHand(room);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("game:action", ({ action, amount }, reply = () => {}) => {
    try {
      const { room, player } = identify(socket);
      if (room.paused) throw new Error("牌桌已暂停，暂时不能操作");
      act(room, player, action, amount);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("game:pause", ({ paused }, reply = () => {}) => {
    try {
      const { room, player } = identify(socket);
      requireHost(room, player);
      room.paused = Boolean(paused);
      if (room.paused) {
        clearAutoStart(room);
        clearActionTimer(room.hand);
      } else {
        scheduleAutoStart(room);
        armActionTimer(room);
      }
      systemMessage(room, `${player.name} ${room.paused ? "暂停了牌桌" : "恢复了牌桌"}`);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("player:away", ({ away }, reply = () => {}) => {
    try {
      const { room, player } = identify(socket);
      const nextAway = Boolean(away);
      if (player.away === nextAway) return reply({ ok: true });
      player.away = nextAway;
      if (nextAway) {
        player.status = "暂时离座";
        if (room.hand && !room.hand.result && player.holeCards.length && !player.folded) {
          if (room.hand.actionPlayerId === player.id) act(room, player, "fold");
          else {
            player.folded = true;
            player.acted = true;
            if (contenders(room).length === 1) progressHand(room, room.hand.actionPlayerId);
          }
        }
      } else {
        player.status = room.hand && !room.hand.result ? "下一手入座" : "等待中";
      }
      systemMessage(room, `${player.name} ${nextAway ? "暂时离座" : "回到了牌桌"}`);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("host:points", ({ playerId, points }, reply = () => {}) => {
    try {
      const { room, player: host } = identify(socket);
      requireHost(room, host);
      if (room.hand && !room.hand.result) throw new Error("请先结束当前牌局再修改积分");
      const target = room.players.find((p) => p.id === playerId);
      if (!target) throw new Error("玩家不存在");
      const nextPoints = clamp(points, 0, 10000000, target.points);
      const before = target.points;
      target.points = nextPoints;
      target.status = target.away ? "暂时离座" : nextPoints > 0 ? "等待中" : "积分不足";
      systemMessage(room, `${host.name} 将 ${target.name} 的积分从 ${before} 调整为 ${nextPoints}`);
      if (nextPoints <= 0) unseatPlayer(room, target);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("host:kick", ({ playerId }, reply = () => {}) => {
    try {
      const { room, player: host } = identify(socket);
      requireHost(room, host);
      if (room.hand && !room.hand.result) throw new Error("请先结束当前牌局再剔除玩家");
      if (playerId === host.id) throw new Error("房主不能剔除自己");
      const index = room.players.findIndex((p) => p.id === playerId);
      if (index < 0) throw new Error("玩家不存在");
      const [target] = room.players.splice(index, 1);
      systemMessage(room, `${target.name} 已被房主移出牌桌`);
      if (target.socketId) {
        io.to(target.socketId).emit("room:kicked", { message: "你已被房主移出牌桌" });
        io.sockets.sockets.get(target.socketId)?.disconnect(true);
      }
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("host:settings", ({ smallBlind, bigBlind, decisionTimeSeconds }, reply = () => {}) => {
    try {
      const { room, player: host } = identify(socket);
      requireHost(room, host);
      if (room.hand && !room.hand.result) throw new Error("请先结束当前牌局再修改盲注");
      const sb = clamp(smallBlind, 1, 1000000, room.settings.smallBlind);
      const bb = clamp(bigBlind, sb * 2, 2000000, room.settings.bigBlind);
      room.settings.smallBlind = sb;
      room.settings.bigBlind = bb;
      room.settings.decisionTimeSeconds = clamp(decisionTimeSeconds, 5, 120, room.settings.decisionTimeSeconds);
      systemMessage(room, `${host.name} 将盲注调整为 ${sb}/${bb}，思考时间 ${room.settings.decisionTimeSeconds} 秒`);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("host:auto-start", ({ enabled }, reply = () => {}) => {
    try {
      const { room, player: host } = identify(socket);
      requireHost(room, host);
      room.settings.autoStartNextHand = Boolean(enabled);
      if (room.settings.autoStartNextHand) scheduleAutoStart(room);
      else clearAutoStart(room);
      systemMessage(room, `${host.name} ${room.settings.autoStartNextHand ? "开启" : "关闭"}了自动开始下一手`);
      broadcast(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("chat:send", ({ text }, reply = () => {}) => {
    try {
      const { room, player } = identify(socket);
      const message = String(text || "").trim().slice(0, 160);
      if (!message) return;
      room.messages.push({ id: randomUUID(), type: "chat", name: player.name, text: message, at: Date.now() });
      broadcast(room);
      io.to(room.id).emit("chat:bubble", { playerId: player.id, text: message, expiresAt: Date.now() + 6000 });
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("disconnect", () => {
    try {
      const { room, player } = identify(socket);
      player.connected = false;
      player.socketId = null;
      if (room.hand && !room.hand.result && room.hand.actionPlayerId === player.id) {
        act(room, player, "fold");
      }
      const online = room.players.filter((p) => p.connected);
      if (!online.length) setTimeout(() => { if (!room.players.some((p) => p.connected)) rooms.delete(room.id); }, 30 * 60 * 1000);
      else if (room.hostId === player.id) room.hostId = online[0].id;
      broadcast(room);
    } catch { /* disconnected before joining */ }
  });
});

// 看四张抢庄牛牛 -------------------------------------------------------------

function createNiuRoom(ownerName, settings = {}) {
  let id;
  do id = roomId(); while (niuRooms.has(id));
  const room = {
    id,
    hostId: null,
    players: [],
    messages: [],
    phase: "waiting",
    paused: false,
    roundNumber: 0,
    bankerId: null,
    bankerBid: 1,
    bankerCandidates: [],
    bankerSelectionEndsAt: null,
    pendingBankerId: null,
    phaseDeadline: null,
    phaseTimer: null,
    dealTimer: null,
    nextRoundAt: null,
    autoStartTimer: null,
    deck: [],
    result: null,
    settings: {
      startingPoints: clamp(settings.startingPoints, 100, 100000, 1000),
      baseScore: clamp(settings.baseScore, 1, 10000, 10),
      maxPlayers: clamp(settings.maxPlayers, 2, 6, 6),
      decisionTimeSeconds: clamp(settings.decisionTimeSeconds, 5, 120, 30),
      autoStartNextRound: Boolean(settings.autoStartNextRound),
    },
  };
  const player = addNiuPlayer(room, ownerName, room.settings.startingPoints, 0);
  room.hostId = player.id;
  niuRooms.set(id, room);
  return { room, player };
}

function addNiuPlayer(room, name, points, requestedSeat) {
  const taken = new Set(room.players.filter((player) => player.seated).map((player) => player.seat));
  const seat = Number(requestedSeat);
  if (!Number.isInteger(seat) || seat < 0 || seat > 5) throw new Error("请选择有效座位");
  if (taken.has(seat)) throw new Error("该座位已被占用，请重新选择");
  const player = {
    id: randomUUID(), token: randomBytes(18).toString("base64url"), socketId: null,
    name: cleanName(name), seat, points: clamp(points, Math.max(1, room.settings.baseScore), 100000, Math.max(room.settings.startingPoints, room.settings.baseScore)),
    connected: true, seated: true, away: false, rejoinCount: 0,
    cards: [], bid: null, bet: null, hand: null, delta: 0, broughtPoints: 0,
    status: "等待中",
  };
  room.players.push(player);
  return player;
}

function activeNiuPlayers(room) {
  return room.players.filter((player) => player.seated && player.connected && !player.away && player.points >= room.settings.baseScore).sort((a, b) => a.seat - b.seat);
}

function niuMessage(room, text) {
  room.messages.push({ id: randomUUID(), type: "system", text, at: Date.now() });
}

function publicNiuState(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId);
  const revealAll = room.phase === "result";
  return {
    id: room.id, hostId: room.hostId, phase: room.phase, paused: room.paused,
    roundNumber: room.roundNumber, bankerId: room.bankerId, bankerBid: room.bankerBid,
    bankerCandidates: room.bankerCandidates, bankerSelectionEndsAt: room.bankerSelectionEndsAt,
    phaseDeadline: room.phaseDeadline, nextRoundAt: room.nextRoundAt, serverTime: Date.now(),
    settings: room.settings, result: room.result,
    viewer: viewer ? { id: viewer.id, seated: viewer.seated, rejoinCount: viewer.rejoinCount, status: viewer.status } : null,
    players: room.players.filter((player) => player.seated).map((player) => ({
      id: player.id, name: player.name, seat: player.seat, points: player.points,
      connected: player.connected, away: player.away, rejoinCount: player.rejoinCount,
      status: player.status, bid: player.bid, bet: player.bet, delta: player.delta,
      cardCount: player.cards.length,
      cards: player.id === viewerId || revealAll ? player.cards : [],
      hand: player.id === viewerId || revealAll ? player.hand : null,
    })),
    messages: room.messages.slice(-60),
  };
}

function broadcastNiu(room) {
  for (const player of room.players) if (player.socketId) io.to(player.socketId).emit("niu:state", publicNiuState(room, player.id));
}

function clearNiuPhaseTimer(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.phaseDeadline = null;
}

function armNiuPhaseTimer(room, phase) {
  clearNiuPhaseTimer(room);
  if (room.paused || room.phase !== phase || !["bid", "bet"].includes(phase)) return;
  room.phaseDeadline = Date.now() + room.settings.decisionTimeSeconds * 1000;
  room.phaseTimer = setTimeout(() => {
    if (room.phase !== phase || room.paused) return;
    if (phase === "bid") {
      for (const player of room.players.filter((candidate) => candidate.cards.length === 4 && candidate.bid === null)) {
        player.bid = 0;
        player.status = "超时 · 不抢庄";
      }
      niuMessage(room, "抢庄时间结束，未选择玩家自动不抢");
      progressNiuBids(room);
    } else {
      for (const player of room.players.filter((candidate) => candidate.cards.length === 4 && candidate.id !== room.bankerId && candidate.bet === null)) {
        player.bet = 1;
        player.status = "超时 · 下注 1 倍";
      }
      niuMessage(room, "下注时间结束，未选择闲家自动下注 1 倍");
      progressNiuBets(room);
    }
    broadcastNiu(room);
  }, room.settings.decisionTimeSeconds * 1000);
}

function clearNiuAutoStart(room) {
  if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
  room.autoStartTimer = null;
  room.nextRoundAt = null;
}

function scheduleNiuAutoStart(room) {
  clearNiuAutoStart(room);
  if (!room.settings.autoStartNextRound || room.paused || room.phase !== "result") return;
  room.nextRoundAt = Date.now() + 5000;
  niuMessage(room, "自动下一局已开启，5 秒后发四张");
  room.autoStartTimer = setTimeout(() => {
    room.autoStartTimer = null;
    room.nextRoundAt = null;
    if (!room.settings.autoStartNextRound || room.paused || room.phase !== "result") return;
    try { startNiuRound(room); } catch (error) { niuMessage(room, `自动开局等待中：${error.message}`); }
    broadcastNiu(room);
  }, 5000);
}

function startNiuRound(room) {
  clearNiuPhaseTimer(room);
  clearNiuAutoStart(room);
  if (room.dealTimer) clearTimeout(room.dealTimer);
  const players = activeNiuPlayers(room);
  if (players.length < 2) throw new Error("至少需要 2 位有积分的在线玩家");
  room.roundNumber += 1;
  room.phase = "deal";
  room.bankerId = null;
  room.bankerBid = 1;
  room.bankerCandidates = [];
  room.bankerSelectionEndsAt = null;
  room.pendingBankerId = null;
  room.result = null;
  room.deck = createDeck();
  for (const player of room.players) {
    player.cards = [];
    player.bid = null;
    player.bet = null;
    player.hand = null;
    player.delta = 0;
    player.broughtPoints = player.points;
    player.status = players.includes(player) ? "发牌中 · 0/4" : player.seated ? "下一局加入" : "等待重新坐下";
  }
  niuMessage(room, `第 ${room.roundNumber} 局开始，依次发出四张牌`);
  dealNiuInitialWave(room, players, 0);
}

function dealNiuInitialWave(room, players, wave) {
  room.dealTimer = setTimeout(() => {
    if (room.phase !== "deal") return;
    if (room.paused) return dealNiuInitialWave(room, players, wave);
    for (const player of players) {
      player.cards.push(room.deck.pop());
      player.status = `发牌中 · ${wave + 1}/4`;
    }
    niuMessage(room, `第 ${wave + 1} 张牌已发出`);
    broadcastNiu(room);
    if (wave < 3) return dealNiuInitialWave(room, players, wave + 1);
    finishNiuInitialDeal(room, players);
  }, 650);
}

function finishNiuInitialDeal(room, players) {
  room.dealTimer = setTimeout(() => {
    if (room.phase !== "deal") return;
    if (room.paused) return finishNiuInitialDeal(room, players);
    room.phase = "bid";
    for (const player of players) {
      if (!player.connected || player.away) { player.bid = 0; player.status = player.away ? "暂时离座" : "离线 · 自动不抢"; }
      else player.status = "请选择抢庄倍数";
    }
    niuMessage(room, "四张牌发完，开始抢庄");
    progressNiuBids(room);
    if (room.phase === "bid") armNiuPhaseTimer(room, "bid");
    broadcastNiu(room);
  }, 500);
}

function progressNiuBids(room) {
  const players = room.players.filter((player) => player.cards.length === 4);
  if (!players.length || players.some((player) => player.bid === null)) return;
  clearNiuPhaseTimer(room);
  const highest = Math.max(...players.map((player) => player.bid));
  const candidates = players.filter((player) => player.bid === highest);
  if (candidates.length > 1) {
    room.phase = "banker_select";
    room.bankerCandidates = candidates.map((player) => player.id);
    room.pendingBankerId = candidates[Math.floor(Math.random() * candidates.length)].id;
    room.bankerSelectionEndsAt = Date.now() + 2400;
    for (const player of players) player.status = candidates.includes(player) ? "候选庄家 · 随机选择中" : "等待定庄";
    niuMessage(room, `${candidates.map((player) => player.name).join("、")} 同为最高 ${highest} 倍，开始随机定庄`);
    setTimeout(() => finalizeNiuBanker(room, highest), 2400);
    return;
  }
  room.pendingBankerId = candidates[0].id;
  finalizeNiuBanker(room, highest);
}

function finalizeNiuBanker(room, highest) {
  if (!["bid", "banker_select"].includes(room.phase) || !room.pendingBankerId) return;
  if (room.paused) return setTimeout(() => finalizeNiuBanker(room, highest), 300);
  const banker = room.players.find((player) => player.id === room.pendingBankerId);
  if (!banker) return;
  room.bankerId = banker.id;
  room.bankerBid = Math.max(1, highest);
  room.bankerCandidates = [];
  room.bankerSelectionEndsAt = null;
  room.pendingBankerId = null;
  room.phase = "bet";
  for (const player of room.players.filter((candidate) => candidate.cards.length === 4)) player.status = player.id === banker.id ? `庄家 · ${room.bankerBid} 倍` : "请选择下注倍数";
  niuMessage(room, `${banker.name} 成为庄家，抢庄 ${room.bankerBid} 倍`);
  armNiuPhaseTimer(room, "bet");
  broadcastNiu(room);
}

function progressNiuBets(room) {
  const players = room.players.filter((player) => player.cards.length === 4);
  const idlePlayers = players.filter((player) => player.id !== room.bankerId);
  if (idlePlayers.some((player) => player.bet === null)) return;
  clearNiuPhaseTimer(room);
  room.phase = "fifth_deal";
  for (const player of players) player.status = "等待第 5 张牌";
  niuMessage(room, "下注完成，准备发出第 5 张牌");
  broadcastNiu(room);
  dealNiuFifthCard(room, players);
}

function dealNiuFifthCard(room, players) {
  room.dealTimer = setTimeout(() => {
    if (room.phase !== "fifth_deal") return;
    if (room.paused) return dealNiuFifthCard(room, players);
    for (const player of players) {
      player.cards.push(room.deck.pop());
      player.hand = evaluateNiuHand(player.cards);
      player.status = `${player.hand.name} · ${player.hand.multiplier}倍`;
    }
    room.phase = "reveal";
    niuMessage(room, "第 5 张牌已翻开，自动完成拼牌");
    broadcastNiu(room);
    setTimeout(() => settleNiuWhenReady(room), 1800);
  }, 750);
}

function settleNiuWhenReady(room) {
  if (room.phase !== "reveal") return;
  if (room.paused) return setTimeout(() => settleNiuWhenReady(room), 400);
  settleNiuRound(room);
  broadcastNiu(room);
}

function evaluateNiuHand(cards) {
  const point = (card) => ["T", "J", "Q", "K"].includes(card.rank) ? 10 : card.rank === "A" ? 1 : Number(card.rank);
  const strength = (card) => ({ A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13 })[card.rank];
  const suitStrength = (card) => ({ d: 1, c: 2, h: 3, s: 4 })[card.suit];
  const highest = [...cards].sort((a, b) => strength(b) - strength(a) || suitStrength(b) - suitStrength(a))[0];
  const common = { highRank: strength(highest), highSuit: suitStrength(highest) };
  const values = cards.map(point);
  if (values.every((value) => value < 5) && values.reduce((sum, value) => sum + value, 0) <= 10) return { category: 13, name: "五小牛", multiplier: 6, ...common };
  const counts = new Map(cards.map((card) => [card.rank, cards.filter((other) => other.rank === card.rank).length]));
  const bomb = [...counts].find(([, count]) => count === 4);
  if (bomb) return { category: 12, name: "炸弹牛", multiplier: 5, bombRank: strength({ rank: bomb[0] }), ...common };
  if (cards.every((card) => ["J", "Q", "K"].includes(card.rank))) return { category: 11, name: "五花牛", multiplier: 4, ...common };
  let niu = -1;
  for (let a = 0; a < 3; a += 1) for (let b = a + 1; b < 4; b += 1) for (let c = b + 1; c < 5; c += 1) {
    if ((values[a] + values[b] + values[c]) % 10 === 0) {
      const rest = values.reduce((sum, value, index) => sum + ([a, b, c].includes(index) ? 0 : value), 0) % 10;
      niu = Math.max(niu, rest === 0 ? 10 : rest);
    }
  }
  if (niu < 0) return { category: 0, name: "无牛", multiplier: 1, ...common };
  return { category: niu, name: niu === 10 ? "牛牛" : `牛${["", "一", "二", "三", "四", "五", "六", "七", "八", "九"][niu]}`, multiplier: niu >= 7 && niu <= 9 ? 2 : niu === 10 ? 3 : 1, ...common };
}

function compareNiuHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  if (a.category === 12 && a.bombRank !== b.bombRank) return a.bombRank - b.bombRank;
  if (a.category === 13) return 0;
  if (a.highRank !== b.highRank) return a.highRank - b.highRank;
  return a.highSuit - b.highSuit;
}

function proportionalAmounts(entries, target) {
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
  if (total <= target) return entries.map((entry) => ({ ...entry }));
  const scaled = entries.map((entry) => ({ ...entry, exact: entry.amount * target / total }));
  let used = scaled.reduce((sum, entry) => sum + Math.floor(entry.exact), 0);
  scaled.sort((a, b) => (b.exact % 1) - (a.exact % 1));
  return scaled.map((entry) => ({ ...entry, amount: Math.floor(entry.exact) + (used++ < target ? 1 : 0) }));
}

function settleNiuRound(room) {
  const banker = room.players.find((player) => player.id === room.bankerId);
  if (!banker) return;
  const winners = [];
  const losers = [];
  for (const idle of room.players.filter((player) => player.cards.length === 5 && player.id !== banker.id)) {
    const idleWins = compareNiuHands(idle.hand, banker.hand) > 0;
    const winningHand = idleWins ? idle.hand : banker.hand;
    const theoretical = room.settings.baseScore * winningHand.multiplier * room.bankerBid * idle.bet;
    const entry = { player: idle, amount: Math.min(theoretical, idle.broughtPoints), theoretical };
    (idleWins ? winners : losers).push(entry);
  }
  let pays = winners;
  let receives = losers;
  const payTotal = pays.reduce((sum, entry) => sum + entry.amount, 0);
  const receiveTotal = receives.reduce((sum, entry) => sum + entry.amount, 0);
  if (payTotal - receiveTotal > banker.broughtPoints) pays = proportionalAmounts(pays, banker.broughtPoints + receiveTotal);
  if (receiveTotal - payTotal > banker.broughtPoints) receives = proportionalAmounts(receives, banker.broughtPoints + payTotal);
  for (const player of room.players) player.delta = 0;
  for (const entry of pays) { entry.player.delta += entry.amount; banker.delta -= entry.amount; }
  for (const entry of receives) { entry.player.delta -= entry.amount; banker.delta += entry.amount; }
  for (const player of room.players) player.points = Math.max(0, player.points + player.delta);
  room.phase = "result";
  room.result = {
    bankerId: banker.id,
    text: `${banker.name} 坐庄 · ${banker.hand.name}，本局已结算`,
    settlements: room.players.filter((player) => player.cards.length === 5).map((player) => ({ playerId: player.id, delta: player.delta })),
  };
  niuMessage(room, room.result.text);
  for (const player of room.players) {
    player.status = player.delta > 0 ? `赢得 ${player.delta}` : player.delta < 0 ? `输掉 ${Math.abs(player.delta)}` : "本局和局";
    if (player.seated && player.points < room.settings.baseScore) unseatNiuPlayer(room, player);
  }
  scheduleNiuAutoStart(room);
}

function unseatNiuPlayer(room, player) {
  if (!player.seated) return;
  player.seated = false;
  player.seat = null;
  player.away = false;
  player.status = `积分不足底注 ${room.settings.baseScore}，等待重新坐下`;
  niuMessage(room, `${player.name} 积分低于底注 ${room.settings.baseScore}，座位已释放`);
}

function reseatNiuPlayer(room, player, { name, points, seat }) {
  if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
  const numericSeat = Number(seat);
  if (!Number.isInteger(numericSeat) || numericSeat < 0 || numericSeat > 5) throw new Error("请选择有效座位");
  if (room.players.some((candidate) => candidate.seated && candidate.seat === numericSeat)) throw new Error("该座位已被占用，请重新选择");
  Object.assign(player, {
    seated: true, seat: numericSeat, name: cleanName(name || player.name),
    points: clamp(points, Math.max(1, room.settings.baseScore), 100000, Math.max(room.settings.startingPoints, room.settings.baseScore)), away: false,
    cards: [], bid: null, bet: null, hand: null, delta: 0,
    status: ["deal", "bid", "banker_select", "bet", "fifth_deal", "reveal"].includes(room.phase) ? "下一局加入" : "等待中",
  });
  player.rejoinCount += 1;
  niuMessage(room, `${player.name} 第 ${player.rejoinCount} 次重新坐下`);
}

function identifyNiu(socket) {
  const room = niuRooms.get(socket.data?.niuRoomId);
  const player = room?.players.find((candidate) => candidate.id === socket.data?.niuPlayerId);
  if (!room || !player) throw new Error("请先加入牛牛房间");
  return { room, player };
}

io.on("connection", (socket) => {
  socket.on("niu:create", ({ name, settings }, reply = () => {}) => {
    try {
      const { room, player } = createNiuRoom(name, settings);
      player.socketId = socket.id;
      socket.join(`niu:${room.id}`);
      socket.data.niuRoomId = room.id;
      socket.data.niuPlayerId = player.id;
      reply({ ok: true, roomId: room.id, token: player.token, playerId: player.id });
      broadcastNiu(room);
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:preview", ({ roomId: rawId }, reply = () => {}) => {
    try {
      const room = niuRooms.get(String(rawId || "").toUpperCase());
      if (!room) throw new Error("房间不存在或已关闭");
      const seatedCount = room.players.filter((player) => player.seated).length;
      reply({ ok: true, roomId: room.id, defaultPoints: room.settings.startingPoints, maxPlayers: room.settings.maxPlayers,
        remainingSlots: Math.max(0, room.settings.maxPlayers - seatedCount),
        occupiedSeats: room.players.filter((player) => player.seated).map((player) => ({ seat: player.seat, name: player.name })),
        inProgress: ["deal", "bid", "banker_select", "bet", "fifth_deal", "reveal"].includes(room.phase) });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:join", ({ roomId: rawId, name, points, seat, token }, reply = () => {}) => {
    try {
      const room = niuRooms.get(String(rawId || "").toUpperCase());
      if (!room) throw new Error("房间不存在或已关闭");
      let player = room.players.find((candidate) => candidate.token === token);
      if (player && !player.seated) {
        if (seat === undefined || seat === null || seat === "") return reply({ ok: false, needsSeat: true, error: "请重新选择座位" });
        reseatNiuPlayer(room, player, { name, points, seat });
      } else if (!player) {
        if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
        player = addNiuPlayer(room, name, points, seat);
        if (["deal", "bid", "banker_select", "bet", "fifth_deal", "reveal"].includes(room.phase)) player.status = "下一局加入";
        niuMessage(room, `${player.name} 已入座${player.status === "下一局加入" ? "，将从下一局加入" : ""}`);
      }
      player.socketId = socket.id;
      player.connected = true;
      socket.join(`niu:${room.id}`);
      socket.data.niuRoomId = room.id;
      socket.data.niuPlayerId = player.id;
      reply({ ok: true, roomId: room.id, token: player.token, playerId: player.id, rejoinCount: player.rejoinCount });
      broadcastNiu(room);
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:start", (_, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以开始");
      if (room.paused) throw new Error("牌桌已暂停");
      if (!["waiting", "result"].includes(room.phase)) throw new Error("本局尚未结束");
      startNiuRound(room);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:bid", ({ multiplier }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.paused || room.phase !== "bid" || player.cards.length !== 4 || player.bid !== null) throw new Error("当前不能抢庄");
      const value = Number(multiplier);
      if (![0, 1, 2, 3, 4].includes(value)) throw new Error("无效抢庄倍数");
      if (value > 0 && player.points < room.settings.baseScore * value) throw new Error("积分不足，无法选择该抢庄倍数");
      player.bid = value;
      player.status = value ? `已抢庄 ${value} 倍` : "不抢庄";
      niuMessage(room, `${player.name} ${value ? `抢庄 ${value} 倍` : "不抢"}`);
      progressNiuBids(room);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:bet", ({ multiplier }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.paused || room.phase !== "bet" || player.id === room.bankerId || player.cards.length !== 4 || player.bet !== null) throw new Error("当前不能下注");
      const value = Number(multiplier);
      if (![1, 2, 3, 5, 10, 15].includes(value)) throw new Error("无效下注倍数");
      if (player.points < room.settings.baseScore * room.bankerBid * value) throw new Error("积分不足，请选择更低倍数");
      player.bet = value;
      player.status = `已下注 ${value} 倍`;
      niuMessage(room, `${player.name} 下注 ${value} 倍`);
      progressNiuBets(room);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:away", ({ away }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      player.away = Boolean(away);
      if (player.away && room.phase === "bid" && player.cards.length === 4 && player.bid === null) { player.bid = 0; progressNiuBids(room); }
      if (player.away && room.phase === "bet" && player.id !== room.bankerId && player.cards.length === 4 && player.bet === null) { player.bet = 1; progressNiuBets(room); }
      player.status = player.away ? "暂时离座" : ["deal", "bid", "banker_select", "bet", "fifth_deal", "reveal"].includes(room.phase) ? "下一局加入" : "等待中";
      niuMessage(room, `${player.name} ${player.away ? "暂时离座" : "回到牌桌"}`);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:pause", ({ paused }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以暂停");
      room.paused = Boolean(paused);
      if (room.paused) { clearNiuPhaseTimer(room); clearNiuAutoStart(room); }
      else if (["bid", "bet"].includes(room.phase)) armNiuPhaseTimer(room, room.phase);
      else if (room.phase === "result") scheduleNiuAutoStart(room);
      niuMessage(room, `${player.name} ${room.paused ? "暂停" : "恢复"}了游戏`);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:auto-start", ({ enabled }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以设置自动开局");
      room.settings.autoStartNextRound = Boolean(enabled);
      if (room.settings.autoStartNextRound) scheduleNiuAutoStart(room); else clearNiuAutoStart(room);
      niuMessage(room, `${player.name} ${room.settings.autoStartNextRound ? "开启" : "关闭"}了自动下一局`);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:host-points", ({ playerId, points }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以修改积分");
      if (!["waiting", "result"].includes(room.phase)) throw new Error("请在两局之间修改积分");
      const target = room.players.find((candidate) => candidate.id === playerId && candidate.seated);
      if (!target) throw new Error("玩家不存在");
      target.points = clamp(points, 0, 10000000, target.points);
      niuMessage(room, `${player.name} 将 ${target.name} 的积分调整为 ${target.points}`);
      if (target.points < room.settings.baseScore) unseatNiuPlayer(room, target);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:kick", ({ playerId }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以剔除玩家");
      if (!["waiting", "result"].includes(room.phase)) throw new Error("请在两局之间剔除玩家");
      if (playerId === player.id) throw new Error("房主不能剔除自己");
      const index = room.players.findIndex((candidate) => candidate.id === playerId);
      if (index < 0) throw new Error("玩家不存在");
      const [target] = room.players.splice(index, 1);
      if (target.socketId) io.to(target.socketId).emit("niu:kicked", { message: "你已被房主移出牛牛房间" });
      niuMessage(room, `${target.name} 已被移出房间`);
      broadcastNiu(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("niu:chat", ({ text }, reply = () => {}) => {
    try {
      const { room, player } = identifyNiu(socket);
      const message = String(text || "").trim().slice(0, 160);
      if (!message) return reply({ ok: false, error: "消息不能为空" });
      room.messages.push({ id: randomUUID(), type: "chat", name: player.name, text: message, at: Date.now() });
      broadcastNiu(room);
      io.to(`niu:${room.id}`).emit("niu:chat-bubble", { playerId: player.id, text: message, expiresAt: Date.now() + 6000 });
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("disconnect", () => {
    try {
      const { room, player } = identifyNiu(socket);
      player.connected = false;
      player.socketId = null;
      if (room.phase === "bid" && player.cards.length === 4 && player.bid === null) { player.bid = 0; progressNiuBids(room); }
      if (room.phase === "bet" && player.id !== room.bankerId && player.cards.length === 4 && player.bet === null) { player.bet = 1; progressNiuBets(room); }
      const online = room.players.filter((candidate) => candidate.connected);
      if (room.hostId === player.id && online.length) room.hostId = online[0].id;
      if (!online.length) setTimeout(() => { if (!room.players.some((candidate) => candidate.connected)) niuRooms.delete(room.id); }, 30 * 60 * 1000);
      broadcastNiu(room);
    } catch { /* not in a niuniu room */ }
  });
});

function createZjhRoom(ownerName, settings = {}) {
  let id;
  do id = roomId(); while (zjhRooms.has(id));
  const room = {
    id,
    createdAt: Date.now(),
    hostId: null,
    players: [],
    messages: [],
    paused: false,
    phase: "waiting",
    handNumber: 0,
    dealerId: null,
    actionPlayerId: null,
    bettingRound: 0,
    currentUnit: 0,
    pot: 0,
    deck: [],
    actedThisRound: new Set(),
    actionDeadline: null,
    actionTimer: null,
    nextHandAt: null,
    autoStartTimer: null,
    result: null,
    settings: {
      startingPoints: clamp(settings.startingPoints, 100, 100000, 1000),
      ante: clamp(settings.ante, 1, 10000, 10),
      maxPlayers: clamp(settings.maxPlayers, 2, 5, 5),
      decisionTimeSeconds: clamp(settings.decisionTimeSeconds, 5, 120, 30),
      maxRounds: 15,
      autoStartNextHand: Boolean(settings.autoStartNextHand),
    },
  };
  const player = addZjhPlayer(room, ownerName, room.settings.startingPoints, 0);
  room.hostId = player.id;
  zjhRooms.set(id, room);
  return { room, player };
}

function addZjhPlayer(room, name, points, requestedSeat) {
  const taken = new Set(room.players.filter((player) => player.seated).map((player) => player.seat));
  const seat = Number(requestedSeat);
  if (!Number.isInteger(seat) || seat < 0 || seat >= room.settings.maxPlayers) throw new Error("请选择有效座位");
  if (taken.has(seat)) throw new Error("该座位已被占用，请重新选择");
  const player = {
    id: randomUUID(), token: randomBytes(18).toString("base64url"), socketId: null,
    name: cleanName(name), seat,
    points: clamp(points, room.settings.ante, 100000, Math.max(room.settings.startingPoints, room.settings.ante)),
    connected: true, seated: true, away: false, rejoinCount: 0,
    cards: [], seen: false, folded: false, totalBet: 0, raisedRound: 0,
    status: "等待中",
  };
  room.players.push(player);
  return player;
}

function activeZjhPlayers(room) {
  return room.players.filter((player) => player.seated && player.connected && !player.away && player.points >= room.settings.ante);
}

function zjhContenders(room) {
  return room.players.filter((player) => player.cards.length === 3 && !player.folded);
}

function zjhCounterClockwise(room, players = zjhContenders(room)) {
  return [...players].sort((a, b) => b.seat - a.seat);
}

function nextZjhPlayer(room, currentId, players = zjhContenders(room)) {
  const ordered = zjhCounterClockwise(room, players);
  if (!ordered.length) return null;
  const current = room.players.find((player) => player.id === currentId);
  if (!current) return ordered[0];
  return ordered.find((player) => player.seat < current.seat) || ordered[0];
}

function zjhMessage(room, text) {
  room.messages.push({ id: randomUUID(), type: "system", text, at: Date.now() });
}

function publicZjhState(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId);
  const revealAll = room.phase === "result";
  const maxRoomChip = Math.max(room.settings.ante, ...room.players.filter((player) => player.seated).map((player) => player.points + player.totalBet));
  return {
    id: room.id, hostId: room.hostId, paused: room.paused, phase: room.phase,
    handNumber: room.handNumber, dealerId: room.dealerId, actionPlayerId: room.actionPlayerId,
    bettingRound: room.bettingRound, currentUnit: room.currentUnit, pot: room.pot,
    actionDeadline: room.actionDeadline, nextHandAt: room.nextHandAt, serverTime: Date.now(),
    maxRoomChip, settings: room.settings, result: room.result,
    viewer: viewer ? { id: viewer.id, seated: viewer.seated, rejoinCount: viewer.rejoinCount, status: viewer.status } : null,
    players: room.players.filter((player) => player.seated).map((player) => ({
      id: player.id, name: player.name, seat: player.seat, points: player.points,
      connected: player.connected, away: player.away, rejoinCount: player.rejoinCount,
      seen: player.seen, folded: player.folded, totalBet: player.totalBet,
      raisedThisRound: player.raisedRound === room.bettingRound, status: player.status,
      cardCount: player.cards.length,
      cards: player.id === viewerId || revealAll ? player.cards : [],
      hand: revealAll && player.cards.length === 3 ? evaluateZjhHand(player.cards) : null,
    })),
    messages: room.messages.slice(-80),
  };
}

function broadcastZjh(room) {
  for (const player of room.players) if (player.socketId) io.to(player.socketId).emit("zjh:state", publicZjhState(room, player.id));
}

function clearZjhActionTimer(room) {
  if (room.actionTimer) clearTimeout(room.actionTimer);
  room.actionTimer = null;
  room.actionDeadline = null;
}

function armZjhActionTimer(room) {
  clearZjhActionTimer(room);
  if (room.phase !== "playing" || room.paused || !room.actionPlayerId) return;
  const playerId = room.actionPlayerId;
  room.actionDeadline = Date.now() + room.settings.decisionTimeSeconds * 1000;
  room.actionTimer = setTimeout(() => {
    if (room.phase !== "playing" || room.paused || room.actionPlayerId !== playerId) return;
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.folded) return;
    player.folded = true;
    player.status = "超时 · 自动弃牌";
    zjhMessage(room, `${player.name} 操作超时，自动弃牌`);
    advanceZjhAction(room, player.id);
    broadcastZjh(room);
  }, room.settings.decisionTimeSeconds * 1000);
}

function setZjhActionPlayer(room, player) {
  clearZjhActionTimer(room);
  room.actionPlayerId = player?.id || null;
  if (player) {
    player.status = player.seen ? "轮到你 · 明牌" : "轮到你 · 暗牌";
    armZjhActionTimer(room);
  }
}

function takeZjhBet(room, player, amount) {
  const value = Math.max(0, Math.round(Number(amount) || 0));
  if (value > player.points) throw new Error("积分不足，请选择更低金额或弃牌");
  player.points -= value;
  player.totalBet += value;
  room.pot += value;
  return value;
}

function clearZjhAutoStart(room) {
  if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
  room.autoStartTimer = null;
  room.nextHandAt = null;
}

function scheduleZjhAutoStart(room) {
  clearZjhAutoStart(room);
  if (!room.settings.autoStartNextHand || room.paused || room.phase !== "result") return;
  room.nextHandAt = Date.now() + 5000;
  room.autoStartTimer = setTimeout(() => {
    room.autoStartTimer = null;
    room.nextHandAt = null;
    if (!room.settings.autoStartNextHand || room.paused || room.phase !== "result") return;
    try { startZjhHand(room); } catch (error) { zjhMessage(room, `自动开局等待中：${error.message}`); }
    broadcastZjh(room);
  }, 5000);
}

function unseatZjhPlayer(room, player) {
  if (!player.seated) return;
  player.seated = false;
  player.seat = null;
  player.away = false;
  player.status = `积分不足底注 ${room.settings.ante}，等待重新坐下`;
  zjhMessage(room, `${player.name} 积分低于底注 ${room.settings.ante}，座位已释放`);
}

function startZjhHand(room) {
  clearZjhActionTimer(room);
  clearZjhAutoStart(room);
  for (const player of room.players) if (player.seated && player.points < room.settings.ante) unseatZjhPlayer(room, player);
  const players = activeZjhPlayers(room);
  if (players.length < 2) throw new Error("至少需要 2 位有足够积分的在线玩家");
  room.phase = "playing";
  room.handNumber += 1;
  room.bettingRound = 1;
  room.currentUnit = room.settings.ante;
  room.pot = 0;
  room.result = null;
  room.deck = createDeck();
  room.actedThisRound = new Set();
  const dealer = players[Math.floor(Math.random() * players.length)];
  room.dealerId = dealer.id;
  const dealOrder = zjhCounterClockwise(room, players);
  const dealerIndex = dealOrder.findIndex((player) => player.id === dealer.id);
  const ordered = [...dealOrder.slice(dealerIndex), ...dealOrder.slice(0, dealerIndex)];
  for (const player of room.players) {
    player.cards = [];
    player.seen = false;
    player.folded = !players.includes(player);
    player.totalBet = 0;
    player.raisedRound = 0;
    player.status = players.includes(player) ? "暗牌 · 等待行动" : player.away ? "暂时离座" : "下一局加入";
  }
  for (const player of players) takeZjhBet(room, player, room.settings.ante);
  for (let wave = 0; wave < 3; wave += 1) for (const player of ordered) player.cards.push(room.deck.pop());
  zjhMessage(room, `第 ${room.handNumber} 局开始，${dealer.name} 随机坐庄，每人支付底注 ${room.settings.ante}`);
  setZjhActionPlayer(room, nextZjhPlayer(room, dealer.id, players));
}

function zjhCallCost(room, player) {
  return room.currentUnit * (player.seen ? 2 : 1);
}

function advanceZjhAction(room, actorId) {
  if (room.phase !== "playing") return;
  const contenders = zjhContenders(room);
  if (contenders.length <= 1) return finishZjhHand(room, contenders[0]);
  room.actedThisRound.add(actorId);
  if (contenders.every((player) => room.actedThisRound.has(player.id))) {
    if (room.bettingRound >= room.settings.maxRounds) return forceZjhShowdown(room);
    room.bettingRound += 1;
    room.actedThisRound = new Set();
    for (const player of contenders) player.status = player.seen ? "明牌 · 等待行动" : "暗牌 · 等待行动";
    zjhMessage(room, `进入第 ${room.bettingRound} 轮下注`);
  }
  setZjhActionPlayer(room, nextZjhPlayer(room, actorId));
}

function forceZjhShowdown(room) {
  const contenders = zjhContenders(room);
  const ordered = zjhCounterClockwise(room, contenders);
  const first = nextZjhPlayer(room, room.dealerId, contenders);
  const start = ordered.findIndex((player) => player.id === first?.id);
  const sequence = [...ordered.slice(start), ...ordered.slice(0, start)];
  let champion = sequence[0];
  for (const challenger of sequence.slice(1)) {
    const score = compareZjhCards(champion.cards, challenger.cards);
    if (score <= 0) { champion.folded = true; champion.status = `强制比牌负于 ${challenger.name}`; champion = challenger; }
    else { challenger.folded = true; challenger.status = `强制比牌负于 ${champion.name}`; }
  }
  zjhMessage(room, `达到 ${room.settings.maxRounds} 轮上限，系统依次强制比牌`);
  finishZjhHand(room, champion);
}

function finishZjhHand(room, winner) {
  clearZjhActionTimer(room);
  room.phase = "result";
  room.actionPlayerId = null;
  if (winner) {
    const award = room.pot;
    winner.points += award;
    winner.status = `本局获胜 · +${award}`;
    room.result = { winnerId: winner.id, text: `${winner.name} 赢得底池 ${award}` };
    zjhMessage(room, room.result.text);
  } else {
    room.result = { winnerId: null, text: "本局结束" };
  }
  for (const player of room.players) {
    if (player.cards.length !== 3 || player.id === winner?.id) continue;
    if (!player.folded) player.status = "等待下一局";
    if (player.points < room.settings.ante) player.status = `积分不足底注 ${room.settings.ante} · 下一局离桌`;
  }
  scheduleZjhAutoStart(room);
}

function reseatZjhPlayer(room, player, { name, points, seat }) {
  if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
  const numericSeat = Number(seat);
  if (!Number.isInteger(numericSeat) || numericSeat < 0 || numericSeat >= room.settings.maxPlayers) throw new Error("请选择有效座位");
  if (room.players.some((candidate) => candidate.seated && candidate.seat === numericSeat)) throw new Error("该座位已被占用，请重新选择");
  Object.assign(player, {
    seated: true, seat: numericSeat, name: cleanName(name || player.name),
    points: clamp(points, room.settings.ante, 100000, Math.max(room.settings.startingPoints, room.settings.ante)),
    away: false, cards: [], seen: false, folded: room.phase === "playing", totalBet: 0,
    status: room.phase === "playing" ? "下一局加入" : "等待中",
  });
  player.rejoinCount += 1;
  zjhMessage(room, `${player.name} 第 ${player.rejoinCount} 次重新坐下`);
}

function identifyZjh(socket) {
  const room = zjhRooms.get(socket.data?.zjhRoomId);
  const player = room?.players.find((candidate) => candidate.id === socket.data?.zjhPlayerId);
  if (!room || !player) throw new Error("请先加入炸金花房间");
  return { room, player };
}

io.on("connection", (socket) => {
  socket.on("zjh:create", ({ name, settings }, reply = () => {}) => {
    try {
      const { room, player } = createZjhRoom(name, settings);
      player.socketId = socket.id;
      socket.data.zjhRoomId = room.id;
      socket.data.zjhPlayerId = player.id;
      socket.join(`zjh:${room.id}`);
      zjhMessage(room, `${player.name} 创建了炸金花房间`);
      broadcastZjh(room);
      reply({ ok: true, roomId: room.id, playerId: player.id, token: player.token });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:preview", ({ roomId: rawId }, reply = () => {}) => {
    try {
      const room = zjhRooms.get(String(rawId || "").toUpperCase());
      if (!room) throw new Error("房间不存在或已结束");
      const seated = room.players.filter((player) => player.seated);
      reply({ ok: true, roomId: room.id, defaultPoints: room.settings.startingPoints, ante: room.settings.ante,
        maxPlayers: room.settings.maxPlayers, remainingSlots: Math.max(0, room.settings.maxPlayers - seated.length),
        occupiedSeats: seated.map((player) => ({ seat: player.seat, name: player.name })), inProgress: room.phase === "playing" });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:join", ({ roomId: rawId, name, points, seat, token }, reply = () => {}) => {
    try {
      const room = zjhRooms.get(String(rawId || "").toUpperCase());
      if (!room) throw new Error("房间不存在或已结束");
      let player = room.players.find((candidate) => candidate.token === token);
      if (player && !player.seated) reseatZjhPlayer(room, player, { name, points, seat });
      else if (!player) {
        if (room.players.filter((candidate) => candidate.seated).length >= room.settings.maxPlayers) throw new Error("房间已满");
        player = addZjhPlayer(room, name, points, seat);
        if (room.phase === "playing") { player.folded = true; player.status = "下一局加入"; }
        zjhMessage(room, `${player.name} 已入座${room.phase === "playing" ? "，将从下一局加入" : ""}`);
      }
      player.socketId = socket.id;
      player.connected = true;
      socket.data.zjhRoomId = room.id;
      socket.data.zjhPlayerId = player.id;
      socket.join(`zjh:${room.id}`);
      broadcastZjh(room);
      reply({ ok: true, roomId: room.id, playerId: player.id, token: player.token, rejoinCount: player.rejoinCount });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:start", (_, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以开始");
      if (room.paused) throw new Error("牌桌已暂停");
      if (!['waiting', 'result'].includes(room.phase)) throw new Error("本局尚未结束");
      startZjhHand(room);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:look", (_, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.phase !== "playing" || player.folded || player.cards.length !== 3) throw new Error("当前不能看牌");
      if (!player.seen) {
        player.seen = true;
        player.status = room.actionPlayerId === player.id ? "轮到你 · 明牌" : "已看牌 · 等待行动";
        zjhMessage(room, `${player.name} 选择了看牌`);
        broadcastZjh(room);
      }
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:action", ({ action, amount, targetId }, reply = () => {}) => {
    let actingRoom = null;
    try {
      const { room, player } = identifyZjh(socket);
      if (room.phase !== "playing" || room.paused || room.actionPlayerId !== player.id || player.folded) throw new Error("还没轮到你");
      actingRoom = room;
      clearZjhActionTimer(room);
      if (action === "fold") {
        player.folded = true;
        player.status = "已弃牌";
        zjhMessage(room, `${player.name} 弃牌`);
      } else if (action === "call") {
        const paid = takeZjhBet(room, player, zjhCallCost(room, player));
        player.status = `${player.seen ? "明牌" : "暗牌"} · 跟注 ${paid}`;
        zjhMessage(room, `${player.name} ${player.seen ? "明牌" : "暗牌"}跟注 ${paid}`);
      } else if (action === "raise") {
        if (player.raisedRound === room.bettingRound) throw new Error("每轮只能加注一次");
        const target = Math.round(Number(amount));
        const maxRoomChip = Math.max(room.settings.ante, ...room.players.filter((candidate) => candidate.seated).map((candidate) => candidate.points + candidate.totalBet));
        if (!Number.isFinite(target) || target <= room.currentUnit) throw new Error("加注金额必须高于当前注");
        if (target > maxRoomChip) throw new Error("加注不能超过房间最大筹码");
        const paid = takeZjhBet(room, player, target * (player.seen ? 2 : 1));
        room.currentUnit = target;
        room.actedThisRound = new Set();
        player.raisedRound = room.bettingRound;
        player.status = `${player.seen ? "明牌" : "暗牌"} · 加注 ${paid}`;
        zjhMessage(room, `${player.name} 加注，暗注基准升至 ${target}`);
      } else if (action === "compare") {
        if (room.bettingRound < 2) throw new Error("第二轮开始才可以比牌");
        const target = zjhContenders(room).find((candidate) => candidate.id === targetId && candidate.id !== player.id);
        if (!target) throw new Error("请选择仍在局中的比牌对象");
        const paid = takeZjhBet(room, player, zjhCallCost(room, player) * 2);
        const score = compareZjhCards(player.cards, target.cards);
        const loser = score > 0 ? target : player;
        loser.folded = true;
        loser.status = `比牌负于 ${loser.id === player.id ? target.name : player.name}`;
        player.status = loser.id === player.id ? `比牌失败 · 支付 ${paid}` : `比牌获胜 · 支付 ${paid}`;
        zjhMessage(room, `${player.name} 与 ${target.name} 比牌，${loser.name} 失利`);
      } else throw new Error("未知操作");
      advanceZjhAction(room, player.id);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) {
      if (actingRoom?.phase === "playing" && actingRoom.actionPlayerId) armZjhActionTimer(actingRoom);
      reply({ ok: false, error: error.message });
    }
  });

  socket.on("zjh:away", ({ away }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      player.away = Boolean(away);
      if (player.away && room.phase === "playing" && !player.folded && player.cards.length === 3) {
        player.folded = true;
        if (room.actionPlayerId === player.id) advanceZjhAction(room, player.id);
        else if (zjhContenders(room).length <= 1) finishZjhHand(room, zjhContenders(room)[0]);
      }
      player.status = player.away ? "暂时离座" : room.phase === "playing" ? "下一局加入" : "等待中";
      zjhMessage(room, `${player.name} ${player.away ? "暂时离座" : "回到牌桌"}`);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:pause", ({ paused }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以暂停");
      room.paused = Boolean(paused);
      if (room.paused) { clearZjhActionTimer(room); clearZjhAutoStart(room); }
      else if (room.phase === "playing") armZjhActionTimer(room);
      else if (room.phase === "result") scheduleZjhAutoStart(room);
      zjhMessage(room, `${player.name} ${room.paused ? "暂停" : "恢复"}了游戏`);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:auto-start", ({ enabled }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以设置自动开局");
      room.settings.autoStartNextHand = Boolean(enabled);
      if (room.settings.autoStartNextHand) scheduleZjhAutoStart(room); else clearZjhAutoStart(room);
      zjhMessage(room, `${player.name} ${room.settings.autoStartNextHand ? "开启" : "关闭"}了自动下一局`);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:host-points", ({ playerId, points }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以修改积分");
      if (!['waiting', 'result'].includes(room.phase)) throw new Error("请在两局之间修改积分");
      const target = room.players.find((candidate) => candidate.id === playerId && candidate.seated);
      if (!target) throw new Error("玩家不存在");
      target.points = clamp(points, 0, 10000000, target.points);
      zjhMessage(room, `${player.name} 将 ${target.name} 的积分调整为 ${target.points}`);
      if (target.points < room.settings.ante) unseatZjhPlayer(room, target);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:kick", ({ playerId }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      if (room.hostId !== player.id) throw new Error("只有房主可以剔除玩家");
      if (!['waiting', 'result'].includes(room.phase)) throw new Error("请在两局之间剔除玩家");
      if (playerId === player.id) throw new Error("房主不能剔除自己");
      const index = room.players.findIndex((candidate) => candidate.id === playerId);
      if (index < 0) throw new Error("玩家不存在");
      const [target] = room.players.splice(index, 1);
      if (target.socketId) io.to(target.socketId).emit("zjh:kicked", { message: "你已被房主移出炸金花房间" });
      zjhMessage(room, `${target.name} 已被移出房间`);
      broadcastZjh(room);
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("zjh:chat", ({ text }, reply = () => {}) => {
    try {
      const { room, player } = identifyZjh(socket);
      const message = String(text || "").trim().slice(0, 160);
      if (!message) throw new Error("消息不能为空");
      room.messages.push({ id: randomUUID(), type: "chat", name: player.name, text: message, at: Date.now() });
      broadcastZjh(room);
      io.to(`zjh:${room.id}`).emit("zjh:chat-bubble", { playerId: player.id, text: message, expiresAt: Date.now() + 6000 });
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });

  socket.on("disconnect", () => {
    try {
      const { room, player } = identifyZjh(socket);
      player.connected = false;
      player.socketId = null;
      if (room.phase === "playing" && !player.folded && player.cards.length === 3) {
        player.folded = true;
        player.status = "离线 · 自动弃牌";
        if (room.actionPlayerId === player.id) advanceZjhAction(room, player.id);
        else if (zjhContenders(room).length <= 1) finishZjhHand(room, zjhContenders(room)[0]);
      }
      const online = room.players.filter((candidate) => candidate.connected);
      if (room.hostId === player.id && online.length) room.hostId = online[0].id;
      if (!online.length) setTimeout(() => { if (!room.players.some((candidate) => candidate.connected)) zjhRooms.delete(room.id); }, 30 * 60 * 1000);
      broadcastZjh(room);
    } catch { /* not in a zjh room */ }
  });
});

function identify(socket) {
  const room = rooms.get(socket.data?.roomId);
  const player = room?.players.find((p) => p.id === socket.data?.playerId);
  if (!room || !player) throw new Error("请先加入房间");
  return { room, player };
}

function requireHost(room, player) {
  if (room.hostId !== player.id) throw new Error("只有房主可以执行此操作");
}

httpServer.listen(PORT, () => console.log(`River Club running at http://localhost:${PORT}`));
