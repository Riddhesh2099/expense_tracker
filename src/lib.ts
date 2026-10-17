import type { Category, Expense } from "./types";

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

export function formatMoney(amount: number) {
  return currencyFormatter.format(amount);
}

export function formatInputDate(date: Date) {
  // toISOString would shift to UTC and show yesterday's date for
  // timezones ahead of UTC in the early morning.
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function isSameMonth(date: Date, now: Date) {
  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

/** Last `months` calendar months that have spend, oldest first, labelled like "Oct 26". */
export function monthlyTotals(expenses: Expense[], months = 12) {
  const buckets = new Map<string, { label: string; amount: number }>();
  for (const expense of expenses) {
    const d = expense.expenseDate;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const bucket = buckets.get(key) ?? {
      label: d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
      amount: 0,
    };
    bucket.amount += expense.amount;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-months)
    .map(([, { label, amount }]) => ({ month: label, amount }));
}

/** This month's spend per category against its monthly budget. Only categories with a budget. */
export function budgetStatus(categories: Category[], expenses: Expense[], now = new Date()) {
  return categories
    .filter((category) => (category.budget ?? 0) > 0)
    .map((category) => {
      const spent = expenses
        .filter((expense) => expense.categoryId === category.id && isSameMonth(expense.expenseDate, now))
        .reduce((sum, expense) => sum + expense.amount, 0);
      const budget = category.budget ?? 0;
      return { category, spent, budget, ratio: spent / budget };
    });
}

function csvCell(value: string | number) {
  // Text starting with = + - @ is run as a formula by Excel/Sheets; a leading ' keeps it literal.
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function expensesToCsv(expenses: Expense[], categoryName: (id: string) => string) {
  const header = ["Date", "Title", "Merchant", "Category", "Payment method", "Amount (INR)", "Notes"];
  const rows = expenses.map((expense) => [
    formatInputDate(expense.expenseDate),
    expense.title,
    expense.merchant,
    categoryName(expense.categoryId),
    expense.paymentMethod,
    expense.amount,
    expense.notes,
  ]);
  // BOM so Excel reads UTF-8 (₹, non-ASCII titles) instead of the local ANSI code page.
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
