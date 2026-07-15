import { io } from "socket.io-client";
import assert from "node:assert/strict";

const url = "http://localhost:3000";
const host = io(url);
const guest = io(url);
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const latest = new Map();
const busy = new Set();
let hostId;
let guestId;
let autoplay = false;

host.on("room:state", (value) => {
  latest.set(host.id, value);
  if (hostId) play(host, value, hostId);
});
guest.on("room:state", (value) => {
  latest.set(guest.id, value);
  if (guestId) play(guest, value, guestId);
});

await Promise.all([connected(host), connected(guest)]);
const created = await emit(host, "room:create", { name: "Host", settings: { startingPoints: 1000, smallBlind: 10, bigBlind: 20 } });
assert.equal(created.ok, true);
hostId = created.playerId;
const joined = await emit(guest, "room:join", { roomId: created.roomId, name: "Guest" });
assert.equal(joined.ok, true);
guestId = joined.playerId;
await waitFor(host, (value) => value.players.length === 2);

assert.equal((await emit(host, "game:pause", { paused: true })).ok, true);
await waitFor(host, (value) => value.paused === true);
assert.equal((await emit(host, "game:start")).ok, false);
assert.equal((await emit(guest, "game:pause", { paused: false })).ok, false);
assert.equal((await emit(guest, "host:points", { playerId: hostId, points: 999999 })).ok, false);
assert.equal((await emit(guest, "host:kick", { playerId: hostId })).ok, false);
assert.equal((await emit(host, "game:pause", { paused: false })).ok, true);
assert.equal((await emit(host, "host:points", { playerId: guestId, points: 1500 })).ok, true);
await waitFor(guest, (value) => value.players.find((p) => p.id === guestId)?.points === 1500);
assert.equal((await emit(guest, "player:away", { away: true })).ok, true);
await waitFor(host, (value) => value.players.find((p) => p.id === guestId)?.away === true);
assert.equal((await emit(host, "game:start")).ok, false);
assert.equal((await emit(guest, "player:away", { away: false })).ok, true);
await waitFor(host, (value) => value.players.find((p) => p.id === guestId)?.away === false);

const started = await emit(host, "game:start");
assert.equal(started.ok, true);
const hostDealt = await waitFor(host, (value) => value.hand && !value.hand.result);
const guestDealt = await waitFor(guest, (value) => value.hand && !value.hand.result);
assert.equal(hostDealt.players.find((p) => p.id === hostId).cards.length, 2);
assert.equal(hostDealt.players.find((p) => p.id === guestId).cards.length, 0);
assert.equal(guestDealt.players.find((p) => p.id === guestId).cards.length, 2);
assert.equal(guestDealt.players.find((p) => p.id === hostId).cards.length, 0);

assert.equal((await emit(host, "game:pause", { paused: true })).ok, true);
const currentId = hostDealt.hand.actionPlayerId;
const currentSocket = currentId === hostId ? host : guest;
assert.equal((await emit(currentSocket, "game:action", { action: "fold" })).ok, false);
assert.equal((await emit(host, "game:pause", { paused: false })).ok, true);

autoplay = true;
play(host, hostDealt, hostId);
play(guest, guestDealt, guestId);
const finished = await waitFor(host, (value) => Boolean(value.hand?.result), 6000);
assert.equal(finished.players.every((p) => p.cards.length === 2), true);
assert.equal(finished.players.reduce((sum, p) => sum + p.points, 0), 2500);
assert.equal((await emit(host, "host:kick", { playerId: guestId })).ok, true);
const afterKick = await waitFor(host, (value) => value.players.length === 1);
assert.equal(afterKick.players[0].id, hostId);
console.log(JSON.stringify({ room: created.roomId, hand: finished.hand.result.text, totalPoints: 2500, permissions: "ok", awayState: "ok", kick: "ok" }));
host.disconnect();
guest.disconnect();

function connected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", resolve));
}

function waitFor(socket, predicate, timeout = 3000) {
  const current = latest.get(socket.id);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("room:state", check); reject(new Error("state timeout")); }, timeout);
    const check = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off("room:state", check);
      resolve(value);
    };
    socket.on("room:state", check);
  });
}

async function play(socket, value, playerId) {
  if (!autoplay || !value?.hand || value.hand.result || value.hand.actionPlayerId !== playerId || busy.has(socket.id)) return;
  busy.add(socket.id);
  const player = value.players.find((p) => p.id === playerId);
  const call = Math.max(0, value.hand.currentBet - player.bet);
  await emit(socket, "game:action", { action: call ? "call" : "check" });
  busy.delete(socket.id);
  play(socket, latest.get(socket.id), playerId);
}
