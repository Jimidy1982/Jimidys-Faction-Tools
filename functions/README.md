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

1. **addTrackedFaction** (Callable) – Frontend calls this when a user adds a faction (Load or current war). Sends `factionId`, the user’s `apiKey`, and a persistent `userId`. Backend stores the key in `trackedFactionKeys/{factionId}` and ensures the faction is in `trackedFactions`.

2. **removeTrackedFaction** (Callable) – Frontend calls when a user removes a faction. Sends `factionId` and `userId`. Backend removes that user’s key for the faction; if no keys remain, the faction is removed from tracking.

3. **sampleActivity** (scheduled, every 5 minutes) – Reads `trackedFactionKeys` (one doc per faction, each with a `keys` array). For each faction, uses the first stored key, calls the Torn API for members, and writes one batched doc to `activitySamples` with `{ t, factions: { [factionId]: { onlineIds } } }`. Deletes samples older than 7 days.

## Verify

- In Firebase Console → **Functions**, you should see `addTrackedFaction`, `removeTrackedFaction`, and `sampleActivity`.
- Add a faction in the War Dashboard (with your API key set in the sidebar). After a few minutes, check Firestore → `activitySamples` for new docs.
