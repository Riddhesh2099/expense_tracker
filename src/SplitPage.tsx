import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "./store";
import type { User } from "firebase/auth";
import { ArrowRightLeft, Check, Plus, Trash2, Users } from "lucide-react";
import { db } from "./firebase";
import { formatInputDate } from "./lib";
import { balances, computeShares, CURRENCIES, formatCurrency, parseMoney, simplify, type Member, type SplitMode } from "./split";
import type { Category } from "./types";

type Group = {
  id: string;
  name: string;
  currency: string;
  createdBy: string;
  members: Member[];
  autoAddShare: boolean;
};
type SplitExpense = {
  id: string;
  title: string;
  amount: number;
  paidBy: string;
  splitMode: SplitMode;
  shares: Record<string, number>;
  date: Date;
  personalExpenseId?: string;
};
type SplitSettlement = { id: string; from: string; to: string; amount: number; date: Date };

const newId = () => crypto.randomUUID().slice(0, 8);
const toDate = (v: unknown) => (v instanceof Timestamp ? v.toDate() : new Date());

export function SplitApp({ user, categories }: { user: User; categories: Category[] }) {
  const groupId = new URLSearchParams(window.location.search).get("g");
  return groupId ? <GroupView user={user} groupId={groupId} categories={categories} /> : <GroupList user={user} />;
}

function GroupList({ user }: { user: User }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [others, setOthers] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!db) return;
    return onSnapshot(
      query(collection(db, "groups"), where("memberUids", "array-contains", user.uid)),
      (snap) =>
        setGroups(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Group, "id">) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      (err) => setError(`Couldn't load your groups: ${err.message}`),
    );
  }, [user.uid]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!db) return;
    const me: Member = { id: newId(), name: user.displayName?.split(" ")[0] || user.email?.split("@")[0] || "Me", uid: user.uid };
    const members = [me, ...others.split(",").map((n) => n.trim()).filter(Boolean).map((n) => ({ id: newId(), name: n }))];
    try {
      const ref = await addDoc(collection(db, "groups"), {
        name: name.trim(),
        currency,
        createdBy: user.uid,
        memberUids: [user.uid],
        members,
        autoAddShare: false,
        createdAt: serverTimestamp(),
      });
      window.location.href = `/split?g=${ref.id}`;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the group.");
    }
  }

  return (
    <main className="shell">
      <SplitHeader title="Split" back="/" backLabel="← Ridventure" />
      <section className="workspace">
        <section className="panel">
          <div className="panel-title">
            <Users size={20} />
            <h2>Your groups</h2>
          </div>
          {groups.length ? (
            <div className="expense-list">
              {groups.map((g) => (
                <a className="expense-row group-link" href={`/split?g=${g.id}`} key={g.id}>
                  <div>
                    <strong>{g.name}</strong>
                    <span>
                      {g.members.map((m) => m.name).join(", ")} · {g.currency}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <p className="empty">No groups yet. Create one for your next trip.</p>
          )}
        </section>
        <form className="panel form-panel" onSubmit={create}>
          <div className="panel-title">
            <Plus size={20} />
            <h2>New group</h2>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name, e.g. Goa trip" required />
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input value={others} onChange={(e) => setOthers(e.target.value)} placeholder="Other people, comma separated" />
          {error && <p className="error">{error}</p>}
          <button>
            <Check size={18} />
            Create group
          </button>
        </form>
      </section>
    </main>
  );
}

function GroupView({ user, groupId, categories }: { user: User; groupId: string; categories: Category[] }) {
  const [group, setGroup] = useState<Group | null | undefined>(undefined);
  const [expenses, setExpenses] = useState<SplitExpense[]>([]);
  const [settlements, setSettlements] = useState<SplitSettlement[]>([]);
  const [error, setError] = useState("");
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    if (!db) return;
    const firestore = db;
    const ref = doc(firestore, "groups", groupId);
    const unsubs = [
      onSnapshot(
        ref,
        (snap) => setGroup(snap.exists() ? ({ id: snap.id, ...snap.data() } as Group) : null),
        () => setGroup(null),
      ),
      onSnapshot(
        query(collection(ref, "expenses"), orderBy("date", "desc")),
        (snap) => setExpenses(snap.docs.map((d) => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }) as SplitExpense)),
        (err) => setError(`Couldn't load expenses: ${err.message}`),
      ),
      onSnapshot(
        query(collection(ref, "settlements"), orderBy("date", "desc")),
        (snap) => setSettlements(snap.docs.map((d) => ({ id: d.id, ...d.data(), date: toDate(d.data().date) }) as SplitSettlement)),
        (err) => setError(`Couldn't load settlements: ${err.message}`),
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [groupId]);

  const net = useMemo(() => (group ? balances(group.members, expenses, settlements) : {}), [group, expenses, settlements]);
  const transfers = useMemo(() => simplify(net), [net]);

  if (group === undefined) return <div className="centered">Loading...</div>;
  if (group === null) {
    return (
      <main className="shell">
        <SplitHeader title="Group not found" back="/split" backLabel="← Split" />
        <p className="empty">This group doesn't exist or isn't shared with you.</p>
      </main>
    );
  }

  const g = group;
  const me = g.members.find((m) => m.uid === user.uid);
  const name = (id: string) => g.members.find((m) => m.id === id)?.name ?? "?";
  const money = (n: number) => formatCurrency(n, g.currency);
  const ref = doc(db!, "groups", g.id);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    }
  }

  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("member") as HTMLInputElement;
    const memberName = input.value.trim();
    if (!memberName) return;
    input.value = "";
    // arrayUnion/arrayRemove: concurrent edits from two tabs don't overwrite each other.
    run(() => updateDoc(ref, { members: arrayUnion({ id: newId(), name: memberName }) }), "Could not add the member.");
  }

  function removeMember(member: Member) {
    if (member.uid || Math.abs(net[member.id] ?? 0) > 0.001 || expenses.some((e) => e.paidBy === member.id || member.id in e.shares)) {
      setError(`${member.name} has expenses or a balance in this group, so they can't be removed.`);
      return;
    }
    run(() => updateDoc(ref, { members: arrayRemove(member) }), "Could not remove the member.");
  }

  async function settle(from: string, to: string, amount: number) {
    if (settling || !window.confirm(`Record that ${name(from)} paid ${name(to)} ${money(amount)}?`)) return;
    setSettling(true);
    await run(
      () =>
        addDoc(collection(ref, "settlements"), {
          from,
          to,
          amount,
          date: Timestamp.fromDate(new Date(`${formatInputDate(new Date())}T12:00:00`)),
          createdBy: user.uid,
        }),
      "Could not record the settlement.",
    );
    setSettling(false);
  }

  async function removeExpense(expense: SplitExpense) {
    if (!window.confirm(`Delete "${expense.title}"?`)) return;
    await run(async () => {
      const batch = writeBatch(db!);
      batch.delete(doc(ref, "expenses", expense.id));
      if (expense.personalExpenseId) batch.delete(doc(db!, "users", user.uid, "expenses", expense.personalExpenseId));
      await batch.commit();
    }, "Could not delete the expense.");
  }

  async function deleteGroup() {
    if (!window.confirm(`Delete the group "${g.name}" and all its expenses? Your personal expense entries stay.`)) return;
    await run(async () => {
      // ponytail: one batch caps at 500 writes; chunk it if a group ever gets that big.
      const batch = writeBatch(db!);
      for (const sub of ["expenses", "settlements"]) {
        (await getDocs(collection(ref, sub))).forEach((d) => batch.delete(d.ref));
      }
      batch.delete(ref);
      await batch.commit();
      window.location.href = "/split";
    }, "Could not delete the group.");
  }

  const myShareTotal = me ? expenses.reduce((sum, e) => sum + (e.shares[me.id] ?? 0), 0) : 0;

  return (
    <main className="shell">
      <SplitHeader title={g.name} back="/split" backLabel="← Split" />
      {error && <p className="error">{error}</p>}

      <section className="summary-grid">
        <section className="metric">
          <span>Group spend</span>
          <strong>{money(expenses.reduce((s, e) => s + e.amount, 0))}</strong>
        </section>
        <section className="metric">
          <span>Your share</span>
          <strong>{money(myShareTotal)}</strong>
        </section>
        <section className="metric">
          <span>{me && (net[me.id] ?? 0) < 0 ? "You owe" : "You are owed"}</span>
          <strong>{money(Math.abs(me ? (net[me.id] ?? 0) : 0))}</strong>
        </section>
      </section>

      <section className="workspace">
        <SplitExpenseForm group={g} me={me} user={user} categories={categories} onError={setError} />
        <section className="panel">
          <div className="panel-title">
            <ArrowRightLeft size={20} />
            <h2>Settle up</h2>
          </div>
          {transfers.length ? (
            <div className="expense-list">
              {transfers.map((t) => (
                <div className="transfer-row" key={`${t.from}-${t.to}`}>
                  <span>
                    <strong>{name(t.from)}</strong> pays <strong>{name(t.to)}</strong>
                  </span>
                  <strong>{money(t.amount)}</strong>
                  <button className="ghost" onClick={() => settle(t.from, t.to, t.amount)} disabled={settling}>
                    Settle
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty small">All settled up.</p>
          )}

          <div className="panel-title spaced">
            <Users size={20} />
            <h2>Members</h2>
          </div>
          <div className="category-list">
            {g.members.map((m) => (
              <div className="category-row member-row" key={m.id}>
                <span className="category-name">
                  {m.name}
                  {m.uid === user.uid ? " (you)" : ""}
                </span>
                <span className={(net[m.id] ?? 0) < 0 ? "over" : ""}>{money(net[m.id] ?? 0)}</span>
                {!m.uid && (
                  <button className="icon-only ghost" type="button" onClick={() => removeMember(m)} aria-label={`Remove ${m.name}`}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <form className="category-form" onSubmit={addMember}>
            <input name="member" placeholder="Add a person" />
            <button>Add</button>
          </form>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={g.autoAddShare && g.currency === "INR"}
              disabled={g.currency !== "INR"}
              onChange={(e) => run(() => updateDoc(ref, { autoAddShare: e.target.checked }), "Could not save the setting.")}
            />
            <span>
              Add my share of new expenses to my Expenses
              {g.currency !== "INR" && " (INR groups only for now)"}
            </span>
          </label>
        </section>
      </section>

      <section className="panel table-panel">
        <div className="panel-title">
          <Users size={20} />
          <h2>Expenses</h2>
        </div>
        {expenses.length ? (
          <div className="expense-list">
            {expenses.map((e) => (
              <article className="expense-row split-row" key={e.id}>
                <div>
                  <strong>{e.title}</strong>
                  <span>
                    {name(e.paidBy)} paid · {e.date.toLocaleDateString()} · {e.splitMode}
                    {me && e.shares[me.id] ? ` · your share ${money(e.shares[me.id])}` : ""}
                  </span>
                </div>
                <strong>{money(e.amount)}</strong>
                <button className="icon-only" onClick={() => removeExpense(e)} aria-label={`Delete ${e.title}`}>
                  <Trash2 size={18} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No expenses yet.</p>
        )}
        {settlements.length > 0 && (
          <>
            <div className="panel-title spaced">
              <ArrowRightLeft size={20} />
              <h2>Settlements</h2>
            </div>
            <div className="expense-list">
              {settlements.map((s) => (
                <article className="expense-row split-row" key={s.id}>
                  <div>
                    <strong>
                      {name(s.from)} paid {name(s.to)}
                    </strong>
                    <span>{s.date.toLocaleDateString()}</span>
                  </div>
                  <strong>{money(s.amount)}</strong>
                  <button
                    className="icon-only"
                    onClick={() => window.confirm("Delete this settlement?") && run(() => deleteDoc(doc(ref, "settlements", s.id)), "Could not delete.")}
                    aria-label="Delete settlement"
                  >
                    <Trash2 size={18} />
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
        {g.createdBy === user.uid && (
          <button className="ghost danger-link" onClick={deleteGroup}>
            Delete group
          </button>
        )}
      </section>
    </main>
  );
}

function SplitExpenseForm({
  group,
  me,
  user,
  categories,
  onError,
}: {
  group: Group;
  me: Member | undefined;
  user: User;
  categories: Category[];
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [pickedPaidBy, setPaidBy] = useState(me?.id ?? group.members[0]?.id ?? "");
  // Derived: if the picked payer was removed meanwhile, fall back to what the select shows.
  const paidBy = group.members.some((m) => m.id === pickedPaidBy) ? pickedPaidBy : (group.members[0]?.id ?? "");
  const [mode, setMode] = useState<SplitMode>("equal");
  // Track who's left OUT, so members added later are automatically in the split.
  const [excluded, setExcluded] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [date, setDate] = useState(formatInputDate(new Date()));
  const [busy, setBusy] = useState(false);

  const participants = group.members.map((m) => m.id).filter((id) => !excluded.includes(id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!db) return;
    onError("");
    const total = parseMoney(amount); // "₹1,200.456" -> 1200.46: stored amount == what the shares add up to
    let shares: Record<string, number>;
    try {
      shares = computeShares(
        total,
        mode,
        participants,
        Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.trim() === "" ? 0 : parseMoney(v)])),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Invalid split.");
      return;
    }
    setBusy(true);
    const when = Timestamp.fromDate(new Date(`${date}T12:00:00`));
    try {
      // One atomic batch: the group expense and (optionally) your personal share land together or not at all.
      const batch = writeBatch(db);
      const groupExpense = doc(collection(db, "groups", group.id, "expenses"));
      const myShare = me ? shares[me.id] : undefined;
      let personalExpenseId: string | undefined;
      if (group.autoAddShare && group.currency === "INR" && myShare) {
        const category = categories.find((c) => c.name === "Travel") ?? categories.find((c) => c.name === "Other") ?? categories[0];
        const personal = doc(collection(db, "users", user.uid, "expenses"));
        personalExpenseId = personal.id;
        batch.set(personal, {
          title: `${group.name}: ${title}`,
          merchant: "",
          amount: myShare,
          currency: "INR",
          categoryId: category?.id ?? "",
          paymentMethod: "Other",
          notes: `Your share, split in ${group.name}`,
          expenseDate: when,
          createdAt: serverTimestamp(),
        });
      }
      batch.set(groupExpense, {
        title,
        amount: total,
        paidBy,
        splitMode: mode,
        shares,
        date: when,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        ...(personalExpenseId && { personalExpenseId }),
      });
      await batch.commit();
      setTitle("");
      setAmount("");
      setInputs({});
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not save the expense.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <div className="panel-title">
        <Plus size={20} />
        <h2>Add group expense</h2>
      </div>
      <div className="field-grid">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What for, e.g. Dinner" required />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount (${group.currency})`}
          inputMode="decimal"
          required
        />
        <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)} aria-label="Paid by">
          {group.members.map((m) => (
            <option key={m.id} value={m.id}>
              Paid by {m.name}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as SplitMode)} aria-label="Split mode">
          <option value="equal">Split equally</option>
          <option value="exact">Exact amounts</option>
          <option value="percent">By percentage</option>
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <div className="split-people">
        {group.members.map((m) => (
          <label className="split-person" key={m.id}>
            <input
              type="checkbox"
              checked={participants.includes(m.id)}
              onChange={(e) =>
                setExcluded(e.target.checked ? excluded.filter((id) => id !== m.id) : [...excluded, m.id])
              }
            />
            <span>{m.name}</span>
            {mode !== "equal" && participants.includes(m.id) && (
              <input
                value={inputs[m.id] ?? ""}
                onChange={(e) => setInputs({ ...inputs, [m.id]: e.target.value })}
                placeholder={mode === "percent" ? "%" : group.currency}
                inputMode="decimal"
              />
            )}
          </label>
        ))}
      </div>
      <button disabled={busy || !group.members.length}>
        <Check size={18} />
        Add expense
      </button>
    </form>
  );
}

function SplitHeader({ title, back, backLabel }: { title: string; back: string; backLabel: string }) {
  return (
    <header className="topbar">
      <div>
        <a className="eyebrow" href={back}>
          {backLabel}
        </a>
        <h1>{title}</h1>
      </div>
    </header>
  );
}
