/**
 * Audit trackedFactionKeys/_registry (+ legacy per-faction docs if any).
 * Run from project root: node scripts/inspect-tracked-faction-keys.js
 * Optional: --empty-only  (only rows with no API keys)
 * Requires: firebase login (uses your Firebase CLI session).
 */
const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));

const KEYS_COL = 'trackedFactionKeys';
const REGISTRY_ID = '_registry';
const FACTIONS_COL = 'trackedFactions';

async function ensureFirebaseCliCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const npmRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'firebase-tools')
    : null;
  if (!npmRoot || !fs.existsSync(npmRoot)) {
    throw new Error('Firebase CLI not found. Install: npm install -g firebase-tools, then run: firebase login');
  }
  const auth = require(path.join(npmRoot, 'lib', 'auth'));
  const defaultCredentials = require(path.join(npmRoot, 'lib', 'defaultCredentials'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) {
    throw new Error('Not logged in. Run: firebase login');
  }
  const credPath = await defaultCredentials.getCredentialPathAsync(account);
  if (!credPath) {
    throw new Error('Could not build credentials from firebase login. Run: firebase login');
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
}

async function main() {
  const emptyOnly = process.argv.includes('--empty-only');

  await ensureFirebaseCliCredentials();

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'jimidy-s-faction-tools' });
  }
  const db = admin.firestore();

  const [registrySnap, keysSnap, factionsSnap] = await Promise.all([
    db.collection(KEYS_COL).doc(REGISTRY_ID).get(),
    db.collection(KEYS_COL).get(),
    db.collection(FACTIONS_COL).get(),
  ]);

  const legacyDocs = keysSnap.docs.filter((d) => d.id !== REGISTRY_ID);
  const registryFactions =
    registrySnap.exists && registrySnap.data().factions ? registrySnap.data().factions : {};

  const rows = [];
  for (const [fid, entry] of Object.entries(registryFactions)) {
    const keys = (entry && entry.keys) || [];
    const keyCount = Array.isArray(keys) ? keys.length : 0;
    if (emptyOnly && keyCount > 0) continue;
    rows.push({
      factionId: fid,
      keyCount,
      addedAt: entry && entry.addedAt != null ? Number(entry.addedAt) : null,
      source: 'registry',
    });
  }

  legacyDocs.forEach((doc) => {
    const keys = (doc.data() && doc.data().keys) || [];
    const keyCount = Array.isArray(keys) ? keys.length : 0;
    if (emptyOnly && keyCount > 0) return;
    rows.push({
      factionId: doc.id,
      keyCount,
      addedAt: null,
      source: 'legacy doc',
    });
  });

  factionsSnap.docs.forEach((doc) => {
    if (registryFactions[doc.id] || legacyDocs.some((k) => k.id === doc.id)) return;
    if (emptyOnly) return;
    const d = doc.data() || {};
    rows.push({
      factionId: doc.id,
      keyCount: 0,
      addedAt: d.addedAt != null ? Number(d.addedAt) : null,
      orphanTrackedFactions: true,
    });
  });

  rows.sort((a, b) => a.keyCount - b.keyCount || String(a.factionId).localeCompare(String(b.factionId)));

  const totalKeys = rows.reduce((n, r) => n + r.keyCount, 0);
  const emptyRows = rows.filter((r) => r.keyCount === 0);
  const factionCount = Object.keys(registryFactions).length;

  console.log('--- trackedFactionKeys audit ---');
  console.log('Registry doc exists:', registrySnap.exists);
  console.log('Factions in _registry:', factionCount);
  console.log('Legacy per-faction docs:', legacyDocs.length);
  console.log('trackedFactions docs (legacy):', factionsSnap.size);
  console.log('Listed rows:', rows.length, emptyOnly ? '(empty only)' : '');
  console.log('Empty key rows:', emptyRows.length);
  console.log('Total registered API keys:', totalKeys);
  console.log('');
  console.log('Reads per sampleActivity tick (approx):', registrySnap.exists ? 1 : legacyDocs.length || 1);
  console.log('Reads per day (288 ticks):', (registrySnap.exists ? 1 : legacyDocs.length || 1) * 288);
  console.log('');

  rows.forEach((r) => {
    const added =
      r.addedAt != null && Number.isFinite(r.addedAt)
        ? new Date(r.addedAt).toISOString().slice(0, 10)
        : '—';
    const tag = r.orphanTrackedFactions ? ' [orphan trackedFactions]' : r.source === 'legacy doc' ? ' [legacy]' : '';
    const emptyTag = r.keyCount === 0 ? ' <-- empty' : '';
    console.log(
      String(r.factionId).padEnd(10) +
        '  keys: ' +
        String(r.keyCount).padStart(3) +
        '  added: ' +
        added +
        emptyTag +
        tag
    );
  });

  if (legacyDocs.length > 0) {
    console.log('');
    console.log('Legacy docs (migrate on next sampleActivity or addTrackedFaction):');
    legacyDocs.forEach((d) => console.log('  ', d.id));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
