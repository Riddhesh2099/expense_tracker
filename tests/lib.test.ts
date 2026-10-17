import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetStatus, expensesToCsv, monthlyTotals } from "../src/lib.ts";
import type { Category, Expense } from "../src/types.ts";

const expense = (over: Partial<Expense>): Expense => ({
  id: "e",
  title: "Lunch",
  merchant: "",
  amount: 100,
  currency: "INR",
  categoryId: "food",
  paymentMethod: "UPI",
  notes: "",
  expenseDate: new Date(2026, 9, 10),
  createdAt: new Date(),
  ...over,
});
const food: Category = { id: "food", name: "Food", color: "#f00", budget: 400, createdAt: new Date() };
const travel: Category = { id: "travel", name: "Travel", color: "#00f", createdAt: new Date() };

test("monthlyTotals sorts chronologically across years and keeps the last N", () => {
  const rows = monthlyTotals(
    [
      expense({ expenseDate: new Date(2026, 0, 5), amount: 10 }),
      expense({ expenseDate: new Date(2025, 11, 5), amount: 20 }),
      expense({ expenseDate: new Date(2026, 0, 20), amount: 5 }),
      expense({ expenseDate: new Date(2025, 10, 5), amount: 1 }),
    ],
    2,
  );
  assert.deepEqual(rows.map((r) => r.amount), [20, 15]);
});

test("budgetStatus counts only this month and only budgeted categories", () => {
  const now = new Date(2026, 9, 18);
  const rows = budgetStatus(
    [food, travel],
    [expense({ amount: 300 }), expense({ amount: 999, expenseDate: new Date(2026, 8, 30) }), expense({ categoryId: "travel" })],
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spent, 300);
  assert.equal(rows[0].ratio, 0.75);
});

test("expensesToCsv escapes commas, quotes and newlines", () => {
  const csv = expensesToCsv([expense({ title: 'Dinner, "fancy"', notes: "two\nlines" })], () => "Food");
  const [, row] = csv.split("\r\n");
  assert.equal(row, '2026-10-10,"Dinner, ""fancy""",,Food,UPI,100,"two\nlines"');
});
