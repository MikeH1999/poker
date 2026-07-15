const rankValues = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

export function evaluateZjhHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error("炸金花牌型必须包含三张牌");
  const values = cards.map((card) => rankValues[card.rank]).sort((a, b) => b - a);
  const counts = new Map(values.map((value) => [value, values.filter((other) => other === value).length]));
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const wheel = values[0] === 14 && values[1] === 3 && values[2] === 2;
  const straight = wheel || (values[0] - values[1] === 1 && values[1] - values[2] === 1);
  const trips = [...counts].find(([, count]) => count === 3)?.[0];
  const pair = [...counts].find(([, count]) => count === 2)?.[0];
  const is235 = !flush && values[0] === 5 && values[1] === 3 && values[2] === 2;
  if (trips) return { category: 6, name: "豹子", values: [trips], is235: false };
  if (straight && flush) return { category: 5, name: "顺金", values: [wheel ? 3 : values[0]], is235: false };
  if (flush) return { category: 4, name: "金花", values, is235: false };
  if (straight) return { category: 3, name: "顺子", values: [wheel ? 3 : values[0]], is235: false };
  if (pair) return { category: 2, name: "对子", values: [pair, values.find((value) => value !== pair)], is235: false };
  return { category: 1, name: is235 ? "特殊 235" : "散牌", values, is235 };
}

export function compareZjhCards(cardsA, cardsB) {
  const a = evaluateZjhHand(cardsA);
  const b = evaluateZjhHand(cardsB);
  if (a.is235 && b.category === 6) return 1;
  if (b.is235 && a.category === 6) return -1;
  if (a.category !== b.category) return a.category - b.category;
  for (let index = 0; index < Math.max(a.values.length, b.values.length); index += 1) {
    if ((a.values[index] || 0) !== (b.values[index] || 0)) return (a.values[index] || 0) - (b.values[index] || 0);
  }
  return 0;
}
