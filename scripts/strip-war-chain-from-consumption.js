const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const p = path.join(root, 'tools/consumption-tracker/consumption-tracker.js');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
// Remove lines 807–1454 (1-based): war/chain fetch + merge + apply (0-based 806..1453)
const before = lines.slice(0, 806);
const after = lines.slice(1454);
fs.writeFileSync(p, [...before, ...after].join('\n'));
console.log('Removed', 1454 - 806, 'lines from consumption-tracker.js');
