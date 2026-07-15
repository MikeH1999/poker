import { io } from "socket.io-client";
import assert from "node:assert/strict";

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url);
const guest = io(url);
const late = io(url);
const latest = new Map();
const dealCounts = [];
for (const socket of [host, guest, late]) socket.on("niu:state", (state) => {
  latest.set(socket.id, state);
  if (socket === host && state.phase === "deal") {
    const self = state.players.find((player) => player.id === state.viewer?.id);
    if (self && dealCounts.at(-1) !== self.cardCount) dealCounts.push(self.cardCount);
  }
});
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
await Promise.all([connected(host), connected(guest), connected(late)]);

const created = await emit(host, "niu:create", { name: "庄家候选", settings: { startingPoints: 1000, baseScore: 10, maxPlayers: 6, decisionTimeSeconds: 30 } });
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
const hostBidState = await waitFor(host, (state) => state.phase === "bid", 6000);
const guestBidState = await waitFor(guest, (state) => state.phase === "bid", 6000);
assert.deepEqual(dealCounts, [0, 1, 2, 3, 4]);
assert.equal(hostBidState.phaseDeadline > Date.now(), true);
assert.equal(hostBidState.players.find((player) => player.id === created.playerId).cards.length, 4);
assert.equal(hostBidState.players.find((player) => player.id === joined.playerId).cards.length, 0);
assert.equal(guestBidState.players.find((player) => player.id === joined.playerId).cards.length, 4);

const midPreview = await emit(late, "niu:preview", { roomId: created.roomId });
assert.equal(midPreview.inProgress, true);
const lateJoin = await emit(late, "niu:join", { roomId: created.roomId, name: "下一局玩家", points: 600, seat: 5 });
assert.equal(lateJoin.ok, true);
await waitFor(host, (state) => state.players.length === 3);

assert.equal((await emit(host, "niu:bid", { multiplier: 1 })).ok, true);
assert.equal((await emit(guest, "niu:bid", { multiplier: 1 })).ok, true);
const selecting = await waitFor(host, (state) => state.phase === "banker_select");
assert.equal(selecting.bankerCandidates.length, 2);
const betState = await waitFor(host, (state) => state.phase === "bet", 4000);
const idleSocket = betState.bankerId === created.playerId ? guest : host;
assert.equal((await emit(idleSocket, "niu:bet", { multiplier: 1 })).ok, true);
const fifthDeal = await waitFor(guest, (state) => state.phase === "fifth_deal");
assert.equal(fifthDeal.players.find((player) => player.id === joined.playerId).cardCount, 4);
const reveal = await waitFor(guest, (state) => state.phase === "reveal", 3000);
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
assert.equal((await emit(host, "niu:auto-start", { enabled: true })).ok, true);
await waitFor(host, (state) => Boolean(state.nextRoundAt));
assert.equal((await emit(host, "niu:auto-start", { enabled: false })).ok, true);

assert.equal((await emit(host, "niu:host-points", { playerId: lateJoin.playerId, points: 4 })).ok, true);
await waitFor(late, (state) => state.viewer?.seated === false);
const returned = await emit(late, "niu:join", { roomId: created.roomId, token: lateJoin.token, name: "下一局玩家", points: 800, seat: 4 });
assert.equal(returned.rejoinCount, 1);
await waitFor(host, (state) => state.players.some((player) => player.id === lateJoin.playerId && player.seat === 4));

console.log(JSON.stringify({ room: created.roomId, stagedDeal: dealCounts, bidding: "ok", bankerMarquee: "ok", betting: "ok", fifthCard: "ok", settlement: "ok", conservation: "ok", minimumBalance: "ok", autoStart: "ok", midRoundJoin: "ok", reseat: "ok", chat: "ok" }));
host.disconnect(); guest.disconnect(); late.disconnect();

function connected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", resolve));
}

function waitFor(socket, predicate, timeout = 3000) {
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
