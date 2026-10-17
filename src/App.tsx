import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import {
  ArrowDownAZ,
  BarChart3,
  Calendar,
  Check,
  CircleDollarSign,
  Download,
  Filter,
  LogOut,
  Pencil,
  Plus,
  Search,
  Target,
  Trash2,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { auth, db, hasFirebaseConfig, missingFirebaseConfig } from "./firebase";
import { budgetStatus, expensesToCsv, formatInputDate, formatMoney, isSameMonth, monthlyTotals } from "./lib";
import type { Category, DateRange, Expense, SortKey } from "./types";

const defaultCategories = [
  ["Food", "#ef4444"],
  ["Groceries", "#22c55e"],
  ["Travel", "#3b82f6"],
  ["Bills", "#f59e0b"],
  ["Shopping", "#a855f7"],
  ["Health", "#14b8a6"],
  ["Entertainment", "#ec4899"],
  ["Other", "#64748b"],
] as const;

function toDate(value: unknown) {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return new Date();
}

function downloadCsv(expenses: Expense[], categories: Map<string, Category>) {
  const csv = expensesToCsv(expenses, (id) => categories.get(id)?.name ?? "Uncategorized");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `expenses-${formatInputDate(new Date())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0); // revoking synchronously is flaky in Safari
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("month");
  const [pickedCategoryFilter, setCategoryFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("date-desc");
  const [editing, setEditing] = useState<Expense | null>(null);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!db || !user) return;
    const firestore = db;

    const categoryQuery = query(collection(firestore, "users", user.uid, "categories"), orderBy("name"));
    const expenseQuery = query(collection(firestore, "users", user.uid, "expenses"), orderBy("expenseDate", "desc"));

    let seededDefaults = false;

    const unsubscribeCategories = onSnapshot(categoryQuery, async (snapshot) => {
      if (snapshot.empty) {
        if (seededDefaults) return;
        seededDefaults = true;
        const batch = writeBatch(firestore);
        defaultCategories.forEach(([name, color]) => {
          batch.set(doc(collection(firestore, "users", user.uid, "categories")), {
            name,
            color,
            createdAt: serverTimestamp(),
          });
        });
        await batch.commit();
        return;
      }

      setCategories(
        snapshot.docs.map((categoryDoc) => ({
          id: categoryDoc.id,
          name: categoryDoc.data().name,
          color: categoryDoc.data().color,
          budget: Number(categoryDoc.data().budget ?? 0),
          createdAt: toDate(categoryDoc.data().createdAt),
        })),
      );
    });

    const unsubscribeExpenses = onSnapshot(expenseQuery, (snapshot) => {
      setExpenses(
        snapshot.docs.map((expenseDoc) => {
          const data = expenseDoc.data();
          return {
            id: expenseDoc.id,
            title: data.title,
            merchant: data.merchant ?? "",
            amount: Number(data.amount ?? 0),
            currency: data.currency ?? "INR",
            categoryId: data.categoryId,
            paymentMethod: data.paymentMethod ?? "",
            notes: data.notes ?? "",
            expenseDate: toDate(data.expenseDate),
            createdAt: toDate(data.createdAt),
          };
        }),
      );
    });

    return () => {
      unsubscribeCategories();
      unsubscribeExpenses();
    };
  }, [user]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  // A filter on a since-deleted category silently hides everything; treat it as "all".
  const categoryFilter = categoryById.has(pickedCategoryFilter) ? pickedCategoryFilter : "all";

  const filteredExpenses = useMemo(() => {
    const now = new Date();
    const lowerSearch = search.trim().toLowerCase();

    return expenses
      .filter((expense) => {
        if (categoryFilter !== "all" && expense.categoryId !== categoryFilter) return false;
        if (dateRange === "month") return isSameMonth(expense.expenseDate, now);
        if (dateRange === "year") {
          return expense.expenseDate.getFullYear() === now.getFullYear();
        }
        return true;
      })
      .filter((expense) => {
        if (!lowerSearch) return true;
        const category = categoryById.get(expense.categoryId)?.name ?? "";
        return [expense.title, expense.merchant, expense.notes, category]
          .join(" ")
          .toLowerCase()
          .includes(lowerSearch);
      })
      .sort((a, b) => {
        if (sortKey === "date-asc") return a.expenseDate.getTime() - b.expenseDate.getTime();
        if (sortKey === "amount-desc") return b.amount - a.amount;
        if (sortKey === "amount-asc") return a.amount - b.amount;
        if (sortKey === "title") return a.title.localeCompare(b.title);
        return b.expenseDate.getTime() - a.expenseDate.getTime();
      });
  }, [categoryById, categoryFilter, dateRange, expenses, search, sortKey]);

  const total = filteredExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const monthTotal = expenses
    .filter((expense) => isSameMonth(expense.expenseDate, new Date()))
    .reduce((sum, expense) => sum + expense.amount, 0);
  const budgets = budgetStatus(categories, expenses);

  const categoryChart = categories
    .map((category) => ({
      name: category.name,
      value: filteredExpenses
        .filter((expense) => expense.categoryId === category.id)
        .reduce((sum, expense) => sum + expense.amount, 0),
      color: category.color,
    }))
    .filter((item) => item.value > 0);

  const monthlyChart = useMemo(() => monthlyTotals(expenses), [expenses]);

  if (!hasFirebaseConfig) {
    return <ConfigMissing missing={missingFirebaseConfig} />;
  }

  if (!authReady) {
    return <div className="centered">Loading your tracker...</div>;
  }

  if (!user) {
    return <AuthScreen />;
  }

  if (window.location.pathname === "/cli-login") {
    return <CliLogin user={user} />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Cloud Expense Tracker</p>
          <h1>Expenses</h1>
        </div>
        <button className="icon-text ghost" onClick={() => auth && signOut(auth)}>
          <LogOut size={18} />
          Sign out
        </button>
      </header>

      <section className="summary-grid">
        <Metric label="Filtered spend" value={formatMoney(total)} icon={<Filter size={20} />} />
        <Metric label="This month" value={formatMoney(monthTotal)} icon={<Calendar size={20} />} />
        <Metric label="Entries" value={String(filteredExpenses.length)} icon={<CircleDollarSign size={20} />} />
      </section>

      <section className="workspace">
        <ExpenseForm
          key={editing?.id ?? "new"}
          userId={user.uid}
          categories={categories}
          editing={editing}
          onDone={() => setEditing(null)}
        />
        <CategoryManager userId={user.uid} categories={categories} expenses={expenses} />
      </section>

      {budgets.length > 0 && (
        <section className="panel budget-panel">
          <div className="panel-title">
            <Target size={20} />
            <h2>Budgets this month</h2>
          </div>
          {budgets.map(({ category, spent, budget, ratio }) => (
            <div className="budget-row" key={category.id}>
              <span>{category.name}</span>
              <div className="budget-bar">
                <span
                  style={{ width: `${Math.min(ratio, 1) * 100}%`, backgroundColor: ratio > 1 ? "#dc2626" : category.color }}
                />
              </div>
              <span className={ratio > 1 ? "over" : ""}>
                {formatMoney(spent)} / {formatMoney(budget)}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="toolbar">
        <label className="search-field">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search expenses" />
        </label>
        <select value={dateRange} onChange={(event) => setDateRange(event.target.value as DateRange)}>
          <option value="month">This month</option>
          <option value="year">This year</option>
          <option value="all">All time</option>
        </select>
        <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="amount-desc">Amount high to low</option>
          <option value="amount-asc">Amount low to high</option>
          <option value="title">Title A-Z</option>
        </select>
        <button
          className="ghost"
          onClick={() => downloadCsv(filteredExpenses, categoryById)}
          disabled={!filteredExpenses.length}
          title="Export the expenses currently shown (respects filters)"
        >
          <Download size={18} />
          CSV
        </button>
      </section>

      <section className="charts">
        <ChartPanel title="Monthly trend">
          {monthlyChart.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => formatMoney(Number(value))} />
                <Line type="monotone" dataKey="amount" stroke="#2563eb" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState text="Add an expense to see your monthly trend." />
          )}
        </ChartPanel>

        <ChartPanel title="By category">
          {categoryChart.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={categoryChart} dataKey="value" nameKey="name" innerRadius={64} outerRadius={96}>
                  {categoryChart.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatMoney(Number(value))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState text="Add an expense to see category charts." />
          )}
        </ChartPanel>

        <ChartPanel title="Category bars">
          {categoryChart.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={categoryChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip formatter={(value) => formatMoney(Number(value))} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {categoryChart.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState text="Add an expense to see category totals." />
          )}
        </ChartPanel>
      </section>

      <ExpenseList
        expenses={filteredExpenses}
        categories={categoryById}
        userId={user.uid}
        onEdit={(expense) => {
          setEditing(expense);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </main>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth) return;
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) setBusy(false);
      })
      .catch((caught) => {
        setBusy(false);
        setError(authErrorMessage(caught, "Google sign-in failed."));
      });
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (nextUser) => {
      if (nextUser) setBusy(false);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (caught) {
      setError(authErrorMessage(caught, "Authentication failed."));
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
        setBusy(false);
      } catch (caught) {
        if (shouldUseRedirectFallback(caught)) {
          await signInWithRedirect(auth, provider);
          return;
        }
        setError(authErrorMessage(caught, "Google sign-in failed."));
        setBusy(false);
      }
    } catch (caught) {
      setError(authErrorMessage(caught, "Google sign-in failed."));
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <BarChart3 size={32} />
        <h1>Expense Tracker</h1>
        <p>Sign in to record expenses and review spending from any phone or browser.</p>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" required />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          minLength={6}
          required
        />
        {error && <p className="error">{error}</p>}
        <button className="google-button" type="button" onClick={signInWithGoogle} disabled={busy}>
          <span aria-hidden="true">G</span>
          Continue with Google
        </button>
        <div className="divider">or</div>
        <button disabled={busy}>{busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}</button>
        <button className="link-button" type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Create a new account" : "Use an existing account"}
        </button>
      </form>
    </main>
  );
}

function authErrorMessage(caught: unknown, fallback: string) {
  if (!(caught instanceof Error)) return fallback;
  const code = "code" in caught ? String(caught.code) : "";
  if (code.includes("unauthorized-domain")) {
    return "This website domain is not authorized in Firebase Authentication settings.";
  }
  if (code.includes("operation-not-allowed")) {
    return "Google sign-in is not enabled in Firebase Authentication.";
  }
  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) {
    return "The Google sign-in window was closed before finishing.";
  }
  if (code.includes("popup-blocked")) {
    return "Your browser blocked the Google sign-in window. Allow popups for this site and try again.";
  }
  return caught.message || fallback;
}

function shouldUseRedirectFallback(caught: unknown) {
  if (!(caught instanceof Error) || !("code" in caught)) return false;
  if (!String(caught.code).includes("popup-blocked")) return false;
  // signInWithRedirect only completes reliably when the app is served from the
  // Firebase authDomain; on any other origin modern browsers block the
  // third-party storage it needs and the redirect returns with no user.
  const authDomain = String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "");
  return authDomain !== "" && window.location.hostname === authDomain;
}

function ExpenseForm({
  userId,
  categories,
  editing,
  onDone,
}: {
  userId: string;
  categories: Category[];
  editing: Expense | null;
  onDone: () => void;
}) {
  // Remounted via `key` when `editing` changes, so these initialisers always see the right expense.
  const [title, setTitle] = useState(editing?.title ?? "");
  const [merchant, setMerchant] = useState(editing?.merchant ?? "");
  const [amount, setAmount] = useState(editing ? String(editing.amount) : "");
  const [pickedCategoryId, setPickedCategoryId] = useState(editing?.categoryId ?? "");
  const [paymentMethod, setPaymentMethod] = useState(editing?.paymentMethod || "Card");
  const [expenseDate, setExpenseDate] = useState(formatInputDate(editing?.expenseDate ?? new Date()));
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Derived, not stored: if the picked category is deleted meanwhile, fall back to what the select shows.
  const categoryId = categories.some((c) => c.id === pickedCategoryId) ? pickedCategoryId : (categories[0]?.id ?? "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!db || !categoryId) return;
    const parsedAmount = Number(amount.trim());
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Enter a valid amount greater than zero, like 12.50.");
      return;
    }
    setBusy(true);
    setError("");
    const fields = {
      title,
      merchant,
      amount: parsedAmount,
      currency: "INR",
      categoryId,
      paymentMethod,
      notes,
      expenseDate: Timestamp.fromDate(new Date(`${expenseDate}T12:00:00`)),
    };
    try {
      if (editing) {
        await updateDoc(doc(db, "users", userId, "expenses", editing.id), fields);
        onDone();
        return;
      }
      await addDoc(collection(db, "users", userId, "expenses"), { ...fields, createdAt: serverTimestamp() });
      setTitle("");
      setMerchant("");
      setAmount("");
      setNotes("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the expense.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <div className="panel-title">
        {editing ? <Pencil size={20} /> : <Plus size={20} />}
        <h2>{editing ? "Edit expense" : "Add expense"}</h2>
      </div>
      <div className="field-grid">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" required />
        <input value={merchant} onChange={(event) => setMerchant(event.target.value)} placeholder="Merchant" />
        <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount (₹)" inputMode="decimal" required />
        <input type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} required />
        <select value={categoryId} onChange={(event) => setPickedCategoryId(event.target.value)} required>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
          <option>Card</option>
          <option>Cash</option>
          <option>UPI</option>
          <option>Bank transfer</option>
          <option>Other</option>
        </select>
      </div>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" rows={3} />
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button disabled={busy || !categories.length}>
          <Check size={18} />
          {editing ? "Update expense" : "Save expense"}
        </button>
        {editing && (
          <button type="button" className="ghost" onClick={onDone}>
            <X size={18} />
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CategoryManager({
  userId,
  categories,
  expenses,
}: {
  userId: string;
  categories: Category[];
  expenses: Expense[];
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#2563eb");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!db) return;
    setError("");
    try {
      await addDoc(collection(db, "users", userId, "categories"), {
        name,
        color,
        createdAt: serverTimestamp(),
      });
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the category.");
    }
  }

  async function update(category: Category, fields: Partial<Pick<Category, "name" | "budget">>) {
    if (!db) return;
    setError("");
    try {
      await updateDoc(doc(db, "users", userId, "categories", category.id), fields);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the category.");
    }
  }

  function rename(category: Category) {
    const next = window.prompt("Rename category", category.name)?.trim();
    if (next && next !== category.name) update(category, { name: next });
  }

  function saveBudget(category: Category, raw: string) {
    const budget = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(budget) || budget < 0) {
      setError("Budget must be a positive number, or empty for no budget.");
      return;
    }
    if (budget !== (category.budget ?? 0)) update(category, { budget });
  }

  async function remove(category: Category) {
    const firestore = db;
    if (!firestore) return;
    const fallback = categories.find((c) => c.id !== category.id && c.name === "Other") ?? categories.find((c) => c.id !== category.id);
    if (!fallback) {
      setError("Keep at least one category.");
      return;
    }
    const used = expenses.filter((expense) => expense.categoryId === category.id);
    const message = used.length
      ? `Delete "${category.name}"? Its ${used.length} expense(s) will move to "${fallback.name}".`
      : `Delete "${category.name}"?`;
    if (!window.confirm(message)) return;
    setError("");
    try {
      // ponytail: one batch caps at 500 writes; chunk it if a category ever holds more expenses than that.
      const batch = writeBatch(firestore);
      used.forEach((expense) =>
        batch.update(doc(firestore, "users", userId, "expenses", expense.id), { categoryId: fallback.id }),
      );
      batch.delete(doc(firestore, "users", userId, "categories", category.id));
      await batch.commit();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the category.");
    }
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <ArrowDownAZ size={20} />
        <h2>Categories</h2>
      </div>
      <form className="category-form" onSubmit={submit}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New category" required />
        <input className="color-input" type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="Category color" />
        <button>Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="category-list">
        {categories.map((category) => (
          <div className="category-row" key={category.id}>
            <span className="dot" style={{ backgroundColor: category.color }} />
            <span className="category-name">{category.name}</span>
            <input
              key={category.budget ?? 0}
              defaultValue={category.budget || ""}
              onBlur={(event) => saveBudget(category, event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              placeholder="Budget ₹"
              inputMode="decimal"
              aria-label={`Monthly budget for ${category.name}`}
            />
            <button className="icon-only ghost" type="button" onClick={() => rename(category)} aria-label={`Rename ${category.name}`}>
              <Pencil size={16} />
            </button>
            <button className="icon-only ghost" type="button" onClick={() => remove(category)} aria-label={`Delete ${category.name}`}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExpenseList({
  expenses,
  categories,
  userId,
  onEdit,
}: {
  expenses: Expense[];
  categories: Map<string, Category>;
  userId: string;
  onEdit: (expense: Expense) => void;
}) {
  async function removeExpense(expense: Expense) {
    if (!db) return;
    if (!window.confirm(`Delete "${expense.title}"? This cannot be undone.`)) return;
    await deleteDoc(doc(db, "users", userId, "expenses", expense.id));
  }

  async function changeCategory(expenseId: string, categoryId: string) {
    if (!db) return;
    await updateDoc(doc(db, "users", userId, "expenses", expenseId), { categoryId });
  }

  return (
    <section className="panel table-panel">
      <div className="panel-title">
        <CircleDollarSign size={20} />
        <h2>Expense list</h2>
      </div>
      {expenses.length ? (
        <div className="expense-list">
          {expenses.map((expense) => {
            const category = categories.get(expense.categoryId);
            return (
              <article className="expense-row" key={expense.id}>
                <div>
                  <strong>{expense.title}</strong>
                  <span>{expense.merchant || "No merchant"} · {expense.expenseDate.toLocaleDateString()}</span>
                </div>
                <select value={expense.categoryId} onChange={(event) => changeCategory(expense.id, event.target.value)}>
                  {[...categories.values()].map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <span className="category-pill" style={{ borderColor: category?.color }}>
                  {category?.name ?? "Uncategorized"}
                </span>
                <strong>{formatMoney(expense.amount)}</strong>
                <button className="icon-only ghost" onClick={() => onEdit(expense)} aria-label={`Edit ${expense.title}`}>
                  <Pencil size={18} />
                </button>
                <button className="icon-only" onClick={() => removeExpense(expense)} aria-label={`Delete ${expense.title}`}>
                  <Trash2 size={18} />
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState text="No expenses match these filters." />
      )}
    </section>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <section className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function ChartPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel chart-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

/**
 * `ridv login` handoff. The CLI generated a random code and polls cliLogins/{code}; authorizing writes this
 * browser's Firebase refresh token there. The CLI reads it once and deletes it; leftovers expire via TTL.
 */
function CliLogin({ user }: { user: User }) {
  const code = new URLSearchParams(window.location.search).get("code") ?? "";
  const valid = /^[A-Za-z0-9_-]{32,64}$/.test(code);
  const verification = `${code.slice(-8, -4)}-${code.slice(-4)}`.toUpperCase();
  const [status, setStatus] = useState<"ask" | "busy" | "done">("ask");
  const [error, setError] = useState("");

  async function authorize() {
    if (!db) return;
    setStatus("busy");
    setError("");
    try {
      await setDoc(doc(db, "cliLogins", code), {
        uid: user.uid,
        email: user.email ?? "",
        refreshToken: user.refreshToken,
        createdAt: serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
      });
      setStatus("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not authorize the CLI.");
      setStatus("ask");
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <h1>Authorize ridv</h1>
        {!valid ? (
          <p className="error">This link is missing a valid login code. Run `ridv login` again.</p>
        ) : status === "done" ? (
          <p>Done. Return to your terminal; you can close this tab.</p>
        ) : (
          <>
            <p>
              Allow the <strong>ridv</strong> command-line tool to add and read expenses as <strong>{user.email}</strong>.
            </p>
            <p>
              Only continue if you just ran <code>ridv login</code> yourself and your terminal shows the code:
            </p>
            <pre>{verification}</pre>
            {error && <p className="error">{error}</p>}
            <button onClick={authorize} disabled={status === "busy"}>
              <Check size={18} />
              Authorize this computer
            </button>
            <a className="link-button" href="/">
              Cancel
            </a>
          </>
        )}
      </section>
    </main>
  );
}

function ConfigMissing({ missing }: { missing: string[] }) {
  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <h1>Firebase config needed</h1>
        <p>Add these values to a local .env file from your Firebase web app settings.</p>
        <pre>{missing.join("\n")}</pre>
      </section>
    </main>
  );
}
