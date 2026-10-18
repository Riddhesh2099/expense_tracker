import { test } from "node:test";
import assert from "node:assert/strict";
import { balances, computeShares, simplify } from "../src/split.ts";

const members = ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() }));

test("equal split hands rounding paise to the first people and sums exactly", () => {
  assert.deepEqual(computeShares(100, "equal", ["a", "b", "c"]), { a: 33.34, b: 33.33, c: 33.33 });
  assert.deepEqual(computeShares(0.02, "equal", ["a", "b", "c"]), { a: 0.01, b: 0.01 }, "zero shares dropped");
});

test("exact split must add up; percent split must total 100 and sums exactly", () => {
  assert.deepEqual(computeShares(500, "exact", ["a", "b"], { a: 200, b: 300 }), { a: 200, b: 300 });
  assert.throws(() => computeShares(500, "exact", ["a", "b"], { a: 200, b: 200 }), /add up to 400/);
  assert.deepEqual(computeShares(100, "percent", ["a", "b", "c"], { a: 33.3, b: 33.3, c: 33.4 }), { a: 33.3, b: 33.3, c: 33.4 });
  const odd = computeShares(10, "percent", ["a", "b", "c"], { a: 33.333, b: 33.333, c: 33.334 });
  assert.equal(Math.round(Object.values(odd).reduce((x, y) => x + y, 0) * 100), 1000);
  assert.throws(() => computeShares(100, "percent", ["a", "b"], { a: 50, b: 40 }), /90%/);
  assert.throws(() => computeShares(0, "equal", ["a"]), /greater than zero/);
  assert.throws(() => computeShares(10, "equal", []), /at least one/);
});

test("balances: payer is owed, sharers owe, settlements move money back", () => {
  const expenses = [
    { amount: 300, paidBy: "a", shares: { a: 100, b: 100, c: 100 } },
    { amount: 60, paidBy: "b", shares: { a: 30, b: 30 } },
  ];
  assert.deepEqual(balances(members, expenses), { a: 170, b: -70, c: -100 });
  assert.deepEqual(balances(members, expenses, [{ from: "c", to: "a", amount: 100 }]), { a: 70, b: -70, c: 0 });
});

test("simplify settles everyone with no more than n-1 transfers and conserves money", () => {
  const net = { a: 170, b: -70, c: -100 };
  const transfers = simplify(net);
  assert.equal(transfers.length, 2);
  const after = { ...net };
  for (const t of transfers) {
    after[t.from as keyof typeof after] += t.amount;
    after[t.to as keyof typeof after] -= t.amount;
  }
  assert.deepEqual(Object.values(after).map((v) => Math.round(v * 100)), [0, 0, 0]);
  assert.deepEqual(simplify({ a: 0, b: 0 }), []);
});
