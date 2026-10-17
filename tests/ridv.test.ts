import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCategory, matchPayment, parseAmount, parseDate, toFields, verificationCode } from "../bin/ridv.mjs";

test("verificationCode is the last 8 chars, grouped and upper-cased (same as the web page)", () => {
  assert.equal(verificationCode("x".repeat(24) + "ab_dE-9z"), "AB_D-E-9Z");
});

const now = new Date(2026, 9, 18, 9, 30); // 18 Oct 2026, 09:30 local

test("parseDate handles keywords and both date orders, at local noon", () => {
  assert.deepEqual(parseDate("today", now), new Date(2026, 9, 18, 12));
  assert.deepEqual(parseDate("Yesterday", now), new Date(2026, 9, 17, 12));
  assert.deepEqual(parseDate("yesterday", new Date(2026, 0, 1)), new Date(2025, 11, 31, 12));
  assert.deepEqual(parseDate("2026-10-05", now), new Date(2026, 9, 5, 12));
  assert.deepEqual(parseDate("05-10-2026", now), new Date(2026, 9, 5, 12));
  assert.throws(() => parseDate("2026-02-30", now), /Unrecognised date/);
  assert.throws(() => parseDate("last tuesday", now), /Unrecognised date/);
});

test("matchCategory: exact beats prefix, unique prefix works, ambiguity errors", () => {
  const cats = [{ name: "Food" }, { name: "Fuel" }, { name: "Groceries" }, { name: "Other" }];
  assert.equal(matchCategory(cats, "food").name, "Food");
  assert.equal(matchCategory(cats, "gro").name, "Groceries");
  assert.throws(() => matchCategory(cats, "f"), /Ambiguous category/);
  assert.throws(() => matchCategory(cats, "rent"), /Unknown category "rent". Categories: Food, Fuel/);
});

test("parseAmount strips ₹ and commas, rejects zero/garbage", () => {
  assert.equal(parseAmount("₹1,250.5"), 1250.5);
  assert.equal(parseAmount("99.999"), 100);
  assert.throws(() => parseAmount("0"));
  assert.throws(() => parseAmount("abc"));
});

test("matchPayment is case-insensitive and validated", () => {
  assert.equal(matchPayment("upi"), "UPI");
  assert.equal(matchPayment("bank transfer"), "Bank transfer");
  assert.throws(() => matchPayment("crypto"), /Unknown payment/);
});

test("toFields encodes like the web SDK", () => {
  assert.deepEqual(toFields({ a: 450, b: 12.5, c: "x", d: new Date(Date.UTC(2026, 9, 18)) }), {
    a: { integerValue: "450" },
    b: { doubleValue: 12.5 },
    c: { stringValue: "x" },
    d: { timestampValue: "2026-10-18T00:00:00.000Z" },
  });
});
