import { test } from "node:test";
import assert from "node:assert/strict";
import { fromFields, matchCategory, matchMember, matchPayment, parseAmount, parseDate, toFields, verificationCode } from "../bin/ridv.mjs";

test("matchMember: 'me' maps to your own member; names by exact/prefix; clear errors", () => {
  const members = [{ id: "1", name: "riddhesh", uid: "u1" }, { id: "2", name: "Bhavika" }, { id: "3", name: "Bharat" }];
  assert.equal(matchMember(members, "me", "u1").id, "1");
  assert.equal(matchMember(members, "bhavika", "u1").id, "2");
  assert.throws(() => matchMember(members, "bha", "u1"), /Ambiguous member "bha". Members: riddhesh, Bhavika, Bharat/);
  assert.throws(() => matchMember(members, "zed", "u1"), /Unknown member/);
  const withMe = [...members, { id: "4", name: "Me" }];
  assert.equal(matchMember(withMe, "me", "u1").id, "4", "a member literally named Me wins over the alias");
});

test("toFields/fromFields round-trip nested groups (arrays of maps, share maps, booleans)", () => {
  const group = { name: "Goa", autoAddShare: false, members: [{ id: "m1", name: "Rid", uid: "u1" }, { id: "m2", name: "Ankit" }], shares: { m1: 150, m2: 149.5 } };
  assert.deepEqual(fromFields(toFields(group)), group);
  assert.deepEqual(toFields({ ok: true }), { ok: { booleanValue: true } });
});

test("verificationCode is the last 8 hex chars, grouped and upper-cased (same as the web page)", () => {
  assert.equal(verificationCode("0".repeat(40) + "a1b2c3d4"), "A1B2-C3D4");
});

const now = new Date(2026, 9, 18, 9, 30); // 18 Oct 2026, 09:30 local

test("parseDate handles keywords and both date orders, at local noon", () => {
  assert.deepEqual(parseDate("today", now), new Date(2026, 9, 18, 12));
  assert.deepEqual(parseDate("Yesterday", now), new Date(2026, 9, 17, 12));
  assert.deepEqual(parseDate("yesterday", new Date(2026, 0, 1)), new Date(2025, 11, 31, 12));
  assert.deepEqual(parseDate("2026-10-05", now), new Date(2026, 9, 5, 12));
  assert.deepEqual(parseDate("05-10-2026", now), new Date(2026, 9, 5, 12));
  assert.throws(() => parseDate("2026-02-30", now), /Unrecognised date/);
  assert.throws(() => parseDate("2026-13-05", now), /Unrecognised date/, "month overflow must not roll into next year");
  assert.throws(() => parseDate("2026-00-10", now), /Unrecognised date/);
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
