const assert = require('assert');
const L = require('./attack-grouping-logic.js');

function members(ids, stats) {
    return ids.map(function (id, i) {
        return { id: id, name: 'P' + id, stat: stats[i] };
    });
}

const people = members(
    ['1', '2', '3', '4', '5', '6', '7'],
    [700, 600, 500, 400, 300, 200, 100]
);
const bs = {};
people.forEach(function (p) { bs[p.id] = p.stat; });

const split = L.equalSplit(people, bs, 5);
assert.deepStrictEqual(split.map(function (t) { return t.length; }), [2, 2, 1, 1, 1]);
assert.deepStrictEqual(split[0], ['1', '2']);
assert.deepStrictEqual(split[4], ['7']);

const ranges = [
    { min: 500, max: null },
    { min: 200, max: 499 },
    { min: null, max: 199 }
];
const applied = L.applyRanges(people, bs, ranges);
assert.deepStrictEqual(applied.tiers[0], ['1', '2', '3']);
assert.deepStrictEqual(applied.tiers[1], ['4', '5', '6']);
assert.deepStrictEqual(applied.tiers[2], ['7']);
assert.deepStrictEqual(applied.unassigned, []);

const noStat = L.applyRanges([{ id: '9', name: 'Z' }], {}, [{ min: null, max: null }]);
assert.deepStrictEqual(noStat.unassigned, ['9']);

assert.strictEqual(L.parseStatInput('1.5b'), 1.5e9);
assert.strictEqual(L.parseStatInput('500m'), 5e8);
assert.strictEqual(L.parseStatInput(''), null);
assert.strictEqual(L.parseStatInput('nope'), null);
assert.strictEqual(L.formatStat(1.5e9), '1.5b');
assert.strictEqual(L.formatStat(3.24e9), '3.2b');
assert.strictEqual(L.formatStat(320.4e6), '320m');
assert.strictEqual(L.formatStat(1500), '2k');
assert.strictEqual(L.clampTierCount(99), 10);
assert.strictEqual(L.clampTierCount(0), 1);

const defaults = L.defaultRanges(people, bs, 5);
assert.strictEqual(defaults.length, 5);
assert.ok(defaults[0].min != null);
assert.strictEqual(defaults[4].min, null);

const resized = L.resizeSide({ method: 'manual', ranges: [{ min: 1, max: 2 }], tiers: [['1'], ['2']] }, 1);
assert.strictEqual(resized.tiers.length, 1);
assert.deepStrictEqual(resized.tiers[0], ['1']);

console.log('attack-grouping-logic tests passed');
