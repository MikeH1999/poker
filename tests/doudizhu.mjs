import { io } from "socket.io-client";
import assert from "node:assert/strict";
import { analyzeDdzPlay, canBeatDdzPlay, ddzPlayName } from "../game/doudizhu-rules.mjs";

testRules();

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url), guest = io(url), third = io(url);
const sockets = [host, guest, third];
const latest = new Map();
for (const socket of sockets) socket.on("ddz:state", (state) => latest.set(socket.id, state));
const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
await Promise.all(sockets.map(connected));

const created = await emit(host, "ddz:create", { name: "地主候选", settings: { startingPoints: 1000, baseScore: 10, decisionTimeSeconds: 30 } });
const joinedGuest = await emit(guest, "ddz:join", { roomId: created.roomId, name: "农民甲", points: 1000, seat: 1 });
const joinedThird = await emit(third, "ddz:join", { roomId: created.roomId, name: "农民乙", points: 1000, seat: 2 });
assert.equal(created.ok && joinedGuest.ok && joinedThird.ok, true);
await waitFor(host, (state) => state.players.length === 3);

const bubblePromise = new Promise((resolve) => host.once("ddz:chat-bubble", resolve));
assert.equal((await emit(guest, "ddz:chat", { text: "开始斗地主" })).ok, true);
assert.equal((await bubblePromise).playerId, joinedGuest.playerId);

assert.equal((await emit(host, "ddz:start")).ok, true);
const bidding = await waitFor(host, (state) => state.phase === "bidding");
const guestBidding = await waitFor(guest, (state) => state.phase === "bidding");
assert.equal(bidding.players.every((player) => player.cardCount === 17), true);
assert.equal(bidding.players.find((player) => player.id === created.playerId).cards.length, 17);
assert.equal(bidding.players.filter((player) => player.id !== created.playerId).every((player) => player.cards.length === 0), true);
assert.equal(guestBidding.players.find((player) => player.id === joinedGuest.playerId).cards.length, 17);
assert.equal(bidding.bottomCards.length, 0);

const idToSocket = new Map([[created.playerId, host], [joinedGuest.playerId, guest], [joinedThird.playerId, third]]);
const bidder = idToSocket.get(bidding.bidPlayerId);
assert.equal((await emit(bidder, "ddz:bid", { score: 3 })).ok, true);
let state = await waitFor(host, (value) => value.phase === "playing");
assert.equal(state.highestBid, 3);
assert.equal(state.bottomCards.length, 3);
assert.equal(state.players.find((player) => player.id === state.landlordId).cardCount, 20);
for (const socket of sockets) {
  const view = latest.get(socket.id);
  const ownId = view.viewer.id;
  assert.equal(view.players.filter((player) => player.id !== ownId).every((player) => player.cards.length === 0), true);
}

const landlordSocket = idToSocket.get(state.landlordId);
assert.equal((await emit(landlordSocket, "ddz:pass")).ok, false);
let actions = 0;
while (state.phase !== "result" && actions < 70) {
  const actorId = state.actionPlayerId;
  const actorSocket = idToSocket.get(actorId);
  assert.ok(actorSocket);
  let response;
  if (state.previousPlay && state.previousPlay.playerId !== actorId) response = await emit(actorSocket, "ddz:pass");
  else {
    const actorView = latest.get(actorSocket.id);
    const card = actorView.players.find((player) => player.id === actorId).cards[0];
    response = await emit(actorSocket, "ddz:play", { cardIds: [card.id] });
  }
  assert.equal(response.ok, true);
  actions += 1;
  state = await waitFor(host, (value) => value.phase === "result" || value.actionPlayerId !== actorId);
}
assert.equal(state.phase, "result");
assert.equal(state.result.landlordWon, true);
assert.equal(state.result.score, 30);
assert.equal(state.players.reduce((sum, player) => sum + player.points, 0), 3000);
assert.equal(state.players.find((player) => player.id === state.landlordId).delta, 60);
assert.equal(state.players.filter((player) => player.id !== state.landlordId).every((player) => player.delta === -30), true);
assert.equal(state.players.every((player) => player.cards.length === player.cardCount), true);

assert.equal((await emit(host, "ddz:auto-start", { enabled: true })).ok, true);
await waitFor(host, (value) => Boolean(value.nextHandAt));
assert.equal((await emit(host, "ddz:auto-start", { enabled: false })).ok, true);
assert.equal((await emit(host, "ddz:host-points", { playerId: joinedThird.playerId, points: 5 })).ok, true);
await waitFor(third, (value) => value.viewer?.seated === false);

const redeal = await testAllPass();
assert.equal(redeal.handNumber >= 2, true);
assert.equal(redeal.phase, "bidding");

console.log(JSON.stringify({ room: created.roomId, privacy: "ok", bidding: "ok", bottomCards: "ok", completeHand: actions, settlement: "ok", conservation: "ok", autoStart: "ok", minimumBalance: "ok", allPassRedeal: "ok", rules: "ok", chat: "ok" }));
for (const socket of sockets) socket.disconnect();

function connected(socket) { if (socket.connected) return Promise.resolve(); return new Promise((resolve) => socket.once("connect", resolve)); }
function waitFor(socket, predicate, timeout = 5000) {
  const current = latest.get(socket.id); if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.off("ddz:state", check); reject(new Error("ddz state timeout")); }, timeout); const check = (value) => { if (!predicate(value)) return; clearTimeout(timer); socket.off("ddz:state", check); resolve(value); }; socket.on("ddz:state", check); });
}

async function testAllPass() {
  const a = io(url), b = io(url), c = io(url), roundLatest = new Map();
  for (const socket of [a,b,c]) socket.on("ddz:state", (state) => roundLatest.set(socket.id, state));
  await Promise.all([a,b,c].map(connected));
  const room = await emit(a, "ddz:create", { name:"不叫甲", settings:{startingPoints:1000,baseScore:10,decisionTimeSeconds:30} });
  const jb = await emit(b, "ddz:join", { roomId:room.roomId,name:"不叫乙",points:1000,seat:1 });
  const jc = await emit(c, "ddz:join", { roomId:room.roomId,name:"不叫丙",points:1000,seat:2 });
  const byId = new Map([[room.playerId,a],[jb.playerId,b],[jc.playerId,c]]);
  const wait = (predicate, timeout=5000) => { const current=roundLatest.get(a.id); if(current&&predicate(current))return Promise.resolve(current); return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{a.off("ddz:state",check);reject(new Error("redeal timeout"));},timeout);function check(value){if(!predicate(value))return;clearTimeout(timer);a.off("ddz:state",check);resolve(value);}a.on("ddz:state",check);}); };
  await wait((state)=>state.players.length===3); await emit(a,"ddz:start");
  for(let turn=0;turn<3;turn+=1){const current=await wait((state)=>state.phase==="bidding"&&Boolean(state.bidPlayerId));const actor=byId.get(current.bidPlayerId);assert.equal((await emit(actor,"ddz:bid",{score:0})).ok,true);if(turn<2)await wait((state)=>state.bidPlayerId!==current.bidPlayerId);}
  const result=await wait((state)=>state.phase==="bidding"&&state.handNumber>=2);
  a.disconnect();b.disconnect();c.disconnect();return result;
}

function testRules() {
  const c=(rank,suit="s",id=`${rank}-${suit}-${Math.random()}`)=>({id,rank,suit});
  const play=(cards)=>analyzeDdzPlay(cards);
  assert.equal(ddzPlayName(play([c("3")])),"单张");
  assert.equal(play([c("4","s"),c("4","h")]).type,"pair");
  assert.equal(play([c("5","s"),c("5","h"),c("5","c")]).type,"triple");
  assert.equal(play([c("3"),c("4"),c("5"),c("6"),c("7")]).type,"straight");
  assert.equal(play([c("A"),c("2"),c("3"),c("4"),c("5")]),null);
  assert.equal(play([c("3","s"),c("3","h"),c("4","s"),c("4","h"),c("5","s"),c("5","h")]).type,"pair_straight");
  assert.equal(play([c("3","s"),c("3","h"),c("3","c"),c("4","s"),c("4","h"),c("4","c")]).type,"airplane");
  assert.equal(play([c("3","s"),c("3","h"),c("3","c"),c("3","d"),c("4","s"),c("4","h"),c("4","c"),c("4","d")]),null);
  assert.equal(play([c("6","s"),c("6","h"),c("6","c"),c("6","d")]).type,"bomb");
  const rocket=[c("BJ","joker","BJ"),c("RJ","joker","RJ")]; assert.equal(play(rocket).type,"rocket");
  const bomb=[c("7","s"),c("7","h"),c("7","c"),c("7","d")]; assert.equal(canBeatDdzPlay(bomb,play([c("A")])),true); assert.equal(canBeatDdzPlay(rocket,play(bomb)),true);
  const lowStraight=[c("3"),c("4"),c("5"),c("6"),c("7")],highStraight=[c("4"),c("5"),c("6"),c("7"),c("8")]; assert.equal(canBeatDdzPlay(highStraight,play(lowStraight)),true);
}
