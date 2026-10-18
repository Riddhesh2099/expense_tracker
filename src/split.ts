// Split money maths, shared by the web app and `ridv split`. Pure functions only; amounts are in the
// group's currency, computed in minor units (paise/cents) so shares always add up exactly.

export type SplitMode = "equal" | "exact" | "percent";
export type Member = { id: string; name: string; uid?: string };
export type GroupExpense = { amount: number; paidBy: string; shares: Record<string, number> };
export type Settlement = { from: string; to: string; amount: number };
export type Transfer = { from: string; to: string; amount: number };

const toMinor = (n: number) => Math.round(n * 100);
const fromMinor = (n: number) => n / 100;
const MAX_AMOUNT = 1e9; // sanity cap: keeps paise maths far inside safe-integer range

/** "₹1,200.50" / "1200.5" -> 1200.5 (rounded to 2 dp); NaN if it isn't a number. */
export function parseMoney(text: string) {
  return fromMinor(toMinor(Number(String(text).replace(/[₹$€£,\s]/g, ""))));
}

/**
 * Turn an amount + split mode into absolute shares per member.
 * equal: among `participants`; exact: `inputs` are amounts; percent: `inputs` are percentages.
 * Rounding remainders (in paise) go to the earliest participants so the total is exact.
 */
export function computeShares(
  amount: number,
  mode: SplitMode,
  participants: string[],
  inputs: Record<string, number> = {},
): Record<string, number> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a number greater than zero.");
  if (amount > MAX_AMOUNT) throw new Error("That amount is too large.");
  const total = toMinor(amount);
  if (total <= 0) throw new Error("Amount must be at least 0.01.");
  if (!participants.length) throw new Error("Pick at least one person to split with.");
  if (mode !== "equal") {
    const bad = participants.find((id) => !Number.isFinite(inputs[id] ?? 0) || (inputs[id] ?? 0) < 0);
    if (bad !== undefined) throw new Error("Every share must be a number of 0 or more.");
  }

  let minor: number[];
  if (mode === "equal") {
    const base = Math.floor(total / participants.length);
    minor = participants.map((_, i) => base + (i < total - base * participants.length ? 1 : 0));
  } else if (mode === "exact") {
    minor = participants.map((id) => toMinor(inputs[id] ?? 0));
    const sum = minor.reduce((a, b) => a + b, 0);
    if (sum !== total) throw new Error(`Exact amounts add up to ${fromMinor(sum)}, not ${fromMinor(total)}.`);
  } else {
    const pct = participants.map((id) => inputs[id] ?? 0);
    const pctSum = pct.reduce((a, b) => a + b, 0);
    // Tight tolerance: only float noise (33.333+33.333+33.334), never a real over/under-allocation.
    if (!(Math.abs(pctSum - 100) <= 1e-9)) throw new Error(`Percentages add up to ${pctSum}%, not 100%.`);
    minor = pct.map((p) => Math.floor((total * p) / 100));
    let left = total - minor.reduce((a, b) => a + b, 0);
    // Remainder paise go to participants who actually have a share.
    for (let i = 0; left > 0; i = (i + 1) % minor.length) {
      if (pct[i] > 0) {
        minor[i] += 1;
        left--;
      }
    }
  }
  // Invariant for every mode: shares are non-negative and add up to the total exactly.
  if (minor.some((m) => m < 0) || minor.reduce((a, b) => a + b, 0) !== total) {
    throw new Error("Shares don't add up to the amount.");
  }
  return Object.fromEntries(participants.map((id, i) => [id, fromMinor(minor[i])]).filter(([, v]) => v !== 0));
}

/** Net balance per member: positive = is owed money, negative = owes. */
export function balances(members: Member[], expenses: GroupExpense[], settlements: Settlement[] = []) {
  const net = new Map(members.map((m) => [m.id, 0]));
  const bump = (id: string, minor: number) => net.set(id, (net.get(id) ?? 0) + minor);
  for (const e of expenses) {
    bump(e.paidBy, toMinor(e.amount));
    for (const [id, share] of Object.entries(e.shares)) bump(id, -toMinor(share));
  }
  for (const s of settlements) {
    bump(s.from, toMinor(s.amount));
    bump(s.to, -toMinor(s.amount));
  }
  return Object.fromEntries([...net].map(([id, minor]) => [id, fromMinor(minor)]));
}

/** Fewest-ish payments to settle up: greedily match the biggest debtor with the biggest creditor. */
export function simplify(net: Record<string, number>): Transfer[] {
  const creditors = Object.entries(net).map(([id, v]) => ({ id, minor: toMinor(v) })).filter((x) => x.minor > 0);
  const debtors = Object.entries(net).map(([id, v]) => ({ id, minor: -toMinor(v) })).filter((x) => x.minor > 0);
  const transfers: Transfer[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.minor - a.minor);
    debtors.sort((a, b) => b.minor - a.minor);
    const pay = Math.min(creditors[0].minor, debtors[0].minor);
    transfers.push({ from: debtors[0].id, to: creditors[0].id, amount: fromMinor(pay) });
    creditors[0].minor -= pay;
    debtors[0].minor -= pay;
    if (!creditors[0].minor) creditors.shift();
    if (!debtors[0].minor) debtors.shift();
  }
  return transfers;
}

export function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en", { style: "currency", currency }).format(amount);
}

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "THB", "SGD", "JPY", "AUD"] as const;
