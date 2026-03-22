# Activity tracker backend (Cloud Functions)

**Per-user API keys:** Each user registers their own Torn API key when they add a faction in the War Dashboard. The backend stores one key per (faction, user) and uses any stored key per faction when sampling. No shared `.env` key needed.

## Requirements

- Firebase **Blaze** plan.

## Deploy

From the **project root**:

```bash
npm install --prefix functions
firebase deploy --only firestore,functions
```

## What runs

1. **addTrackedFaction** (**HTTP / Gen2 `onRequest`**, callable-shaped JSON) – `POST` body `{"data":{ factionId, apiKey, userId, tornPlayerId? }}`. Optional **`tornPlayerId`** (Torn player id) ties registrations to your account across origins (localhost vs GitHub) and updates **`activityRegistrationsByPlayer/{playerId}`**.

2. **removeTrackedFaction** – Same pattern; body `{"data":{ factionId, userId, tornPlayerId? }}`.

3. **listMyActivityFactions** – Body `{"data":{ userId?, tornPlayerId?, apiKey? }}` (at least one required). Optional **`apiKey`**: verified with Torn; must match **`tornPlayerId`** if both sent. Migrates legacy key rows (same stored API key, no `tornPlayerId`) and updates **`activityRegistrationsByPlayer`**. Returns `{"result":{ factionIds: string[] }}`.

4. **sampleActivity** (scheduled, every 5 minutes) – Reads `trackedFactionKeys` (one doc per faction, each with a `keys` array). For each faction, uses the first stored key, calls the Torn API for members, and writes one batched doc to `activitySamples` with `{ t, factions: { [factionId]: { onlineIds } } }`. **`onlineIds` includes only `last_action.status === "online"`** (idle is excluded). Deletes samples older than 7 days.

## Changing a function’s type (callable ↔ HTTP)

Firebase does not allow in-place conversion. Delete first, then deploy:

`firebase functions:delete addTrackedFaction removeTrackedFaction --region us-central1 --force`

## Verify

- In Firebase Console → **Functions**, you should see `addTrackedFaction`, `removeTrackedFaction`, `listMyActivityFactions`, and `sampleActivity`.
- Add a faction in the War Dashboard (with your API key set in the sidebar). After a few minutes, check Firestore → `activitySamples` for new docs.

## Local dev (Vite, Live Server, etc.)

If the browser shows **CORS** / **preflight** errors for callables from `http://localhost:…`, Gen2 **callables** need **`invoker: 'public'` and explicit `cors` on each `onCall`** (global `setGlobalOptions({ invoker })` is not enough for callables). This repo uses **`callableOpts()`** in `index.js`. Redeploy after changes.

**Firestore “default location” (e.g. London)** only affects where Firestore data lives. **Cloud Functions** for this project are deployed to **`us-central1`** (`setGlobalOptions({ region })` + `firebase-config.js` pins the client to `us-central1`).

The Chrome message *“A listener indicated an asynchronous response…”* is almost always a **browser extension**, not this app.
