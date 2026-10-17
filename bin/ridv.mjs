#!/usr/bin/env node
// ridv — add, list and delete expenses in the expense tracker from a terminal or an AI agent.
// Auth: `ridv login` hands this browser-free tool a Firebase session from expenses.ridventure.com; every call then
// runs as that user, under the same Firestore security rules as the website. Talks to Firestore REST directly.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROJECT = "project-dc59a57a-442b-4b6a-a3f";
const API_KEY = "AIzaSyAaGPkRzftcI83LmQosIkjHFKofGALxLvo"; // public Firebase web key (ships in the website bundle)
const SITE = process.env.RIDV_SITE ?? "https://expenses.ridventure.com";
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CREDENTIALS = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ridv", "credentials.json");
const PAYMENTS = ["Card", "Cash", "UPI", "Bank transfer", "Other"];
const USAGE = `ridv — expense tracker CLI (expenses.ridventure.com)

  ridv login                  sign in via the browser (Google or email), once per computer
  ridv whoami | logout
  ridv add <amount> <title...> [-c category] [-m merchant] [-d date] [-p payment] [-n notes]
      date: today (default) | yesterday | YYYY-MM-DD | DD-MM-YYYY
      payment: ${PAYMENTS.join(" | ")} (default Card)
      category: name or unique prefix, case-insensitive (default Other)
  ridv list [-l limit]        latest expenses (default 10) + this month's total
  ridv categories             category names
  ridv delete <id>            delete one expense (ids are shown by add/list)
  add --json / list --json    machine-readable output

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
  if (!date || date.getDate() !== Number(d)) throw new Error(`Unrecognised date "${text}". Use today, yesterday, YYYY-MM-DD or DD-MM-YYYY.`);
  return date;
}

export function matchCategory(categories, query) {
  const q = query.trim().toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const prefixed = categories.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefixed.length === 1) return prefixed[0];
  const names = categories.map((c) => c.name).join(", ");
  throw new Error(`${prefixed.length ? "Ambiguous" : "Unknown"} category "${query}". Categories: ${names}`);
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
export function toFields(object) {
  const value = (v) =>
    v instanceof Date
      ? { timestampValue: v.toISOString() }
      : typeof v === "number"
        ? Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
        : { stringValue: String(v) };
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, value(v)]));
}

function fromFields(fields = {}) {
  const value = (v) => v.stringValue ?? v.timestampValue ?? Number(v.integerValue ?? v.doubleValue);
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, value(v)]));
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
    const error = new Error(`${init.method ?? "GET"} ${url.split("?")[0]} -> ${res.status}: ${body.error?.message ?? JSON.stringify(body)}`);
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

async function saveCredentials(credentials) {
  await mkdir(join(CREDENTIALS, ".."), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, JSON.stringify(credentials, null, 2), { mode: 0o600 });
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
  if (body.refresh_token !== credentials.refreshToken) await saveCredentials({ ...credentials, refreshToken: body.refresh_token });
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
  const code = randomBytes(24).toString("base64url"); // 32 chars; the only secret guarding the handoff slot
  const url = `${SITE}/cli-login?code=${code}`;
  console.log(`Opening ${url}\nSign in if asked, check the code matches, and click "Authorize this computer".\n\n  Verification code: ${verificationCode(code)}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {}); // best effort; the URL is printed for headless use
  const slot = `${DOCS}/cliLogins/${code}?key=${API_KEY}`;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let doc;
    try {
      doc = await request(slot);
    } catch (error) {
      if (error.status === 404) continue;
      throw error;
    }
    await request(slot, { method: "DELETE" }); // one-time: never leave the token lying around
    const { uid, email, refreshToken } = fromFields(doc.fields);
    await saveCredentials({ uid, email, refreshToken });
    await getSession(); // proves the token works before we claim success
    return console.log(`Logged in as ${email}. Session saved to ${CREDENTIALS}`);
  }
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
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (opts.help || !command) return console.log(USAGE);
  if (command === "login") return login();
  if (command === "logout") {
    await rm(CREDENTIALS, { force: true });
    return console.log("Logged out (local session removed).");
  }
  if (command === "whoami") return console.log((await getSession()).email);
  if (command === "add") return add(args, opts);
  if (command === "list") return list(opts);
  if (command === "categories") return console.log((await getCategories(await userBase())).map((c) => c.name).sort().join("\n"));
  if (command === "delete") {
    if (!args[0]) throw new Error("Usage: ridv delete <id>");
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
