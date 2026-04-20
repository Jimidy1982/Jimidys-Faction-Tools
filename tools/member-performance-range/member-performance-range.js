/**
 * Member Performance — OC score (same participation formula as Organised Crime Stats),
 * war/outside hits (Consumption Tracker logic), activity hours (timeplayed delta), consumption cost.
 */
(function () {
    'use strict';

    const MPR_CONSUMPTION_KEYS = [
        { id: 'xanax', itemName: 'Xanax', isPoints: false },
        { id: 'vicodin', itemName: 'Vicodin', isPoints: false },
        { id: 'ketamine', itemName: 'Ketamine', isPoints: false },
        { id: 'speed', itemName: 'Speed', isPoints: false },
        { id: 'shrooms', itemName: 'Shrooms', isPoints: false },
        { id: 'cannabis', itemName: 'Cannabis', isPoints: false },
        { id: 'pcp', itemName: 'PCP', isPoints: false },
        { id: 'opium', itemName: 'Opium', isPoints: false },
        { id: 'ecstasy', itemName: 'Ecstasy', isPoints: false },
        { id: 'lsd', itemName: 'LSD', isPoints: false },
        { id: 'loveJuice', itemName: 'Love Juice', isPoints: false },
        { id: 'bloodbags', itemName: 'Blood Bag', isPoints: false },
        { id: 'firstAidKit', itemName: 'First Aid Kit', isPoints: false },
        { id: 'smallFirstAidKit', itemName: 'Small First Aid Kit', isPoints: false },
        { id: 'morphine', itemName: 'Morphine', isPoints: false },
        { id: 'ipecacSyrup', itemName: 'Ipecac Syrup', isPoints: false },
        { id: 'beer', itemName: 'Bottle of Beer', isPoints: false },
        { id: 'lollipop', itemName: 'Lollipop', isPoints: false },
        { id: 'sweetHearts', itemName: 'Box of Sweet Hearts', isPoints: false },
        { id: 'gooseJuice', itemName: 'Can of Goose Juice', isPoints: false },
        { id: 'dampValley', itemName: 'Can of Damp Valley', isPoints: false },
        { id: 'crocozade', itemName: 'Can of Crocozade', isPoints: false },
        { id: 'santaShooters', itemName: 'Can of Santa Shooters', isPoints: false },
        { id: 'munster', itemName: 'Can of Munster', isPoints: false },
        { id: 'redCow', itemName: 'Can of Red Cow', isPoints: false },
        { id: 'rockstarRudolph', itemName: 'Can of Rockstar Rudolph', isPoints: false },
        { id: 'taurineElite', itemName: 'Can of Taurine Elite', isPoints: false },
        { id: 'xmass', itemName: 'Can of X-MASS', isPoints: false },
        { id: 'points', itemName: 'Points', isPoints: true }
    ];

    let mprSortState = { column: 'crimeScore', direction: 'desc' };
    let mprLastRows = [];

    const MPR_LS_FACTION_CUT = 'mprFactionCutPercent';
    const MPR_ACTIVITY_RETRY_DELAY_MS = 2000;

    const MPR_CHECKLIST_STEPS = [
        { id: 'members', label: 'Faction members (v2)' },
        { id: 'crimes', label: 'Completed crimes in date range (OC)' },
        { id: 'items', label: 'Item market values + points market' },
        { id: 'news', label: 'Faction armory news (consumption)' },
        { id: 'war', label: 'Ranked wars & chain reports (hits)' },
        { id: 'activity', label: 'Activity (timeplayed snapshots)' }
    ];

    function mprGetProgressEls() {
        return {
            progressMessage: document.getElementById('mprProgressMessage'),
            progressDetails: document.getElementById('mprProgressDetails'),
            progressPercentage: document.getElementById('mprProgressPercentage'),
            progressFill: document.getElementById('mprProgressFill')
        };
    }

    function mprChecklistEnsure() {
        const ul = document.getElementById('mprChecklist');
        if (!ul) return null;
        if (!ul.dataset.mprBuilt) {
            ul.innerHTML = MPR_CHECKLIST_STEPS.map(
                s => `<li data-mpr-step="${s.id}" class="mpr-check mpr-check--pending">${mprEscapeHtml(s.label)}</li>`
            ).join('');
            ul.dataset.mprBuilt = '1';
        }
        return ul;
    }

    function mprChecklistReset() {
        const ul = mprChecklistEnsure();
        if (!ul) return;
        ul.querySelectorAll('[data-mpr-step]').forEach(li => {
            li.className = 'mpr-check mpr-check--pending';
        });
    }

    function mprChecklistSet(stepId, status) {
        const ul = document.getElementById('mprChecklist');
        if (!ul) return;
        const li = ul.querySelector(`[data-mpr-step="${stepId}"]`);
        if (!li) return;
        const label = MPR_CHECKLIST_STEPS.find(s => s.id === stepId);
        const text = label ? label.label : stepId;
        li.className = 'mpr-check mpr-check--' + status;
        li.textContent = text;
    }

    /** Same rate limits & countdown UX as the welcome panel (fetchWithRateLimit). */
    async function mprApiJson(url, progressEls) {
        const els = progressEls || mprGetProgressEls();
        if (typeof window.fetchWithRateLimit === 'function') {
            return window.fetchWithRateLimit(url, {
                progressMessage: els.progressMessage,
                progressDetails: els.progressDetails,
                retryOnRateLimit: true
            });
        }
        const tornUrl = typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
        const res = await fetch(tornUrl);
        return res.json();
    }

    function mprParseUnixLoose(val) {
        if (val == null || val === '') return null;
        if (typeof val === 'number' && !isNaN(val) && val > 1e9 && val < 2e10) return Math.floor(val);
        const s = String(val).trim();
        const digits = parseInt(s.replace(/\D/g, '') || '0', 10);
        if (!isNaN(digits) && digits > 1e9 && digits < 2e10) return digits;
        return null;
    }

    /** Days in current faction from API fields when present, else from faction join timestamp. */
    function mprDaysInFaction(member, nowTs) {
        const n = Math.floor(Number(nowTs) || Date.now() / 1000);
        if (!member || typeof member !== 'object') return null;
        const direct =
            member.days_in_faction ??
            member.days_in_faction_member ??
            (member.faction && (member.faction.days_in_faction ?? member.faction.days_in_faction_member));
        if (direct != null && String(direct).trim() !== '') {
            const d = parseInt(String(direct).replace(/[^\d-]/g, ''), 10);
            if (!isNaN(d) && d >= 0 && d < 50000) return d;
        }
        const joined =
            mprParseUnixLoose(member.joined_faction) ||
            mprParseUnixLoose(member.faction && member.faction.joined) ||
            mprParseUnixLoose(member.faction && member.faction.timestamp);
        if (joined != null) return Math.max(0, Math.floor((n - joined) / 86400));
        return null;
    }

    /** From v2/faction/members `last_action` (same fields as War Dashboard / battle stats). */
    function mprFormatRelativeFromUnixSeconds(ts) {
        const now = Math.floor(Date.now() / 1000);
        const diff = Math.max(0, now - ts);
        const days = Math.floor(diff / 86400);
        if (days === 0) return 'Today';
        if (days === 1) return '1 day ago';
        return `${days} days ago`;
    }

    function mprLastOnlineFromMember(m) {
        const la = (m && m.last_action) || {};
        const ts = la.timestamp != null ? Number(la.timestamp) : null;
        const tsOk = ts != null && !isNaN(ts) && ts > 0;
        const relative = la.relative != null ? String(la.relative).trim() : '';
        const statusRaw = la.status != null ? String(la.status).trim() : '';
        const status = statusRaw.toLowerCase();
        let display = relative;
        if (!display && tsOk) display = mprFormatRelativeFromUnixSeconds(ts);
        if (!display && statusRaw) display = statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1).toLowerCase();
        if (!display) display = '—';
        let sortVal = tsOk ? ts : 0;
        if (!tsOk && (status === 'online' || status === 'idle')) sortVal = Math.floor(Date.now() / 1000);
        const title = tsOk ? mprFormatTctUtc(ts) : (relative || statusRaw || '').trim();
        return { sortVal, display, title };
    }

    function mprParseYmd(ymd) {
        if (!ymd || typeof ymd !== 'string') return null;
        const p = ymd.split('-').map(Number);
        if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null;
        return { y: p[0], m: p[1] - 1, d: p[2] };
    }

    function mprClampInt(n, lo, hi, fallback) {
        const x = Math.floor(Number(n));
        if (!Number.isFinite(x)) return fallback;
        return Math.max(lo, Math.min(hi, x));
    }

    function mprTctInstantUnix(ymd, hour, minute, second) {
        const parts = mprParseYmd(ymd);
        if (!parts) return null;
        const h = mprClampInt(hour, 0, 23, 0);
        const m = mprClampInt(minute, 0, 59, 0);
        const s = mprClampInt(second, 0, 59, 0);
        return Math.floor(Date.UTC(parts.y, parts.m, parts.d, h, m, s) / 1000);
    }

    function mprFormatTctUtc(ts) {
        return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' TCT';
    }

    function mprUtcYmd() {
        const t = new Date();
        const y = t.getUTCFullYear();
        const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
        const d = String(t.getUTCDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
    }

    /** `daysInclusive` calendar days in TCT ending today, matching full-day fetch bounds. */
    function mprApplyQuickRangeDaysInclusive(daysInclusive) {
        const n = Math.min(366, Math.max(1, Math.floor(Number(daysInclusive)) || 1));
        const now = new Date();
        const y = now.getUTCFullYear();
        const mo = now.getUTCMonth();
        const d = now.getUTCDate();
        const endUtc = new Date(Date.UTC(y, mo, d));
        const startUtc = new Date(Date.UTC(y, mo, d));
        startUtc.setUTCDate(startUtc.getUTCDate() - (n - 1));
        const toYmd = dt => dt.toISOString().slice(0, 10);
        const endYmd = toYmd(endUtc);
        const startYmd = toYmd(startUtc);
        const startInput = document.getElementById('mprStartDate');
        const endInput = document.getElementById('mprEndDate');
        if (startInput) {
            if (startInput._flatpickr) startInput._flatpickr.setDate(startYmd, false);
            else startInput.value = startYmd;
        }
        if (endInput) {
            if (endInput._flatpickr) endInput._flatpickr.setDate(endYmd, false);
            else endInput.value = endYmd;
        }
    }

    function mprEscapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Same participation scoring as Organised Crime Stats (difficulty × participants/6 per slot),
     * without reward/cost side tables.
     */
    function mprProcessCrimeScoresOnly(crimes, playerNames, currentMemberIds) {
        const playerMap = {};
        currentMemberIds.forEach(memberId => {
            playerMap[memberId] = {
                id: memberId,
                name: playerNames[memberId] || `Player ${memberId}`,
                totalParticipations: 0,
                successfulParticipations: 0,
                failedParticipations: 0,
                highestDifficultySucceeded: 0,
                totalScore: 0,
                successRate: 0,
                difficultyBreakdown: {},
                difficultyCrimeTypeBreakdown: {}
            };
            for (let i = 1; i <= 10; i++) {
                playerMap[memberId].difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
            }
        });

        crimes.forEach(crime => {
            const difficulty = crime.difficulty;
            let hasCurrentMember = false;
            if (crime.slots && Array.isArray(crime.slots)) {
                hasCurrentMember = crime.slots.some(
                    slot => slot.user && slot.user.id && currentMemberIds.has(slot.user.id.toString())
                );
            }
            if (!hasCurrentMember) return;

            const crimeName =
                crime.crime_name ??
                crime.name ??
                crime.title ??
                'Crime #' + (crime.crime_id ?? crime.type ?? 'unknown');
            const crimeTypeKey = String(crimeName).trim().toLowerCase();

            if (!crime.slots || !Array.isArray(crime.slots)) return;

            crime.slots.forEach(slot => {
                if (!slot.user || !slot.user.id) return;
                const playerId = slot.user.id.toString();
                if (!currentMemberIds.has(playerId)) return;

                let pm = playerMap[playerId];
                if (!pm) {
                    pm = {
                        id: playerId,
                        name: playerNames[playerId] || `Player ${playerId}`,
                        totalParticipations: 0,
                        successfulParticipations: 0,
                        failedParticipations: 0,
                        highestDifficultySucceeded: 0,
                        totalScore: 0,
                        successRate: 0,
                        difficultyBreakdown: {},
                        difficultyCrimeTypeBreakdown: {}
                    };
                    for (let i = 1; i <= 10; i++) {
                        pm.difficultyBreakdown[i] = { successful: 0, failed: 0, total: 0 };
                    }
                    playerMap[playerId] = pm;
                }

                pm.totalParticipations++;
                const totalParticipants = crime.slots.length;
                const participationRatio = totalParticipants / 6;
                const participationScore = Math.round(difficulty * participationRatio);
                pm.totalScore += participationScore;

                if (pm.difficultyBreakdown[difficulty]) {
                    pm.difficultyBreakdown[difficulty].total++;
                    if (slot.user.outcome === 'Successful') {
                        pm.difficultyBreakdown[difficulty].successful++;
                    } else {
                        pm.difficultyBreakdown[difficulty].failed++;
                    }
                }

                if (!pm.difficultyCrimeTypeBreakdown[difficulty]) {
                    pm.difficultyCrimeTypeBreakdown[difficulty] = {};
                }
                const pct = pm.difficultyCrimeTypeBreakdown[difficulty];
                if (!pct[crimeTypeKey]) {
                    pct[crimeTypeKey] = { crimeName, total: 0, successful: 0, failed: 0 };
                }
                pct[crimeTypeKey].total++;
                if (slot.user.outcome === 'Successful') {
                    pct[crimeTypeKey].successful++;
                    pm.successfulParticipations++;
                    const diffNum = parseInt(String(difficulty), 10);
                    if (diffNum >= 1 && diffNum <= 10 && diffNum > (pm.highestDifficultySucceeded || 0)) {
                        pm.highestDifficultySucceeded = diffNum;
                    }
                } else {
                    pct[crimeTypeKey].failed++;
                    pm.failedParticipations++;
                }
            });
        });

        Object.values(playerMap).forEach(player => {
            if (player.totalParticipations > 0) {
                player.successRate = Math.round((player.successfulParticipations / player.totalParticipations) * 100);
            }
        });

        return playerMap;
    }

    function mprGetAccountStartTimestamp(member) {
        if (!member || typeof member !== 'object') return null;
        const tryUnix = val => {
            if (val == null || val === '') return null;
            const n = typeof val === 'number' ? val : parseInt(String(val).replace(/[^\d]/g, ''), 10);
            if (!isNaN(n) && n > 1e9 && n < 2e10) return Math.floor(n);
            return null;
        };
        const raw =
            member.signed_up ??
            member.sign_up ??
            member.user_joined ??
            member.signedUp ??
            member.signUp ??
            member.userJoined ??
            member.signup;
        const fromRaw = tryUnix(raw);
        if (fromRaw != null) return fromRaw;
        const basic = member.basic;
        if (basic && typeof basic === 'object') {
            const b = tryUnix(basic.signed_up ?? basic.sign_up ?? basic.user_joined ?? basic.signup);
            if (b != null) return b;
        }
        const life = member.life;
        if (life && typeof life === 'object') {
            const l = tryUnix(life.created ?? life.created_at ?? life.started);
            if (l != null) return l;
        }
        const age = member.age ?? basic?.age;
        if (age != null && age !== '') {
            const ageDays = parseInt(String(age).replace(/[^\d]/g, '') || '0', 10);
            if (!isNaN(ageDays) && ageDays >= 0 && ageDays < 10000) {
                return Math.floor(Date.now() / 1000) - ageDays * 86400;
            }
        }
        return null;
    }

    function mprEffectiveStartSnapshotTs(nominalFromTs, member) {
        const n = Math.floor(Number(nominalFromTs));
        if (isNaN(n)) return nominalFromTs;
        const start = mprGetAccountStartTimestamp(member);
        if (start != null && !isNaN(start) && start > n) return Math.floor(start);
        return n;
    }

    function mprCrimeExecutedTs(crime) {
        const t = crime.executed_at;
        if (t == null) return null;
        const n = typeof t === 'number' ? t : parseInt(String(t), 10);
        return !isNaN(n) ? n : null;
    }

    async function mprFetchCrimesInRange(apiKey, fromTs, toTs, progressEls, onProgress) {
        const all = [];
        let offset = 0;
        const limit = 100;
        let page = 0;
        let hasMore = true;

        while (hasMore && page < 50) {
            page++;
            if (onProgress) onProgress(page, all.length);
            const url = `https://api.torn.com/v2/faction/crimes?cat=completed&offset=${offset}&limit=${limit}&sort=DESC&key=${encodeURIComponent(apiKey)}`;
            const data = await mprApiJson(url, progressEls);
            if (data.error) throw new Error(data.error.error || 'Crimes API error');
            const crimes = data.crimes || [];
            if (crimes.length === 0) {
                hasMore = false;
                break;
            }
            const execTsList = crimes.map(mprCrimeExecutedTs).filter(x => x != null);
            for (const c of crimes) {
                const ex = mprCrimeExecutedTs(c);
                if (ex != null && ex >= fromTs && ex <= toTs) all.push(c);
            }
            const maxEx = execTsList.length ? Math.max(...execTsList) : null;
            if (maxEx != null && maxEx < fromTs) {
                hasMore = false;
            } else if (!data._metadata?.links?.next) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }
        return all;
    }

    async function mprFetchNewsForRange(fromTimestamp, toTimestamp, apiKey, progressEls, progressCallback) {
        const allNews = [];
        const seenEntryIds = new Set();
        let lastTimestamp = toTimestamp;
        let currentPage = 0;
        let hasMorePages = true;
        const rangeSpan = toTimestamp - fromTimestamp;

        while (hasMorePages) {
            currentPage++;
            if (currentPage > 100) break;
            const url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&to=${lastTimestamp}&from=${fromTimestamp}&cat=armoryAction&key=${encodeURIComponent(apiKey)}`;
            const newsData = await mprApiJson(url, progressEls);
            if (newsData.error) throw new Error(newsData.error.error || 'News API error');
            const news = newsData.news || [];
            if (news.length === 0) {
                hasMorePages = false;
                if (progressCallback) progressCallback(currentPage, allNews.length, 1);
            } else {
                const newEntries = news.filter(entry => {
                    const ok = entry.timestamp >= fromTimestamp && entry.timestamp <= toTimestamp;
                    const dup = seenEntryIds.has(entry.id);
                    if (ok && !dup) {
                        seenEntryIds.add(entry.id);
                        return true;
                    }
                    return false;
                });
                if (newEntries.length === 0) hasMorePages = false;
                else {
                    allNews.push(...newEntries);
                    const oldestTimestamp = Math.min(...news.map(e => e.timestamp));
                    lastTimestamp = oldestTimestamp - 1;
                    const fraction = rangeSpan > 0 ? Math.min(1, (toTimestamp - lastTimestamp) / rangeSpan) : 1;
                    if (progressCallback) progressCallback(currentPage, allNews.length, fraction);
                    if (oldestTimestamp < fromTimestamp) hasMorePages = false;
                }
            }
        }
        if (progressCallback) progressCallback(currentPage, allNews.length, 1);
        return allNews;
    }

    function mprEmptyConsumptionRow(playerId, playerName) {
        const o = {
            name: playerName,
            id: playerId
        };
        MPR_CONSUMPTION_KEYS.forEach(k => {
            o[k.id] = 0;
        });
        return o;
    }

    function mprAccumulateNewsEntry(byId, logText) {
        const playerMatch = logText.match(/<a href[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>/);
        if (!playerMatch) return;
        const playerId = playerMatch[1];
        const playerName = playerMatch[2];
        if (!byId.has(playerId)) byId.set(playerId, mprEmptyConsumptionRow(playerId, playerName));
        const row = byId.get(playerId);

        if (logText.includes("used one of the faction's Xanax items")) row.xanax++;
        else if (logText.includes("used one of the faction's Vicodin items")) row.vicodin++;
        else if (logText.includes("used one of the faction's Ketamine items")) row.ketamine++;
        else if (logText.includes("used one of the faction's Speed items")) row.speed++;
        else if (logText.includes("used one of the faction's Shrooms items")) row.shrooms++;
        else if (logText.includes("used one of the faction's Cannabis items")) row.cannabis++;
        else if (logText.includes("used one of the faction's PCP items")) row.pcp++;
        else if (logText.includes("used one of the faction's Opium items")) row.opium++;
        else if (logText.includes("used one of the faction's Ecstasy items")) row.ecstasy++;
        else if (logText.includes("used one of the faction's LSD items")) row.lsd++;
        else if (logText.includes("used one of the faction's Love Juice items")) row.loveJuice++;
        else if (
            logText.includes("used one of the faction's Blood Bag") ||
            logText.includes("used one of the faction's Empty Blood Bag")
        ) {
            row.bloodbags++;
        } else if (logText.includes("used one of the faction's First Aid Kit items") && !logText.includes('Small')) {
            row.firstAidKit++;
        } else if (logText.includes("used one of the faction's Small First Aid Kit items")) {
            row.smallFirstAidKit++;
        } else if (logText.includes("used one of the faction's Morphine items")) row.morphine++;
        else if (logText.includes("used one of the faction's Ipecac Syrup items")) row.ipecacSyrup++;
        else if (logText.includes("used one of the faction's Bottle of Beer items")) row.beer++;
        else if (logText.includes("used one of the faction's Lollipop items")) row.lollipop++;
        else if (logText.includes("used one of the faction's Box of Sweet Hearts items")) row.sweetHearts++;
        else if (logText.includes("used one of the faction's Can of Goose Juice items")) row.gooseJuice++;
        else if (logText.includes("used one of the faction's Can of Damp Valley items")) row.dampValley++;
        else if (logText.includes("used one of the faction's Can of Crocozade items")) row.crocozade++;
        else if (logText.includes("used one of the faction's Can of Santa Shooters items")) row.santaShooters++;
        else if (logText.includes("used one of the faction's Can of Munster items")) row.munster++;
        else if (logText.includes("used one of the faction's Can of Red Cow items")) row.redCow++;
        else if (logText.includes("used one of the faction's Can of Rockstar Rudolph items")) row.rockstarRudolph++;
        else if (logText.includes("used one of the faction's Can of Taurine Elite items")) row.taurineElite++;
        else if (logText.includes("used one of the faction's Can of X-MASS items")) row.xmass++;
        else if (logText.includes('used') && logText.includes("of the faction's points")) {
            const pointsMatch = logText.match(/used\s+(\d+)\s+of\s+the\s+faction's\s+points/);
            if (pointsMatch) row.points += parseInt(pointsMatch[1], 10);
        }
    }

    function mprConsumptionCostDollars(row, itemValues) {
        let sum = 0;
        for (const col of MPR_CONSUMPTION_KEYS) {
            const qty = row[col.id] || 0;
            const price = col.isPoints ? itemValues.Points || 0 : itemValues[col.itemName] || 0;
            sum += qty * price;
        }
        return sum;
    }

    function mprConsumptionDetailsHtml(row, itemValues) {
        const lines = [];
        for (const col of MPR_CONSUMPTION_KEYS) {
            const qty = row[col.id] || 0;
            if (!qty) continue;
            const price = col.isPoints ? itemValues.Points || 0 : itemValues[col.itemName] || 0;
            const sub = qty * price;
            const label = col.isPoints ? 'Points' : col.itemName;
            lines.push(`${qty}× ${mprEscapeHtml(label)} — $${Math.round(sub).toLocaleString()}`);
        }
        if (!lines.length) return '<span style="color:#888;">No armory usage in range</span>';
        return lines.join('<br>');
    }

    async function mprBuildItemValues(apiKey, progressEls) {
        const itemsUrl = `https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(apiKey)}`;
        const itemsData = await mprApiJson(itemsUrl, progressEls);
        if (itemsData.error) throw new Error(itemsData.error.error || 'Items API error');

        const itemValues = {};
        const itemNameMapping = {
            Xanax: 'Xanax',
            Vicodin: 'Vicodin',
            Ketamine: 'Ketamine',
            Speed: 'Speed',
            Shrooms: 'Shrooms',
            Cannabis: 'Cannabis',
            PCP: 'PCP',
            Opium: 'Opium',
            Ecstasy: 'Ecstasy',
            LSD: 'LSD',
            'Love Juice': 'Love Juice',
            'Blood Bag': 'Blood Bag',
            'First Aid Kit': 'First Aid Kit',
            'Small First Aid Kit': 'Small First Aid Kit',
            Morphine: 'Morphine',
            'Ipecac Syrup': 'Ipecac Syrup',
            'Bottle of Beer': 'Bottle of Beer',
            Lollipop: 'Lollipop',
            'Box of Sweet Hearts': 'Box of Sweet Hearts',
            'Can of Goose Juice': 'Can of Goose Juice',
            'Can of Damp Valley': 'Can of Damp Valley',
            'Can of Crocozade': 'Can of Crocozade',
            'Can of Santa Shooters': 'Can of Santa Shooters',
            'Can of Munster': 'Can of Munster',
            'Can of Red Cow': 'Can of Red Cow',
            'Can of Rockstar Rudolph': 'Can of Rockstar Rudolph',
            'Can of Taurine Elite': 'Can of Taurine Elite',
            'Can of X-MASS': 'Can of X-MASS'
        };

        Object.values(itemsData.items || {}).forEach(item => {
            if (!item.type || item.type === 'Weapon' || item.type === 'Armor' || item.type === 'Temporary' || item.type === 'Special') {
                return;
            }
            if (itemNameMapping[item.name]) {
                itemValues[itemNameMapping[item.name]] = item.market_value || 0;
            }
        });

        const bloodBagItems = Object.values(itemsData.items || {}).filter(
            item => item.name.includes('Blood Bag') && item.market_value > 0 && item.type && item.type !== 'Weapon' && item.type !== 'Armor'
        );
        if (bloodBagItems.length > 0) {
            const total = bloodBagItems.reduce((sum, item) => sum + item.market_value, 0);
            itemValues['Blood Bag'] = Math.round(total / bloodBagItems.length);
        }

        try {
            const pointsUrl = `https://api.torn.com/market/?selections=pointsmarket&key=${encodeURIComponent(apiKey)}`;
            const pointsMarketData = await mprApiJson(pointsUrl, progressEls);
            if (!pointsMarketData.error && pointsMarketData.pointsmarket) {
                const listings = Object.values(pointsMarketData.pointsmarket).sort((a, b) => a.cost - b.cost);
                if (listings.length >= 5) itemValues.Points = listings[4].cost;
                else if (listings.length > 0) itemValues.Points = listings[0].cost;
            }
        } catch (e) {
            console.warn('[MPR] Points market:', e);
        }

        return itemValues;
    }

    function mprExtractTimeplayed(data) {
        if (!data || data.personalstats == null) return null;
        const ps = data.personalstats;
        if (Array.isArray(ps) && ps.length > 0) {
            const item = ps[0];
            if (item && typeof item.value === 'number' && !isNaN(item.value)) return item.value;
            if (item && typeof item.value === 'string' && item.value !== '') {
                const n = parseInt(item.value, 10);
                return !isNaN(n) ? n : null;
            }
        }
        if (typeof ps === 'object' && !Array.isArray(ps) && ps.timeplayed != null) {
            const v = ps.timeplayed;
            if (typeof v === 'number' && !isNaN(v)) return v;
            if (typeof v === 'string' && v !== '') {
                const n = parseInt(v, 10);
                return !isNaN(n) ? n : null;
            }
        }
        return null;
    }

    function mprBuildMissingTimeplayedRequests(memberIds, membersById, fromTs, endTs, store, apiKey) {
        const requests = [];
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            if (!store[id]) store[id] = {};
            if (typeof store[id][endTs] !== 'number' || isNaN(store[id][endTs])) {
                requests.push({
                    playerId: id,
                    timestamp: endTs,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${endTs}&key=${encodeURIComponent(apiKey)}`
                });
            }
            if (typeof store[id][startSnap] !== 'number' || isNaN(store[id][startSnap])) {
                requests.push({
                    playerId: id,
                    timestamp: startSnap,
                    url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${startSnap}&key=${encodeURIComponent(apiKey)}`
                });
            }
        });
        return requests;
    }

    function mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store) {
        const hoursById = {};
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            const a = store[id] && store[id][endTs];
            const b = store[id] && store[id][startSnap];
            if (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) {
                const h = (a - b) / 3600;
                hoursById[id] = h >= 0 && h < 10000 && isFinite(h) ? h : null;
            } else {
                hoursById[id] = null;
            }
        });
        return hoursById;
    }

    async function mprFetchActivityHours(memberIds, membersById, fromTs, toTs, apiKey, progressEls) {
        const nowCap = Math.floor(Date.now() / 1000);
        const endTs = Math.min(toTs, nowCap);
        const store = {};
        memberIds.forEach(mid => {
            store[String(mid)] = {};
        });

        const onSuccess = (data, request) => {
            const tp = mprExtractTimeplayed(data);
            const pid = String(request.playerId);
            if (tp === null) return;
            if (!store[pid]) store[pid] = {};
            store[pid][request.timestamp] = tp;
        };

        if (typeof window.batchApiCallsWithRateLimit !== 'function') {
            console.warn('[MPR] batchApiCallsWithRateLimit missing');
            return {};
        }

        const allRequests = [];
        memberIds.forEach(mid => {
            const id = String(mid);
            const member = membersById[id];
            const startSnap = mprEffectiveStartSnapshotTs(fromTs, member);
            allRequests.push({
                playerId: id,
                timestamp: endTs,
                url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${endTs}&key=${encodeURIComponent(apiKey)}`
            });
            allRequests.push({
                playerId: id,
                timestamp: startSnap,
                url: `https://api.torn.com/v2/user/${id}/personalstats?stat=timeplayed&timestamp=${startSnap}&key=${encodeURIComponent(apiKey)}`
            });
        });

        await window.batchApiCallsWithRateLimit(allRequests, {
            progressMessage: progressEls.progressMessage,
            progressDetails: progressEls.progressDetails,
            progressPercentage: progressEls.progressPercentage,
            progressFill: progressEls.progressFill,
            progressSegmentStart: 0,
            progressSegmentWidth: 0.85,
            progressDetailsPrefix: 'Activity (timeplayed): ',
            onSuccess,
            onError: (err, req) => console.warn('[MPR] timeplayed', req && req.playerId, err)
        });

        let hoursById = mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store);
        const missingIds = memberIds.filter(mid => hoursById[String(mid)] == null).map(String);
        if (missingIds.length > 0) {
            if (progressEls.progressDetails) {
                progressEls.progressDetails.textContent = `Retrying activity for ${missingIds.length} member(s) with incomplete snapshots…`;
            }
            await new Promise(r => setTimeout(r, MPR_ACTIVITY_RETRY_DELAY_MS));
            const retryReqs = mprBuildMissingTimeplayedRequests(memberIds, membersById, fromTs, endTs, store, apiKey);
            if (retryReqs.length > 0) {
                await window.batchApiCallsWithRateLimit(retryReqs, {
                    progressMessage: progressEls.progressMessage,
                    progressDetails: progressEls.progressDetails,
                    progressPercentage: progressEls.progressPercentage,
                    progressFill: progressEls.progressFill,
                    progressSegmentStart: 0.85,
                    progressSegmentWidth: 0.15,
                    progressDetailsPrefix: 'Activity retry: ',
                    onSuccess,
                    onError: (err, req) => console.warn('[MPR] timeplayed retry', req && req.playerId, err)
                });
            }
            hoursById = mprComputeActivityHoursMap(memberIds, membersById, fromTs, endTs, store);
        }
        return hoursById;
    }

    function mprCrimeDetailsHtml(player) {
        if (!player.totalParticipations) {
            return '<span style="color:#888;">No OC in range</span>';
        }
        let inner = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;"><thead><tr><th>D</th><th>Total</th><th>OK</th><th>Fail</th><th>%</th></tr></thead><tbody>';
        for (let diff = 1; diff <= 10; diff++) {
            const br = player.difficultyBreakdown[diff];
            if (!br || !br.total) continue;
            const pct = Math.round((br.successful / br.total) * 100);
            inner += `<tr><td>${diff}</td><td>${br.total}</td><td style="color:#4ecdc4">${br.successful}</td><td style="color:#ff6b6b">${br.failed}</td><td>${pct}%</td></tr>`;
        }
        inner += '</tbody></table>';
        return inner;
    }

    function mprSortValue(row, col) {
        switch (col) {
            case 'name':
                return (row.name || '').toLowerCase();
            case 'lastOnline':
                return row.lastOnlineSort == null || row.lastOnlineSort === 0 ? -Infinity : row.lastOnlineSort;
            case 'daysInFaction':
                return row.daysInFaction == null ? -Infinity : row.daysInFaction;
            case 'crimeScore':
                return row.crimeScore;
            case 'warHits':
                return row.warHits;
            case 'outsideHits':
                return row.outsideHits;
            case 'activityHours':
                if (row.activityPending) return -Infinity;
                return row.activityHours == null ? -Infinity : row.activityHours;
            case 'consumptionCost':
                return row.consumptionCost;
            default:
                return 0;
        }
    }

    function mprRenderTable(rows) {
        const wrap = document.getElementById('mprTableWrap');
        if (!wrap) return;
        const sorted = [...rows].sort((a, b) => {
            const va = mprSortValue(a, mprSortState.column);
            const vb = mprSortValue(b, mprSortState.column);
            let c = 0;
            if (typeof va === 'string' || typeof vb === 'string') {
                c = String(va).localeCompare(String(vb));
            } else {
                c = (va || 0) - (vb || 0);
            }
            return mprSortState.direction === 'asc' ? c : -c;
        });

        const showId = typeof window.toolsGetShowMemberIdInBrackets === 'function' && window.toolsGetShowMemberIdInBrackets();
        const nameSortArrow = mprSortState.column === 'name' ? (mprSortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
        const nameHeaderClickable = `<span data-mpr-sort="name" style="cursor:pointer;color:var(--accent-color);">Member${nameSortArrow}</span>`;
        const nameThInner =
            typeof window.toolsMemberColumnHeaderWrap === 'function'
                ? window.toolsMemberColumnHeaderWrap(nameHeaderClickable, { align: 'flex-start', labelColor: '#aaa' })
                : nameHeaderClickable;
        const nameTh = `<th style="padding:10px;text-align:left;background:var(--secondary-color);border-bottom:1px solid var(--border-color);vertical-align:middle;">${nameThInner}</th>`;
        const otherHeaders = [
            ['lastOnline', 'Last online'],
            ['daysInFaction', 'Days in faction'],
            ['crimeScore', 'OC score'],
            ['warHits', 'War hits'],
            ['outsideHits', 'Outside hits'],
            ['activityHours', 'Activity (h)'],
            ['consumptionCost', 'Consumption $']
        ]
            .map(
                ([id, label]) =>
                    `<th data-mpr-sort="${id}" style="cursor:pointer;padding:10px;text-align:center;background:var(--secondary-color);color:var(--accent-color);border-bottom:1px solid var(--border-color);">${mprEscapeHtml(label)}${mprSortState.column === id ? (mprSortState.direction === 'asc' ? ' ▲' : ' ▼') : ''}</th>`
            )
            .join('');
        let html =
            '<table class="mpr-roster-table" style="width:100%;min-width:1160px;border-collapse:collapse;"><thead><tr>' +
            nameTh +
            otherHeaders +
            '</tr></thead><tbody>';

        sorted.forEach(row => {
            const label =
                typeof window.toolsFormatMemberDisplayLabel === 'function'
                    ? window.toolsFormatMemberDisplayLabel(row, showId)
                    : mprEscapeHtml(row.name);
            const linkAttrs =
                typeof window.toolsMemberLinkAttrs === 'function' ? window.toolsMemberLinkAttrs(row.name, row.id) : '';
            const nameCell = `<a class="player-link" href="https://www.torn.com/profiles.php?XID=${row.id}" target="_blank" rel="noopener noreferrer"${linkAttrs}>${label}</a>`;
            const loTitle = row.lastOnlineTitle ? mprEscapeHtml(row.lastOnlineTitle) : '';
            const lastOnlineCell = `<span title="${loTitle}">${mprEscapeHtml(row.lastOnlineDisplay || '—')}</span>`;
            const daysCell = row.daysInFaction == null ? '—' : String(row.daysInFaction);
            const crimeCell = `<strong style="color:#ffd700">${row.crimeScore}</strong> <span style="color:#aaa;font-size:0.85em">(${row.ocParts} parts)</span><details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--accent-color);font-size:0.85em;">Details</summary><div style="margin-top:6px;padding:8px;background:var(--secondary-color);border-radius:6px;max-width:360px;">${mprCrimeDetailsHtml(
                row.ocPlayer || { totalParticipations: 0, difficultyBreakdown: {} }
            )}</div></details>`;
            const war = row.warHits == null ? '—' : String(row.warHits);
            const out = row.outsideHits == null ? '—' : String(row.outsideHits);
            const act = row.activityPending
                ? '<span class="mpr-activity-loading" title="Fetching timeplayed from the API (same limits as Check Activity)"><span class="mpr-activity-spinner" aria-hidden="true"></span><span>Updating…</span></span>'
                : row.activityHours == null
                  ? '—'
                  : `${row.activityHours.toFixed(1)}`;
            const costNum = row.consumptionCost || 0;
            const costCell =
                costNum > 0
                    ? `<strong>$${Math.round(costNum).toLocaleString()}</strong><details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--accent-color);font-size:0.85em;">Details</summary><div style="margin-top:6px;padding:8px;background:var(--secondary-color);border-radius:6px;max-width:380px;">${mprConsumptionDetailsHtml(
                          row.consumptionRow,
                          row._itemValues || {}
                      )}</div></details>`
                    : '<span style="color:#888">$0</span>';

            html += `<tr style="border-bottom:1px solid var(--border-color);"><td style="padding:10px;">${nameCell}</td><td style="padding:10px;text-align:center;white-space:nowrap;font-size:0.92em;color:#ccc;">${lastOnlineCell}</td><td style="padding:10px;text-align:center;">${daysCell}</td><td style="padding:10px;vertical-align:top;">${crimeCell}</td><td style="padding:10px;text-align:center;">${war}</td><td style="padding:10px;text-align:center;">${out}</td><td style="padding:10px;text-align:center;">${act}</td><td style="padding:10px;vertical-align:top;">${costCell}</td></tr>`;
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;

        wrap.querySelectorAll('[data-mpr-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-mpr-sort');
                if (mprSortState.column === col) {
                    mprSortState.direction = mprSortState.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    mprSortState.column = col;
                    mprSortState.direction = col === 'name' ? 'asc' : 'desc';
                }
                mprRenderTable(mprLastRows);
            });
        });
    }

    async function mprEnsureConsumptionScriptForWarHits() {
        if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') return;
        const id = 'consumption-tracker-script-mpr-dep';
        if (!document.getElementById(id)) {
            const s = document.createElement('script');
            s.id = id;
            s.src = './tools/consumption-tracker/consumption-tracker.js';
            document.body.appendChild(s);
        }
        for (let i = 0; i < 200; i++) {
            if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') return;
            await new Promise(r => setTimeout(r, 50));
        }
    }

    function mprBuildPerformanceRows(
        membersArray,
        ocMap,
        byConsumptionId,
        hitsById,
        warMeta,
        itemValues,
        fromTs,
        toTs,
        activityHoursById,
        activityPending
    ) {
        const nowTs = Math.floor(Date.now() / 1000);
        const rangeEndTs = Math.min(toTs, nowTs);
        return membersArray.map(m => {
            const id = String(m.id);
            const ocPlayer = ocMap[id] || {
                id,
                name: m.name,
                totalParticipations: 0,
                successfulParticipations: 0,
                failedParticipations: 0,
                totalScore: 0,
                successRate: 0,
                difficultyBreakdown: {},
                difficultyCrimeTypeBreakdown: {}
            };
            const cons = byConsumptionId.get(id) || mprEmptyConsumptionRow(id, m.name);
            const h = hitsById[id];
            const warHits = h ? h.war : warMeta.ok ? 0 : null;
            const outsideHits = h ? h.outside : warMeta.ok ? 0 : null;
            const ah = activityPending ? null : activityHoursById[id];
            const cost = mprConsumptionCostDollars(cons, itemValues);
            const lo = mprLastOnlineFromMember(m);
            return {
                id,
                name: m.name,
                lastOnlineSort: lo.sortVal,
                lastOnlineDisplay: lo.display,
                lastOnlineTitle: lo.title,
                daysInFaction: mprDaysInFaction(m, rangeEndTs),
                crimeScore: ocPlayer.totalScore,
                ocParts: ocPlayer.totalParticipations,
                ocPlayer,
                warHits,
                outsideHits,
                activityHours: ah,
                activityPending: !!activityPending,
                consumptionCost: cost,
                consumptionRow: cons,
                _itemValues: itemValues
            };
        });
    }

    async function handleMprFetch() {
        const apiKey = (localStorage.getItem('tornApiKey') || '').trim();
        if (!apiKey) {
            alert('Please enter your API key in the sidebar first.');
            return;
        }

        const startEl = document.getElementById('mprStartDate');
        const endEl = document.getElementById('mprEndDate');

        let startYmd = (startEl && startEl.value.trim()) || '';
        const endYmd = (endEl && endEl.value.trim()) || mprUtcYmd();
        if (!startYmd) {
            const t = new Date();
            const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0));
            d.setUTCDate(d.getUTCDate() - 30);
            startYmd = d.toISOString().slice(0, 10);
        }

        const fromTs = mprTctInstantUnix(startYmd, 0, 0, 0);
        const toTs = mprTctInstantUnix(endYmd, 23, 59, 59);
        if (fromTs == null || toTs == null) {
            alert('Invalid date. Use the calendar pickers (YYYY-MM-DD, TCT).');
            return;
        }
        if (fromTs > toTs) {
            alert('Start date must be on or before end date (TCT).');
            return;
        }

        const progressContainer = document.getElementById('mprProgressContainer');
        const progressEls = mprGetProgressEls();
        const { progressMessage, progressPercentage, progressFill, progressDetails } = progressEls;
        const spinner = document.getElementById('mprLoadingSpinner');
        const btn = document.getElementById('mprFetchBtn');
        const results = document.getElementById('mprResultsSection');
        const tableOpts = document.getElementById('mprTableOptions');

        const setProg = (pct, msg, det) => {
            if (progressPercentage) progressPercentage.textContent = `${Math.round(pct)}%`;
            if (progressFill) progressFill.style.width = `${Math.min(100, pct)}%`;
            if (progressMessage && msg) progressMessage.textContent = msg;
            if (progressDetails && det != null) progressDetails.textContent = det;
        };

        try {
            if (btn) btn.disabled = true;
            if (spinner) spinner.style.display = 'inline-block';
            if (results) results.style.display = 'none';
            if (tableOpts) tableOpts.style.display = 'none';
            if (progressContainer) progressContainer.style.display = 'block';
            mprChecklistReset();
            mprChecklistEnsure();
            setProg(0, 'Starting…', 'Using your welcome panel rate limit.');

            mprChecklistSet('members', 'active');
            setProg(2, 'Faction members…', '');
            const memUrl = `https://api.torn.com/v2/faction/members?key=${encodeURIComponent(apiKey)}`;
            const memData = await mprApiJson(memUrl, progressEls);
            if (memData.error) throw new Error(memData.error.error || 'Members API error');
            mprChecklistSet('members', 'done');

            const membersArray = memData.members || [];
            const currentMemberIds = new Set(membersArray.map(m => String(m.id)));
            const playerNames = {};
            const membersById = {};
            membersArray.forEach(m => {
                const id = String(m.id);
                playerNames[id] = m.name;
                membersById[id] = m;
            });

            mprChecklistSet('crimes', 'active');
            setProg(8, 'Completed crimes (OC)…', 'v2/faction/crimes, newest first');
            const crimesInRange = await mprFetchCrimesInRange(apiKey, fromTs, toTs, progressEls, (page, n) => {
                setProg(8 + Math.min(18, page * 2), 'Crimes…', `Page ${page}, ${n} in range`);
            });
            mprChecklistSet('crimes', 'done');

            const ocMap = mprProcessCrimeScoresOnly(crimesInRange, playerNames, currentMemberIds);

            mprChecklistSet('items', 'active');
            setProg(28, 'Item prices…', 'torn/?selections=items + points market');
            const itemValues = await mprBuildItemValues(apiKey, progressEls);
            mprChecklistSet('items', 'done');

            mprChecklistSet('news', 'active');
            setProg(38, 'Armory news…', 'v2/faction/news (consumption)');
            const allNews = await mprFetchNewsForRange(fromTs, toTs, apiKey, progressEls, (page, count, frac) => {
                setProg(38 + Math.min(20, frac * 20), 'Armory news…', `Page ${page}, ${count} rows`);
            });
            mprChecklistSet('news', 'done');

            const byConsumptionId = new Map();
            for (const entry of allNews) {
                mprAccumulateNewsEntry(byConsumptionId, entry.text || '');
            }

            mprChecklistSet('war', 'active');
            setProg(60, 'War & chain hits…', '');
            let warMeta = { ok: false, hitsById: {}, warnings: [], message: '' };
            try {
                await mprEnsureConsumptionScriptForWarHits();
                if (typeof window.factionToolsFetchWarChainHitsForRange === 'function') {
                    warMeta = await window.factionToolsFetchWarChainHitsForRange(apiKey, fromTs, toTs);
                } else {
                    warMeta.message = 'War/chain helper not available.';
                }
                mprChecklistSet('war', 'done');
            } catch (e) {
                console.warn('[MPR] War/chain:', e);
                warMeta.message = e.message || 'War/chain fetch failed';
                mprChecklistSet('war', 'error');
            }
            const hitsById = warMeta.ok && warMeta.hitsById ? warMeta.hitsById : {};

            const rangeEl = document.getElementById('mprRangeSummary');
            if (rangeEl) {
                rangeEl.textContent = `Range: ${mprFormatTctUtc(fromTs)} → ${mprFormatTctUtc(toTs)} · ${crimesInRange.length} completed crime(s) with execution time in range · ${allNews.length} armory news row(s) scanned.`;
            }
            const note = document.getElementById('mprWarChainNote');
            if (note) {
                if (warMeta.warnings && warMeta.warnings.length) {
                    note.style.display = 'block';
                    note.textContent = warMeta.warnings.join(' ');
                } else if (!warMeta.ok && warMeta.message) {
                    note.style.display = 'block';
                    note.textContent = 'War / outside hits: ' + warMeta.message;
                } else {
                    note.style.display = 'none';
                    note.textContent = '';
                }
            }

            mprChecklistSet('activity', 'active');
            setProg(
                72,
                'Activity (timeplayed)…',
                `Loading ${membersArray.length * 2} snapshot(s) — table below is ready; this column updates when done.`
            );

            const rowsPending = mprBuildPerformanceRows(
                membersArray,
                ocMap,
                byConsumptionId,
                hitsById,
                warMeta,
                itemValues,
                fromTs,
                toTs,
                {},
                true
            );
            mprLastRows = rowsPending;
            if (tableOpts) tableOpts.style.display = 'block';
            mprRenderTable(rowsPending);
            if (results) results.style.display = 'block';

            const memberIds = membersArray.map(m => m.id);
            let activityHours = {};
            try {
                activityHours = await mprFetchActivityHours(memberIds, membersById, fromTs, toTs, apiKey, progressEls);
            } catch (actErr) {
                console.warn('[MPR] Activity fetch failed:', actErr);
                mprChecklistSet('activity', 'error');
            }
            mprChecklistSet('activity', 'done');

            mprLastRows.forEach(r => {
                r.activityPending = false;
                r.activityHours = Object.prototype.hasOwnProperty.call(activityHours, r.id) ? activityHours[r.id] : null;
            });
            setProg(100, 'Done.', '');
            mprRenderTable(mprLastRows);
        } catch (e) {
            console.error('[MPR]', e);
            alert(e.message || String(e));
        } finally {
            if (btn) btn.disabled = false;
            if (spinner) spinner.style.display = 'none';
            if (progressContainer) progressContainer.style.display = 'none';
        }
    }

    function initMemberPerformanceRange() {
        if (window.logToolUsage) window.logToolUsage('member-performance-range');

        const btn = document.getElementById('mprFetchBtn');
        if (btn && !btn.dataset.mprWired) {
            btn.dataset.mprWired = '1';
            btn.addEventListener('click', () => handleMprFetch());
        }

        /* Name [ID] toggle lives in the Member column header (toolsMemberColumnHeaderWrap); app.js persists to localStorage and dispatches toolsMemberIdDisplayChanged. */
        if (!window._mprToolsMemberIdListener) {
            window._mprToolsMemberIdListener = true;
            window.addEventListener('toolsMemberIdDisplayChanged', () => {
                mprRenderTable(mprLastRows);
            });
        }

        setTimeout(() => {
            if (window.initDatePickers) {
                const startDef = new Date(Date.now() - 30 * 86400000);
                window.initDatePickers('mprStartDate', 'mprEndDate', {
                    startDefaultDate: startDef,
                    endDefaultDate: 'today'
                });
            }
            const quickRoot = document.getElementById('mprQuickRangeBtns');
            if (quickRoot && !quickRoot.dataset.mprWired) {
                quickRoot.dataset.mprWired = '1';
                quickRoot.addEventListener('click', e => {
                    const b = e.target.closest('[data-mpr-range-days]');
                    if (!b) return;
                    const days = parseInt(b.getAttribute('data-mpr-range-days'), 10);
                    if (days > 0) mprApplyQuickRangeDaysInclusive(days);
                });
            }
        }, 100);

        const cutInput = document.getElementById('mprFactionCutPercent');
        if (cutInput && !cutInput.dataset.mprWiredLs) {
            cutInput.dataset.mprWiredLs = '1';
            try {
                const saved = localStorage.getItem(MPR_LS_FACTION_CUT);
                if (saved != null && saved !== '') cutInput.value = saved;
            } catch (e) {
                /* ignore */
            }
            cutInput.addEventListener('change', () => {
                try {
                    localStorage.setItem(MPR_LS_FACTION_CUT, String(cutInput.value));
                } catch (e) {
                    /* ignore */
                }
            });
        }
    }

    window.initMemberPerformanceRange = initMemberPerformanceRange;
})();
