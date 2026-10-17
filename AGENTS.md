# AGENTS.md

Guide for AI agents working in this repo or acting for its user. Humans: see README.md.

## What this is

A personal, mobile-first expense tracker (amounts in ₹), the first app of a planned travel hub on
`*.ridventure.com`. Live at **https://expenses.ridventure.com**.

- React 19 + Vite + TypeScript SPA, Firebase Auth (Google + email/password), Cloud Firestore.
- Firebase/GCP project `project-dc59a57a-442b-4b6a-a3f` (Spark/free plan: no billing, so no Cloud
  Functions, no Firestore TTL). DNS for `ridventure.com` is on Cloudflare (proxied) → Firebase Hosting.
- `bin/ridv.mjs`: zero-dependency CLI so a person or an AI agent can add/list/delete expenses.

## Adding expenses for the user (ridv)

When the user says something like "add ₹450 lunch at Truffles yesterday on UPI", run:

```sh
ridv add 450 Lunch -m Truffles -d yesterday -p upi -c food
```

- `ridv add <amount> <title...> [-c category] [-m merchant] [-d date] [-p payment] [-n notes] [--json]`
  - amount: number, `₹` and commas allowed. date: `today` (default) | `yesterday` | `YYYY-MM-DD` | `DD-MM-YYYY`.
  - payment: Card (default) | Cash | UPI | Bank transfer | Other. category: name or unique prefix (default Other).
- `ridv categories` — run this first if the category is unclear; pick the closest, don't invent one.
- `ridv list [-l N] [--json]` — recent expenses + this month's total. `ridv delete <id>` — undo (20-char id from add/list).
- `ridv whoami` / `ridv login` / `ridv logout`. If a command says "Not logged in" or "session expired", tell the
  user to run `ridv login` themselves — it opens a browser and needs them to type a code. Never try to complete it.
- Relative dates ("last Tuesday") aren't parsed: convert to `YYYY-MM-DD` yourself using today's date.
- Don't guess the amount. If it's missing or ambiguous, ask. Echo back the `Added …` line so the user can check.
- Use `--json` when you need to chain commands (e.g. keep the id for a possible undo).

## Layout

| Path | What |
|---|---|
| `src/App.tsx` | The whole UI: auth screen, `/cli-login` page, form, categories + budgets, filters, charts, list |
| `src/lib.ts` | Pure helpers (money/date formatting, monthly totals, budgets, CSV) — keep logic here, testable |
| `src/firebase.ts`, `src/types.ts` | Firebase init from `VITE_FIREBASE_*`; shared types |
| `bin/ridv.mjs` | CLI. Pure helpers are exported and unit-tested; I/O below them |
| `firestore.rules` | **The security boundary.** Data lives at `users/{uid}/categories` and `users/{uid}/expenses` |
| `tests/*.test.ts` | Unit tests (`node --test`, TypeScript run natively by Node ≥ 24.2) |
| `tests/rules.emulator.mjs` | Security-rules allow/deny tests against the Firestore emulator (needs Java) |

## Commands

```sh
npm ci
npm run dev        # needs a .env with VITE_FIREBASE_* (values are public; see .github/workflows/firebase-hosting.yml)
npm run lint
npm test           # unit tests
npx firebase emulators:exec --only firestore --project demo-ridv "node --test tests/rules.emulator.mjs"
npm run build      # tsc -b && vite build
```

Run lint, tests, rules tests and build before pushing. CI runs the same, plus `firebase deploy --dry-run`.

## Conventions

- Smallest change that works; no new dependencies without a clear need. The CLI stays dependency-free.
- Amounts are INR numbers; dates are stored as Firestore timestamps at **local noon** (avoids TZ day-shift).
- Firestore field shapes must match between the web app and `ridv` (integers as `integerValue`, etc.).
- Any change to `firestore.rules` needs matching cases in `tests/rules.emulator.mjs`.
- `cliLogins/{code}` is the `ridv login` handoff: create-only, own uid, expiring ≤ 15 min, readable by code
  until expiry, never listable. Don't loosen it.
- Keep a `ponytail:`-style comment where a shortcut has a known ceiling (e.g. 500-write batch limit).

## Git, PRs and deploys

- GitHub: `Riddhesh2099/expense_tracker` (personal account). Remote uses the `github.com-rid` SSH alias;
  `gh` for this repo needs `GH_CONFIG_DIR=~/.config/gh-personal` (the user's shell alias `ghp`).
  Commit as `Riddhesh Tiwaskar <riddheshwork2099@gmail.com>`.
- Never push to `main`. Branch → PR → CI green → merge. **Merging to `main` deploys to production**
  (Hosting + Firestore rules/indexes); only `main` deploys, serialized.
- CI auth is keyless (Workload Identity Federation → `github-deployer@…` service account). There are no repo
  secrets; don't add a service-account key.
- gcloud for this project: `--account riddheshwork2099@gmail.com` (the default account may be a work one).

## Changing the domain/auth setup

`authDomain` is `expenses.ridventure.com` (so Google's picker shows it). It must stay in Firebase Auth's
authorized domains, and `https://expenses.ridventure.com/__/auth/handler` must stay a redirect URI on the
"Web client (auto created by Google Service)" OAuth client — that one is console-only, ask the user.
