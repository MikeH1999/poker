import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";

const url = process.env.TEST_URL || "http://localhost:3000";
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const connect = (socket) => socket.connected ? Promise.resolve() : new Promise((resolve) => socket.once("connect", resolve));

function track(event, sockets) {
  const latest = new Map();
  for (const socket of sockets) socket.on(event, (state) => latest.set(socket, state));
  return (socket, predicate, timeout = 8000) => {
    const current = latest.get(socket);
    if (current && predicate(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off(event, check); reject(new Error(`${event} timeout`)); }, timeout);
      function check(state) {
        if (!predicate(state)) return;
        clearTimeout(timer);
        socket.off(event, check);
        resolve(state);
      }
      socket.on(event, check);
    });
  };
}

async function testShortAllIn() {
  const sockets = [io(url), io(url), io(url)];
  const [host, caller, short] = sockets;
  const wait = track("room:state", sockets);
  await Promise.all(sockets.map(connect));
  const created = await emit(host, "room:create", { name: "A", settings: { startingPoints: 1000, smallBlind: 50, bigBlind: 100 } });
  const joinedCaller = await emit(caller, "room:join", { roomId: created.roomId, name: "B", points: 1000, seat: 1 });
  const joinedShort = await emit(short, "room:join", { roomId: created.roomId, name: "C", points: 150, seat: 2 });
  assert.equal(created.ok && joinedCaller.ok && joinedShort.ok, true);
  await wait(host, (state) => state.players.length === 3);
  assert.equal((await emit(host, "game:start")).ok, true);
  await wait(host, (state) => state.hand?.actionPlayerId === created.playerId);
  assert.equal((await emit(host, "game:action", { action: "call" })).ok, true);
  await wait(caller, (state) => state.hand?.actionPlayerId === joinedCaller.playerId);
  assert.equal((await emit(caller, "game:action", { action: "call" })).ok, true);
  await wait(short, (state) => state.hand?.actionPlayerId === joinedShort.playerId);
  assert.equal((await emit(short, "game:action", { action: "allin" })).ok, true);
  const reopened = await wait(host, (state) => state.hand?.currentBet === 150 && state.hand?.actionPlayerId === created.playerId);
  assert.equal(reopened.players.find((player) => player.id === created.playerId).canRaise, false);
  const rejected = await emit(host, "game:action", { action: "raise", amount: 250 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /未重新开放加注/);
  assert.equal((await emit(host, "game:action", { action: "call" })).ok, true);
  for (const socket of sockets) socket.disconnect();
}

async function testNiuResultVisibility() {
  const sockets = [io(url), io(url)];
  const [host, low] = sockets;
  const wait = track("niu:state", sockets);
  await Promise.all(sockets.map(connect));
  const created = await emit(host, "niu:create", { name: "Banker", settings: { startingPoints: 100, baseScore: 10 } });
  const joined = await emit(low, "niu:join", { roomId: created.roomId, name: "Low", points: 10, seat: 1 });
  await wait(host, (state) => state.players.length === 2);
  for (let round = 1; round <= 20; round += 1) {
    assert.equal((await emit(host, "niu:start")).ok, true);
    await wait(host, (state) => state.phase === "bid" && state.roundNumber === round);
    assert.equal((await emit(host, "niu:bid", { multiplier: 1 })).ok, true);
    assert.equal((await emit(low, "niu:bid", { multiplier: 0 })).ok, true);
    await wait(host, (state) => state.phase === "bet" && state.bankerId === created.playerId);
    assert.equal((await emit(low, "niu:bet", { multiplier: 1 })).ok, true);
    const result = await wait(low, (state) => state.phase === "result" && state.roundNumber === round);
    const settlement = result.result.settlements.find((entry) => entry.playerId === joined.playerId);
    if (settlement.delta < 0) {
      const busted = result.players.find((player) => player.id === joined.playerId);
      assert.ok(busted);
      assert.equal(busted.seated, false);
      assert.equal(busted.seat, 1);
      assert.equal(busted.cards.length, 5);
      assert.ok(busted.hand);
      assert.equal(result.viewer.seated, false);
      for (const socket of sockets) socket.disconnect();
      return;
    }
    assert.equal((await emit(host, "niu:host-points", { playerId: joined.playerId, points: 10 })).ok, true);
    await wait(low, (state) => state.players.some((player) => player.id === joined.playerId && player.points === 10));
  }
  throw new Error("牛牛 20 局内未出现低余额玩家输局");
}

async function testDdzReconnectTimer() {
  const original = [io(url), io(url), io(url)];
  const wait = track("ddz:state", original);
  await Promise.all(original.map(connect));
  const created = await emit(original[0], "ddz:create", { name: "A", settings: { startingPoints: 1000, baseScore: 10, decisionTimeSeconds: 30 } });
  const joinedB = await emit(original[1], "ddz:join", { roomId: created.roomId, name: "B", points: 1000, seat: 1 });
  const joinedC = await emit(original[2], "ddz:join", { roomId: created.roomId, name: "C", points: 1000, seat: 2 });
  await wait(original[0], (state) => state.players.length === 3);
  assert.equal((await emit(original[0], "ddz:start")).ok, true);
  const bidding = await wait(original[0], (state) => state.phase === "bidding" && Boolean(state.bidPlayerId));
  const credentials = [created, joinedB, joinedC];
  const actor = credentials.findIndex((entry) => entry.playerId === bidding.bidPlayerId);
  assert.equal((await emit(original[actor], "ddz:bid", { score: 3 })).ok, true);
  await wait(original[0], (state) => state.phase === "playing" && Boolean(state.actionDeadline));
  for (const socket of original) socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const reconnected = [io(url), io(url), io(url)];
  const waitReconnected = track("ddz:state", reconnected);
  await Promise.all(reconnected.map(connect));
  for (let index = 0; index < reconnected.length; index += 1) {
    assert.equal((await emit(reconnected[index], "ddz:join", { roomId: created.roomId, token: credentials[index].token })).ok, true);
  }
  const restored = await waitReconnected(reconnected[0], (state) => state.phase === "playing" && state.players.every((player) => player.connected));
  assert.ok(restored.actionPlayerId);
  assert.ok(restored.actionDeadline > Date.now());
  for (const socket of reconnected) socket.disconnect();
}

async function testNiuLandscapeBreakpoint() {
  const css = await readFile(new URL("../public/niuniu.css", import.meta.url), "utf8");
  assert.match(css, /@media\(max-width:760px\),\(max-width:900px\) and \(max-height:600px\) and \(orientation:landscape\)/);
}

await testShortAllIn();
await testNiuResultVisibility();
await testDdzReconnectTimer();
await testNiuLandscapeBreakpoint();
console.log(JSON.stringify({ shortAllInReopen: "ok", niuBustedResult: "ok", ddzReconnectTimer: "ok", niuLandscape: "ok" }));
