import { io } from "socket.io-client";
import assert from "node:assert/strict";

const url = "http://localhost:3000";
const host = io(url);
const guest = io(url);
const late = io(url);
const latest = new Map();
for (const socket of [host, guest, late]) socket.on("niu:state", (state) => latest.set(socket.id, state));
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
await Promise.all([connected(host), connected(guest), connected(late)]);

const created = await emit(host, "niu:create", { name: "庄家候选", settings: { startingPoints: 1000, baseScore: 1, maxPlayers: 6 } });
assert.equal(created.ok, true);
const preview = await emit(guest, "niu:preview", { roomId: created.roomId });
assert.equal(preview.maxPlayers, 6);
assert.equal(preview.occupiedSeats[0].seat, 0);
const joined = await emit(guest, "niu:join", { roomId: created.roomId, name: "闲家", points: 1000, seat: 3 });
assert.equal(joined.ok, true);
await waitFor(host, (state) => state.players.length === 2);

const bubblePromise = new Promise((resolve) => host.once("niu:chat-bubble", resolve));
assert.equal((await emit(guest, "niu:chat", { text: "牛牛走起" })).ok, true);
assert.equal((await bubblePromise).playerId, joined.playerId);

assert.equal((await emit(host, "niu:start")).ok, true);
const hostBidState = await waitFor(host, (state) => state.phase === "bid");
const guestBidState = await waitFor(guest, (state) => state.phase === "bid");
assert.equal(hostBidState.players.find((player) => player.id === created.playerId).cards.length, 4);
assert.equal(hostBidState.players.find((player) => player.id === joined.playerId).cards.length, 0);
assert.equal(guestBidState.players.find((player) => player.id === joined.playerId).cards.length, 4);

const midPreview = await emit(late, "niu:preview", { roomId: created.roomId });
assert.equal(midPreview.inProgress, true);
const lateJoin = await emit(late, "niu:join", { roomId: created.roomId, name: "下一局玩家", points: 600, seat: 5 });
assert.equal(lateJoin.ok, true);
await waitFor(host, (state) => state.players.length === 3);

assert.equal((await emit(host, "niu:bid", { multiplier: 1 })).ok, true);
assert.equal((await emit(guest, "niu:bid", { multiplier: 0 })).ok, true);
const betState = await waitFor(guest, (state) => state.phase === "bet");
assert.equal(betState.bankerId, created.playerId);
assert.equal((await emit(guest, "niu:bet", { multiplier: 1 })).ok, true);
const reveal = await waitFor(guest, (state) => state.phase === "reveal");
const own = reveal.players.find((player) => player.id === joined.playerId);
assert.equal(own.cards.length, 5);
assert.equal(Boolean(own.hand?.name), true);
assert.equal([1, 2, 3, 4, 5, 6].includes(own.hand.multiplier), true);

const result = await waitFor(host, (state) => state.phase === "result", 4000);
const participants = result.players.filter((player) => player.cardCount === 5);
assert.equal(participants.length, 2);
assert.equal(participants.every((player) => player.cards.length === 5), true);
assert.equal(result.players.reduce((sum, player) => sum + player.points, 0), 2600);
assert.equal(result.result.settlements.reduce((sum, settlement) => sum + settlement.delta, 0), 0);

assert.equal((await emit(host, "niu:host-points", { playerId: lateJoin.playerId, points: 0 })).ok, true);
await waitFor(late, (state) => state.viewer?.seated === false);
const returned = await emit(late, "niu:join", { roomId: created.roomId, token: lateJoin.token, name: "下一局玩家", points: 800, seat: 4 });
assert.equal(returned.rejoinCount, 1);
await waitFor(host, (state) => state.players.some((player) => player.id === lateJoin.playerId && player.seat === 4));

console.log(JSON.stringify({ room: created.roomId, dealFour: "ok", bidding: "ok", betting: "ok", fifthCard: "ok", settlement: "ok", conservation: "ok", midRoundJoin: "ok", reseat: "ok", chat: "ok" }));
host.disconnect(); guest.disconnect(); late.disconnect();

function connected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", resolve));
}

function waitFor(socket, predicate, timeout = 2500) {
  const current = latest.get(socket.id);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("niu:state", check); reject(new Error("niu state timeout")); }, timeout);
    const check = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off("niu:state", check);
      resolve(state);
    };
    socket.on("niu:state", check);
  });
}
