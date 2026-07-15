export const ddzRankValues = { "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14, "2": 15, BJ: 16, RJ: 17 };

export function sortDdzCards(cards) {
  return [...cards].sort((a, b) => ddzRankValues[a.rank] - ddzRankValues[b.rank] || String(a.suit).localeCompare(String(b.suit)));
}

export function analyzeDdzPlay(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const values = cards.map((card) => ddzRankValues[card.rank]);
  if (values.some((value) => !value)) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const length = cards.length;
  const result = (type, mainValue, sequenceLength = 1) => ({ type, mainValue, length, sequenceLength });

  if (length === 2 && counts.get(16) === 1 && counts.get(17) === 1) return result("rocket", 17);
  if (length === 4 && groups.length === 1) return result("bomb", groups[0][0]);
  if (length === 1) return result("single", values[0]);
  if (length === 2 && groups.length === 1) return result("pair", groups[0][0]);
  if (length === 3 && groups.length === 1) return result("triple", groups[0][0]);
  if (length === 4 && groups.some(([, count]) => count === 3)) return result("triple_single", groups.find(([, count]) => count === 3)[0]);
  if (length === 5 && groups.length === 2 && groups.some(([, count]) => count === 3) && groups.some(([, count]) => count === 2)) return result("triple_pair", groups.find(([, count]) => count === 3)[0]);

  if (length >= 5 && groups.length === length && isConsecutive(groups.map(([value]) => value))) return result("straight", groups.at(-1)[0], length);
  if (length >= 6 && length % 2 === 0 && groups.length === length / 2 && groups.every(([, count]) => count === 2) && isConsecutive(groups.map(([value]) => value))) return result("pair_straight", groups.at(-1)[0], length / 2);

  for (const wing of ["none", "single", "pair"]) {
    const unit = wing === "none" ? 3 : wing === "single" ? 4 : 5;
    if (length % unit !== 0) continue;
    const sequenceLength = length / unit;
    if (sequenceLength < 2) continue;
    const sequences = consecutiveSequences(groups.filter(([value, count]) => value <= 14 && count >= 3).map(([value]) => value), sequenceLength);
    for (const sequence of sequences.reverse()) {
      const rest = new Map(counts);
      for (const value of sequence) rest.set(value, rest.get(value) - 3);
      const remaining = [...rest.entries()].filter(([, count]) => count > 0);
      if (remaining.some(([value]) => sequence.includes(value))) continue;
      if (wing === "none" && remaining.length === 0) return result("airplane", sequence.at(-1), sequenceLength);
      if (wing === "single" && remaining.reduce((sum, [, count]) => sum + count, 0) === sequenceLength) return result("airplane_single", sequence.at(-1), sequenceLength);
      if (wing === "pair" && remaining.length === sequenceLength && remaining.every(([, count]) => count === 2)) return result("airplane_pair", sequence.at(-1), sequenceLength);
    }
  }

  if (length === 6) {
    const four = groups.find(([, count]) => count === 4);
    if (four) return result("four_two_single", four[0]);
  }
  if (length === 8) {
    const four = groups.find(([, count]) => count === 4);
    if (four && groups.filter(([value, count]) => value !== four[0] && count === 2).length === 2) return result("four_two_pair", four[0]);
  }
  return null;
}

export function canBeatDdzPlay(candidateCards, previousPlay) {
  const candidate = analyzeDdzPlay(candidateCards);
  if (!candidate) return false;
  if (!previousPlay) return true;
  if (candidate.type === "rocket") return previousPlay.type !== "rocket";
  if (previousPlay.type === "rocket") return false;
  if (candidate.type === "bomb") return previousPlay.type !== "bomb" || candidate.mainValue > previousPlay.mainValue;
  if (previousPlay.type === "bomb") return false;
  return candidate.type === previousPlay.type && candidate.length === previousPlay.length && candidate.sequenceLength === previousPlay.sequenceLength && candidate.mainValue > previousPlay.mainValue;
}

export function ddzPlayName(play) {
  return ({ single: "单张", pair: "对子", triple: "三张", triple_single: "三带一", triple_pair: "三带一对", straight: "顺子", pair_straight: "连对", airplane: "飞机", airplane_single: "飞机带单", airplane_pair: "飞机带对", four_two_single: "四带二", four_two_pair: "四带两对", bomb: "炸弹", rocket: "王炸" })[play?.type] || "未知牌型";
}

function isConsecutive(values) {
  return values.length > 0 && values.at(-1) <= 14 && values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function consecutiveSequences(values, size) {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  const sequences = [];
  for (let start = 0; start <= unique.length - size; start += 1) {
    const sequence = unique.slice(start, start + size);
    if (isConsecutive(sequence)) sequences.push(sequence);
  }
  return sequences;
}
