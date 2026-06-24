/**
 * Remove stale entries from trackedFactionKeys/_registry (same rules as sampleActivity).
 * Dry run by default. Pass --apply to update Firestore.
 *
 *   node scripts/prune-stale-tracked-faction-keys.js
 *   node scripts/prune-stale-tracked-faction-keys.js --apply
 */
const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));

const KEYS_COL = 'trackedFactionKeys';
const REGISTRY_ID = '_registry';
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

async function ensureFirebaseCliCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const npmRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'firebase-tools')
    : null;
  if (!npmRoot || !fs.existsSync(npmRoot)) {
    throw new Error('Run: firebase login');
  }
  const auth = require(path.join(npmRoot, 'lib', 'auth'));
  const defaultCredentials = require(path.join(npmRoot, 'lib', 'defaultCredentials'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Run: firebase login');
  const credPath = await defaultCredentials.getCredentialPathAsync(account);
  if (!credPath) throw new Error('Run: firebase login');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
}

function lastActiveMs(entry) {
  const n = entry && entry.lastActiveAt != null ? Number(entry.lastActiveAt) : 0;
  return Number.isFinite(n) ? n : 0;
}

function activeKeys(keys, now) {
  const cutoff = now - STALE_MS;
  return (keys || []).filter((e) => lastActiveMs(e) >= cutoff);
}

function normalizeFactions(factions) {
  const out = {};
  for (const [fid, entry] of Object.entries(factions || {})) {
    const keys = entry && Array.isArray(entry.keys) ? entry.keys : [];
    if (!keys.length) continue;
    out[fid] = { keys, ...(entry.addedAt != null ? { addedAt: entry.addedAt } : {}) };
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await ensureFirebaseCliCredentials();
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'jimidy-s-faction-tools' });
  }
  const db = admin.firestore();
  const now = Date.now();
  const ref = db.collection(KEYS_COL).doc(REGISTRY_ID);
  const snap = await ref.get();

  if (!snap.exists) {
    console.log('No _registry doc — nothing to prune.');
    return;
  }

  const factions = snap.data().factions || {};
  let factionsTouched = 0;
  let keysRemoved = 0;
  const next = {};

  for (const [fid, entry] of Object.entries(factions)) {
    const before = entry.keys || [];
    const after = activeKeys(before, now);
    if (after.length === before.length) {
      next[fid] = entry;
      continue;
    }
    keysRemoved += before.length - after.length;
    factionsTouched++;
    console.log(
      fid + ': ' + before.length + ' keys -> ' + after.length + (after.length === 0 ? ' (drop faction)' : '')
    );
    if (after.length) {
      next[fid] = { keys: after, ...(entry.addedAt != null ? { addedAt: entry.addedAt } : {}) };
    }
  }

  const cleaned = normalizeFactions(next);

  console.log('');
  console.log('--- summary ---');
  console.log('Mode:', apply ? 'APPLY (written)' : 'DRY RUN (no changes)');
  console.log('Factions in registry:', Object.keys(factions).length);
  console.log('Factions with stale keys:', factionsTouched);
  console.log('Keys removed:', keysRemoved);
  console.log('Factions after prune:', Object.keys(cleaned).length);

  if (!apply || !factionsTouched) return;

  if (!Object.keys(cleaned).length) {
    await ref.delete();
    console.log('Registry doc deleted (empty).');
  } else {
    await ref.set({ factions: cleaned, updatedAt: Date.now() });
    console.log('Registry updated.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
