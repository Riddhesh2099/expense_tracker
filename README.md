# Expense Tracker on GCP/Firebase

A mobile-first expense tracker backed by Firebase Authentication and Cloud Firestore.

## Features

Live at **https://expenses.ridventure.com** (Cloudflare DNS → Firebase Hosting).

- Email/password or Google sign in
- Add, edit and delete expenses (amounts in ₹) from mobile or desktop
- Categories: add, rename, delete (its expenses move to "Other"), and an optional monthly budget each
- "Budgets this month" progress bars, red when a category goes over
- Filter by search, date range, and category; sort by date, amount, or title
- Export the filtered list as CSV
- Monthly trend and category charts
- Firestore security rules scoped to each authenticated user

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Firebase project in the Firebase Console.

3. Enable these Firebase products:

   - Authentication: enable Email/Password provider
   - Firestore Database: create in production mode
   - Hosting: enable hosting for the project

4. Create a web app in Firebase Project settings and copy its config values into `.env`:

   ```bash
   cp .env.example .env
   ```

   Fill in:

   ```bash
   VITE_FIREBASE_API_KEY=
   VITE_FIREBASE_AUTH_DOMAIN=
   VITE_FIREBASE_PROJECT_ID=
   VITE_FIREBASE_STORAGE_BUCKET=
   VITE_FIREBASE_MESSAGING_SENDER_ID=
   VITE_FIREBASE_APP_ID=
   ```

5. Run locally:

   ```bash
   npm run dev
   ```

## Deploy

Install or run the Firebase CLI:

```bash
npx firebase-tools login
npx firebase-tools use <your-project-id>
npm run build
npx firebase-tools deploy
```

The deploy publishes:

- `dist/` to Firebase Hosting
- `firestore.rules`
- `firestore.indexes.json`

Current deployed v1:

- Custom domain: https://expenses.ridventure.com (also listed under Authentication > Settings > Authorized domains)
- Hosting URL: https://project-dc59a57a-442b-4b6a-a3f.web.app
- Firebase Console: https://console.firebase.google.com/project/project-dc59a57a-442b-4b6a-a3f/overview

## Required Auth Toggle

Firebase Authentication must be initialized once in the console:

1. Open the Firebase Console.
2. Go to Build > Authentication.
3. Click Get started if prompted.
4. Open the Sign-in method tab.
5. Enable Email/Password.

After that, sign-up and sign-in from the deployed app will work.

## GitHub Deployment

This repository includes a GitHub Actions workflow at `.github/workflows/firebase-hosting.yml`.
Pull requests run lint, tests, build and a `firebase deploy --dry-run`. Pushes to `main`
deploy Firebase Hosting plus Firestore rules/indexes (deploys are serialized; other branches never deploy).

**No repository secrets are needed.** The workflow authenticates with Workload Identity Federation:
GitHub's OIDC token is exchanged for short-lived credentials of the
`github-deployer@project-dc59a57a-442b-4b6a-a3f.iam.gserviceaccount.com` service account
(roles: Hosting admin, Rules admin, Datastore index admin, Firebase viewer, Service usage consumer).
The pool `github` / provider `expense-tracker` only accepts tokens from `Riddhesh2099/expense_tracker`.
The Firebase web config (`VITE_FIREBASE_*`) is public by design and is set in the workflow `env`.

Keep your local `.env` out of git; it is ignored intentionally.

Run the unit tests with `npm test` (Node's built-in runner; needs Node 22.18+ for TypeScript).

## Cost Notes

This app is designed to stay inside Firebase/GCP free-tier usage for personal use. Firestore is used instead of Cloud SQL because a managed relational database is usually where the always-free story breaks down.

Watch these areas if usage grows:

- Firestore document reads from dashboards and charts
- Hosting bandwidth
- Authentication usage
- Storage if receipt uploads are added later
