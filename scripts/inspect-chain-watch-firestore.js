/**
 * Inspect factionChainWatch docs in Firestore (active + archives).
 * Run from project root: node scripts/inspect-chain-watch-firestore.js [factionId]
 * Requires: firebase login (or GOOGLE_APPLICATION_CREDENTIALS).
 */
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));

const COLLECTION = 'factionChainWatch';
const ARCHIVED = 'archived';

function countSignups(slots) {
  if (!slots || typeof slots !== 'object') return 0;
  let n = 0;
  const samples = [];
  Object.keys(slots).forEach((key) => {
    const arr = slots[key] || [];
    n += arr.length;
    arr.forEach((w) => {
      if (samples.length < 8) {
        samples.push({
          slot: key,
          playerId: w.playerId,
          name: w.name,
          col: w.col,
        });
      }
    });
  });
  return { count: n, samples };
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'jimidy-s-faction-tools' });
  }
  const db = admin.firestore();
  const onlyFid = process.argv[2] ? String(process.argv[2]).trim() : null;

  const col = db.collection(COLLECTION);
  const snap = onlyFid ? await col.doc(onlyFid).get() : await col.get();

  const docs = onlyFid ? (snap.exists ? [snap] : []) : snap.docs;

  if (!docs.length) {
    console.log('No factionChainWatch documents found' + (onlyFid ? ' for ' + onlyFid : '') + '.');
    process.exit(0);
  }

  for (const doc of docs) {
    const fid = doc.id;
    const d = doc.data() || {};
    const settings = d.settings || {};
    const active = countSignups(d.slots);
    const updated =
      d.updatedAt && typeof d.updatedAt.toDate === 'function'
        ? d.updatedAt.toDate().toISOString()
        : '—';

    console.log('\n=== ACTIVE factionChainWatch/' + fid + ' ===');
    console.log('chainName:', settings.chainName || '(none)');
    console.log('chainStartUnix:', settings.chainStartUnix);
    console.log('chainTarget:', settings.chainTarget);
    console.log('backupColumns:', settings.backupColumns);
    console.log('updatedAt:', updated);
    console.log('signupCount:', active.count);
    if (active.samples.length) {
      console.log('sample signups:', JSON.stringify(active.samples, null, 2));
    }

    const archSnap = await col.doc(fid).collection(ARCHIVED).orderBy('archivedAt', 'desc').get();
    console.log('archives:', archSnap.size);
    archSnap.docs.forEach((a, i) => {
      const ad = a.data() || {};
      const ac = countSignups(ad.slots);
      const at =
        ad.archivedAt && typeof ad.archivedAt.toDate === 'function'
          ? ad.archivedAt.toDate().toISOString()
          : '—';
      console.log(
        '  [' +
          i +
          '] ' +
          a.id +
          ' | ' +
          (ad.settings && ad.settings.chainName ? ad.settings.chainName : 'Chain watch') +
          ' | archived ' +
          at +
          ' | signups ' +
          ac.count +
          (ad.archiveReason ? ' | reason ' + ad.archiveReason : '')
      );
      if (ac.count > 0 && ac.samples.length) {
        console.log('      sample:', JSON.stringify(ac.samples.slice(0, 3)));
      }
    });
  }

  console.log('\nDone. If active signupCount is 0 but an archive has signups, use Restore in the app.');
  console.log('If all are 0, recovery needs Firestore point-in-time recovery (GCP Console) or a browser session cache.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
