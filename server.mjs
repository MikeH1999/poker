import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(join(__dirname, "public")));
app.get("/room/:id", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const rooms = new Map();
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
