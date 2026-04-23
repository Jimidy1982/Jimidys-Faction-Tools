const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const p = path.join(root, 'tools/consumption-tracker/consumption-tracker.js');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const chunk = lines.slice(806, 1443).join('\n');
const pairs = [
    ['consumptionFetchTornApiInChunks', 'mprWcFetchTornApiInChunks'],
    ['consumptionNormalizeRankedWarsArray', 'mprWcNormalizeRankedWarsArray'],
    ['consumptionWarOverlapsRange', 'mprWcWarOverlapsRange'],
    ['consumptionWarMemberRespectLike', 'mprWcWarMemberRespectLike'],
    ['consumptionEnsureHitRow', 'mprWcEnsureHitRow'],
    ['consumptionCollectEnemyMemberIdsFromWarReports', 'mprWcCollectEnemyMemberIdsFromWarReports'],
    ['consumptionNormalizedChainBonusList', 'mprWcNormalizedChainBonusList'],
    ['consumptionParseTornNumeric', 'mprWcParseTornNumeric'],
    ['consumptionChainBonusExtraRespect', 'mprWcChainBonusExtraRespect'],
    ['consumptionAttackerChainRespectTotal', 'mprWcAttackerChainRespectTotal'],
    ['consumptionNormalizedChainAttackersList', 'mprWcNormalizedChainAttackersList'],
    ['consumptionChainParticipantHitCounts', 'mprWcChainParticipantHitCounts'],
    ['consumptionChainParticipantMemberId', 'mprWcChainParticipantMemberId'],
    ['consumptionNormalizedChainParticipantsList', 'mprWcNormalizedChainParticipantsList'],
    ['consumptionGetChainReportObject', 'mprWcGetChainReportObject'],
    ['consumptionTornChainReportLookupId', 'mprWcTornChainReportLookupId'],
    ['consumptionBuildWarChainFetchDebug', 'mprWcBuildWarChainFetchDebug'],
    ['consumptionMergeChainReportsIntoHits', 'mprWcMergeChainReportsIntoHits'],
    ['consumptionMergeWarReportsIntoHits', 'mprWcMergeWarReportsIntoHits'],
    ['consumptionFetchWarChainHitsForRange', 'mprFetchWarChainHitsForRange'],
    ['consumptionTornFetchUrl', 'mprWcTornFetchUrl']
];
let out = chunk;
for (const [a, b] of pairs) out = out.split(a).join(b);
const header = `/** Ranked war + chain report merge for Member Performance (not part of consumption tracker). */
function mprWcTornFetchUrl(url) {
    return typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
}

`;
const footer = '\nwindow.factionToolsFetchWarChainHitsForRange = mprFetchWarChainHitsForRange;\n';
const outPath = path.join(root, 'tools/member-performance-range/mpr-war-chain-hits.js');
fs.writeFileSync(outPath, header + out + footer);
console.log('Wrote', outPath);
