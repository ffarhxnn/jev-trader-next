import { expect, test } from "bun:test";
import { quotePrice } from "../src/paper";

test("paper quotes improve one whole tick or join when improvement would lock the book", () => {
  for (const [spreadTicks, buy, sell] of [[1, 0.03, 0.030001], [2, 0.030001, 0.030001], [3, 0.030001, 0.030002], [10, 0.030001, 0.030009], [100, 0.030001, 0.030099]]) {
    const book = { bid: 0.03, ask: (3000000 + spreadTicks * 100) / 1e8 };
    expect(quotePrice(book, "buy", 0.000001)).toBe(buy);
    expect(quotePrice(book, "sell", 0.000001)).toBe(sell);
  }
});

test("paper quotes reject fractional raw levels and ticks below supported precision", () => {
  for (const book of [{ bid: 0.03000001, ask: 0.030002 }, { bid: 0.03, ask: 0.03000201 },
    { bid: 0.030000004, ask: 0.030002 }, { bid: 0.03, ask: 0.030002004 }]) {
    expect(quotePrice(book, "buy", 0.000001)).toBeNull();
    expect(quotePrice(book, "sell", 0.000001)).toBeNull();
  }
  expect(quotePrice({ bid: 0.03, ask: 0.030002 }, "buy", 1e-10)).toBeNull();
});
