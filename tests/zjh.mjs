import { io } from "socket.io-client";
import assert from "node:assert/strict";
import { evaluateZjhHand, compareZjhCards } from "../game/zjh-rules.mjs";

testRules();

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url);
const guest = io(url);
const third = io(url);
const sockets = [host, guest, third];
const latest = new Map();
for (const socket of sockets) socket.on("zjh:state", (state) => latest.set(socket.id, state));
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
await Promise.all(sockets.map(connected));

const created = await emit(host, "zjh:create", { name: "房主", settings: { startingPoints: 1000, ante: 10, maxPlayers: 5, decisionTimeSeconds: 30 } });
assert.equal(created.ok, true);
const guestJoin = await emit(guest, "zjh:join", { roomId: created.roomId, name: "玩家乙", points: 1000, seat: 2 });
const thirdJoin = await emit(third, "zjh:join", { roomId: created.roomId, name: "玩家丙", points: 1000, seat: 4 });
assert.equal(guestJoin.ok, true);
assert.equal(thirdJoin.ok, true);
await waitFor(host, (state) => state.players.length === 3);

const bubblePromise = new Promise((resolve) => host.once("zjh:chat-bubble", resolve));
assert.equal((await emit(guest, "zjh:chat", { text: "暗牌走起" })).ok, true);
assert.equal((await bubblePromise).playerId, guestJoin.playerId);

assert.equal((await emit(host, "zjh:start")).ok, true);
const dealtHost = await waitFor(host, (state) => state.phase === "playing");
const dealtGuest = await waitFor(guest, (state) => state.phase === "playing");
assert.equal(dealtHost.pot, 30);
assert.equal(dealtHost.players.every((player) => player.points === 990), true);
assert.equal(dealtHost.players.find((player) => player.id === created.playerId).cards.length, 3);
assert.equal(dealtHost.players.filter((player) => player.id !== created.playerId).every((player) => player.cards.length === 0), true);
assert.equal(dealtGuest.players.find((player) => player.id === guestJoin.playerId).cards.length, 3);
assert.equal(dealtGuest.players.filter((player) => player.id !== guestJoin.playerId).every((player) => player.cards.length === 0), true);

const idToSocket = new Map([[created.playerId, host], [guestJoin.playerId, guest], [thirdJoin.playerId, third]]);
let state = latest.get(host.id);
const firstId = state.actionPlayerId;
const firstSocket = idToSocket.get(firstId);
assert.ok(firstSocket);
assert.equal((await emit(firstSocket, "zjh:look")).ok, true);
const looked = await waitFor(firstSocket, (value) => value.players.find((player) => player.id === firstId)?.seen === true);
const beforeSeenCall = looked.players.find((player) => player.id === firstId).points;
assert.equal((await emit(firstSocket, "zjh:action", { action: "call" })).ok, true);
await waitFor(firstSocket, (value) => value.actionPlayerId !== firstId);
assert.equal(latest.get(firstSocket.id).players.find((player) => player.id === firstId).points, beforeSeenCall - 20);

state = latest.get(host.id);
const raiserId = state.actionPlayerId;
const raiserSocket = idToSocket.get(raiserId);
assert.equal((await emit(raiserSocket, "zjh:action", { action: "raise", amount: 20 })).ok, true);
const afterRaise = await waitFor(host, (value) => value.currentUnit === 20 && value.actionPlayerId !== raiserId);
assert.equal(afterRaise.players.find((player) => player.id === raiserId).raisedThisRound, true);
for (let index = 0; index < 2; index += 1) {
  state = latest.get(host.id);
  const socket = idToSocket.get(state.actionPlayerId);
  assert.equal((await emit(socket, "zjh:action", { action: "call" })).ok, true);
  await waitFor(host, (value) => value.bettingRound === 2 || value.actionPlayerId !== state.actionPlayerId);
}
state = await waitFor(host, (value) => value.bettingRound === 2);
assert.equal(state.pot, 130);

const comparerId = state.actionPlayerId;
const comparerSocket = idToSocket.get(comparerId);
const targetId = state.players.find((player) => player.cardCount === 3 && !player.folded && player.id !== comparerId).id;
assert.equal((await emit(comparerSocket, "zjh:action", { action: "compare", targetId })).ok, true);
const afterCompare = await waitFor(host, (value) => value.phase === "playing" && value.players.filter((player) => player.cardCount === 3 && !player.folded).length === 2);
assert.equal(afterCompare.players.filter((player) => player.id !== created.playerId).every((player) => player.cards.length === 0), true);

const foldSocket = idToSocket.get(afterCompare.actionPlayerId);
assert.ok(foldSocket);
assert.equal((await emit(foldSocket, "zjh:action", { action: "fold" })).ok, true);
const result = await waitFor(host, (value) => value.phase === "result");
assert.equal(result.players.filter((player) => player.cardCount === 3).every((player) => player.cards.length === 3 && Boolean(player.hand?.name)), true);
assert.equal(result.players.reduce((sum, player) => sum + player.points, 0), 3000);
assert.equal(Boolean(result.result?.winnerId), true);

assert.equal((await emit(host, "zjh:auto-start", { enabled: true })).ok, true);
await waitFor(host, (value) => Boolean(value.nextHandAt));
assert.equal((await emit(host, "zjh:auto-start", { enabled: false })).ok, true);
assert.equal((await emit(host, "zjh:host-points", { playerId: thirdJoin.playerId, points: 5 })).ok, true);
await waitFor(third, (value) => value.viewer?.seated === false);
const preview = await emit(third, "zjh:preview", { roomId: created.roomId });
assert.equal(preview.occupiedSeats.some((seat) => seat.seat === 4), false);
const forced = await testRoundLimit();
assert.equal(forced.maxRound, 15);
assert.equal(forced.result.phase, "result");

console.log(JSON.stringify({ room: created.roomId, privacy: "ok", seenCost: "ok", raise: "ok", compare: "ok", roundLimit: forced.maxRound, conservation: "ok", rules: "ok", autoStart: "ok", minimumBalance: "ok", chat: "ok" }));
for (const socket of sockets) socket.disconnect();

function connected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", resolve));
}

function waitFor(socket, predicate, timeout = 4000) {
  const current = latest.get(socket.id);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("zjh:state", check); reject(new Error("zjh state timeout")); }, timeout);
    const check = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off("zjh:state", check);
      resolve(value);
    };
    socket.on("zjh:state", check);
  });
}

function testRules() {
  const c = (rank, suit) => ({ rank, suit });
  const trips = [c("A", "s"), c("A", "h"), c("A", "c")];
  const straightFlush = [c("Q", "h"), c("K", "h"), c("A", "h")];
  const flush = [c("A", "d"), c("J", "d"), c("8", "d")];
  const straight = [c("9", "s"), c("T", "h"), c("J", "c")];
  const pair = [c("K", "s"), c("K", "h"), c("2", "c")];
  const high = [c("A", "s"), c("J", "h"), c("8", "c")];
  assert.deepEqual([trips, straightFlush, flush, straight, pair, high].map((cards) => evaluateZjhHand(cards).category), [6, 5, 4, 3, 2, 1]);
  assert.equal(evaluateZjhHand([c("A", "s"), c("2", "h"), c("3", "c")]).name, "顺子");
  assert.equal(evaluateZjhHand([c("K", "s"), c("A", "h"), c("2", "c")]).name, "散牌");
  assert.equal(compareZjhCards(straightFlush, [c("J", "s"), c("Q", "s"), c("K", "s")]) > 0, true);
  const special235 = [c("2", "s"), c("3", "h"), c("5", "c")];
  assert.equal(compareZjhCards(special235, trips) > 0, true);
  assert.equal(compareZjhCards([c("2", "s"), c("3", "s"), c("5", "s")], trips) < 0, true);
  assert.equal(compareZjhCards(high, [...high]) === 0, true);
}

async function testRoundLimit() {
  const a = io(url);
  const b = io(url);
  const roundLatest = new Map();
  for (const socket of [a, b]) socket.on("zjh:state", (value) => roundLatest.set(socket.id, value));
  await Promise.all([connected(a), connected(b)]);
  const createdRound = await emit(a, "zjh:create", { name: "轮数甲", settings: { startingPoints: 10000, ante: 1, maxPlayers: 2, decisionTimeSeconds: 30 } });
  const joinedRound = await emit(b, "zjh:join", { roomId: createdRound.roomId, name: "轮数乙", points: 10000, seat: 1 });
  await waitRound(a, (value) => value.players.length === 2);
  await emit(a, "zjh:start");
  const socketById = new Map([[createdRound.playerId, a], [joinedRound.playerId, b]]);
  let maxRound = 0;
  for (let actions = 0; actions < 35; actions += 1) {
    const current = await waitRound(a, (value) => value.phase === "result" || Boolean(value.actionPlayerId));
    maxRound = Math.max(maxRound, current.bettingRound);
    if (current.phase === "result") break;
    const actor = socketById.get(current.actionPlayerId);
    assert.ok(actor);
    assert.equal((await emit(actor, "zjh:action", { action: "call" })).ok, true);
    await waitRound(a, (value) => value.phase === "result" || value.actionPlayerId !== current.actionPlayerId);
  }
  const result = await waitRound(a, (value) => value.phase === "result");
  a.disconnect();
  b.disconnect();
  return { maxRound, result };

  function waitRound(socket, predicate, timeout = 4000) {
    const current = roundLatest.get(socket.id);
    if (current && predicate(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off("zjh:state", check); reject(new Error("round-limit timeout")); }, timeout);
      const check = (value) => {
        if (!predicate(value)) return;
        clearTimeout(timer);
        socket.off("zjh:state", check);
        resolve(value);
      };
      socket.on("zjh:state", check);
    });
  }
}
