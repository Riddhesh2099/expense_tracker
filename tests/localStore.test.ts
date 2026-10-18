import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage for Node, installed before the module loads.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const s = await import("../src/localStore.ts");
const { Timestamp } = await import("firebase/firestore");
const tick = () => new Promise((r) => setTimeout(r, 0));

test("add + query: orderBy desc, timestamps persist as Timestamps, auto ids", async () => {
  s.clearGuestData();
  const col = s.collection(null, "users", "guest", "expenses");
  await s.addDoc(col, { title: "old", expenseDate: Timestamp.fromMillis(1000), createdAt: s.serverTimestamp() });
  const newer = await s.addDoc(col, { title: "new", expenseDate: Timestamp.fromMillis(2000) });
  assert.match(newer.id, /^[A-Za-z0-9]{20}$/);
  const snap = await s.getDocs(s.query(col, s.orderBy("expenseDate", "desc")));
  assert.deepEqual(snap.docs.map((d) => d.data().title), ["new", "old"]);
  assert.ok(snap.docs[1].data().createdAt instanceof Timestamp, "serverTimestamp resolved and revived from JSON");
});

test("nested collections, where array-contains, arrayUnion/arrayRemove", async () => {
  s.clearGuestData();
  const g = await s.addDoc(s.collection(null, "groups"), { name: "Goa", memberUids: ["guest"], members: [{ id: "a" }] });
  await s.addDoc(s.collection(g, "expenses"), { title: "dinner" });
  assert.equal((await s.getDocs(s.collection(g, "expenses"))).size, 1);
  assert.equal((await s.getDocs(s.collection(null, "groups"))).size, 1, "subcollection docs aren't listed as groups");
  const mine = await s.getDocs(s.query(s.collection(null, "groups"), s.where("memberUids", "array-contains", "guest")));
  assert.equal(mine.size, 1);
  await s.updateDoc(g, { members: s.arrayUnion({ id: "b" }) });
  await s.updateDoc(g, { members: s.arrayUnion({ id: "b" }) }); // no duplicate
  await s.updateDoc(g, { members: s.arrayRemove({ id: "a" }) });
  const after = await s.getDocs(s.collection(null, "groups"));
  assert.deepEqual(after.docs[0].data().members, [{ id: "b" }]);
});

test("onSnapshot emits initially and after writes; unsubscribe stops it", async () => {
  s.clearGuestData();
  const col = s.collection(null, "users", "guest", "categories");
  const sizes: number[] = [];
  const stop = s.onSnapshot(col, ((snap: { size: number }) => sizes.push(snap.size)) as never);
  await tick();
  await s.addDoc(col, { name: "Food" });
  await tick();
  stop();
  await s.addDoc(col, { name: "Travel" });
  await tick();
  assert.deepEqual(sizes, [0, 1]);
});

test("writeBatch is all-or-nothing", async () => {
  s.clearGuestData();
  const col = s.collection(null, "users", "guest", "expenses");
  const batch = s.writeBatch();
  batch.set(s.doc(col), { title: "a" });
  batch.update(s.doc(col, "missing"), { title: "b" });
  await assert.rejects(batch.commit(), /No document to update/);
  assert.equal((await s.getDocs(col)).size, 0, "the set before the failing update was not saved");
});
