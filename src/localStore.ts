// Guest-preview backend: the subset of the Firestore modular API this app uses, kept in localStorage.
// Nothing leaves the browser and no account exists. Paths/refs mirror Firestore so call sites don't change.
import { Timestamp } from "firebase/firestore";

type Data = Record<string, unknown>;
type CollectionRef = { kind: "collection"; path: string; id: string };
type DocRef = { kind: "doc"; path: string; id: string };
type Constraint = { kind: "orderBy"; field: string; dir: "asc" | "desc" } | { kind: "where"; field: string; op: string; value: unknown };
type Query = { kind: "query"; path: string; constraints: Constraint[] };
type Sentinel = { __sentinel: "serverTimestamp" } | { __sentinel: "arrayUnion" | "arrayRemove"; values: unknown[] };

const KEY = "ridv-guest-db";
const listeners = new Set<() => void>();

// ---------- persistence (Timestamps survive JSON as {__ts: millis}) ----------

function load(): Record<string, Data> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}", (_k, v) => (v && typeof v === "object" && "__ts" in v ? Timestamp.fromMillis(v.__ts) : v));
  } catch {
    return {};
  }
}

function save(all: Record<string, Data>) {
  const json = JSON.stringify(all, function (k, v) {
    const raw = (this as Record<string, unknown>)[k]; // pre-toJSON value
    return raw instanceof Timestamp ? { __ts: raw.toMillis() } : v;
  });
  localStorage.setItem(KEY, json);
  queueMicrotask(() => listeners.forEach((fn) => fn()));
}

export function clearGuestData() {
  localStorage.removeItem(KEY);
}

// ---------- refs ----------

const join = (parts: string[]) => parts.filter(Boolean).join("/");
const lastSegment = (path: string) => path.split("/").pop() ?? "";
const autoId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");

export function collection(parent: unknown, ...segments: string[]): CollectionRef {
  const base = parent && typeof parent === "object" && "path" in parent ? (parent as DocRef).path : "";
  const path = join([base, ...segments]);
  return { kind: "collection", path, id: lastSegment(path) };
}

export function doc(parent: unknown, ...segments: string[]): DocRef {
  const base = parent && typeof parent === "object" && "path" in parent ? (parent as CollectionRef).path : "";
  const isCollection = parent && typeof parent === "object" && (parent as CollectionRef).kind === "collection";
  const path = isCollection && !segments.length ? join([base, autoId()]) : join([base, ...segments]);
  return { kind: "doc", path, id: lastSegment(path) };
}

export const orderBy = (field: string, dir: "asc" | "desc" = "asc"): Constraint => ({ kind: "orderBy", field, dir });
export const where = (field: string, op: string, value: unknown): Constraint => ({ kind: "where", field, op, value });
export const query = (ref: CollectionRef, ...constraints: Constraint[]): Query => ({ kind: "query", path: ref.path, constraints });

// ---------- values ----------

export const serverTimestamp = (): Sentinel => ({ __sentinel: "serverTimestamp" });
export const arrayUnion = (...values: unknown[]): Sentinel => ({ __sentinel: "arrayUnion", values });
export const arrayRemove = (...values: unknown[]): Sentinel => ({ __sentinel: "arrayRemove", values });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function resolve(value: unknown, previous?: unknown): unknown {
  if (value && typeof value === "object" && "__sentinel" in value) {
    const s = value as Sentinel;
    if (s.__sentinel === "serverTimestamp") return Timestamp.now();
    const current = Array.isArray(previous) ? previous : [];
    if (s.__sentinel === "arrayUnion") return [...current, ...s.values.filter((v) => !current.some((c) => same(c, v)))];
    return current.filter((c) => !s.values.some((v) => same(c, v)));
  }
  return value;
}

const resolveAll = (data: Data, previous: Data = {}) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined).map(([k, v]) => [k, resolve(v, previous[k])]));

// ---------- reads ----------

const childrenOf = (all: Record<string, Data>, collectionPath: string) =>
  Object.keys(all).filter((p) => p.startsWith(`${collectionPath}/`) && !p.slice(collectionPath.length + 1).includes("/"));

const comparable = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : v);

function runQuery(q: Query | CollectionRef) {
  const all = load();
  const constraints = q.kind === "query" ? q.constraints : [];
  let docs = childrenOf(all, q.path).map((path) => ({ path, data: all[path] }));
  for (const c of constraints) {
    if (c.kind === "where" && c.op === "array-contains") {
      docs = docs.filter((d) => Array.isArray(d.data[c.field]) && (d.data[c.field] as unknown[]).some((v) => same(v, c.value)));
    } else if (c.kind === "where" && c.op === "==") {
      docs = docs.filter((d) => same(d.data[c.field], c.value));
    }
  }
  for (const c of [...constraints].reverse()) {
    if (c.kind !== "orderBy") continue;
    const sign = c.dir === "desc" ? -1 : 1;
    docs.sort((a, b) => {
      const x = comparable(a.data[c.field]) as number | string;
      const y = comparable(b.data[c.field]) as number | string;
      return x < y ? -sign : x > y ? sign : 0;
    });
  }
  const snapDocs = docs.map((d) => ({
    id: lastSegment(d.path),
    ref: { kind: "doc", path: d.path, id: lastSegment(d.path) } as DocRef,
    data: () => d.data,
  }));
  return { docs: snapDocs, empty: !snapDocs.length, size: snapDocs.length, forEach: (fn: (d: (typeof snapDocs)[number]) => void) => snapDocs.forEach(fn) };
}

function docSnapshot(ref: DocRef) {
  const data = load()[ref.path];
  return { id: ref.id, ref, exists: () => data !== undefined, data: () => data };
}

// (Firestore's optional error callback is accepted by callers but never fires: local reads can't fail.)
export function onSnapshot(target: Query | CollectionRef | DocRef, next: (snap: never) => void) {
  const emit = () => next((target.kind === "doc" ? docSnapshot(target) : runQuery(target)) as never);
  listeners.add(emit);
  queueMicrotask(emit);
  return () => {
    listeners.delete(emit);
  };
}

export async function getDocs(target: Query | CollectionRef) {
  return runQuery(target);
}

// ---------- writes ----------

type Op = { type: "set" | "update" | "delete"; ref: DocRef; data?: Data };

function apply(ops: Op[]) {
  const all = load();
  for (const op of ops) {
    if (op.type === "delete") delete all[op.ref.path];
    else if (op.type === "set") all[op.ref.path] = resolveAll(op.data ?? {});
    else {
      if (!all[op.ref.path]) throw new Error(`No document to update: ${op.ref.path}`);
      all[op.ref.path] = { ...all[op.ref.path], ...resolveAll(op.data ?? {}, all[op.ref.path]) };
    }
  }
  save(all);
}

export async function addDoc(ref: CollectionRef, data: Data) {
  const target = doc(ref);
  apply([{ type: "set", ref: target, data }]);
  return target;
}
export async function setDoc(ref: DocRef, data: Data) {
  apply([{ type: "set", ref, data }]);
}
export async function updateDoc(ref: DocRef, data: Data) {
  apply([{ type: "update", ref, data }]);
}
export async function deleteDoc(ref: DocRef) {
  apply([{ type: "delete", ref }]);
}

export function writeBatch() {
  const ops: Op[] = [];
  const batch = {
    set: (ref: DocRef, data: Data) => (ops.push({ type: "set", ref, data }), batch),
    update: (ref: DocRef, data: Data) => (ops.push({ type: "update", ref, data }), batch),
    delete: (ref: DocRef) => (ops.push({ type: "delete", ref }), batch),
    commit: async () => apply(ops), // all-or-nothing: apply() builds the new state before saving once
  };
  return batch;
}
