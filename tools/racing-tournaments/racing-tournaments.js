/**
 * Racing Tournaments UI.
 * Standings math mirrors functions/racingStandings.js.
 */
(function () {
    const DEFAULT_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
    const TORN_RACING = 'https://www.torn.com/page.php?sid=racing';

    const S = {
        leagueId: '',
        league: null,
        missing: false,
        rounds: [],
        seasons: [],
        viewSeason: null,
        mine: [],
        me: null,
        serverVip: null,
        hubError: '',
        error: '',
        notice: '',
        loadingLeague: false,
        countdownTo: 0,
    };

    function listenerBucket() {
        if (!window.__rtListeners) {
            window.__rtListeners = { league: null, rounds: null, seasons: null, roundKey: '' };
        }
        return window.__rtListeners;
    }

    function ensureFont() {
        if (document.getElementById('rt-font')) return;
        const link = document.createElement('link');
        link.id = 'rt-font';
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Rajdhani:wght@500;600;700&display=swap';
        document.head.appendChild(link);
    }

    function decodeTornText(value) {
        let text = String(value == null ? '' : value);
        for (let pass = 0; pass < 2; pass += 1) {
            const next = text
                .replace(/&#0*39;/g, "'")
                .replace(/&#x0*27;/gi, "'")
                .replace(/&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            if (next === text) break;
            text = next;
        }
        return text;
    }

    function esc(value) {
        return decodeTornText(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function apiKey() {
        const el = document.getElementById('globalApiKey');
        const raw = (el && el.value) || localStorage.getItem('tornApiKey') || '';
        return String(raw).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    }

    function requireKey() {
        const key = apiKey();
        if (key.length !== 16) {
            throw new Error('Add your 16-character Torn API key in the sidebar first.');
        }
        return key;
    }

    function call(name, data) {
        if (typeof firebase === 'undefined' || !firebase.functions) {
            return Promise.reject(new Error('Firebase did not load. Refresh the page.'));
        }
        return firebase.functions().httpsCallable(name)(data).then(function (res) {
            return res && res.data !== undefined ? res.data : res;
        });
    }

    function parseLeagueId() {
        const hash = String(location.hash || '').replace(/^#/, '');
        const parts = hash.split('/');
        if (parts[0] !== 'racing-tournaments') return '';
        try {
            return decodeURIComponent(parts[1] || '').trim();
        } catch (e) {
            return String(parts[1] || '').trim();
        }
    }

    function shareUrl(leagueId) {
        return location.origin + location.pathname + location.search + '#racing-tournaments/' + encodeURIComponent(leagueId);
    }

    function vipLevel() {
        if (S.serverVip != null && Number.isFinite(Number(S.serverVip))) return Number(S.serverVip);
        if (window.vipLevelKnown) return Number(window.currentVipLevel) || 0;
        return null;
    }

    function pointsForPosition(pointsTable, position) {
        const pos = Number(position);
        if (!Number.isFinite(pos) || pos < 1) return 0;
        const table = Array.isArray(pointsTable) ? pointsTable : DEFAULT_POINTS;
        const pts = Number(table[pos - 1]);
        return Number.isFinite(pts) && pts > 0 ? pts : 0;
    }

    function computeStandings(rounds, pointsTable, roster) {
        const map = new Map();
        (rounds || []).forEach(function (round) {
            if (!round || round.status !== 'completed' || !Array.isArray(round.results)) return;
            round.results.forEach(function (result) {
                if (!result) return;
                const driverId = String(result.driverId || '').trim();
                if (!driverId) return;
                if (!map.has(driverId)) {
                    map.set(driverId, {
                        driverId: driverId,
                        driverName: result.driverName ? String(result.driverName) : 'Player ' + driverId,
                        points: 0,
                        wins: 0,
                        seconds: 0,
                        thirds: 0,
                        starts: 0,
                        bestFinish: null,
                    });
                }
                const row = map.get(driverId);
                if (result.driverName) row.driverName = String(result.driverName);
                const pos = result.position == null || result.position === '' ? null : Number(result.position);
                const classified = pos != null && Number.isFinite(pos);
                row.points += pointsForPosition(pointsTable, classified ? pos : null);
                row.starts += 1;
                if (pos === 1) row.wins += 1;
                if (pos === 2) row.seconds += 1;
                if (pos === 3) row.thirds += 1;
                if (classified && (row.bestFinish == null || pos < row.bestFinish)) row.bestFinish = pos;
            });
        });
        const rosterIds = new Set(Object.keys(roster || {}));
        const standings = [...map.values()].map(function (row) {
            return Object.assign({}, row, { inLeague: rosterIds.has(String(row.driverId)) });
        });
        standings.sort(function (a, b) {
            if (b.points !== a.points) return b.points - a.points;
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.seconds !== a.seconds) return b.seconds - a.seconds;
            if (b.thirds !== a.thirds) return b.thirds - a.thirds;
            const af = a.bestFinish == null ? 9999 : a.bestFinish;
            const bf = b.bestFinish == null ? 9999 : b.bestFinish;
            if (af !== bf) return af - bf;
            const byName = String(a.driverName).localeCompare(String(b.driverName));
            if (byName !== 0) return byName;
            return String(a.driverId).localeCompare(String(b.driverId));
        });
        return standings;
    }

    function formatTct(unix) {
        const n = Number(unix) || 0;
        if (!n) return '';
        try {
            return new Intl.DateTimeFormat('en-GB', {
                timeZone: 'America/New_York',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(n * 1000)) + ' TCT';
        } catch (e) {
            return '';
        }
    }

    function placeLabel(index) {
        const n = index + 1;
        const mod100 = n % 100;
        let suffix = 'th';
        if (mod100 < 11 || mod100 > 13) {
            if (n % 10 === 1) suffix = 'st';
            else if (n % 10 === 2) suffix = 'nd';
            else if (n % 10 === 3) suffix = 'rd';
        }
        return n + suffix + ' Place';
    }

    function formatRoundWhen(round) {
        const date = formatDateLabel(round && round.scheduledDate);
        const time = round && round.scheduledTime ? String(round.scheduledTime) : '';
        if (!time || date === 'Date TBC') return date;
        return date + ' · ' + time + ' TCT';
    }

    function formatRaceWhen(unix) {
        const n = Number(unix) || 0;
        if (!n) return '';
        try {
            return new Intl.DateTimeFormat('en-GB', {
                timeZone: 'America/New_York',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).format(new Date(n * 1000)).replace(',', '') + ' TCT';
        } catch (e) {
            return '';
        }
    }

    function roundDisplayWhen(round) {
        if (round && round.status === 'completed' && round.race && Number(round.race.start)) {
            return formatRaceWhen(round.race.start) || formatRoundWhen(round);
        }
        return formatRoundWhen(round);
    }

    function formatDateLabel(iso) {
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'Date TBC';
        const parts = iso.split('-');
        const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        return new Intl.DateTimeFormat('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(dt);
    }

    function formatRaceTime(value) {
        if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
        let sec = Number(value);
        if (sec > 100000) sec = sec / 1000;
        if (sec < 0) return '—';
        const m = Math.floor(sec / 60);
        const s = sec - m * 60;
        return m + ':' + s.toFixed(2).padStart(5, '0');
    }

    function formatMoney(n) {
        const v = Number(n) || 0;
        if (!v) return '';
        return '$' + v.toLocaleString('en-US');
    }

    function countdownLabel(unix) {
        const diff = Number(unix) * 1000 - Date.now();
        if (!Number.isFinite(diff)) return '';
        if (diff <= 0) return 'Scheduled start has passed';
        const total = Math.floor(diff / 1000);
        const d = Math.floor(total / 86400);
        const h = Math.floor((total % 86400) / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
        return h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
    }

    function myRole() {
        if (S.me && S.league && S.league.roster) {
            const entry = S.league.roster[S.me.playerId];
            return entry && entry.role ? entry.role : null;
        }
        const row = (S.mine || []).find(function (league) { return league.leagueId === S.leagueId; });
        return row ? row.role : null;
    }

    function isStaff() {
        const role = myRole();
        return role === 'owner' || role === 'admin';
    }

    function isOwner() {
        return myRole() === 'owner';
    }

    function leagueGate() {
        const gate = S.league && S.league.gate;
        if (gate === 'faction' || gate === 'invite' || gate === 'open') return gate;
        return 'open';
    }

    function joinLocked() {
        return !!(S.league && S.league.joinLocked);
    }

    function gateLabel() {
        const gate = leagueGate();
        if (gate === 'faction') {
            const name = S.league && S.league.ownerFactionName;
            return name ? 'Own faction · ' + name : 'Own faction';
        }
        if (gate === 'invite') return 'Invitation only';
        return 'Open event';
    }

    function canKick(entry) {
        if (!isStaff() || isArchiveView() || !entry) return false;
        if (entry.role === 'owner') return false;
        if (entry.role === 'admin') return isOwner();
        return true;
    }

    function currentSeasonNumber() {
        return Number(S.league && S.league.seasonNumber) || 1;
    }

    function viewingSeasonNumber() {
        if (S.viewSeason) return Number(S.viewSeason);
        return currentSeasonNumber();
    }

    function isArchiveView() {
        return !!(S.league && S.viewSeason && Number(S.viewSeason) !== currentSeasonNumber());
    }

    function archivedSeason() {
        if (!isArchiveView()) return null;
        return (S.seasons || []).find(function (season) {
            return Number(season.seasonNumber) === Number(S.viewSeason);
        }) || null;
    }

    function activePoints() {
        const archived = archivedSeason();
        if (archived && Array.isArray(archived.pointsTable) && archived.pointsTable.length) return archived.pointsTable;
        if (S.league && Array.isArray(S.league.pointsTable) && S.league.pointsTable.length) return S.league.pointsTable;
        return DEFAULT_POINTS.slice();
    }

    function grandPrizeValues(src) {
        const prizes = src && typeof src === 'object' ? src : {};
        if (Array.isArray(prizes.places)) {
            return prizes.places.map(function (item) { return String(item || ''); });
        }
        return [prizes.first || '', prizes.second || '', prizes.third || ''];
    }

    function activePrizes() {
        const archived = archivedSeason();
        const src = archived ? archived.grandPrizes : (S.league && S.league.grandPrizes);
        const places = grandPrizeValues(src);
        return {
            places: places,
            first: places[0] || '',
            second: places[1] || '',
            third: places[2] || '',
        };
    }

    function standingsRows() {
        const archived = archivedSeason();
        if (archived && Array.isArray(archived.standings)) return archived.standings;
        return computeStandings(S.rounds, activePoints(), (S.league && S.league.roster) || {});
    }

    function sortedRounds() {
        return (S.rounds || []).slice().sort(function (a, b) {
            const da = a.scheduledDate || '';
            const db = b.scheduledDate || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.createdAt || 0) - (b.createdAt || 0);
        });
    }

    function rosterEntries() {
        const roster = (S.league && S.league.roster) || {};
        const rank = { owner: 0, admin: 1, member: 2 };
        return Object.keys(roster).map(function (id) {
            return Object.assign({ id: id }, roster[id]);
        }).sort(function (a, b) {
            const ra = rank[a.role] != null ? rank[a.role] : 9;
            const rb = rank[b.role] != null ? rank[b.role] : 9;
            if (ra !== rb) return ra - rb;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
    }

    function driverLink(id, name) {
        const href = 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id);
        return '<a class="rt-driver" href="' + href + '" target="_blank" rel="noopener noreferrer">' + esc(name || ('Player ' + id)) + '</a>';
    }

    function memberChip(inLeague) {
        if (!inLeague) return '';
        return '<span class="rt-chip">League</span>';
    }

    function stopListeners() {
        const listeners = listenerBucket();
        ['league', 'rounds', 'seasons'].forEach(function (key) {
            if (listeners[key]) {
                try { listeners[key](); } catch (e) { /* ignore */ }
                listeners[key] = null;
            }
        });
        listeners.roundKey = '';
    }

    function watchRounds(leagueId, seasonNumber) {
        const listeners = listenerBucket();
        const key = leagueId + ':' + seasonNumber;
        if (listeners.roundKey === key) return;
        if (listeners.rounds) listeners.rounds();
        listeners.roundKey = key;
        listeners.rounds = firebase.firestore()
            .collection('racingLeagues').doc(leagueId)
            .collection('rounds')
            .where('seasonNumber', '==', seasonNumber)
            .onSnapshot(function (snap) {
                S.rounds = snap.docs.map(function (doc) {
                    return Object.assign({ id: doc.id }, doc.data());
                });
                S.loadingLeague = false;
                render();
            }, function (err) {
                S.error = err && err.message ? err.message : 'Could not load rounds.';
                render();
            });
    }

    function watchLeague(leagueId) {
        S.loadingLeague = true;
        const listeners = listenerBucket();
        listeners.league = firebase.firestore().collection('racingLeagues').doc(leagueId).onSnapshot(function (snap) {
            if (!snap.exists) {
                S.missing = true;
                S.league = null;
                S.loadingLeague = false;
                render();
                return;
            }
            S.missing = false;
            S.league = Object.assign({ id: snap.id }, snap.data());
            watchRounds(leagueId, viewingSeasonNumber());
            if (!listeners.seasons) {
                listeners.seasons = firebase.firestore()
                    .collection('racingLeagues').doc(leagueId)
                    .collection('seasons')
                    .onSnapshot(function (seasonSnap) {
                        S.seasons = seasonSnap.docs.map(function (doc) {
                            return Object.assign({ id: doc.id }, doc.data());
                        });
                        render();
                    }, function () { /* archive list is optional */ });
            }
            render();
        }, function (err) {
            S.loadingLeague = false;
            S.error = err && err.message ? err.message : 'Could not load this league.';
            render();
        });
    }

    function render() {
        const root = document.getElementById('rt-view');
        if (!root) return;
        root.innerHTML = S.leagueId ? leagueHtml() : hubHtml();
        const open = sortedRounds().find(function (round) { return round.status === 'open' && round.race; });
        S.countdownTo = open && open.race && open.race.status === 'open' ? Number(open.race.start) || 0 : 0;
    }

    function tickCountdown() {
        const el = document.getElementById('rt-countdown');
        if (!el || !S.countdownTo) return;
        el.textContent = countdownLabel(S.countdownTo);
    }

    function hero(kicker, title, sub) {
        return '' +
            '<header class="rt-hero">' +
                '<div class="rt-checker" aria-hidden="true"></div>' +
                '<p class="rt-kicker">' + esc(kicker) + '</p>' +
                '<h1>' + esc(title) + '</h1>' +
                (sub ? '<p class="rt-sub">' + sub + '</p>' : '') +
            '</header>';
    }

    function noticeHtml() {
        let html = '';
        if (S.error) html += '<p class="rt-banner rt-banner-error" role="alert">' + esc(S.error) + '</p>';
        if (S.notice) html += '<p class="rt-banner" role="status">' + esc(S.notice) + '</p>';
        return html;
    }

    function hubHtml() {
        const vip = vipLevel();
        const keyReady = apiKey().length === 16;
        let create = '';
        if (!keyReady) {
            create = '<p class="rt-muted">Add your API key in the sidebar. VIP 3 can create a league. Everyone else can open a share link and join.</p>';
        } else if (vip == null) {
            create = '<p class="rt-muted">Checking your VIP level…</p>';
        } else if (vip >= 3) {
            create = '<button type="button" class="rt-btn rt-btn-gold" data-act="open-create">Create a league</button>';
        } else {
            create = '' +
                '<div class="rt-lock">' +
                    '<strong>VIP 3 starts a league</strong>' +
                    '<p>Send Xanax to Jimidy until you hit VIP 3. Drivers you invite do not need VIP — the share link is enough.</p>' +
                '</div>';
        }

        let mine = '';
        if (!keyReady) {
            mine = '<p class="rt-muted">Your leagues show up here once the sidebar has your key.</p>';
        } else if (S.hubError) {
            mine = '<p class="rt-banner rt-banner-error">' + esc(S.hubError) + '</p>';
        } else if (!S.mine.length) {
            mine = '<p class="rt-muted">You have not created or joined a league on this key yet.</p>';
        } else {
            mine = '<div class="rt-hub-grid">' + S.mine.map(function (league) {
                const role = league.role === 'owner' ? 'Owner' : league.role === 'admin' ? 'Admin' : 'Joined';
                return '' +
                    '<a class="rt-card" href="#racing-tournaments/' + encodeURIComponent(league.leagueId) + '">' +
                        '<span class="rt-chip">' + esc(role) + '</span>' +
                        '<strong>' + esc(league.leagueName || 'League') + '</strong>' +
                        '<span>Open the grid</span>' +
                    '</a>';
            }).join('') + '</div>';
        }

        return hero(
            "Jimidy's Faction Tools",
            'Racing Tournaments',
            'A Grand Prix table for Torn. The owner posts the rounds. Torn supplies the results.'
        ) +
            noticeHtml() +
            '<section class="rt-panel">' +
                '<div class="rt-panel-head"><h2>Your leagues</h2></div>' +
                mine +
                '<div class="rt-create-row">' + create + '</div>' +
            '</section>' +
            '<section class="rt-steps">' +
                '<article><span>01</span><h3>Share the link</h3><p>VIP 3 creates the league and picks who can join: your faction, people you add, or anyone with the link.</p></article>' +
                '<article><span>02</span><h3>Line up the rounds</h3><p>Set a date and as many prizes as you like. The Torn race stays TBC until you open one race for entry. Only one can be open.</p></article>' +
                '<article><span>03</span><h3>File the result</h3><p>Pick a race you drove, or paste a race ID if you could not enter. Every finisher scores. League drivers are marked.</p></article>' +
            '</section>';
    }

    function seasonSwitcher() {
        const current = currentSeasonNumber();
        const nums = new Set([current]);
        (S.seasons || []).forEach(function (season) {
            if (season.seasonNumber) nums.add(Number(season.seasonNumber));
        });
        if (nums.size < 2) return '';
        const ordered = [...nums].sort(function (a, b) { return b - a; });
        const viewing = viewingSeasonNumber();
        return '<div class="rt-seasons" role="tablist">' + ordered.map(function (n) {
            const active = n === viewing;
            const act = n === current ? 'view-current' : 'view-season';
            return '<button type="button" class="rt-btn rt-btn-tiny ' + (active ? 'rt-btn-gold' : 'rt-btn-ghost') + '" data-act="' + act + '" data-season="' + n + '">' +
                'Season ' + n + (n === current ? ' · live' : '') +
            '</button>';
        }).join('') + '</div>';
    }

    function requirementChips(race) {
        if (!race) return '';
        const req = race.requirements || {};
        const chips = [];
        if (race.trackName) chips.push(race.trackName);
        if (race.laps) chips.push(race.laps + ' laps');
        if (req.carClass) chips.push('Car ' + req.carClass);
        if (req.driverClass) chips.push('Driver ' + req.driverClass);
        if (req.requiresStock) chips.push('Stock');
        if (req.joinFee) chips.push(formatMoney(req.joinFee) + ' entry');
        if (req.requiresPassword) chips.push('Password');
        if (race.isOfficial) chips.push('Official');
        if (race.participantsMax) chips.push((race.participantsCurrent || 0) + ' / ' + race.participantsMax + ' entered');
        else if (race.participantsCurrent) chips.push(race.participantsCurrent + ' entered');
        if (!chips.length) return '';
        return '<ul class="rt-meta">' + chips.map(function (chip) {
            return '<li>' + esc(chip) + '</li>';
        }).join('') + '</ul>';
    }

    function roundPrizeList(round) {
        if (!round) return [];
        if (Array.isArray(round.prizes) && round.prizes.length) {
            return round.prizes.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
        }
        if (round.prize && String(round.prize).trim()) return [String(round.prize).trim()];
        return [];
    }

    function prizeTickets(round) {
        const list = roundPrizeList(round);
        if (!list.length) {
            return '<div class="rt-prize-ticket"><span>Round prize</span><strong>TBC</strong></div>';
        }
        return '<div class="rt-prize-stack">' + list.map(function (prize, index) {
            return '<div class="rt-prize-ticket"><span>' + placeLabel(index) + '</span><strong>' + esc(prize) + '</strong></div>';
        }).join('') + '</div>';
    }

    function finisherAtPlace(round, placeNumber) {
        const results = Array.isArray(round && round.results) ? round.results : [];
        return results.find(function (result) {
            return Number(result.position) === placeNumber;
        }) || null;
    }

    function prizeForPosition(round, position) {
        const place = Number(position);
        if (!Number.isFinite(place) || place < 1) return '';
        const list = roundPrizeList(round);
        return list[place - 1] || '';
    }

    function prizeLines(round, showWinners) {
        const list = roundPrizeList(round);
        if (!list.length) return '<p class="rt-round-prize">Prize TBC</p>';
        return list.map(function (prize, index) {
            let who = '';
            if (showWinners) {
                const finisher = finisherAtPlace(round, index + 1);
                who = finisher
                    ? '<span class="rt-prize-who">' + driverLink(finisher.driverId, finisher.driverName) +
                        ' <span class="rt-prize-note">(' + esc(prize) + ')</span></span>'
                    : '<span class="rt-prize-who rt-muted">No finisher</span><span class="rt-prize-amt">' + esc(prize) + '</span>';
            }
            return '<p class="rt-round-prize"><span class="rt-place">' + placeLabel(index) + '</span>' +
                (showWinners ? who : '<span class="rt-prize-amt">' + esc(prize) + '</span>') + '</p>';
        }).join('');
    }

    function billboardHtml() {
        const rounds = sortedRounds();
        const open = rounds.find(function (round) { return round.status === 'open'; });
        const nextTbc = rounds.find(function (round) { return round.status === 'tbc'; });
        if (open) {
            const race = open.race || {};
            const live = race.status === 'in_progress';
            const flag = live ? 'Green flag' : 'Entry open';
            const when = race.start ? formatTct(race.start) : formatRoundWhen(open);
            let clock = '';
            if (!live && race.start) {
                clock = '<p class="rt-countdown" id="rt-countdown">' + esc(countdownLabel(race.start)) + '</p>';
            } else if (live) {
                clock = '<p class="rt-countdown">Race in progress</p>';
            }
            const later = nextTbc
                ? '<p class="rt-later">Also scheduled: ' + esc(nextTbc.title || 'Round') + ' · ' + esc(formatRoundWhen(nextTbc)) + ' · details TBC</p>'
                : '';
            return '' +
                '<section class="rt-billboard">' +
                    '<div class="rt-flag-row"><span class="rt-live-pip"></span><span class="rt-flag">' + esc(flag) + '</span></div>' +
                    '<h2>' + esc(race.title || open.title || 'Upcoming race') + '</h2>' +
                    prizeTickets(open) +
                    '<p class="rt-when">' + esc(when) + '</p>' +
                    requirementChips(race) +
                    clock +
                    '<p class="rt-race-id">Torn race <b>#' + esc(race.id || open.tornRaceId || '') + '</b></p>' +
                    (race.requirements && race.requirements.requiresPassword
                        ? '<p class="rt-muted">This race has a password. The owner shares it outside the tool.</p>'
                        : '') +
                    '<div class="rt-actions">' +
                        '<a class="rt-btn rt-btn-gold" href="' + TORN_RACING + '" target="_blank" rel="noopener noreferrer" data-tip="Open Torn racing so you can join this race">Enter on Torn</a>' +
                        (isStaff() && !isArchiveView()
                            ? actionBtn('clear-entry', 'Clear entry', 'Unpin this race so you can open a different one', 'rt-btn rt-btn-ghost', 'data-round="' + esc(open.id) + '"')
                            : '') +
                    '</div>' +
                    later +
                '</section>';
        }
        if (nextTbc && !isArchiveView()) {
            return '' +
                '<section class="rt-billboard rt-billboard-tbc">' +
                    '<div class="rt-flag-row"><span class="rt-flag rt-flag-tbc">Up next</span></div>' +
                    '<h2>' + esc(nextTbc.title || 'Round') + '</h2>' +
                    prizeTickets(nextTbc) +
                    '<div class="rt-billboard-foot">' +
                        '<p class="rt-when">' + esc(formatRoundWhen(nextTbc)) + '</p>' +
                        (isStaff() && !isArchiveView()
                            ? '<div class="rt-billboard-actions">' +
                                actionBtn('edit-round', 'Edit', 'Change the name, date, time, or prizes', 'rt-btn rt-btn-tiny rt-btn-ghost', 'data-round="' + esc(nextTbc.id) + '"') +
                                actionBtn('open-submit', 'File result', 'Add a finished Torn race to this round', 'rt-btn rt-btn-tiny rt-btn-gold', 'data-round="' + esc(nextTbc.id) + '"') +
                            '</div>'
                            : '') +
                    '</div>' +
                '</section>';
        }
        if (!rounds.length) {
            return '<section class="rt-billboard rt-billboard-tbc"><h2>The grid is empty</h2><p class="rt-muted">' +
                (isStaff() && !isArchiveView()
                    ? 'Add a round with a date and a prize. Race details stay TBC until you open one in Torn.'
                    : 'No rounds in this season yet.') +
                '</p></section>';
        }
        return '';
    }

    function podiumHtml(rows) {
        if (!rows.length) return '';
        const slots = [
            { place: 2, row: rows[1] },
            { place: 1, row: rows[0] },
            { place: 3, row: rows[2] },
        ];
        return '<div class="rt-podium">' + slots.map(function (slot) {
            if (!slot.row) {
                return '<div class="rt-podium-slot is-' + slot.place + ' is-empty"><span>P' + slot.place + '</span></div>';
            }
            return '' +
                '<div class="rt-podium-slot is-' + slot.place + '">' +
                    '<span class="rt-podium-place">P' + slot.place + '</span>' +
                    '<strong>' + driverLink(slot.row.driverId, slot.row.driverName) + memberChip(slot.row.inLeague) + '</strong>' +
                    '<em>' + esc(slot.row.points) + ' pts</em>' +
                '</div>';
        }).join('') + '</div>';
    }

    function standingsHtml(rows) {
        if (!rows.length) {
            return '<p class="rt-muted">No results filed for this season yet. Finishers from each submitted race land here.</p>';
        }
        const body = rows.map(function (row, index) {
            const place = index + 1;
            return '' +
                '<tr class="' + (row.inLeague ? 'rt-row-league' : '') + '">' +
                    '<td class="rt-pos is-' + place + '">' + place + '</td>' +
                    '<td>' + driverLink(row.driverId, row.driverName) + memberChip(row.inLeague) + '</td>' +
                    '<td class="rt-num">' + esc(row.points) + '</td>' +
                    '<td class="rt-num">' + esc(row.wins) + '</td>' +
                    '<td class="rt-num">' + esc(row.seconds) + '</td>' +
                    '<td class="rt-num">' + esc(row.thirds) + '</td>' +
                    '<td class="rt-num">' + esc(row.bestFinish == null ? '—' : row.bestFinish) + '</td>' +
                    '<td class="rt-num">' + esc(row.starts) + '</td>' +
                '</tr>';
        }).join('');
        return '' +
            podiumHtml(rows) +
            '<div class="rt-table-wrap">' +
                '<table class="rt-table">' +
                    '<thead><tr>' +
                        '<th>P</th><th>Driver</th><th>Pts</th><th>Wins</th><th>2nd</th><th>3rd</th><th>Best</th><th>Starts</th>' +
                    '</tr></thead>' +
                    '<tbody>' + body + '</tbody>' +
                '</table>' +
            '</div>' +
            '<p class="rt-fine">Ties break on wins, then 2nds, then 3rds, then best finish. Positions outside the points table score 0. A DNF scores 0. Drivers with a gold League tag have joined.</p>';
    }

    function prizesHtml() {
        const cards = activePrizes().places.map(function (prize, index) {
            return { label: placeLabel(index), prize: String(prize || '').trim() };
        }).filter(function (card) { return card.prize; });
        if (!cards.length) return '';
        return '<section class="rt-trophies">' + cards.map(function (card) {
            return '<article><span>' + esc(card.label) + '</span><strong>' + esc(card.prize) + '</strong></article>';
        }).join('') + '</section>';
    }

    function roundCard(round) {
        const status = round.status || 'tbc';
        const label = status === 'open' ? 'Entry open' : status === 'completed' ? 'Finished' : 'TBC';
        const namedPrizes = status === 'completed' && roundPrizeList(round).length > 0;
        const winner = !namedPrizes && status === 'completed' && round.results && round.results[0]
            ? round.results[0].driverName
            : '';
        const staff = isStaff() && !isArchiveView();
        let actions = '';
        if (staff) {
            actions = '<div class="rt-round-actions">' +
                actionBtn('edit-round', 'Edit', 'Change the name, date, or prizes', 'rt-btn rt-btn-tiny rt-btn-ghost', 'data-round="' + esc(round.id) + '"') +
                (status !== 'completed'
                    ? actionBtn('open-entry', 'Open for entry', 'Pin the Torn race drivers can enter. Only one race can be open', 'rt-btn rt-btn-tiny rt-btn-gold', 'data-round="' + esc(round.id) + '"')
                    : '') +
                (status !== 'completed'
                    ? actionBtn('open-submit', 'File result', 'Add a finished Torn race to this round and the table', 'rt-btn rt-btn-tiny rt-btn-ghost', 'data-round="' + esc(round.id) + '"')
                    : actionBtn('open-results', 'Results', 'See finishers and the points they scored', 'rt-btn rt-btn-tiny rt-btn-ghost', 'data-round="' + esc(round.id) + '"')) +
                actionBtn('ask-delete-round', 'Remove', 'Take this round off the calendar', 'rt-btn rt-btn-tiny rt-btn-danger', 'data-round="' + esc(round.id) + '"') +
            '</div>';
        } else if (status === 'completed') {
            actions = actionBtn('open-results', 'Results', 'See finishers and the points they scored', 'rt-btn rt-btn-tiny rt-btn-ghost', 'data-round="' + esc(round.id) + '"');
        }
        return '' +
            '<article class="rt-round is-' + esc(status) + '">' +
                '<div class="rt-round-top">' +
                    '<span class="rt-status is-' + esc(status) + '">' + label + '</span>' +
                    '<time>' + esc(roundDisplayWhen(round)) + '</time>' +
                '</div>' +
                '<h3>' + esc(round.title || 'Round') + '</h3>' +
                prizeLines(round, namedPrizes) +
                (round.race && round.race.title
                    ? '<p class="rt-muted">' + esc(round.race.trackName || '') + (round.tornRaceId ? ' · race #' + esc(round.tornRaceId) : '') + '</p>'
                    : '<p class="rt-muted">Torn race TBC</p>') +
                (winner ? '<p class="rt-winner">Winner ' + esc(winner) + '</p>' : '') +
                actions +
            '</article>';
    }

    function finishedStamp(round) {
        if (round && round.race && Number(round.race.start)) return Number(round.race.start);
        return 0;
    }

    function calendarGroup(title, rounds, empty) {
        return '<div class="rt-cal-group">' +
            '<h3>' + esc(title) + '</h3>' +
            (rounds.length
                ? '<div class="rt-cal">' + rounds.map(roundCard).join('') + '</div>'
                : '<p class="rt-muted">' + esc(empty) + '</p>') +
        '</div>';
    }

    function calendarHtml() {
        const rounds = sortedRounds();
        const staff = isStaff() && !isArchiveView();
        const upcoming = rounds.filter(function (round) { return round.status !== 'completed'; });
        const finished = rounds.filter(function (round) { return round.status === 'completed'; }).sort(function (a, b) {
            const sa = finishedStamp(a);
            const sb = finishedStamp(b);
            if (sa !== sb) return sb - sa;
            const da = a.scheduledDate || '';
            const db = b.scheduledDate || '';
            if (da !== db) return da < db ? 1 : -1;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });
        const body = rounds.length
            ? calendarGroup('Upcoming', upcoming, 'No upcoming races.') +
                calendarGroup('Finished', finished, 'No finished races yet.')
            : '<p class="rt-muted">No rounds on this season.</p>';
        return '' +
            '<section class="rt-panel">' +
                '<div class="rt-panel-head">' +
                    '<h2>Calendar</h2>' +
                    (staff ? actionBtn('edit-round', 'Add round', 'Schedule a round with a date and as many prizes as you want', 'rt-btn rt-btn-tiny rt-btn-gold') : '') +
                '</div>' +
                body +
            '</section>';
    }

    function rosterHtml() {
        const entries = rosterEntries();
        const staff = isStaff() && !isArchiveView();
        if (!entries.length && !staff) return '';
        return '' +
            '<section class="rt-panel">' +
                '<div class="rt-panel-head"><h2>On the entry list <span class="rt-muted">' + entries.length + '</span></h2>' +
                    (staff ? actionBtn('open-invite', 'Add driver', 'Put a Torn player on the entry list', 'rt-btn rt-btn-tiny rt-btn-gold') : '') +
                '</div>' +
                (entries.length
                    ? '<ul class="rt-roster">' + entries.map(function (entry) {
                        const role = entry.role === 'owner' ? 'Owner' : entry.role === 'admin' ? 'Admin' : '';
                        return '<li>' + driverLink(entry.id, entry.name || ('Player ' + entry.id)) +
                            (role ? '<span class="rt-chip rt-chip-quiet">' + role + '</span>' : '') +
                            (canKick(entry)
                                ? actionBtn('ask-remove-driver', 'Remove', 'Take this driver off the entry list', 'rt-btn rt-btn-tiny rt-btn-danger', 'data-player="' + esc(entry.id) + '" data-name="' + esc(entry.name || entry.id) + '"')
                                : '') +
                        '</li>';
                    }).join('') + '</ul>'
                    : '<p class="rt-muted">No drivers on the list yet.</p>') +
            '</section>';
    }

    function actionBtn(act, label, tip, className, extra) {
        return '<button type="button" class="' + className + '" data-act="' + act + '" data-tip="' + esc(tip) + '"' + (extra ? ' ' + extra : '') + '>' + label + '</button>';
    }

    function leagueHtml() {
        if (S.loadingLeague && !S.league && !S.missing) {
            return hero("Jimidy's Faction Tools", 'Racing Tournaments', 'Loading the grid…') + noticeHtml();
        }
        if (S.missing || S.error && !S.league) {
            return hero("Jimidy's Faction Tools", 'Racing Tournaments', '') +
                noticeHtml() +
                '<section class="rt-panel"><h2>League not found</h2><p class="rt-muted">That link does not match a league. Ask the owner for a fresh one.</p>' +
                '<a class="rt-btn rt-btn-ghost" href="#racing-tournaments">All leagues</a></section>';
        }
        if (!S.league) {
            return hero("Jimidy's Faction Tools", 'Racing Tournaments', 'Loading the grid…');
        }

        const role = myRole();
        const gate = leagueGate();
        let join = '';
        if (role === 'member') {
            join = actionBtn('leave', 'Leave league', 'Leave the entry list. Your past finishes stay on the table', 'rt-btn rt-btn-ghost');
        } else if (!role && joinLocked()) {
            join = '<span class="rt-muted">Joining is locked.</span>';
        } else if (!role && gate === 'invite') {
            join = '<span class="rt-muted">Invitation only. An owner or admin adds you.</span>';
        } else if (!role) {
            join = actionBtn('join', 'Join league', 'Join this league with the API key in the sidebar', 'rt-btn rt-btn-gold');
        }
        const lockedNote = joinLocked() && !isArchiveView()
            ? '<p class="rt-banner">Joining is locked. Drivers already on the list stay until someone removes them.</p>'
            : '';
        const roleChip = role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : role === 'member' ? 'Joined' : '';
        const seasonLabel = isArchiveView()
            ? 'Season ' + viewingSeasonNumber() + ' · archived'
            : 'Season ' + currentSeasonNumber();
        const archiveNote = isArchiveView()
            ? '<p class="rt-banner">You are looking at an archived season. The live table is Season ' + currentSeasonNumber() + '.</p>'
            : '';

        const row = [];
        if (isStaff() && !isArchiveView()) {
            row.push(actionBtn('open-submit', 'Submit a race', 'File a finished Torn race onto the championship table', 'rt-btn rt-btn-gold'));
            row.push(actionBtn('edit-round', 'Add round', 'Schedule a round with a date and as many prizes as you want', 'rt-btn rt-btn-ghost'));
        }
        row.push('<button type="button" class="rt-btn rt-btn-ghost" data-act="open-share">Share link</button>');
        if (join) row.push(join);
        row.push('<span class="rt-chip rt-chip-quiet">' + esc(gateLabel()) + '</span>');
        if (joinLocked()) row.push('<span class="rt-chip rt-chip-quiet">Locked</span>');
        if (roleChip) row.push('<span class="rt-chip">' + roleChip + '</span>');
        if (isStaff() && !isArchiveView()) row.push('<button type="button" class="rt-btn rt-btn-ghost rt-toolbar-settings" data-act="open-league-settings">Settings</button>');

        return hero(
            seasonLabel,
            S.league.name || 'League',
            ''
        ) +
            '<div class="rt-toolbar">' +
                '<div class="rt-actions"><a class="rt-btn rt-btn-ghost" href="#racing-tournaments" data-tip="Back to the leagues on this key">All leagues</a></div>' +
                '<div class="rt-actions rt-toolbar-work">' + row.join('') + '</div>' +
            '</div>' +
            noticeHtml() +
            lockedNote +
            archiveNote +
            seasonSwitcher() +
            billboardHtml() +
            prizesHtml() +
            '<section class="rt-panel">' +
                '<div class="rt-panel-head"><h2>Championship</h2></div>' +
                standingsHtml(standingsRows()) +
            '</section>' +
            calendarHtml() +
            rosterHtml();
    }

    function gateChoices(selected) {
        const current = selected === 'faction' || selected === 'invite' || selected === 'open' ? selected : 'open';
        const options = [
            ['faction', 'Own faction', 'Only drivers in your Torn faction can join from the link.'],
            ['invite', 'Invitation only', 'The link is view-only. You or an admin add drivers, and can remove them.'],
            ['open', 'Open event', 'Anyone with the link can join, until you lock it.'],
        ];
        return '<div class="rt-choice-list">' + options.map(function (opt) {
            return '<label class="rt-choice">' +
                '<input type="radio" name="rt-gate" value="' + opt[0] + '"' + (opt[0] === current ? ' checked' : '') + '>' +
                '<span><strong>' + opt[1] + '</strong><small>' + opt[2] + '</small></span>' +
            '</label>';
        }).join('') + '</div>';
    }

    function selectedGate() {
        const picked = document.querySelector('#rt-modal input[name="rt-gate"]:checked');
        return picked ? String(picked.value || '') : '';
    }

    function shareBlurb() {
        const gate = leagueGate();
        if (gate === 'faction') {
            const name = S.league && S.league.ownerFactionName ? S.league.ownerFactionName : 'the owner’s faction';
            return 'Anyone with this link can view the league. Only members of ' + name + ' can join, and only while joining is unlocked.';
        }
        if (gate === 'invite') {
            return 'Anyone with this link can view the league. They do not join themselves. Add drivers from the entry list. You can remove them later.';
        }
        return 'Anyone with this link can view the league and join with their API key, until joining is locked. No VIP needed.';
    }

    function openModal(title, body) {
        const modal = document.getElementById('rt-modal');
        if (!modal) return;
        modal.hidden = false;
        modal.innerHTML = '' +
            '<div class="rt-modal-backdrop" data-act="close-modal"></div>' +
            '<div class="rt-modal-card" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
                '<div class="rt-checker" aria-hidden="true"></div>' +
                '<div class="rt-modal-head">' +
                    '<h2>' + esc(title) + '</h2>' +
                    '<button type="button" class="rt-modal-x" data-act="close-modal" aria-label="Close">×</button>' +
                '</div>' +
                '<div class="rt-modal-body">' +
                    '<p id="rt-modal-error" class="rt-banner rt-banner-error" hidden></p>' +
                    body +
                '</div>' +
            '</div>';
        const form = modal.querySelector('form[data-act]');
        if (form) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                runAction(form.getAttribute('data-act'), form);
            });
        }
    }

    function prizeRowHtml(value, index) {
        return '<div class="rt-prize-row">' +
            '<span class="rt-place-label">' + placeLabel(index || 0) + '</span>' +
            '<input type="text" data-prize maxlength="200" placeholder="250 Xanax" value="' + esc(value || '') + '">' +
            '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="remove-prize-row">Remove</button>' +
        '</div>';
    }

    function refreshPrizeLabels() {
        document.querySelectorAll('#rt-prize-rows .rt-place-label').forEach(function (label, index) {
            label.textContent = placeLabel(index);
        });
    }

    function grandRowHtml(value, index) {
        return '<div class="rt-prize-row">' +
            '<span class="rt-place-label">' + placeLabel(index || 0) + '</span>' +
            '<input type="text" data-gprize maxlength="140" placeholder="Optional" value="' + esc(value || '') + '">' +
            '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="remove-grand-row">Remove</button>' +
        '</div>';
    }

    function refreshGrandRows() {
        const rows = document.querySelectorAll('#rt-grand-rows .rt-prize-row');
        rows.forEach(function (row, index) {
            const label = row.querySelector('.rt-place-label');
            if (label) label.textContent = placeLabel(index);
            const button = row.querySelector('[data-act="remove-grand-row"]');
            if (button) button.hidden = rows.length <= 1;
        });
    }

    function readGrandRows() {
        const values = [...document.querySelectorAll('#rt-grand-rows [data-gprize]')].map(function (input) {
            return String(input.value || '').trim();
        });
        while (values.length > 1 && !values[values.length - 1]) values.pop();
        if (values.length === 1 && !values[0]) return [];
        return values;
    }

    function grandPrizeFormValues() {
        const src = (S.league && S.league.grandPrizes) || {};
        if (Array.isArray(src.places)) return src.places.length ? src.places.map(function (item) { return String(item || ''); }) : [''];
        const legacy = [src.first || '', src.second || '', src.third || ''];
        return legacy.some(function (item) { return String(item || '').trim(); }) ? legacy : ['', '', ''];
    }

    function adminCandidates() {
        const seen = {};
        const people = [];
        function add(id, name, note) {
            const playerId = String(id || '').trim();
            if (!playerId || seen[playerId]) return;
            const roster = (S.league && S.league.roster) || {};
            const existing = roster[playerId];
            if (existing && (existing.role === 'owner' || existing.role === 'admin')) return;
            seen[playerId] = true;
            people.push({
                id: playerId,
                name: name || (existing && existing.name) || ('Player ' + playerId),
                note: note,
            });
        }
        rosterEntries().forEach(function (entry) {
            if (entry.role === 'member') add(entry.id, entry.name, 'On the entry list');
        });
        (S.rounds || []).forEach(function (round) {
            const results = Array.isArray(round.results) ? round.results : [];
            results.forEach(function (result) {
                add(result.driverId, result.driverName, 'In a filed race');
            });
        });
        people.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        return people;
    }

    function readPrizeRows() {
        return [...document.querySelectorAll('#rt-prize-rows [data-prize]')].map(function (input) {
            return String(input.value || '').trim();
        }).filter(Boolean);
    }

    function bindRoundDate(value) {
        const input = document.getElementById('rt-round-date');
        if (!input || typeof flatpickr !== 'function') return;
        if (input._flatpickr) input._flatpickr.destroy();
        flatpickr(input, {
            dateFormat: 'Y-m-d',
            altInput: true,
            altFormat: 'j M Y',
            defaultDate: value || null,
            allowInput: true,
            disableMobile: true,
            clickOpens: true,
            appendTo: document.body,
            locale: { firstDayOfWeek: 1 },
        });
    }

    function bindRoundTime(value) {
        const input = document.getElementById('rt-round-time');
        if (!input || typeof flatpickr !== 'function') return;
        if (input._flatpickr) input._flatpickr.destroy();
        flatpickr(input, {
            enableTime: true,
            noCalendar: true,
            dateFormat: 'H:i',
            time_24hr: true,
            minuteIncrement: 5,
            defaultDate: value || null,
            allowInput: true,
            disableMobile: true,
            clickOpens: true,
            appendTo: document.body,
        });
    }

    function closeModal() {
        const modal = document.getElementById('rt-modal');
        if (!modal) return;
        ['rt-round-date', 'rt-round-time'].forEach(function (id) {
            const input = document.getElementById(id);
            if (input && input._flatpickr) {
                try { input._flatpickr.destroy(); } catch (e) { /* ignore */ }
            }
        });
        modal.hidden = true;
        modal.innerHTML = '';
    }

    function showActionError(message) {
        const box = document.getElementById('rt-modal-error');
        if (box) {
            box.hidden = false;
            box.textContent = message;
            return;
        }
        S.error = message;
        render();
    }

    function pointsEditor(table) {
        const rows = (table && table.length ? table : DEFAULT_POINTS).map(function (pts, index) {
            return '<label class="rt-pt"><span>P' + (index + 1) + '</span><input data-pt type="number" min="0" max="500" step="1" value="' + esc(pts) + '"></label>';
        }).join('');
        return '<div id="rt-points" class="rt-points">' + rows + '</div>' +
            '<div class="rt-actions">' +
                '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="add-point">Add position</button>' +
                '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="reset-points">Grand Prix default</button>' +
            '</div>';
    }

    function roundChoices(includeNew) {
        const rounds = sortedRounds().filter(function (round) { return round.status !== 'completed'; });
        let html = includeNew ? '<option value="">New round from this race</option>' : '';
        html += rounds.map(function (round) {
            return '<option value="' + esc(round.id) + '">' + esc(round.title || 'Round') + ' · ' + esc(formatRoundWhen(round)) + '</option>';
        }).join('');
        return html;
    }

    function racePicks(races) {
        if (!races || !races.length) {
            return '<p class="rt-muted">No matching races on your recent Torn history. Paste a race ID below.</p>';
        }
        return '<div class="rt-race-list">' + races.map(function (race) {
            const when = race.start ? formatTct(race.start) : 'Time TBC';
            return '' +
                '<label class="rt-race-pick' + (race.alreadyUsed ? ' is-used' : '') + '">' +
                    '<input type="radio" name="rt-race" value="' + esc(race.id) + '"' + (race.alreadyUsed ? ' disabled' : '') + '>' +
                    '<span><strong>' + esc(race.title || 'Race') + '</strong>' +
                    '<small>' + esc(race.trackName || 'Track TBC') + ' · ' + esc(when) + ' · #' + esc(race.id) +
                    (race.alreadyUsed ? ' · already in this league' : '') + '</small></span>' +
                '</label>';
        }).join('') + '</div>';
    }

    function fieldValue(id) {
        const el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function selectedRaceId() {
        const typed = fieldValue('rt-race-id');
        if (typed) return typed;
        const picked = document.querySelector('#rt-modal input[name="rt-race"]:checked');
        return picked ? String(picked.value || '').trim() : '';
    }

    async function runAction(act, source) {
        let unlock = null;
        if (source && (source.tagName === 'BUTTON' || source.tagName === 'FORM')) {
            if (source.dataset.rtBusy === '1') return;
            source.dataset.rtBusy = '1';
            const buttons = source.tagName === 'FORM' ? source.querySelectorAll('button') : [source];
            buttons.forEach(function (button) { button.disabled = true; });
            unlock = function () {
                if (source.dataset) delete source.dataset.rtBusy;
                buttons.forEach(function (button) { button.disabled = false; });
            };
        }
        try {
            if (act === 'close-modal') {
                closeModal();
                return;
            }
            if (act === 'add-point') {
                const wrap = document.getElementById('rt-points');
                if (!wrap) return;
                const count = wrap.querySelectorAll('[data-pt]').length;
                if (count >= 30) return;
                wrap.insertAdjacentHTML('beforeend', '<label class="rt-pt"><span>P' + (count + 1) + '</span><input data-pt type="number" min="0" max="500" step="1" value="0"></label>');
                return;
            }
            if (act === 'reset-points') {
                const wrap = document.getElementById('rt-points');
                if (!wrap) return;
                wrap.innerHTML = DEFAULT_POINTS.map(function (pts, index) {
                    return '<label class="rt-pt"><span>P' + (index + 1) + '</span><input data-pt type="number" min="0" max="500" step="1" value="' + pts + '"></label>';
                }).join('');
                return;
            }
            if (act === 'open-create') {
                openModal('Create a league', '' +
                    '<form data-act="confirm-create">' +
                        '<label>League name<input id="rt-new-name" type="text" maxlength="60" required placeholder="Midnight Grand Prix"></label>' +
                        '<h3>Who can join</h3>' +
                        gateChoices('open') +
                        '<p class="rt-fine">You can change this later, and lock joining at any time. Points start at 25, 18, 15, 12, 10, 8, 6, 4, 2, 1.</p>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">Create league</button>' +
                    '</form>');
                return;
            }
            if (act === 'confirm-create') {
                const name = fieldValue('rt-new-name');
                const res = await call('racingCreateLeague', { apiKey: requireKey(), name: name, gate: selectedGate() || 'open' });
                closeModal();
                if (res && res.leagueId) location.hash = 'racing-tournaments/' + res.leagueId;
                return;
            }
            if (act === 'open-share') {
                const url = shareUrl(S.leagueId);
                openModal('Share link', '' +
                    '<p>' + esc(shareBlurb()) + '</p>' +
                    '<input id="rt-share-url" type="text" readonly value="' + esc(url) + '">' +
                    '<button type="button" class="rt-btn rt-btn-gold" data-act="copy-share">Copy link</button>');
                return;
            }
            if (act === 'copy-share') {
                const input = document.getElementById('rt-share-url');
                const url = input ? input.value : shareUrl(S.leagueId);
                const stay = source && source.getAttribute('data-stay') === '1';
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
                    else if (input) { input.focus(); input.select(); document.execCommand('copy'); }
                    else throw new Error('copy');
                    if (stay && source) {
                        source.textContent = 'Copied';
                        return;
                    }
                    S.notice = 'Share link copied.';
                    S.error = '';
                    closeModal();
                    render();
                } catch (e) {
                    showActionError('Select the link and copy it manually.');
                }
                return;
            }
            if (act === 'join') {
                await call('racingJoinLeague', { apiKey: requireKey(), leagueId: S.leagueId });
                S.notice = 'You are on the entry list. If you finish a filed race, your row is marked League.';
                S.error = '';
                if (S.me && S.league && !S.mine.some(function (l) { return l.leagueId === S.leagueId; })) {
                    S.mine.push({ leagueId: S.leagueId, leagueName: S.league.name, role: 'member' });
                }
                render();
                return;
            }
            if (act === 'leave') {
                await call('racingLeaveLeague', { apiKey: requireKey(), leagueId: S.leagueId });
                S.mine = S.mine.filter(function (l) { return l.leagueId !== S.leagueId; });
                S.notice = 'You left the league. Your past finishes stay on the table.';
                S.error = '';
                render();
                return;
            }
            if (act === 'view-current') {
                S.viewSeason = null;
                if (S.leagueId) watchRounds(S.leagueId, currentSeasonNumber());
                render();
                return;
            }
            if (act === 'view-season') {
                const season = Number(source && source.getAttribute('data-season'));
                if (!season || season === currentSeasonNumber()) {
                    S.viewSeason = null;
                    watchRounds(S.leagueId, currentSeasonNumber());
                } else {
                    S.viewSeason = season;
                    watchRounds(S.leagueId, season);
                }
                render();
                return;
            }
            if (act === 'add-prize-row') {
                const wrap = document.getElementById('rt-prize-rows');
                if (!wrap) return;
                if (wrap.querySelectorAll('[data-prize]').length >= 20) {
                    showActionError('Twenty prizes is the limit for one round.');
                    return;
                }
                wrap.insertAdjacentHTML('beforeend', prizeRowHtml(''));
                refreshPrizeLabels();
                const inputs = wrap.querySelectorAll('[data-prize]');
                if (inputs.length) inputs[inputs.length - 1].focus();
                return;
            }
            if (act === 'remove-prize-row') {
                const row = source && source.closest('.rt-prize-row');
                const wrap = document.getElementById('rt-prize-rows');
                if (!row || !wrap) return;
                row.remove();
                if (!wrap.querySelector('.rt-prize-row')) wrap.insertAdjacentHTML('beforeend', prizeRowHtml(''));
                refreshPrizeLabels();
                return;
            }
            if (act === 'edit-round') {
                const roundId = source && source.getAttribute('data-round');
                const round = roundId ? (S.rounds || []).find(function (item) { return item.id === roundId; }) : null;
                const existingPrizes = roundPrizeList(round);
                const prizeRows = (existingPrizes.length ? existingPrizes : ['']).map(function (value, index) {
                    return prizeRowHtml(value, index);
                }).join('');
                openModal(round ? 'Edit round' : 'Add a round', '' +
                    '<form data-act="confirm-round">' +
                        (round ? '<input type="hidden" id="rt-round-id" value="' + esc(round.id) + '">' : '') +
                        '<label>Round name<input id="rt-round-title" type="text" maxlength="80" required value="' + esc(round ? round.title : '') + '" placeholder="Round 1 — Uptown"></label>' +
                        '<div class="rt-when-row">' +
                            '<label>Race date<input id="rt-round-date" type="text" placeholder="Pick a date" autocomplete="off" value="' + esc(round ? round.scheduledDate : '') + '"></label>' +
                            '<label>Start time<input id="rt-round-time" type="text" placeholder="20:00" autocomplete="off" value="' + esc(round && round.scheduledTime ? round.scheduledTime : '') + '"></label>' +
                        '</div>' +
                        '<h3>Prizes</h3>' +
                        '<div id="rt-prize-rows" class="rt-prize-rows">' + prizeRows + '</div>' +
                        '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="add-prize-row">Add prize</button>' +
                        '<p class="rt-fine">1st Place is the first row. Times are TCT. The Torn track stays TBC until you open a race for entry.</p>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">' + (round ? 'Save round' : 'Add round') + '</button>' +
                    '</form>');
                bindRoundDate(round ? round.scheduledDate : '');
                bindRoundTime(round && round.scheduledTime ? round.scheduledTime : '');
                return;
            }
            if (act === 'confirm-round') {
                const roundId = fieldValue('rt-round-id');
                const scheduledDate = fieldValue('rt-round-date');
                const scheduledTime = fieldValue('rt-round-time');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
                    showActionError('Pick a race date.');
                    return;
                }
                if (!/^\d{1,2}:\d{2}$/.test(scheduledTime)) {
                    showActionError('Pick a start time.');
                    return;
                }
                const prizes = readPrizeRows();
                const payload = {
                    apiKey: requireKey(),
                    leagueId: S.leagueId,
                    title: fieldValue('rt-round-title'),
                    scheduledDate: scheduledDate,
                    scheduledTime: scheduledTime,
                    prizes: prizes,
                    prize: prizes[0] || '',
                };
                if (roundId) payload.roundId = roundId;
                await call(roundId ? 'racingUpdateRound' : 'racingCreateRound', payload);
                closeModal();
                S.notice = roundId ? 'Round updated.' : 'Round added. Race details stay TBC until you open entry.';
                S.error = '';
                render();
                return;
            }
            if (act === 'ask-delete-round') {
                const roundId = source && source.getAttribute('data-round');
                const round = (S.rounds || []).find(function (item) { return item.id === roundId; });
                openModal('Remove this round', '' +
                    '<p>Remove <strong>' + esc(round ? round.title : 'this round') + '</strong> from the current season? Filed results on it leave the table.</p>' +
                    '<button type="button" class="rt-btn rt-btn-danger" data-act="confirm-delete-round" data-round="' + esc(roundId) + '">Remove round</button>');
                return;
            }
            if (act === 'confirm-delete-round') {
                const roundId = source && source.getAttribute('data-round');
                await call('racingDeleteRound', { apiKey: requireKey(), leagueId: S.leagueId, roundId: roundId });
                closeModal();
                S.notice = 'Round removed.';
                S.error = '';
                render();
                return;
            }
            if (act === 'clear-entry') {
                const roundId = source && source.getAttribute('data-round');
                await call('racingClearRound', { apiKey: requireKey(), leagueId: S.leagueId, roundId: roundId });
                S.notice = 'Entry cleared. That round is TBC again.';
                S.error = '';
                render();
                return;
            }
            if (act === 'open-entry' || act === 'open-submit') {
                const mode = act === 'open-entry' ? 'entry' : 'submit';
                const roundId = (source && source.getAttribute('data-round')) || '';
                openModal(mode === 'entry' ? 'Open for entry' : 'Submit a race', '<p class="rt-muted">Checking races you have driven…</p>');
                let data = { open: [], finished: [] };
                let warn = '';
                try {
                    data = await call('racingSuggestRaces', { apiKey: requireKey(), leagueId: S.leagueId });
                } catch (e) {
                    warn = (e && e.message) ? e.message : 'Could not load your races.';
                }
                if (document.getElementById('rt-modal').hidden) return;
                const races = mode === 'entry' ? (data.open || []) : (data.finished || []);
                const roundField = roundId
                    ? '<input type="hidden" id="rt-target-round" value="' + esc(roundId) + '">'
                    : '<label>' + (mode === 'entry' ? 'Calendar round' : 'File it against') + '<select id="rt-target-round">' + roundChoices(mode !== 'entry') + '</select></label>';
                openModal(mode === 'entry' ? 'Open for entry' : 'Submit a race', '' +
                    (warn ? '<p class="rt-fine">' + esc(warn) + ' Listing your races needs a Minimal key or better. Pasting a race ID still works.</p>' : '') +
                    '<form data-act="' + (mode === 'entry' ? 'confirm-entry' : 'confirm-submit') + '">' +
                        racePicks(races) +
                        '<label>Race ID<input id="rt-race-id" type="text" inputmode="numeric" placeholder="Paste a Torn race ID"></label>' +
                        roundField +
                        '<p class="rt-fine">' + (mode === 'entry'
                            ? 'Create the race in Torn first, then pin it here. Only one race can be open. A finished race should be submitted as a result.'
                            : 'Suggestions are races you drove. Use a race ID when you could not enter.') + '</p>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">' + (mode === 'entry' ? 'Open entry' : 'File result') + '</button>' +
                    '</form>');
                const select = document.getElementById('rt-target-round');
                if (select && roundId) select.value = roundId;
                else if (select && mode === 'submit') {
                    const openRound = sortedRounds().find(function (round) { return round.status === 'open'; });
                    if (openRound) select.value = openRound.id;
                }
                return;
            }
            if (act === 'confirm-entry') {
                const raceId = selectedRaceId();
                const roundId = fieldValue('rt-target-round');
                await call('racingOpenRound', { apiKey: requireKey(), leagueId: S.leagueId, roundId: roundId, raceId: raceId });
                closeModal();
                S.notice = 'Entry is open. Drivers can see this race on the league.';
                S.error = '';
                render();
                return;
            }
            if (act === 'confirm-submit') {
                const raceId = selectedRaceId();
                const roundId = fieldValue('rt-target-round');
                const payload = { apiKey: requireKey(), leagueId: S.leagueId, raceId: raceId };
                if (roundId) payload.roundId = roundId;
                const res = await call('racingSubmitRace', payload);
                closeModal();
                S.notice = 'Result filed' + (res && res.drivers ? ' for ' + res.drivers + ' drivers.' : '.');
                S.error = '';
                render();
                return;
            }
            if (act === 'open-results') {
                const roundId = source && source.getAttribute('data-round');
                const round = (S.rounds || []).find(function (item) { return item.id === roundId; });
                if (!round) return;
                const table = activePoints();
                const results = Array.isArray(round.results) ? round.results : [];
                const roster = (S.league && S.league.roster) || {};
                const rows = results.map(function (result) {
                    const pos = result.position == null ? 'DNF' : result.position;
                    const pts = pointsForPosition(table, result.position);
                    const inLeague = !!roster[String(result.driverId)];
                    const prize = prizeForPosition(round, result.position);
                    const prizeNote = prize ? ' <span class="rt-prize-note">(' + esc(prize) + ')</span>' : '';
                    return '<tr class="' + (inLeague ? 'rt-row-league' : '') + '">' +
                        '<td class="rt-pos">' + esc(pos) + '</td>' +
                        '<td>' + driverLink(result.driverId, result.driverName) + prizeNote + memberChip(inLeague) + '</td>' +
                        '<td>' + esc(result.carName || '—') + '</td>' +
                        '<td class="rt-num">' + esc(formatRaceTime(result.raceTime)) + '</td>' +
                        '<td class="rt-num">' + esc(formatRaceTime(result.bestLap)) + '</td>' +
                        '<td class="rt-num">' + esc(pts) + '</td>' +
                    '</tr>';
                }).join('');
                openModal(round.title || 'Race result', '' +
                    '<p class="rt-muted">' + esc(round.race && round.race.trackName ? round.race.trackName : '') +
                    (round.tornRaceId ? ' · race #' + esc(round.tornRaceId) : '') + '</p>' +
                    prizeLines(round, true) +
                    '<div class="rt-table-wrap"><table class="rt-table"><thead><tr><th>P</th><th>Driver</th><th>Car</th><th>Time</th><th>Best lap</th><th>Pts</th></tr></thead><tbody>' +
                    (rows || '<tr><td colspan="6">No drivers stored.</td></tr>') +
                    '</tbody></table></div>');
                return;
            }
            if (act === 'open-league-settings') {
                const bits = [
                    '<div class="rt-settings-list">',
                    '<button type="button" class="rt-btn rt-btn-gold" data-act="copy-share" data-stay="1">Copy link</button>',
                    '<p class="rt-fine">' + esc(shareBlurb()) + '</p>',
                    '<button type="button" class="rt-btn rt-btn-ghost" data-act="toggle-lock">' + (joinLocked() ? 'Unlock joining' : 'Lock joining') + '</button>',
                    '<p class="rt-fine">Locking keeps everyone already on the list. New joins and new invites wait until you unlock.</p>',
                ];
                if (isOwner()) {
                    bits.push('<button type="button" class="rt-btn rt-btn-ghost" data-act="open-settings">Points &amp; prizes</button>');
                    bits.push('<button type="button" class="rt-btn rt-btn-ghost" data-act="open-admins">Admins</button>');
                    bits.push('<button type="button" class="rt-btn rt-btn-ghost" data-act="ask-archive">Archive season</button>');
                    bits.push('<button type="button" class="rt-btn rt-btn-danger" data-act="ask-delete-league">Delete league</button>');
                }
                bits.push('</div>');
                openModal('League settings', bits.join(''));
                return;
            }
            if (act === 'add-grand-row') {
                const wrap = document.getElementById('rt-grand-rows');
                if (!wrap) return;
                if (wrap.querySelectorAll('[data-gprize]').length >= 20) {
                    showActionError('Twenty grand prizes is the limit.');
                    return;
                }
                wrap.insertAdjacentHTML('beforeend', grandRowHtml(''));
                refreshGrandRows();
                const inputs = wrap.querySelectorAll('[data-gprize]');
                if (inputs.length) inputs[inputs.length - 1].focus();
                return;
            }
            if (act === 'remove-grand-row') {
                const row = source && source.closest('.rt-prize-row');
                const wrap = document.getElementById('rt-grand-rows');
                if (!row || !wrap) return;
                if (wrap.querySelectorAll('.rt-prize-row').length <= 1) return;
                row.remove();
                refreshGrandRows();
                return;
            }
            if (act === 'open-settings') {
                const values = grandPrizeFormValues();
                const rows = values.map(function (value, index) { return grandRowHtml(value, index); }).join('');
                openModal('Points and prizes', '' +
                    '<form data-act="confirm-settings">' +
                        '<label>League name<input id="rt-set-name" type="text" maxlength="60" required value="' + esc(S.league.name || '') + '"></label>' +
                        '<h3>Who can join</h3>' +
                        gateChoices(leagueGate()) +
                        '<h3>Points by finish</h3>' +
                        pointsEditor(activePoints()) +
                        '<h3>Grand prizes</h3>' +
                        '<div id="rt-grand-rows" class="rt-prize-rows">' + rows + '</div>' +
                        '<button type="button" class="rt-btn rt-btn-tiny rt-btn-ghost" data-act="add-grand-row">Add place</button>' +
                        '<p class="rt-fine">Starts with 1st, 2nd and 3rd. Add more places, or remove down to one. Changing the points rescores the live season.</p>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">Save</button>' +
                    '</form>');
                refreshGrandRows();
                return;
            }
            if (act === 'confirm-settings') {
                const points = [...document.querySelectorAll('#rt-points [data-pt]')].map(function (input) {
                    return input.value;
                });
                const places = readGrandRows();
                await call('racingUpdateLeague', {
                    apiKey: requireKey(),
                    leagueId: S.leagueId,
                    name: fieldValue('rt-set-name'),
                    gate: selectedGate() || leagueGate(),
                    pointsTable: points,
                    grandPrizes: {
                        places: places,
                        first: places[0] || '',
                        second: places[1] || '',
                        third: places[2] || '',
                    },
                });
                closeModal();
                S.notice = 'Settings saved. The live table is using the new points.';
                S.error = '';
                render();
                return;
            }
            if (act === 'open-admins') {
                const admins = rosterEntries().filter(function (entry) { return entry.role === 'admin'; });
                const picks = adminCandidates();
                const list = admins.length
                    ? '<ul class="rt-admin-list">' + admins.map(function (entry) {
                        return '<li>' + esc(entry.name || entry.id) + ' <span class="rt-muted">[' + esc(entry.id) + ']</span> ' +
                            '<button type="button" class="rt-btn rt-btn-tiny rt-btn-danger" data-act="confirm-remove-admin" data-player="' + esc(entry.id) + '">Remove admin</button></li>';
                    }).join('') + '</ul>'
                    : '<p class="rt-muted">No admins yet. Admins can add rounds and file races. They do not need VIP.</p>';
                const choices = picks.length
                    ? '<div class="rt-race-list">' + picks.map(function (person) {
                        return '<label class="rt-race-pick">' +
                            '<input type="radio" name="rt-admin-pick" value="' + esc(person.id) + '">' +
                            '<span><strong>' + esc(person.name) + '</strong><small>' + esc(person.note) + ' · ' + esc(person.id) + '</small></span>' +
                        '</label>';
                    }).join('') + '</div>'
                    : '<p class="rt-muted">No joined drivers or filed finishers yet. Enter a Torn ID below.</p>';
                openModal('League admins', '' +
                    list +
                    '<form data-act="confirm-add-admin">' +
                        '<h3>Pick a driver</h3>' +
                        choices +
                        '<label>Or Torn player ID<input id="rt-admin-id" type="text" inputmode="numeric" placeholder="2935825"></label>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">Make admin</button>' +
                    '</form>');
                return;
            }
            if (act === 'confirm-add-admin') {
                const typed = fieldValue('rt-admin-id');
                const picked = document.querySelector('#rt-modal input[name="rt-admin-pick"]:checked');
                const playerId = typed || (picked ? String(picked.value || '') : '');
                if (!/^\d{1,12}$/.test(playerId)) {
                    showActionError('Pick a driver or enter their Torn ID.');
                    return;
                }
                await call('racingAddAdmin', {
                    apiKey: requireKey(),
                    leagueId: S.leagueId,
                    playerId: playerId,
                });
                closeModal();
                S.notice = 'Admin added. They can submit races for this league.';
                S.error = '';
                render();
                return;
            }
            if (act === 'confirm-remove-admin') {
                const playerId = source && source.getAttribute('data-player');
                await call('racingRemoveAdmin', { apiKey: requireKey(), leagueId: S.leagueId, playerId: playerId });
                S.notice = 'Admin removed. They stay on the entry list as a driver.';
                S.error = '';
                closeModal();
                render();
                return;
            }
            if (act === 'toggle-lock') {
                const locked = !joinLocked();
                await call('racingSetJoinLock', { apiKey: requireKey(), leagueId: S.leagueId, locked: locked });
                if (S.league) S.league.joinLocked = locked;
                S.notice = locked ? 'Joining is locked. Nobody new can get on the list.' : 'Joining is unlocked.';
                S.error = '';
                closeModal();
                render();
                return;
            }
            if (act === 'open-invite') {
                const gateNote = leagueGate() === 'faction'
                    ? 'Own faction is on, so Torn must show them in your faction.'
                    : leagueGate() === 'invite'
                        ? 'They cannot join from the link. This puts them on the list.'
                        : 'They could also join themselves while the event is open.';
                openModal('Add a driver', '' +
                    '<form data-act="confirm-invite">' +
                        '<label>Torn player ID<input id="rt-invite-id" type="text" inputmode="numeric" required placeholder="2935825"></label>' +
                        '<p class="rt-fine">' + esc(gateNote) + (joinLocked() ? ' Joining is locked, so this will be refused until you unlock.' : '') + '</p>' +
                        '<button type="submit" class="rt-btn rt-btn-gold">Add driver</button>' +
                    '</form>');
                return;
            }
            if (act === 'confirm-invite') {
                const res = await call('racingInviteDriver', {
                    apiKey: requireKey(),
                    leagueId: S.leagueId,
                    playerId: fieldValue('rt-invite-id'),
                });
                closeModal();
                S.notice = res && res.alreadyIn ? (res.name || 'That driver') + ' is already on the list.' : (res && res.name ? res.name : 'Driver') + ' added.';
                S.error = '';
                render();
                return;
            }
            if (act === 'ask-remove-driver') {
                const playerId = source && source.getAttribute('data-player');
                const name = source && source.getAttribute('data-name');
                openModal('Remove driver', '' +
                    '<p>Remove <strong>' + esc(name || 'this driver') + '</strong> from the league? Their past finishes stay on archived seasons. They drop off the live entry list.</p>' +
                    '<button type="button" class="rt-btn rt-btn-danger" data-act="confirm-remove-driver" data-player="' + esc(playerId) + '">Remove from league</button>');
                return;
            }
            if (act === 'confirm-remove-driver') {
                const playerId = source && source.getAttribute('data-player');
                await call('racingRemoveDriver', { apiKey: requireKey(), leagueId: S.leagueId, playerId: playerId });
                closeModal();
                S.notice = 'Driver removed from the league.';
                S.error = '';
                render();
                return;
            }
            if (act === 'ask-archive') {
                openModal('Archive this season', '' +
                    '<p>Season ' + currentSeasonNumber() + ' is frozen: standings, points, and grand prizes stay viewable. The next season starts with an empty calendar.</p>' +
                    '<p>Who stays on the entry list?</p>' +
                    '<div class="rt-actions">' +
                        '<button type="button" class="rt-btn rt-btn-gold" data-act="confirm-archive" data-keep="1">Keep everyone</button>' +
                        '<button type="button" class="rt-btn rt-btn-ghost" data-act="confirm-archive" data-keep="0">Start fresh</button>' +
                    '</div>' +
                    '<p class="rt-fine">Start fresh removes drivers. You and your admins stay.</p>');
                return;
            }
            if (act === 'confirm-archive') {
                const keepRoster = !(source && source.getAttribute('data-keep') === '0');
                const res = await call('racingArchiveSeason', { apiKey: requireKey(), leagueId: S.leagueId, keepRoster: keepRoster });
                if (!keepRoster && S.league && S.league.roster) {
                    const nextRoster = {};
                    Object.keys(S.league.roster).forEach(function (id) {
                        const entry = S.league.roster[id];
                        if (entry && (entry.role === 'owner' || entry.role === 'admin')) nextRoster[id] = entry;
                    });
                    S.league.roster = nextRoster;
                }
                closeModal();
                S.viewSeason = null;
                if (S.league && res && res.seasonNumber) {
                    S.league.seasonNumber = res.seasonNumber;
                    S.league.seasonLabel = 'Season ' + res.seasonNumber;
                    watchRounds(S.leagueId, Number(res.seasonNumber));
                }
                S.notice = 'Season archived. You are on Season ' + ((res && res.seasonNumber) || (currentSeasonNumber() + 1)) + '.' +
                    (res && res.keptRoster === false ? ' Drivers were cleared.' : ' The entry list was kept.');
                S.error = '';
                render();
                return;
            }
            if (act === 'ask-delete-league') {
                openModal('Delete this league', '' +
                    '<p>This removes every season, result, and member. It cannot be undone.</p>' +
                    '<form data-act="confirm-delete-league">' +
                        '<label>Type the league name to confirm<input id="rt-delete-name" type="text" required></label>' +
                        '<button type="submit" class="rt-btn rt-btn-danger">Delete league</button>' +
                    '</form>');
                return;
            }
            if (act === 'confirm-delete-league') {
                const typed = fieldValue('rt-delete-name');
                if (typed !== String(S.league && S.league.name || '')) {
                    showActionError('That does not match the league name.');
                    return;
                }
                await call('racingDeleteLeague', { apiKey: requireKey(), leagueId: S.leagueId });
                closeModal();
                location.hash = 'racing-tournaments';
                return;
            }
        } catch (err) {
            const message = (err && err.message) ? String(err.message).replace(/^Firebase:\s*/i, '') : 'Something went wrong.';
            showActionError(message);
        } finally {
            if (unlock) unlock();
        }
    }

    function onClick(event) {
        const root = document.getElementById('rt-root');
        const btn = event.target.closest('button[data-act], .rt-modal-backdrop[data-act]');
        if (!btn || !root || !root.contains(btn)) return;
        event.preventDefault();
        runAction(btn.getAttribute('data-act'), btn);
    }

    function onKey(event) {
        if (event.key === 'Escape') closeModal();
    }

    async function initRacingTournaments() {
        ensureFont();
        stopListeners();
        S.leagueId = parseLeagueId();
        S.league = null;
        S.missing = false;
        S.rounds = [];
        S.seasons = [];
        S.viewSeason = null;
        S.error = '';
        S.notice = '';
        S.hubError = '';
        S.loadingLeague = !!S.leagueId;
        const root = document.getElementById('rt-root');
        if (root && root.dataset.bound !== '1') {
            root.dataset.bound = '1';
            root.addEventListener('click', onClick);
        }
        if (!window.__rtKeyListener) {
            window.__rtKeyListener = true;
            document.addEventListener('keydown', onKey);
        }
        if (window.__rtTick) clearInterval(window.__rtTick);
        window.__rtTick = setInterval(tickCountdown, 1000);
        render();

        const key = apiKey();
        if (key.length === 16) {
            call('racingListMine', { apiKey: key }).then(function (data) {
                S.me = { playerId: String(data.playerId || ''), name: data.name || '' };
                S.serverVip = Number(data.vipLevel) || 0;
                S.mine = Array.isArray(data.leagues) ? data.leagues : [];
                S.hubError = '';
                render();
            }).catch(function (err) {
                S.hubError = (err && err.message) ? String(err.message).replace(/^Firebase:\s*/i, '') : 'Could not load your leagues.';
                render();
            });
        }

        if (S.leagueId) {
            if (typeof firebase === 'undefined' || !firebase.firestore) {
                S.loadingLeague = false;
                S.error = 'Firebase did not load. Refresh the page.';
                render();
                return;
            }
            watchLeague(S.leagueId);
        }
    }

    window.initRacingTournaments = initRacingTournaments;
})();
