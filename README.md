# Expense Tracker on GCP/Firebase

A mobile-first expense tracker backed by Firebase Authentication and Cloud Firestore.

## Features

- Email/password sign up and sign in
- Add expenses from mobile or desktop
- Manage categories
- Filter by search, date range, and category
- Sort by date, amount, or title
- Monthly and category charts
- Firebase Hosting deployment config
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
When pushed to `main`, it can lint, build, and deploy Firebase Hosting plus Firestore rules/indexes.

Add these repository secrets in GitHub before relying on automatic deploys:

```text
FIREBASE_PROJECT_ID=project-dc59a57a-442b-4b6a-a3f
FIREBASE_SERVICE_ACCOUNT_JSON=<full service account JSON>
VITE_FIREBASE_API_KEY=<Firebase web API key>
VITE_FIREBASE_AUTH_DOMAIN=project-dc59a57a-442b-4b6a-a3f.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=project-dc59a57a-442b-4b6a-a3f
VITE_FIREBASE_STORAGE_BUCKET=project-dc59a57a-442b-4b6a-a3f.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=767682202840
VITE_FIREBASE_APP_ID=1:767682202840:web:678481c0d30cb04e5ddbad
```

Keep local copies of `.env` and `.secrets/firebase-service-account.json` out of git. They are ignored intentionally.

## Cost Notes

This app is designed to stay inside Firebase/GCP free-tier usage for personal use. Firestore is used instead of Cloud SQL because a managed relational database is usually where the always-free story breaks down.

Watch these areas if usage grows:

- Firestore document reads from dashboards and charts
- Hosting bandwidth
- Authentication usage
- Storage if receipt uploads are added later
