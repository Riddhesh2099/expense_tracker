#!/usr/bin/env node
// ridv — add, list and delete expenses in the expense tracker from a terminal or an AI agent.
// Auth: `ridv login` hands this browser-free tool a Firebase session from travel.ridventure.com; every call then
// runs as that user, under the same Firestore security rules as the website. Talks to Firestore REST directly.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { balances, computeShares, CURRENCIES, formatCurrency, simplify } from "../src/split.ts";

const PROJECT = "project-dc59a57a-442b-4b6a-a3f";
const API_KEY = "AIzaSyAaGPkRzftcI83LmQosIkjHFKofGALxLvo"; // public Firebase web key (ships in the website bundle)
const SITE = process.env.RIDV_SITE ?? "https://travel.ridventure.com";
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CREDENTIALS = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ridv", "credentials.json");
const PAYMENTS = ["Card", "Cash", "UPI", "Bank transfer", "Other"];
const USAGE = `ridv — Ridventure travel CLI (travel.ridventure.com)

  ridv login                  sign in via the browser (Google or email), once per computer
  ridv whoami | logout
  Expense commands also work as \`ridv expense <command>\`.
  ridv add <amount> <title...> [-c category] [-m merchant] [-d date] [-p payment] [-n notes]
      date: today (default) | yesterday | YYYY-MM-DD | DD-MM-YYYY
      payment: ${PAYMENTS.join(" | ")} (default Card)
      category: name or unique prefix, case-insensitive (default Other)
  ridv list [-l limit]        latest expenses (default 10) + this month's total
  ridv categories             category names
  ridv delete <id>            delete one expense (ids are shown by add/list)
  add --json / list --json    machine-readable output

  ridv split groups                                   your split groups
  ridv split new <name> -w "A,B" [--currency INR]     create a group (you + A + B)
  ridv split add <amount> <title...> -g <group> [--paid-by A] [-w "A,B"] [-d date]
      equal split among -w (default: everyone); paid-by defaults to you; "me" works as a name
  ridv split balances -g <group>                      who owes whom + suggested settle-up
  ridv split settle -g <group> --from A --to B [amount]   record a payment (default: suggested amount)

  Session is stored in ${CREDENTIALS} (owner-only).`;

// ---------- pure helpers (tested in tests/ridv.test.ts) ----------

export function parseDate(text = "today", now = new Date()) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); // local noon, same as the web app
  const t = text.trim().toLowerCase();
  if (t === "today") return day(now);
  if (t === "yesterday") return day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const [y, mo, d] = m ? [m[1], m[2], m[3]] : ((m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)) ? [m[3], m[2], m[1]] : []);
  const date = y && new Date(Number(y), Number(mo) - 1, Number(d), 12);
  // Round-trip check: rejects day *and* month overflow (2026-02-30, 2026-13-05 would otherwise roll over).
  if (!date || date.getDate() !== Number(d) || date.getMonth() !== Number(mo) - 1) throw new Error(`Unrecognised date "${text}". Use today, yesterday, YYYY-MM-DD or DD-MM-YYYY.`);
  return date;
}

/** Case-insensitive exact name, else a unique prefix; otherwise a helpful error listing the options. */
export function matchByName(items, query, label) {
  const q = query.trim().toLowerCase();
  const exact = items.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const prefixed = items.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefixed.length === 1) return prefixed[0];
  const names = items.map((c) => c.name).join(", ");
  const plural = label === "category" ? "Categories" : `${label[0].toUpperCase()}${label.slice(1)}s`;
  throw new Error(`${prefixed.length ? "Ambiguous" : "Unknown"} ${label} "${query}". ${plural}: ${names}`);
}

export function matchCategory(categories, query) {
  return matchByName(categories, query, "category");
}

/** Resolve a member by name; "me"/"I"/"myself" means the signed-in user's member entry. */
export function matchMember(members, query, myUid) {
  const q = query.trim().toLowerCase();
  // A member literally named "Me" wins over the alias.
  if (["me", "i", "myself"].includes(q) && !members.some((m) => m.name.toLowerCase() === q)) {
    const me = members.find((m) => m.uid === myUid);
    if (me) return me;
  }
  return matchByName(members, query, "member");
}

export function matchPayment(query = "Card") {
  const found = PAYMENTS.find((p) => p.toLowerCase() === query.trim().toLowerCase());
  if (!found) throw new Error(`Unknown payment "${query}". Use one of: ${PAYMENTS.join(", ")}`);
  return found;
}

export function parseAmount(text) {
  const amount = Number(String(text).replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Amount must be a number greater than zero, got "${text}".`);
  return Math.round(amount * 100) / 100;
}

/** JS values -> Firestore REST `fields`, matching what the web SDK writes. */
function toValue(v) {
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

/** JS values -> Firestore REST `fields`, matching what the web SDK writes (incl. arrays, maps, booleans). */
export function toFields(object) {
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, toValue(v)]));
}

function fromValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields);
  return null;
}

export function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));
}

/** Short code shown in both the terminal and the browser, so you only approve logins you started. */
export function verificationCode(code) {
  return `${code.slice(-8, -4)}-${code.slice(-4)}`.toUpperCase();
}

const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

// ---------- session + Firestore over REST ----------

async function request(url, init = {}, idToken) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(idToken && { Authorization: `Bearer ${idToken}` }) },
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    // Redact login codes: they are secrets and errors end up in agent transcripts.
    const where = url.split("?")[0].replace(/cliLogins\/[^/]+/, "cliLogins/<code>");
    const message = String(body.error?.message ?? JSON.stringify(body)).replace(/cliLogins\/[0-9a-f]+/g, "cliLogins/<code>");
    const error = new Error(`${init.method ?? "GET"} ${where} -> ${res.status}: ${message}`);
    error.status = res.status;
    throw error;
  }
  return body;
}

async function readCredentials() {
  try {
    return JSON.parse(await readFile(CREDENTIALS, "utf8"));
  } catch {
    throw new Error("Not logged in. Run `ridv login` first.");
  }
}

/** Atomic write, owner-only even if the file/dir already existed with looser modes (mode only applies on create). */
async function saveCredentials(credentials) {
  const dir = join(CREDENTIALS, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${CREDENTIALS}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, CREDENTIALS);
}

/** Exchange the stored refresh token for a fresh ID token (1h); persists the token if Google rotates it. */
let session;
async function getSession() {
  if (session) return session;
  const credentials = await readCredentials();
  let body;
  try {
    body = await request(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }),
    });
  } catch (error) {
    if (error.status === 400) throw new Error("Your ridv session expired or was revoked. Run `ridv login` again.");
    throw error;
  }
  if (body.refresh_token && body.refresh_token !== credentials.refreshToken) await saveCredentials({ ...credentials, refreshToken: body.refresh_token });
  session = { idToken: body.id_token, uid: body.user_id, email: credentials.email };
  return session;
}

async function api(url, init = {}) {
  return request(url, init, (await getSession()).idToken);
}

async function userBase() {
  return `${DOCS}/users/${(await getSession()).uid}`;
}

async function login() {
  const code = randomBytes(24).toString("hex"); // 48 hex chars (192 bits): the only secret guarding the handoff slot
  const url = `${SITE}/cli-login?code=${code}`;
  console.log(`Opening ${url}\nSign in if asked, type this code on the page, and click "Authorize this computer".\n\n  Code: ${verificationCode(code)}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {}); // best effort; the URL is printed for headless use
  const slot = `${DOCS}/cliLogins/${code}?key=${API_KEY}`;
  // Best effort: if we're interrupted or time out, don't leave a token behind in case the user authorized late.
  const cleanup = () => request(slot, { method: "DELETE" }).catch(() => {});
  process.once("SIGINT", () => cleanup().finally(() => process.exit(130)));
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let doc;
    try {
      doc = await request(slot);
    } catch (error) {
      if (error.status === 404) continue; // not authorized yet
      if (error.status === 403) throw error; // expired/forbidden: retrying won't help
      continue; // network blips, 429, 5xx: keep polling until the deadline
    }
    await request(slot, { method: "DELETE" }); // one-time: never leave the token lying around
    const { uid, email, refreshToken } = fromFields(doc.fields);
    await saveCredentials({ uid, email, refreshToken });
    await getSession(); // proves the token works before we claim success
    return console.log(`Logged in as ${email}. Session saved to ${CREDENTIALS}`);
  }
  await cleanup();
  throw new Error("Timed out after 10 minutes waiting for the browser. Run `ridv login` again.");
}

async function getCategories(base) {
  const { documents = [] } = await api(`${base}/categories?pageSize=300`);
  return documents.map((d) => ({ id: d.name.split("/").pop(), ...fromFields(d.fields) }));
}

// ---------- commands ----------

async function add(args, opts) {
  if (args.length < 2) throw new Error("Usage: ridv add <amount> <title...>");
  const base = await userBase();
  const category = matchCategory(await getCategories(base), opts.category ?? "Other");
  const expense = {
    title: args.slice(1).join(" "),
    merchant: opts.merchant ?? "",
    amount: parseAmount(args[0]),
    currency: "INR",
    categoryId: category.id,
    paymentMethod: matchPayment(opts.payment),
    notes: opts.notes ?? "",
    expenseDate: parseDate(opts.date),
    createdAt: new Date(),
  };
  const doc = await api(`${base}/expenses`, { method: "POST", body: JSON.stringify({ fields: toFields(expense) }) });
  const id = doc.name.split("/").pop();
  if (opts.json) return console.log(JSON.stringify({ id, ...expense, category: category.name }));
  console.log(`Added ${money(expense.amount)} · ${expense.title} · ${category.name} · ${expense.paymentMethod} · ${ymd(expense.expenseDate)}  (id ${id})`);
}

async function list(opts) {
  const base = await userBase();
  const limit = Number(opts.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive whole number, got "${opts.limit}".`);
  const [categories, rows] = await Promise.all([
    getCategories(base),
    api(`${base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "expenses" }],
          orderBy: [{ field: { fieldPath: "expenseDate" }, direction: "DESCENDING" }],
        },
      }),
    }),
  ]);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const expenses = rows.filter((r) => r.document).map((r) => ({ id: r.document.name.split("/").pop(), ...fromFields(r.document.fields) }));
  const month = ymd(new Date()).slice(0, 7);
  const monthTotal = expenses.filter((e) => e.expenseDate && ymd(new Date(e.expenseDate)).startsWith(month)).reduce((s, e) => s + e.amount, 0);
  const shown = expenses.slice(0, limit);
  if (opts.json) return console.log(JSON.stringify({ monthTotal, expenses: shown.map((e) => ({ ...e, category: names.get(e.categoryId) })) }));
  for (const e of shown) {
    console.log(`${ymd(new Date(e.expenseDate))}  ${money(e.amount).padStart(12)}  ${e.title}  [${names.get(e.categoryId) ?? "?"}]  ${e.id}`);
  }
  console.log(`This month: ${money(monthTotal)} across ${expenses.filter((e) => ymd(new Date(e.expenseDate)).startsWith(month)).length} expense(s)`);
}

// ---------- split ----------

async function getGroups() {
  const { uid } = await getSession();
  const rows = await api(`${DOCS}:runQuery`, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "groups" }],
        where: { fieldFilter: { field: { fieldPath: "memberUids" }, op: "ARRAY_CONTAINS", value: { stringValue: uid } } },
      },
    }),
  });
  return rows.filter((r) => r.document).map((r) => ({ id: r.document.name.split("/").pop(), ...fromFields(r.document.fields) }));
}

async function findGroup(query) {
  const groups = await getGroups();
  if (!query) throw new Error(`Pick a group with -g <name>. Groups: ${groups.map((g) => g.name).join(", ") || "none yet"}`);
  return matchByName(groups, query, "group");
}

async function groupDocs(groupId, sub) {
  const docs = [];
  let pageToken = "";
  do {
    const page = await api(`${DOCS}/groups/${groupId}/${sub}?pageSize=300${pageToken && `&pageToken=${encodeURIComponent(pageToken)}`}`);
    docs.push(...(page.documents ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return docs.map((d) => ({ id: d.name.split("/").pop(), ...fromFields(d.fields) }));
}

const newMemberId = () => randomBytes(4).toString("hex");
/** Firestore-style 20-char id, so related docs can be written in one atomic commit. */
const newDocId = () => Array.from(randomBytes(20), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
const DB_PATH = DOCS.replace("https://firestore.googleapis.com/v1/", "");

/** Atomically create several documents ({path relative to documents/, fields}). */
async function createAll(docs) {
  await api(`${DOCS}:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes: docs.map(({ path, fields }) => ({
        update: { name: `${DB_PATH}/${path}`, fields: toFields(fields) },
        currentDocument: { exists: false },
      })),
    }),
  });
}

async function split(args, opts) {
  const [sub, ...rest] = args;
  const { uid, email } = await getSession();

  if (sub === "groups") {
    const groups = await getGroups();
    if (opts.json) return console.log(JSON.stringify(groups));
    if (!groups.length) return console.log("No groups yet. Create one: ridv split new <name> -w \"A,B\"");
    for (const g of groups) console.log(`${g.name}  [${g.currency}]  ${g.members.map((m) => m.name).join(", ")}`);
    return;
  }

  if (sub === "new") {
    const name = rest.join(" ").trim();
    if (!name) throw new Error('Usage: ridv split new <name> -w "A,B" [--currency INR]');
    const currency = (opts.currency ?? "INR").toUpperCase();
    if (!CURRENCIES.includes(currency)) throw new Error(`Currency must be one of ${CURRENCIES.join(", ")}.`);
    const members = [
      { id: newMemberId(), name: email.split("@")[0], uid },
      ...(opts.with ?? "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => ({ id: newMemberId(), name: n })),
    ];
    const fields = { name, currency, createdBy: uid, memberUids: [uid], members, autoAddShare: false, createdAt: new Date() };
    await api(`${DOCS}/groups`, { method: "POST", body: JSON.stringify({ fields: toFields(fields) }) });
    return console.log(`Created ${name} [${currency}] with ${members.map((m) => m.name).join(", ")}`);
  }

  const group = await findGroup(opts.group);
  const money = (n) => formatCurrency(n, group.currency);
  const name = (id) => group.members.find((m) => m.id === id)?.name ?? "?";

  if (sub === "add") {
    if (rest.length < 2) throw new Error('Usage: ridv split add <amount> <title...> -g <group> [--paid-by A] [-w "A,B"] [-d date]');
    const amount = parseAmount(rest[0]);
    const title = rest.slice(1).join(" ");
    const paidBy = matchMember(group.members, opts["paid-by"] ?? "me", uid);
    const participants = opts.with
      ? opts.with.split(",").map((n) => matchMember(group.members, n, uid).id)
      : group.members.map((m) => m.id);
    const shares = computeShares(amount, "equal", [...new Set(participants)]);
    const date = parseDate(opts.date);
    const me = group.members.find((m) => m.uid === uid);
    const writes = [];
    let personalExpenseId;
    if (group.autoAddShare && group.currency === "INR" && me && shares[me.id]) {
      const categories = await getCategories(await userBase());
      const category = categories.find((c) => c.name === "Travel") ?? categories.find((c) => c.name === "Other") ?? categories[0];
      personalExpenseId = newDocId();
      writes.push({
        path: `users/${uid}/expenses/${personalExpenseId}`,
        fields: {
          title: `${group.name}: ${title}`, merchant: "", amount: shares[me.id], currency: "INR",
          categoryId: category?.id ?? "", paymentMethod: "Other", notes: `Your share, split in ${group.name}`,
          expenseDate: date, createdAt: new Date(),
        },
      });
    }
    writes.push({
      path: `groups/${group.id}/expenses/${newDocId()}`,
      fields: {
        title, amount, paidBy: paidBy.id, splitMode: "equal", shares, date, createdBy: uid, createdAt: new Date(),
        ...(personalExpenseId && { personalExpenseId }),
      },
    });
    await createAll(writes); // both or neither: no orphaned personal share if the group write fails
    const each = Object.entries(shares).map(([id, v]) => `${name(id)} ${money(v)}`).join(", ");
    return console.log(`Added ${money(amount)} · ${title} to ${group.name}: paid by ${paidBy.name}; shares ${each}${personalExpenseId ? " (your share also added to Expenses)" : ""}`);
  }

  if (sub === "balances") {
    const [expenses, settlements] = await Promise.all([groupDocs(group.id, "expenses"), groupDocs(group.id, "settlements")]);
    const net = balances(group.members, expenses, settlements);
    const transfers = simplify(net);
    if (opts.json) return console.log(JSON.stringify({ group: group.name, currency: group.currency, net, transfers: transfers.map((t) => ({ ...t, from: name(t.from), to: name(t.to) })) }));
    console.log(`${group.name} [${group.currency}]`);
    for (const m of group.members) console.log(`  ${m.name.padEnd(16)} ${(net[m.id] ?? 0) >= 0 ? "is owed" : "owes   "} ${money(Math.abs(net[m.id] ?? 0))}`);
    console.log(transfers.length ? "To settle:" : "All settled up.");
    for (const t of transfers) console.log(`  ${name(t.from)} pays ${name(t.to)} ${money(t.amount)}`);
    return;
  }

  if (sub === "settle") {
    if (!opts.from || !opts.to) throw new Error("Usage: ridv split settle -g <group> --from A --to B [amount]");
    const from = matchMember(group.members, opts.from, uid);
    const to = matchMember(group.members, opts.to, uid);
    if (from.id === to.id) throw new Error(`--from and --to are both ${from.name}.`);
    let amount = rest[0] ? parseAmount(rest[0]) : undefined;
    if (amount === undefined) {
      const [expenses, settlements] = await Promise.all([groupDocs(group.id, "expenses"), groupDocs(group.id, "settlements")]);
      amount = simplify(balances(group.members, expenses, settlements)).find((t) => t.from === from.id && t.to === to.id)?.amount;
      if (!amount) throw new Error(`${from.name} doesn't owe ${to.name} in the suggested settle-up. Pass an amount explicitly.`);
    }
    const fields = { from: from.id, to: to.id, amount, date: new Date(), createdBy: uid };
    await api(`${DOCS}/groups/${group.id}/settlements`, { method: "POST", body: JSON.stringify({ fields: toFields(fields) }) });
    return console.log(`Recorded: ${from.name} paid ${to.name} ${money(amount)} in ${group.name}`);
  }

  throw new Error("Usage: ridv split groups | new | add | balances | settle  (see ridv --help)");
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      category: { type: "string", short: "c" },
      merchant: { type: "string", short: "m" },
      date: { type: "string", short: "d" },
      payment: { type: "string", short: "p" },
      notes: { type: "string", short: "n" },
      limit: { type: "string", short: "l" },
      group: { type: "string", short: "g" },
      with: { type: "string", short: "w" },
      "paid-by": { type: "string" },
      currency: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  // `ridv expense add …` and `ridv add …` are the same; namespaces leave room for `ridv split …`, `ridv flights …`.
  if (["expense", "expenses"].includes(positionals[0])) positionals.shift();
  const [command, ...args] = positionals;
  if (opts.help || !command) return console.log(USAGE);
  if (command === "login") return login();
  if (command === "logout") {
    await rm(CREDENTIALS, { force: true });
    return console.log("Logged out (local session removed).");
  }
  if (command === "whoami") return console.log((await getSession()).email);
  if (command === "split") return split(args, opts);
  if (command === "add") return add(args, opts);
  if (command === "list") return list(opts);
  if (command === "categories") return console.log((await getCategories(await userBase())).map((c) => c.name).sort().join("\n"));
  if (command === "delete") {
    // Firestore auto-ids are 20 alphanumerics; rejecting anything else stops path tricks like "..".
    if (!/^[A-Za-z0-9]{20}$/.test(args[0] ?? "")) throw new Error("Usage: ridv delete <id>  (the 20-character id shown by add/list)");
    // exists precondition: a wrong id must fail instead of silently "deleting" nothing.
    await api(`${await userBase()}/expenses/${encodeURIComponent(args[0])}?currentDocument.exists=true`, { method: "DELETE" });
    return console.log(`Deleted ${args[0]}`);
  }
  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ridv: ${error.message}`);
    process.exit(1);
  });
}
