// Firestore security-rules tests. Runs against the emulator (no deps):
//   npx firebase emulators:exec --only firestore --project demo-ridv "node --test tests/rules.emulator.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-ridv";
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const DOCS = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

// The emulator accepts unsigned ID tokens.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (uid) => {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now,
  })}.`;
};

async function call(method, path, { uid, fields } = {}) {
  const res = await fetch(`${DOCS}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }) },
    body: fields ? JSON.stringify({ fields }) : undefined,
  });
  return res.status;
}

// Codes are 48 lowercase hex chars; derive a distinct one per test case.
const code = (seed) => Buffer.from(seed).toString("hex").padEnd(48, "0").slice(0, 48);
const minutes = (m) => ({ timestampValue: new Date(Date.now() + m * 60_000).toISOString() });
const slot = (uid, extra = {}) => ({
  uid: { stringValue: uid },
  email: { stringValue: `${uid}@example.com` },
  refreshToken: { stringValue: "rt" },
  expireAt: minutes(10),
  ...extra,
});
// POST to the collection with ?documentId= is a pure create (fails if it exists).
const create = (c, uid, fields) => call("POST", `cliLogins?documentId=${c}`, { uid, fields });

test("cliLogins: signed-in user can create a slot for themselves only", async () => {
  assert.equal(await create(code("ok"), "alice", slot("alice")), 200);
  assert.equal(await create(code("other-uid"), "alice", slot("bob")), 403);
  assert.equal(await create(code("anon"), undefined, slot("alice")), 403);
});

test("cliLogins: rejects bad codes, extra/missing/mistyped fields, huge tokens and far-future expiry", async () => {
  assert.equal(await create("short", "alice", slot("alice")), 403);
  assert.equal(await create("Z".repeat(48), "alice", slot("alice")), 403, "non-hex code");
  assert.equal(await create(code("extra"), "alice", slot("alice", { admin: { booleanValue: true } })), 403);
  const { expireAt: _omit, ...noExpiry } = slot("alice");
  assert.equal(await create(code("no-expiry"), "alice", noExpiry), 403);
  assert.equal(await create(code("typed"), "alice", slot("alice", { refreshToken: { integerValue: "1" } })), 403);
  assert.equal(await create(code("huge"), "alice", slot("alice", { refreshToken: { stringValue: "x".repeat(4096) } })), 403);
  assert.equal(await create(code("long-expiry"), "alice", slot("alice", { expireAt: minutes(60) })), 403);
});

test("cliLogins: readable by code until expiry, never listable or updatable, deletable", async () => {
  assert.equal(await call("GET", `cliLogins/${code("not-yet")}`), 404, "CLI polls a missing slot and must see 404");
  assert.equal(await create(code("read"), "alice", slot("alice")), 200);
  assert.equal(await call("GET", `cliLogins/${code("read")}`), 200);
  assert.equal(await call("GET", "cliLogins"), 403, "listing must be denied");
  assert.equal(await call("PATCH", `cliLogins/${code("read")}`, { uid: "alice", fields: slot("alice") }), 403);
  assert.equal(await create(code("read"), "alice", slot("alice")), 409, "re-create of an existing slot fails");

  assert.equal(await create(code("expired"), "alice", slot("alice", { expireAt: minutes(-1) })), 200);
  assert.equal(await call("GET", `cliLogins/${code("expired")}`), 403, "expired slot is unreadable");

  assert.equal(await call("DELETE", `cliLogins/${code("read")}`), 200);
  assert.equal(await call("GET", `cliLogins/${code("read")}`), 404);
});

test("users/{uid}: only the owner can read and write", async () => {
  const expense = { title: { stringValue: "Lunch" }, amount: { integerValue: "100" } };
  assert.equal(await call("POST", "users/alice/expenses?documentId=e1", { uid: "alice", fields: expense }), 200);
  assert.equal(await call("GET", "users/alice/expenses/e1", { uid: "alice" }), 200);
  assert.equal(await call("GET", "users/alice/expenses/e1", { uid: "bob" }), 403);
  assert.equal(await call("GET", "users/alice/expenses/e1"), 403);
  assert.equal(await call("POST", "users/alice/expenses?documentId=e2", { uid: "bob", fields: expense }), 403);
});
