import { io } from "socket.io-client";
import assert from "node:assert/strict";

const url = "http://localhost:3000";
const host = io(url);
const guest = io(url);
const late = io(url);
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const latest = new Map();
const busy = new Set();
let hostId;
let guestId;
let lateId;
let autoplay = false;
let forcedAllIn = false;
const communityCounts = [];
let runoutStartState;

host.on("room:state", (value) => {
  latest.set(host.id, value);
  if (value.hand?.runout && communityCounts.at(-1) !== value.hand.community.length) communityCounts.push(value.hand.community.length);
  if (value.hand?.runout && value.hand.community.length === 0) runoutStartState = value;
  if (hostId) play(host, value, hostId);
});
guest.on("room:state", (value) => {
  latest.set(guest.id, value);
  if (guestId) play(guest, value, guestId);
});
late.on("room:state", (value) => { latest.set(late.id, value); });

await Promise.all([connected(host), connected(guest), connected(late)]);
const created = await emit(host, "room:create", { name: "Host", settings: { startingPoints: 1000, smallBlind: 10, bigBlind: 20 } });
assert.equal(created.ok, true);
hostId = created.playerId;
const preview = await emit(guest, "room:preview", { roomId: created.roomId });
assert.equal(preview.ok, true);
assert.equal(preview.defaultPoints, 1000);
assert.equal(preview.remainingSlots, 7);
assert.equal(preview.occupiedSeats[0].seat, 0);
assert.equal((await emit(guest, "room:join", { roomId: created.roomId, name: "Guest", points: 1200, seat: 0 })).ok, false);
const joined = await emit(guest, "room:join", { roomId: created.roomId, name: "Guest", points: 1200, seat: 3 });
assert.equal(joined.ok, true);
guestId = joined.playerId;
await waitFor(host, (value) => value.players.length === 2);
assert.equal(latest.get(host.id).players.find((player) => player.id === guestId).points, 1200);
assert.equal(latest.get(host.id).players.find((player) => player.id === guestId).seat, 3);
assert.equal(latest.get(host.id).settings.decisionTimeSeconds, 30);

assert.equal((await emit(host, "game:pause", { paused: true })).ok, true);
await waitFor(host, (value) => value.paused === true);
assert.equal((await emit(host, "game:start")).ok, false);
assert.equal((await emit(guest, "game:pause", { paused: false })).ok, false);
assert.equal((await emit(guest, "host:points", { playerId: hostId, points: 999999 })).ok, false);
assert.equal((await emit(guest, "host:kick", { playerId: hostId })).ok, false);
assert.equal((await emit(guest, "host:auto-start", { enabled: true })).ok, false);
assert.equal((await emit(host, "game:pause", { paused: false })).ok, true);
assert.equal((await emit(host, "host:auto-start", { enabled: true })).ok, true);
await waitFor(host, (value) => value.settings.autoStartNextHand === true);
assert.equal((await emit(host, "host:auto-start", { enabled: false })).ok, true);
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
assert.equal(Boolean(hostDealt.players.find((p) => p.id === hostId).handName), true);
assert.equal(hostDealt.players.find((p) => p.id === guestId).handName, null);
assert.equal(guestDealt.players.find((p) => p.id === guestId).cards.length, 2);
assert.equal(guestDealt.players.find((p) => p.id === hostId).cards.length, 0);

const midHandPreview = await emit(late, "room:preview", { roomId: created.roomId });
assert.equal(midHandPreview.handInProgress, true);
const lateJoined = await emit(late, "room:join", { roomId: created.roomId, name: "Late", points: 700, seat: 5 });
assert.equal(lateJoined.ok, true);
lateId = lateJoined.playerId;
const withLatePlayer = await waitFor(host, (value) => value.players.length === 3);
assert.equal(withLatePlayer.players.find((player) => player.id === lateId).status, "下一手入座");
assert.equal(withLatePlayer.players.find((player) => player.id === lateId).cardCount, 0);

assert.equal((await emit(host, "game:pause", { paused: true })).ok, true);
const currentId = hostDealt.hand.actionPlayerId;
const currentSocket = currentId === hostId ? host : guest;
assert.equal((await emit(currentSocket, "game:action", { action: "fold" })).ok, false);
assert.equal((await emit(host, "game:pause", { paused: false })).ok, true);

autoplay = true;
play(host, hostDealt, hostId);
play(guest, guestDealt, guestId);
const finished = await waitFor(host, (value) => Boolean(value.hand?.result), 9000);
assert.equal(finished.players.filter((p) => p.id !== lateId).every((p) => p.cards.length === 2), true);
assert.equal(finished.players.filter((p) => p.id !== lateId).every((p) => Boolean(p.handName)), true);
assert.equal(finished.players.find((p) => p.id === lateId).cards.length, 0);
assert.deepEqual(communityCounts, [0, 1, 2, 3, 4, 5]);
const allInPlayers = runoutStartState.players.filter((player) => player.cardCount === 2);
assert.equal(allInPlayers.every((player) => player.cards.length === 2), true);
assert.equal(Math.round(Object.values(runoutStartState.hand.equities).reduce((sum, value) => sum + value, 0)), 100);
assert.equal(finished.hand.pot, 2000);
for (const player of finished.players) assert.equal(finished.hand.result.text.split(player.name).length - 1 <= 1, true);
assert.equal(finished.players.reduce((sum, p) => sum + p.points, 0), 3200);
assert.equal((await emit(host, "host:auto-start", { enabled: true })).ok, true);
await waitFor(host, (value) => Boolean(value.nextHandAt));
assert.equal((await emit(host, "host:auto-start", { enabled: false })).ok, true);
assert.equal((await emit(host, "host:points", { playerId: lateId, points: 0 })).ok, true);
const lateBusted = await waitFor(late, (value) => value.viewer?.seated === false);
assert.equal(lateBusted.viewer.rejoinCount, 0);
const freedPreview = await emit(late, "room:preview", { roomId: created.roomId });
assert.equal(freedPreview.occupiedSeats.some((seat) => seat.seat === 5), false);
const reseated = await emit(late, "room:join", { roomId: created.roomId, name: "Late", points: 800, seat: 6, token: lateJoined.token });
assert.equal(reseated.ok, true);
assert.equal(reseated.rejoinCount, 1);
const lateReturned = await waitFor(host, (value) => value.players.some((player) => player.id === lateId && player.seat === 6));
assert.equal(lateReturned.players.find((player) => player.id === lateId).rejoinCount, 1);
assert.equal((await emit(host, "host:kick", { playerId: guestId })).ok, true);
await waitFor(host, (value) => !value.players.some((player) => player.id === guestId));
assert.equal((await emit(host, "host:kick", { playerId: lateId })).ok, true);
await waitFor(host, (value) => !value.players.some((player) => player.id === lateId));
const timeoutHost = io(url);
const timeoutGuest = io(url);
timeoutHost.on("room:state", (value) => latest.set(timeoutHost.id, value));
timeoutGuest.on("room:state", (value) => latest.set(timeoutGuest.id, value));
await Promise.all([connected(timeoutHost), connected(timeoutGuest)]);
const timeoutRoom = await emit(timeoutHost, "room:create", { name: "TimerHost", settings: { startingPoints: 1000, smallBlind: 10, bigBlind: 20, decisionTimeSeconds: 5 } });
const timeoutJoin = await emit(timeoutGuest, "room:join", { roomId: timeoutRoom.roomId, name: "TimerGuest", points: 1000, seat: 2 });
assert.equal(timeoutJoin.ok, true);
await waitFor(timeoutHost, (value) => value.players.length === 2);
assert.equal((await emit(timeoutHost, "game:start")).ok, true);
const timedOutHand = await waitFor(timeoutHost, (value) => Boolean(value.hand?.result), 7000);
assert.equal(timedOutHand.messages.some((message) => message.text.includes("思考超时") && message.text.includes("自动弃牌")), true);
assert.equal(timedOutHand.players.every((player) => player.cards.length === 2), true);
assert.equal((await emit(timeoutHost, "game:start")).ok, true);
const preflopOne = await waitFor(timeoutHost, (value) => value.hand?.phase === "preflop" && !value.hand.result);
await actCurrent(preflopOne, timeoutRoom.playerId, timeoutJoin.playerId, timeoutHost, timeoutGuest);
const preflopTwo = await waitFor(timeoutHost, (value) => value.hand?.phase === "preflop" && value.hand.actionPlayerId !== preflopOne.hand.actionPlayerId);
await actCurrent(preflopTwo, timeoutRoom.playerId, timeoutJoin.playerId, timeoutHost, timeoutGuest);
await waitFor(timeoutHost, (value) => value.hand?.phase === "flop");
const autoChecked = await waitFor(timeoutHost, (value) => value.messages.some((message) => message.text.includes("思考超时") && message.text.includes("自动过牌")), 7000);
const afterCheckSocket = autoChecked.hand.actionPlayerId === timeoutRoom.playerId ? timeoutHost : timeoutGuest;
assert.equal((await emit(afterCheckSocket, "game:action", { action: "fold" })).ok, true);
console.log(JSON.stringify({ room: created.roomId, hand: finished.hand.result.text, totalPoints: 3200, permissions: "ok", awayState: "ok", kick: "ok", runout: communityCounts, allInEquity: "ok", revealAfterHand: "ok", handName: "ok", autoStart: "ok", seatSelection: "ok", midHandJoin: "ok", reseatCount: "ok", actionTimeoutFold: "ok", actionTimeoutCheck: "ok" }));
host.disconnect();
guest.disconnect();
late.disconnect();
timeoutHost.disconnect();
timeoutGuest.disconnect();

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
  const action = !forcedAllIn ? "allin" : call ? "call" : "check";
  forcedAllIn = true;
  await emit(socket, "game:action", { action });
  busy.delete(socket.id);
  play(socket, latest.get(socket.id), playerId);
}

async function actCurrent(state, hostPlayerId, guestPlayerId, hostSocket, guestSocket) {
  const player = state.players.find((candidate) => candidate.id === state.hand.actionPlayerId);
  const call = Math.max(0, state.hand.currentBet - player.bet);
  const socket = state.hand.actionPlayerId === hostPlayerId ? hostSocket : state.hand.actionPlayerId === guestPlayerId ? guestSocket : null;
  assert.ok(socket);
  const response = await emit(socket, "game:action", { action: call ? "call" : "check" });
  assert.equal(response.ok, true);
}
