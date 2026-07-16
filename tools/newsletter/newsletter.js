/**
 * Faction Newsletter — Upcoming War template.
 * Builds Torn faction-mail HTML with section toggles and API-filled blocks.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'newsletter_war_draft_v1';
    /** Section copy (intro, strategy, enemy analysis, closing) — saved separately so it always persists. */
    const SECTION_TEXT_STORAGE_KEY = 'newsletter_section_text_v1';
    /** Persists war rule toggles + custom rules across drafts (localStorage). */
    const WAR_RULES_STORAGE_KEY = 'newsletter_war_rules_v2';
    const PAYOUT_RULES_STORAGE_KEY = 'newsletter_payout_rules_v3';
    const INCENTIVE_COMPETITIONS_STORAGE_KEY = 'newsletter_incentive_competitions_v1';

    /**
     * Built-in war rules by category. inputType:
     * - win_lose: Win / Lose select
     * - score: numeric target score
     * - scoring_limit: stop at score OR keep hitting till we win
     */
    const WAR_RULE_CATEGORIES = [
        {
            id: 'real_war',
            title: 'Real War!!!',
            rules: [
                { id: 'real-hosp-online', text: 'Hospitalise Online Players as Priority', defaultOn: true },
                { id: 'real-revives-off', text: 'Turn Your Revives off', defaultOn: true },
                { id: 'real-fly-offline', text: 'Fly or Self Hospitalise before going offline', defaultOn: true },
                { id: 'real-chain', text: 'Keep Chain alive at all costs', defaultOn: true },
                { id: 'real-online-pushes', text: 'Be online at war start and all pushes', defaultOn: true }
            ]
        },
        {
            id: 'termed_war',
            title: 'Termed War',
            rules: [
                {
                    id: 'termed-offline-only',
                    text: 'Only hit Offline players (Med Pacts are allowed)',
                    defaultOn: true
                },
                {
                    id: 'termed-win-lose',
                    inputType: 'win_lose',
                    defaultOn: true,
                    defaultValue: 'Win'
                },
                {
                    id: 'termed-loser-score',
                    inputType: 'score',
                    defaultOn: true
                },
                {
                    id: 'termed-scoring-limit',
                    inputType: 'scoring_limit',
                    defaultOn: true,
                    defaultMode: 'stop'
                }
            ]
        }
    ];

    /**
     * Flat rule pickers (payout, incentives) — same UX as war rules without categories.
     * inputType inline_text: before + input + after; chain_prize: chain target + prize text.
     */
    const FLAT_SECTION_RULE_SETS = {
        payout: {
            storageKey: PAYOUT_RULES_STORAGE_KEY,
            stateKey: 'payoutRules',
            selectedCategoryStateKey: 'selectedPayoutCategory',
            hint: 'Choose Respect-based or Hit-based payout — options for that type appear below.',
            addPlaceholder: 'Add a custom payout rule…',
            mailHeading: 'Payout method',
            emptyMail: 'No payout rules selected — tick items in the Payout method panel.',
            categories: [
                {
                    id: 'respect_based',
                    title: 'Respect-based',
                    mailLine: 'Respect-based payout',
                    rules: [
                        {
                            id: 'respect-outside',
                            text: 'Outside respect is paid',
                            defaultOn: false
                        },
                        {
                            id: 'respect-assists',
                            text: 'Assists are paid',
                            defaultOn: false
                        },
                        {
                            id: 'respect-chain-excluded',
                            text: 'Chain bonuses are excluded',
                            defaultOn: true
                        },
                        {
                            id: 'respect-minimum',
                            inputType: 'min_or',
                            before: 'Minimum ',
                            primaryAfter: ' respect required for pay or ',
                            after: ' assists',
                            primaryPlaceholder: '50',
                            secondaryPlaceholder: '10',
                            defaultOn: true
                        },
                        {
                            id: 'respect-max-cap',
                            inputType: 'inline_text',
                            before: 'Maximum respect cap of ',
                            after: '',
                            placeholder: '50000',
                            defaultOn: true
                        }
                    ]
                },
                {
                    id: 'hit_based',
                    title: 'Hit-based',
                    mailLine: 'Hit-based payout',
                    rules: [
                        {
                            id: 'hit-outside',
                            text: 'Outside hits are paid',
                            defaultOn: false
                        },
                        {
                            id: 'hit-assists',
                            text: 'Assists are paid',
                            defaultOn: false
                        },
                        {
                            id: 'hit-retal-bonus',
                            text: 'Retals and war hits get a bonus',
                            defaultOn: false
                        },
                        {
                            id: 'hit-minimum',
                            inputType: 'inline_text',
                            before: 'Minimum ',
                            after: ' hits/assists required for pay',
                            placeholder: '10',
                            defaultOn: true
                        },
                        {
                            id: 'hit-max',
                            inputType: 'inline_text',
                            before: 'Maximum ',
                            after: ' hits',
                            placeholder: '20',
                            defaultOn: true
                        }
                    ]
                }
            ]
        }
    };

    /** War competitions with place-based prizes (Competitions & incentives section). */
    const COMPETITION_TYPES = [
        { id: 'most_hits', label: 'Most war hits' },
        { id: 'most_respect', label: 'Most respect' },
        { id: 'most_assists', label: 'Most assists' },
        { id: 'most_active', label: 'Most active' }
    ];

    const COMPETITION_MAX_PLACES = 5;
    const COMPETITION_DEFAULT_PLACES = 3;

    /** Solid panel colours (only style Torn mail reliably keeps). */
    const PANEL_BG_PRESETS = [
        { label: 'Black', color: '#0a0a0a' },
        { label: 'Charcoal', color: '#1a1a22' },
        { label: 'War dusk', color: '#100818' },
        { label: 'Navy', color: '#061018' },
        { label: 'Forest', color: '#060c08' },
        { label: 'Slate', color: '#2a2a35' }
    ];

    /** Old theme IDs from drafts → hex panel colour */
    const LEGACY_THEME_TO_HEX = {
        classic: '#0a0a0a',
        'theme-space': '#06060f',
        'theme-nebula': '#0a0618',
        'theme-fire': '#120605',
        'theme-ember': '#14100c',
        'theme-ice': '#061018',
        'theme-frost': '#0c1420',
        'theme-woodland': '#060c08',
        'theme-grove': '#080e14',
        'theme-war-dusk': '#100818',
        'theme-blood-moon': '#0c0408',
        'theme-vault': '#060a10',
        'theme-rally': '#0e0c14',
        rally: '#0e0c14',
        steel: '#060a10',
        ember: '#14100c',
        banner: '#0e0c14',
        'gradient-rally': '#0e0c14',
        'gradient-steel': '#060a10',
        'gradient-ember': '#14100c',
        'gradient-spotlight': '#0e0c14',
        'photo-brick-dark': '#100818',
        'photo-brick-red': '#0c0408',
        'tile-brick-dark': '#100818',
        'tile-ice': '#061018',
        'tile-blood': '#0c0408',
        'tile-purple': '#0e0c14'
    };

    /** Readable order for war rally mail. */
    const WAR_SECTIONS = [
        { id: 'intro', label: 'Opening rally', defaultOn: true, fieldLabel: 'Opening message', placeholder: 'Faction mates - ranked war is coming. Read everything below and be ready.' },
        { id: 'war_overview', label: 'War overview', defaultOn: true, auto: true },
        { id: 'war_rules', label: 'War rules & terms', defaultOn: true, rulesPicker: true },
        { id: 'strategy', label: 'Strategy', defaultOn: true, fieldLabel: 'Strategy', placeholder: 'Chains, timing, who hits whom, hospital rules...' },
        { id: 'enemy_stats', label: 'Enemy stats', defaultOn: true, auto: true },
        { id: 'enemy_analysis', label: 'Enemy analysis', defaultOn: true, fieldLabel: 'Enemy analysis notes', placeholder: 'Key targets, chains to watch, respect gap, etc. Full enemy roster (3 columns) is included when war data is loaded.' },
        { id: 'payout', label: 'Payout method', defaultOn: true, rulesPicker: true, flatRulesId: 'payout' },
        { id: 'incentives', label: 'Competitions & incentives', defaultOn: false, competitionsPicker: true },
        { id: 'closing', label: 'Closing rally', defaultOn: true, fieldLabel: 'Closing message', placeholder: 'Show up strong. Questions -> faction chat or leaders.' }
    ];

    const ACCENT_COLORS = {
        gold: '#d4a84b',
        violet: '#8f70ff',
        blue: '#5b9bd5',
        crimson: '#c45c5c'
    };

    const state = {
        ourFactionId: null,
        ourFactionName: '',
        ourFactionTag: '',
        enemyFactionId: null,
        enemyFactionName: '',
        enemyBasic: null,
        ourBasic: null,
        war: null,
        warKind: null,
        enemyChain: null,
        enemyMembers: [],
        enemySummary: null,
        /** FF Scouter bs_estimate by member id (same source as Faction Battle Stats). */
        enemyBattleStats: {},
        sectionEnabled: {},
        sectionText: {},
        /** { id, text, enabled, custom?, category, values? }[] — loaded from WAR_RULES_STORAGE_KEY */
        warRules: [],
        /** Active war type in editor + mail: real_war | termed_war */
        selectedWarRuleCategory: 'real_war',
        /** Flat rule pickers — payout & incentives */
        payoutRules: [],
        selectedPayoutCategory: 'respect_based',
        /** { id, typeId, placeCount, prizes[] } */
        competitions: [],
        /** Free-text incentives appended in mail */
        customIncentives: [],
        loading: false
    };

    function normalizeWarRuleCategoryId(cat) {
        return cat === 'termed_war' ? 'termed_war' : 'real_war';
    }

    function getActiveWarRuleCategoryId() {
        return normalizeWarRuleCategoryId(state.selectedWarRuleCategory);
    }

    function getWarRuleCategoryDef(catId) {
        const id = normalizeWarRuleCategoryId(catId);
        for (let i = 0; i < WAR_RULE_CATEGORIES.length; i++) {
            if (WAR_RULE_CATEGORIES[i].id === id) return WAR_RULE_CATEGORIES[i];
        }
        return WAR_RULE_CATEGORIES[0];
    }

    function setSelectedWarRuleCategory(catId) {
        state.selectedWarRuleCategory = normalizeWarRuleCategoryId(catId);
        saveWarRulesPrefs();
        renderWarRulesPicker();
        renderPreview();
    }

    function getApiKey() {
        return (localStorage.getItem('tornApiKey') || '').trim();
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function tornApiErrorToMessage(errField) {
        if (errField == null) return 'Unknown API error';
        if (typeof errField === 'string') return errField;
        if (typeof errField === 'object') {
            if (typeof errField.error === 'string') return errField.error;
            if (typeof errField.message === 'string') return errField.message;
            try {
                return JSON.stringify(errField);
            } catch (e) {
                return String(errField);
            }
        }
        return String(errField);
    }

    async function fetchJson(url) {
        const tornUrl = typeof window.getTornApiFetchUrl === 'function' ? window.getTornApiFetchUrl(url) : url;
        const res = await fetch(tornUrl);
        const data = await res.json();
        if (data.error) throw new Error(tornApiErrorToMessage(data.error));
        return data;
    }

    function rankedWarFactionId(f) {
        if (!f) return null;
        const id = f.id != null ? f.id : f.faction_id != null ? f.faction_id : null;
        return id != null && String(id).trim() !== '' ? String(id) : null;
    }

    function formatTctUnix(unixSec) {
        if (!unixSec) return '-';
        const d = new Date(Number(unixSec) * 1000);
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const pad = (n) => String(n).padStart(2, '0');
        return (
            days[d.getUTCDay()] +
            ' ' +
            d.getUTCDate() +
            ' ' +
            months[d.getUTCMonth()] +
            ', ' +
            pad(d.getUTCHours()) +
            ':' +
            pad(d.getUTCMinutes()) +
            ' TCT'
        );
    }

    function formatNumber(n) {
        if (n == null || isNaN(n)) return '-';
        return Number(n).toLocaleString('en-US');
    }

    /** Display FF Scouter estimated total stats (Faction Battle Stats format). */
    function formatEstimatedBattleStat(bs) {
        if (bs == null || bs === '' || bs === 'N/A') return '—';
        if (typeof bs === 'number' && !isNaN(bs)) return bs.toLocaleString('en-US');
        const n = parseFloat(String(bs).replace(/,/g, ''));
        if (isNaN(n)) return '—';
        return n.toLocaleString('en-US');
    }

    /** Numeric value for sorting FF Scouter estimates (null when missing). */
    function parseBattleStatSortValue(bs) {
        if (bs == null || bs === '' || bs === 'N/A') return null;
        if (typeof bs === 'number' && !isNaN(bs)) return bs;
        const n = parseFloat(String(bs).replace(/,/g, ''));
        return isNaN(n) ? null : n;
    }

    function sortEnemyRoster(members) {
        return members.slice().sort(function (a, b) {
            const aBs = parseBattleStatSortValue(a.bs);
            const bBs = parseBattleStatSortValue(b.bs);
            if (aBs != null && bBs != null) {
                if (bBs !== aBs) return bBs - aBs;
            } else if (aBs != null) return -1;
            else if (bBs != null) return 1;
            return (b.level || 0) - (a.level || 0) || String(a.name || '').localeCompare(String(b.name || ''));
        });
    }

    function attachBattleStatsToSummary(summary, bsMap) {
        if (!summary || !summary.allMembers) return;
        summary.allMembers = summary.allMembers.map(function (m) {
            const id = String(m.id);
            const bs = bsMap && (bsMap[id] != null ? bsMap[id] : bsMap[m.id]);
            return {
                id: m.id,
                name: m.name,
                level: m.level,
                bs: bs != null && bs !== '' ? bs : null
            };
        });
        summary.allMembers = sortEnemyRoster(summary.allMembers);
    }

    async function fetchEnemyBattleStats(apiKey, memberIds) {
        if (!memberIds || !memberIds.length) return {};
        const fn = window.getFFAndBattleStatsForMembers;
        if (typeof fn !== 'function') {
            console.warn('[newsletter] getFFAndBattleStatsForMembers not available (main app not loaded).');
            return {};
        }
        const result = await fn(apiKey, memberIds);
        return (result && result.bs) || {};
    }

    function resolveBodyTextTone() {
        const tone = document.getElementById('newsletter-text-tone')?.value || 'light';
        return tone === 'dark' ? 'dark' : 'light';
    }

    function getContentTextColor() {
        return resolveBodyTextTone() === 'light' ? '#e8e8e8' : '#2a2a2a';
    }

    function isBodyTextLight() {
        return resolveBodyTextTone() === 'light';
    }

    function normalizeHexColor(value) {
        let s = String(value || '').trim();
        if (!s) return '#0a0a0a';
        if (!s.startsWith('#')) s = '#' + s;
        if (/^#[0-9a-fA-F]{3}$/.test(s)) {
            s =
                '#' +
                s[1] +
                s[1] +
                s[2] +
                s[2] +
                s[3] +
                s[3];
        }
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        return '#0a0a0a';
    }

    function getPanelBgHex() {
        const el = document.getElementById('newsletter-panel-color');
        return normalizeHexColor(el && el.value ? el.value : '#0a0a0a');
    }

    function setPanelBgHex(hex) {
        const el = document.getElementById('newsletter-panel-color');
        if (el) el.value = normalizeHexColor(hex);
        syncPanelColorPicker();
    }

    function syncPanelColorPicker() {
        const hex = getPanelBgHex();
        document.querySelectorAll('#newsletter-panel-bg-picker .newsletter-bg-option').forEach(function (btn) {
            const on = btn.dataset.color === hex;
            btn.classList.toggle('newsletter-bg-option--selected', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function renderPanelColorPicker() {
        const grid = document.getElementById('newsletter-panel-bg-picker');
        if (!grid) return;
        grid.innerHTML = '';
        PANEL_BG_PRESETS.forEach(function (preset) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'newsletter-bg-option';
            btn.dataset.color = preset.color;
            btn.setAttribute('aria-pressed', 'false');
            btn.title = preset.label;
            btn.style.backgroundColor = preset.color;
            btn.style.backgroundImage = 'none';
            const cap = document.createElement('span');
            cap.className = 'newsletter-bg-option-label';
            cap.textContent = preset.label;
            btn.appendChild(cap);
            btn.addEventListener('click', function () {
                setPanelBgHex(preset.color);
                saveDraft();
                renderPreview();
            });
            grid.appendChild(btn);
        });
        syncPanelColorPicker();
    }

    function buildPanelStyle() {
        return (
            'padding:14px 12px;border-radius:5px;box-sizing:border-box;display:block;' +
            'background-color:' +
            getPanelBgHex() +
            ';background-image:none;color:' +
            getContentTextColor() +
            ';'
        );
    }

    function bodyTextStyle(base) {
        let s = base || '';
        if (s && s.charAt(s.length - 1) !== ';') s += ';';
        s += 'color:' + getContentTextColor() + ';';
        return s;
    }

    function bodyPStyle(extra) {
        return bodyTextStyle('line-height:1.5;margin:0;margin-top:8px;' + (extra || ''));
    }

    function bodyBoxBorderStyle() {
        return isBodyTextLight() ? '#666666' : '#999999';
    }

    function textToParagraphsHtml(text) {
        const raw = String(text || '').trim();
        if (!raw) return '';
        return raw
            .split(/\n\s*\n/)
            .map(function (block) {
                const inner = esc(block.trim()).replace(/\n/g, '<br>');
                return '<p style="' + bodyPStyle() + '">' + inner + '</p>';
            })
            .join('');
    }

    function getAccentHex() {
        const sel = document.getElementById('newsletter-accent');
        const key = sel && sel.value ? sel.value : 'gold';
        return ACCENT_COLORS[key] || ACCENT_COLORS.gold;
    }

    function subtitleTextStyleAttr() {
        return (
            'line-height:1.4;margin:8px 0 0 0;text-align:center;font-size:13px;color:' +
            getContentTextColor() +
            ';'
        );
    }

    function sectionHeading(title) {
        const accent = getAccentHex();
        return (
            '<h2 style="font-size:16px;margin:0;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-top:24px;' +
            'background:#000000;color:#f5f5f5;padding:8px 10px 8px 12px;border-radius:3px;border-left:4px solid ' +
            accent +
            ';">' +
            esc(title) +
            '</h2>'
        );
    }

    function getResolvedFactionDisplayName() {
        const name = (state.ourFactionName || '').trim();
        if (name && name !== 'Our faction') return name;
        return '';
    }

    function shouldShowFactionNameInHeader() {
        if (document.getElementById('newsletter-show-faction-name')?.checked === false) return false;
        return !!getResolvedFactionDisplayName();
    }

    function buildHeaderBlock(opts) {
        const accent = opts.accent;
        const tag = opts.useTag && state.ourFactionTag ? '[' + state.ourFactionTag + '] ' : '';
        const displayName = getResolvedFactionDisplayName();
        const linkOn = document.getElementById('newsletter-link-faction')?.checked !== false;
        const fid = state.ourFactionId;
        let nameHtml = esc(displayName);
        if (linkOn && fid && displayName) {
            nameHtml =
                '<a href="https://www.torn.com/factions.php?step=profile&amp;ID=' +
                encodeURIComponent(String(fid)) +
                '">' +
                nameHtml +
                '</a>';
        }
        const titleRaw = document.getElementById('newsletter-title')?.value?.trim() || defaultMailTitle();
        const subtitle = document.getElementById('newsletter-subtitle')?.value?.trim() || '';

        let html = '';
        html +=
            '<div class="top" style="width:72px;height:2px;background:linear-gradient(90deg, transparent 0%, ' +
            accent +
            ' 50%, transparent 100%);margin:0 auto 10px auto;">&nbsp;</div>';
        html +=
            '<h1 style="margin:0;font-size:24px;text-align:center;text-transform:uppercase;font-weight:bold;letter-spacing:2px;line-height:1.3;color:' +
            getContentTextColor() +
            ';">' +
            (tag ? esc(tag) : '') +
            buildMailTitleHtml(titleRaw, accent) +
            '</h1>';
        if (subtitle) {
            html += '<p style="' + subtitleTextStyleAttr() + '">' + esc(subtitle) + '</p>';
        }
        if (shouldShowFactionNameInHeader()) {
            html +=
                '<p style="' +
                bodyTextStyle('line-height:1.4;margin:6px 0 0 0;text-align:center;font-size:12px;') +
                '">' +
                nameHtml +
                '</p>';
        }
        html +=
            '<div class="bottom" style="width:72px;height:2px;background:linear-gradient(90deg, transparent 0%, ' +
            accent +
            ' 50%, transparent 100%);margin:10px auto 0 auto;">&nbsp;</div>';
        return html;
    }

    /** Mail title with accent-coloured "vs" when present (Torn mail keeps inline colour). */
    function buildMailTitleHtml(titleLine, accent) {
        const match = String(titleLine || '').match(/^(.+?)\s+vs\s+(.+)$/i);
        if (!match) return esc(titleLine);
        return (
            esc(match[1].trim()) +
            ' <span style="color:' +
            accent +
            ';">vs</span> ' +
            esc(match[2].trim())
        );
    }

    function defaultMailTitle() {
        if (!hasNewsletterEnemySelected()) return 'War briefing';
        const ours = state.ourFactionName || 'Our faction';
        const enemy = state.enemyFactionName || 'Enemy';
        return ours + ' vs ' + enemy;
    }

    function hasNewsletterEnemySelected() {
        const fromState = state.enemyFactionId != null && String(state.enemyFactionId).trim() !== '';
        if (fromState) return true;
        const input = document.getElementById('newsletter-enemy-id');
        return !!(input && String(input.value || '').trim());
    }

    /** Grey placeholder hint — never write defaults into the input value. */
    function syncMailTitlePlaceholder() {
        const t = document.getElementById('newsletter-title');
        if (!t) return;
        t.placeholder = defaultMailTitle();
    }

    function buildWarOverviewSection() {
        if (!state.war) {
            return sectionHeading('War overview') + '<p style="' + bodyPStyle() + '">Load war data to fill this section.</p>';
        }
        const w = state.war;
        const enemy = state.enemyFactionName || 'Enemy';
        const kindLabel = state.warKind === 'upcoming' ? 'Upcoming ranked war' : 'Ongoing ranked war';
        let target = '-';
        if (w.target != null) target = formatNumber(w.target);
        else if (w.war && w.war.target != null) target = formatNumber(w.war.target);

        let html = sectionHeading('War overview');
        html +=
            '<p style="' +
            bodyPStyle() +
            '"><strong>' +
            esc(kindLabel) +
            '</strong> against <strong>' +
            esc(enemy) +
            '</strong>.</p>';
        html +=
            '<div style="border:1px solid ' +
            bodyBoxBorderStyle() +
            ';border-radius:4px;padding:12px;margin:12px auto 0 auto;max-width:320px;">' +
            '<p style="' +
            bodyTextStyle(
                'line-height:1.5;margin:0;text-align:center;font-size:14px;text-transform:uppercase;letter-spacing:1px;'
            ) +
            '">Start</p>' +
            '<p style="' +
            bodyTextStyle('line-height:1.5;margin:8px 0 0 0;text-align:center;font-size:15px;') +
            '">' +
            esc(formatTctUnix(w.start)) +
            '</p>';
        if (target !== '-') {
            html +=
                '<p style="' +
            bodyTextStyle(
                'line-height:1.5;margin:12px 0 0 0;text-align:center;font-size:14px;text-transform:uppercase;letter-spacing:1px;'
            ) +
            '">Required lead</p>' +
                '<p style="' +
                bodyTextStyle('line-height:24px;margin:4px 0 0 0;text-align:center;font-size:22px;font-weight:bold;') +
                '">' +
                esc(target) +
                '</p>';
        }
        html += '</div>';
        return html;
    }

    function summarizeEnemyMembers(members) {
        const roster = members.map(function (m) {
            return {
                id: m.id,
                name: m.name || 'Unknown',
                level: m.level != null ? Number(m.level) : 0,
                bs: null
            };
        });
        return {
            count: members.length,
            allMembers: sortEnemyRoster(roster)
        };
    }

    function splitMembersIntoColumns(members, columnCount) {
        const cols = [];
        const size = Math.ceil(members.length / columnCount);
        for (let i = 0; i < columnCount; i++) {
            const chunk = members.slice(i * size, (i + 1) * size);
            if (chunk.length) cols.push(chunk);
        }
        return cols;
    }

    function enemyRosterRowWidths(hasEstStats) {
        if (hasEstStats) {
            return { name: '44%', lvl: '11%', est: '45%' };
        }
        return { name: '68%', lvl: '32%', est: '0' };
    }

    function enemyRosterInlineCol(style) {
        return 'display:inline-block;vertical-align:top;box-sizing:border-box;' + style;
    }

    /** Div-based 3-column roster — float layout fits Torn mail width (inline-block + padding overflows). */
    function buildEnemyRosterColumnsHtml(members, hasEstStats) {
        const cols = splitMembersIntoColumns(members, 3);
        const accent = getAccentHex();
        const border = bodyBoxBorderStyle();
        const w = enemyRosterRowWidths(hasEstStats);
        let html =
            '<div data-newsletter-enemy-roster="1" style="margin:8px 0 0 0;width:100%;max-width:100%;overflow:hidden;">';
        cols.forEach(function (colMembers, idx) {
            const sep =
                (idx > 0 ? 'border-left:1px solid ' + accent + ';padding-left:3px;' : '') +
                (idx < cols.length - 1 ? 'padding-right:4px;' : 'padding-right:2px;');
            html +=
                '<div style="float:left;width:33.33%;box-sizing:border-box;text-align:left;font-size:10px;line-height:1.35;' +
                sep +
                '">';
            html +=
                '<p style="' +
                bodyTextStyle(
                    'margin:0 0 4px 0;padding-bottom:3px;border-bottom:1px solid ' +
                        border +
                        ';font-size:10px;font-weight:bold;text-transform:uppercase;'
                ) +
                '"><span style="' +
                enemyRosterInlineCol('width:' + w.name + ';color:' + accent + ';') +
                '">Name</span><span style="' +
                enemyRosterInlineCol('width:' + w.lvl + ';text-align:right;color:' + accent + ';') +
                '">Lvl</span>';
            if (hasEstStats) {
                html +=
                    '<span style="' +
                    enemyRosterInlineCol('width:' + w.est + ';text-align:right;color:' + accent + ';padding-right:3px;') +
                    '">Est</span>';
            }
            html += '</p>';
            colMembers.forEach(function (m) {
                html +=
                    '<p style="' +
                    bodyTextStyle('margin:0;padding:1px 0;font-size:10px;line-height:1.35;') +
                    '"><span style="' +
                    enemyRosterInlineCol(
                        'width:' + w.name + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
                    ) +
                    '"><a href="https://www.torn.com/profiles.php?XID=' +
                    encodeURIComponent(String(m.id)) +
                    '">' +
                    esc(m.name) +
                    '</a></span><span style="' +
                    enemyRosterInlineCol('width:' + w.lvl + ';text-align:right;') +
                    '">' +
                    esc(String(m.level)) +
                    '</span>';
                if (hasEstStats) {
                    html +=
                        '<span style="' +
                        enemyRosterInlineCol('width:' + w.est + ';text-align:right;font-size:9px;padding-right:3px;') +
                        '">' +
                        esc(formatEstimatedBattleStat(m.bs)) +
                        '</span>';
                }
                html += '</p>';
            });
            html += '</div>';
        });
        html += '<div style="clear:both;height:0;line-height:0;font-size:0;">&nbsp;</div></div>';
        return html;
    }

    function buildEnemyStatsSection() {
        let html = sectionHeading('Enemy stats');
        const b = state.enemyBasic;
        const sum = state.enemySummary;
        if (!b && !sum) {
            html += '<p style="' + bodyPStyle() + '">Load war data to fill enemy intel.</p>';
            return html;
        }
        html += '<div style="margin-top:10px;font-size:13px;">';
        function row(label, val) {
            return (
                '<p style="' +
                bodyPStyle('margin-top:4px;') +
                '"><span style="' +
                bodyTextStyle('') +
                '">' +
                esc(label) +
                '</span> <strong>' +
                esc(val) +
                '</strong></p>'
            );
        }
        if (state.enemyFactionName) html += row('Faction', state.enemyFactionName);
        if (b && b.respect != null) html += row('Respect', formatNumber(b.respect));
        if (sum) html += row('Members', formatNumber(sum.count));
        if (state.enemyChain && state.enemyChain.highest != null && state.enemyChain.highest > 0) {
            html += row('Highest chain', formatNumber(state.enemyChain.highest));
        }
        html += '</div>';
        return html;
    }

    function buildEnemyAnalysisSection() {
        let html = sectionHeading('Enemy analysis');
        const notes = state.sectionText.enemy_analysis || '';
        if (notes.trim()) html += textToParagraphsHtml(notes);

        const sum = state.enemySummary;
        if (sum && sum.allMembers && sum.allMembers.length) {
            const members = sum.allMembers;
            const hasEstStats = members.some(function (m) {
                return m.bs != null && m.bs !== '';
            });
            html +=
                '<p style="' +
                bodyPStyle('font-size:12px;') +
                '">All enemy members by ' +
                (hasEstStats ? 'est. battle stats' : 'level (est. stats unavailable)') +
                ' (' +
                esc(String(members.length)) +
                '):</p>';
            html += buildEnemyRosterColumnsHtml(members, hasEstStats);
        } else if (!notes.trim()) {
            html += '<p style="' + bodyPStyle() + '">Add notes above or load war data for a member snapshot.</p>';
        }
        return html;
    }

    function getWarRuleTemplate(ruleId) {
        for (let c = 0; c < WAR_RULE_CATEGORIES.length; c++) {
            const cat = WAR_RULE_CATEGORIES[c];
            for (let r = 0; r < cat.rules.length; r++) {
                if (cat.rules[r].id === ruleId) {
                    return { category: cat, template: cat.rules[r] };
                }
            }
        }
        return null;
    }

    function defaultValuesForTemplate(tmpl) {
        const values = {};
        if (!tmpl || !tmpl.inputType) return values;
        if (tmpl.inputType === 'win_lose') values.choice = tmpl.defaultValue || 'Win';
        if (tmpl.inputType === 'score') values.score = tmpl.defaultScore || '';
        if (tmpl.inputType === 'scoring_limit') {
            values.mode = tmpl.defaultMode || 'stop';
            values.stopScore = tmpl.defaultStopScore || '';
        }
        return values;
    }

    function ruleFromTemplate(catId, tmpl) {
        return {
            id: tmpl.id,
            category: catId,
            enabled: tmpl.defaultOn !== false,
            custom: false,
            values: defaultValuesForTemplate(tmpl)
        };
    }

    function buildDefaultWarRulesList() {
        const list = [];
        WAR_RULE_CATEGORIES.forEach(function (cat) {
            cat.rules.forEach(function (tmpl) {
                list.push(ruleFromTemplate(cat.id, tmpl));
            });
        });
        return list;
    }

    function mergeRuleValues(tmpl, savedValues) {
        const values = defaultValuesForTemplate(tmpl);
        if (!savedValues || typeof savedValues !== 'object') return values;
        if (tmpl.inputType === 'win_lose' && savedValues.choice) {
            values.choice = savedValues.choice === 'Lose' ? 'Lose' : 'Win';
        }
        if (tmpl.inputType === 'score' && savedValues.score != null) {
            values.score = String(savedValues.score);
        }
        if (tmpl.inputType === 'scoring_limit') {
            values.mode = savedValues.mode === 'fight_on' ? 'fight_on' : 'stop';
            if (savedValues.stopScore != null) values.stopScore = String(savedValues.stopScore);
        }
        return values;
    }

    function mergeSavedWarRules(savedRules) {
        const defaults = buildDefaultWarRulesList();
        if (!savedRules || !savedRules.length) return defaults;
        const savedById = {};
        savedRules.forEach(function (r) {
            if (r && r.id) savedById[r.id] = r;
        });
        const merged = defaults.map(function (d) {
            const s = savedById[d.id];
            const found = getWarRuleTemplate(d.id);
            const tmpl = found ? found.template : null;
            return {
                id: d.id,
                category: d.category,
                enabled: s != null ? !!s.enabled : d.enabled,
                custom: false,
                values: tmpl ? mergeRuleValues(tmpl, s && s.values) : {}
            };
        });
        savedRules.forEach(function (r) {
            if (!r || !r.id || !r.custom) return;
            if (merged.some(function (m) { return m.id === r.id; })) return;
            const text = String(r.text || '').trim();
            if (!text) return;
            merged.push({
                id: r.id,
                category: normalizeWarRuleCategoryId(r.category),
                text: text,
                enabled: r.enabled !== false,
                custom: true,
                values: r.values && typeof r.values === 'object' ? r.values : {}
            });
        });
        return merged;
    }

    function loadWarRulesPrefs() {
        try {
            const raw = localStorage.getItem(WAR_RULES_STORAGE_KEY);
            if (!raw) {
                state.warRules = buildDefaultWarRulesList();
                state.selectedWarRuleCategory = 'real_war';
                saveWarRulesPrefs();
                return;
            }
            const parsed = JSON.parse(raw);
            state.warRules = mergeSavedWarRules(parsed.rules);
            state.selectedWarRuleCategory = normalizeWarRuleCategoryId(parsed.selectedCategory);
        } catch (e) {
            state.warRules = buildDefaultWarRulesList();
        }
    }

    function saveWarRulesPrefs() {
        try {
            localStorage.setItem(
                WAR_RULES_STORAGE_KEY,
                JSON.stringify({
                    selectedCategory: getActiveWarRuleCategoryId(),
                    rules: state.warRules.map(function (r) {
                        const out = {
                            id: r.id,
                            category: r.category,
                            enabled: !!r.enabled,
                            custom: !!r.custom
                        };
                        if (r.custom) out.text = r.text;
                        if (r.values && Object.keys(r.values).length) out.values = r.values;
                        return out;
                    })
                })
            );
        } catch (e) {
            /* ignore */
        }
    }

    function formatWarRuleScore(raw) {
        const s = String(raw == null ? '' : raw).replace(/,/g, '').trim();
        if (!s) return '';
        const n = parseInt(s, 10);
        if (!Number.isFinite(n) || n < 0) return s;
        return n.toLocaleString('en-US');
    }

    function resolveWarRuleDisplayText(rule) {
        if (rule.custom) return String(rule.text || '').trim();
        const found = getWarRuleTemplate(rule.id);
        const tmpl = found ? found.template : null;
        if (!tmpl) return '';
        const values = rule.values || {};
        if (tmpl.inputType === 'win_lose') {
            const choice = values.choice === 'Lose' ? 'Lose' : 'Win';
            return 'We will take the ' + choice;
        }
        if (tmpl.inputType === 'score') {
            const score = formatWarRuleScore(values.score);
            return score ? 'Loser will score ' + score : 'Loser will score (set target score)';
        }
        if (tmpl.inputType === 'scoring_limit') {
            if (values.mode === 'fight_on') return 'We will keep hitting till we win';
            const stop = formatWarRuleScore(values.stopScore);
            return stop ? 'We will stop scoring at ' + stop : 'We will stop scoring at (set target score)';
        }
        return tmpl.text || '';
    }

    function getEnabledWarRulesGrouped() {
        const catId = getActiveWarRuleCategoryId();
        const cat = getWarRuleCategoryDef(catId);
        const builtIn = state.warRules.filter(function (r) {
            return !r.custom && r.category === catId && r.enabled;
        });
        const custom = state.warRules.filter(function (r) {
            return r.custom && r.category === catId && r.enabled && String(r.text || '').trim();
        });
        const rules = builtIn.concat(custom);
        if (!rules.length) return [];
        return [{ title: cat.title, rules: rules }];
    }

    function setWarRuleEnabled(ruleId, enabled) {
        const rule = state.warRules.find(function (r) {
            return r.id === ruleId;
        });
        if (!rule) return;
        rule.enabled = !!enabled;
        saveWarRulesPrefs();
        renderWarRulesPicker();
        renderPreview();
    }

    function setWarRuleValue(ruleId, key, value) {
        const rule = state.warRules.find(function (r) {
            return r.id === ruleId;
        });
        if (!rule) return;
        if (!rule.values) rule.values = {};
        rule.values[key] = value;
        saveWarRulesPrefs();
        renderPreview();
    }

    function addCustomWarRule(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        state.warRules.push({
            id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
            category: getActiveWarRuleCategoryId(),
            text: trimmed,
            enabled: true,
            custom: true,
            values: {}
        });
        saveWarRulesPrefs();
        renderWarRulesPicker();
        renderPreview();
        return true;
    }

    function removeCustomWarRule(ruleId) {
        const idx = state.warRules.findIndex(function (r) {
            return r.id === ruleId && r.custom;
        });
        if (idx < 0) return;
        state.warRules.splice(idx, 1);
        saveWarRulesPrefs();
        renderWarRulesPicker();
        renderPreview();
    }

    function getFlatSectionRuleSet(sectionId) {
        return FLAT_SECTION_RULE_SETS[sectionId] || null;
    }

    function getFlatSectionCategories(def) {
        return def && def.categories && def.categories.length ? def.categories : null;
    }

    function normalizeFlatSectionCategoryId(sectionId, cat) {
        if (sectionId === 'payout') return cat === 'hit_based' ? 'hit_based' : 'respect_based';
        return cat;
    }

    function getActiveFlatSectionCategoryId(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def || !def.selectedCategoryStateKey) return null;
        return normalizeFlatSectionCategoryId(sectionId, state[def.selectedCategoryStateKey]);
    }

    function getFlatSectionCategoryDef(sectionId, catId) {
        const def = getFlatSectionRuleSet(sectionId);
        const categories = getFlatSectionCategories(def);
        if (!categories) return null;
        const id = normalizeFlatSectionCategoryId(sectionId, catId);
        for (let i = 0; i < categories.length; i++) {
            if (categories[i].id === id) return categories[i];
        }
        return categories[0];
    }

    function setSelectedFlatSectionCategory(sectionId, catId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def || !def.selectedCategoryStateKey) return;
        state[def.selectedCategoryStateKey] = normalizeFlatSectionCategoryId(sectionId, catId);
        saveFlatSectionRulesPrefs(sectionId);
        renderFlatSectionRulesPicker(sectionId);
        renderPreview();
    }

    function getFlatSectionRulesArray(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return [];
        return state[def.stateKey] || [];
    }

    function defaultValuesForFlatTemplate(tmpl) {
        const values = {};
        if (!tmpl || !tmpl.inputType) return values;
        if (tmpl.inputType === 'inline_text') {
            values.text = tmpl.defaultValue != null ? String(tmpl.defaultValue) : '';
        }
        if (tmpl.inputType === 'chain_prize') {
            values.chain = tmpl.defaultChain != null ? String(tmpl.defaultChain) : '';
            values.prize = tmpl.defaultPrize != null ? String(tmpl.defaultPrize) : '';
        }
        if (tmpl.inputType === 'min_or') {
            values.primary = tmpl.defaultPrimary != null ? String(tmpl.defaultPrimary) : '';
            values.secondary = tmpl.defaultSecondary != null ? String(tmpl.defaultSecondary) : '';
        }
        return values;
    }

    function flatRuleFromTemplate(sectionId, tmpl, catId) {
        const row = {
            id: tmpl.id,
            sectionId: sectionId,
            enabled: tmpl.defaultOn !== false,
            custom: false,
            values: defaultValuesForFlatTemplate(tmpl)
        };
        if (catId) row.category = catId;
        return row;
    }

    function buildDefaultFlatSectionRules(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return [];
        const categories = getFlatSectionCategories(def);
        if (categories) {
            const list = [];
            categories.forEach(function (cat) {
                cat.rules.forEach(function (tmpl) {
                    list.push(flatRuleFromTemplate(sectionId, tmpl, cat.id));
                });
            });
            return list;
        }
        return def.rules.map(function (tmpl) {
            return flatRuleFromTemplate(sectionId, tmpl);
        });
    }

    function getFlatRuleTemplate(sectionId, ruleId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return null;
        const categories = getFlatSectionCategories(def);
        if (categories) {
            for (let c = 0; c < categories.length; c++) {
                const cat = categories[c];
                for (let r = 0; r < cat.rules.length; r++) {
                    if (cat.rules[r].id === ruleId) return cat.rules[r];
                }
            }
            return null;
        }
        for (let i = 0; i < def.rules.length; i++) {
            if (def.rules[i].id === ruleId) return def.rules[i];
        }
        return null;
    }

    function mergeFlatRuleValues(tmpl, savedValues) {
        const values = defaultValuesForFlatTemplate(tmpl);
        if (!savedValues || typeof savedValues !== 'object') return values;
        if (tmpl.inputType === 'inline_text' && savedValues.text != null) {
            values.text = String(savedValues.text);
        }
        if (tmpl.inputType === 'chain_prize') {
            if (savedValues.chain != null) values.chain = String(savedValues.chain);
            if (savedValues.prize != null) values.prize = String(savedValues.prize);
        }
        if (tmpl.inputType === 'min_or') {
            if (savedValues.primary != null) values.primary = String(savedValues.primary);
            if (savedValues.secondary != null) values.secondary = String(savedValues.secondary);
        }
        return values;
    }

    function mergeSavedFlatSectionRules(sectionId, savedRules) {
        const defaults = buildDefaultFlatSectionRules(sectionId);
        if (!savedRules || !savedRules.length) return defaults;
        const savedById = {};
        savedRules.forEach(function (r) {
            if (r && r.id) savedById[r.id] = r;
        });
        const merged = defaults.map(function (d) {
            const s = savedById[d.id];
            const tmpl = getFlatRuleTemplate(sectionId, d.id);
            const row = {
                id: d.id,
                sectionId: sectionId,
                enabled: s != null ? !!s.enabled : d.enabled,
                custom: false,
                values: tmpl ? mergeFlatRuleValues(tmpl, s && s.values) : {}
            };
            if (d.category) row.category = d.category;
            return row;
        });
        savedRules.forEach(function (r) {
            if (!r || !r.id || !r.custom) return;
            if (merged.some(function (m) { return m.id === r.id; })) return;
            const text = String(r.text || '').trim();
            if (!text) return;
            merged.push({
                id: r.id,
                sectionId: sectionId,
                category: r.category
                    ? normalizeFlatSectionCategoryId(sectionId, r.category)
                    : getActiveFlatSectionCategoryId(sectionId) || undefined,
                text: text,
                enabled: r.enabled !== false,
                custom: true,
                values: r.values && typeof r.values === 'object' ? r.values : {}
            });
        });
        return merged;
    }

    function loadFlatSectionRulesPrefs(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return;
        try {
            const raw = localStorage.getItem(def.storageKey);
            if (!raw) {
                state[def.stateKey] = buildDefaultFlatSectionRules(sectionId);
                if (def.selectedCategoryStateKey) {
                    state[def.selectedCategoryStateKey] = normalizeFlatSectionCategoryId(sectionId, 'respect_based');
                }
                saveFlatSectionRulesPrefs(sectionId);
                return;
            }
            const parsed = JSON.parse(raw);
            state[def.stateKey] = mergeSavedFlatSectionRules(sectionId, parsed.rules);
            if (def.selectedCategoryStateKey) {
                state[def.selectedCategoryStateKey] = normalizeFlatSectionCategoryId(
                    sectionId,
                    parsed.selectedCategory
                );
            }
        } catch (e) {
            state[def.stateKey] = buildDefaultFlatSectionRules(sectionId);
        }
    }

    function saveFlatSectionRulesPrefs(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return;
        const rules = getFlatSectionRulesArray(sectionId);
        const payload = {
            rules: rules.map(function (r) {
                const out = {
                    id: r.id,
                    enabled: !!r.enabled,
                    custom: !!r.custom
                };
                if (r.category) out.category = r.category;
                if (r.custom) out.text = r.text;
                if (r.values && Object.keys(r.values).length) out.values = r.values;
                return out;
            })
        };
        if (def.selectedCategoryStateKey) {
            payload.selectedCategory = getActiveFlatSectionCategoryId(sectionId);
        }
        try {
            localStorage.setItem(def.storageKey, JSON.stringify(payload));
        } catch (e) {
            /* ignore */
        }
    }

    function loadAllFlatSectionRulesPrefs() {
        Object.keys(FLAT_SECTION_RULE_SETS).forEach(loadFlatSectionRulesPrefs);
    }

    function resolveFlatRuleDisplayText(sectionId, rule) {
        if (rule.custom) return String(rule.text || '').trim();
        const tmpl = getFlatRuleTemplate(sectionId, rule.id);
        if (!tmpl) return '';
        const values = rule.values || {};
        if (tmpl.inputType === 'inline_text') {
            const val = String(values.text != null ? values.text : '').trim();
            const before = tmpl.before || '';
            const after = tmpl.after || '';
            if (!val && tmpl.defaultOn !== false) {
                return before + (tmpl.placeholder || '…') + after;
            }
            return before + val + after;
        }
        if (tmpl.inputType === 'chain_prize') {
            const chain = String(values.chain != null ? values.chain : '').trim();
            const prize = String(values.prize != null ? values.prize : '').trim();
            if (!chain && !prize) return 'Chain bonus (set chain target and prize)';
            return (
                'Chain bonus at ' +
                (chain || '…') +
                ' chain' +
                (prize ? ' — ' + prize : '')
            );
        }
        if (tmpl.inputType === 'min_or') {
            const primary = String(values.primary != null ? values.primary : '').trim();
            const secondary = String(values.secondary != null ? values.secondary : '').trim();
            const primaryDisp = primary || tmpl.primaryPlaceholder || '…';
            const secondaryDisp = secondary || tmpl.secondaryPlaceholder || '…';
            return (
                (tmpl.before || '') +
                primaryDisp +
                (tmpl.primaryAfter || '') +
                secondaryDisp +
                (tmpl.after || '')
            );
        }
        return tmpl.text || '';
    }

    function getEnabledFlatSectionRules(sectionId) {
        const activeCatId = getActiveFlatSectionCategoryId(sectionId);
        return getFlatSectionRulesArray(sectionId).filter(function (r) {
            if (!r.enabled) return false;
            if (activeCatId && r.category && normalizeFlatSectionCategoryId(sectionId, r.category) !== activeCatId) {
                return false;
            }
            if (r.custom) return String(r.text || '').trim().length > 0;
            return true;
        });
    }

    function setFlatSectionRuleEnabled(sectionId, ruleId, enabled) {
        const rules = getFlatSectionRulesArray(sectionId);
        const rule = rules.find(function (r) {
            return r.id === ruleId;
        });
        if (!rule) return;
        rule.enabled = !!enabled;
        saveFlatSectionRulesPrefs(sectionId);
        renderFlatSectionRulesPicker(sectionId);
        renderPreview();
    }

    function setFlatSectionRuleValue(sectionId, ruleId, key, value) {
        const rules = getFlatSectionRulesArray(sectionId);
        const rule = rules.find(function (r) {
            return r.id === ruleId;
        });
        if (!rule) return;
        if (!rule.values) rule.values = {};
        rule.values[key] = value;
        saveFlatSectionRulesPrefs(sectionId);
        renderPreview();
    }

    function addCustomFlatSectionRule(sectionId, text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        const rules = getFlatSectionRulesArray(sectionId);
        const row = {
            id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
            sectionId: sectionId,
            text: trimmed,
            enabled: true,
            custom: true,
            values: {}
        };
        const activeCatId = getActiveFlatSectionCategoryId(sectionId);
        if (activeCatId) row.category = activeCatId;
        rules.push(row);
        saveFlatSectionRulesPrefs(sectionId);
        renderFlatSectionRulesPicker(sectionId);
        renderPreview();
        return true;
    }

    function removeCustomFlatSectionRule(sectionId, ruleId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return;
        const rules = state[def.stateKey];
        const idx = rules.findIndex(function (r) {
            return r.id === ruleId && r.custom;
        });
        if (idx < 0) return;
        rules.splice(idx, 1);
        saveFlatSectionRulesPrefs(sectionId);
        renderFlatSectionRulesPicker(sectionId);
        renderPreview();
    }

    function migrateLegacySectionTextToFlatRules(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return;
        const text = String(state.sectionText[sectionId] || '').trim();
        if (!text) return;
        const rules = getFlatSectionRulesArray(sectionId);
        const hasLegacy = rules.some(function (r) {
            return r.custom && String(r.id).indexOf('legacy-' + sectionId) === 0;
        });
        if (hasLegacy) return;
        rules.push({
            id: 'legacy-' + sectionId + '-' + Date.now().toString(36),
            sectionId: sectionId,
            text: text,
            enabled: true,
            custom: true,
            values: {}
        });
        state.sectionText[sectionId] = '';
        saveFlatSectionRulesPrefs(sectionId);
        saveDraft();
    }

    function appendFlatRuleInputControls(sectionId, rule, label, tmpl) {
        const values = rule.values || {};
        const disabled = !rule.enabled;
        const body = document.createElement('div');
        body.className = 'newsletter-war-rule-body';
        label.appendChild(body);

        if (tmpl && tmpl.inputType === 'inline_text') {
            const line = document.createElement('span');
            line.className = 'newsletter-war-rule-inline';
            if (tmpl.before) line.appendChild(document.createTextNode(tmpl.before));
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            inp.dataset.flatRuleInput = '1';
            inp.dataset.flatRuleSection = sectionId;
            inp.dataset.flatRuleId = rule.id;
            inp.dataset.valueKey = 'text';
            inp.placeholder = tmpl.placeholder || '';
            inp.value = values.text != null ? String(values.text) : '';
            inp.disabled = disabled;
            line.appendChild(inp);
            if (tmpl.after) line.appendChild(document.createTextNode(tmpl.after));
            body.appendChild(line);
            return;
        }

        if (tmpl && tmpl.inputType === 'chain_prize') {
            const line = document.createElement('span');
            line.className = 'newsletter-war-rule-inline';
            line.appendChild(document.createTextNode('Chain bonus at '));
            const chainInp = document.createElement('input');
            chainInp.type = 'text';
            chainInp.inputMode = 'numeric';
            chainInp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            chainInp.dataset.flatRuleInput = '1';
            chainInp.dataset.flatRuleSection = sectionId;
            chainInp.dataset.flatRuleId = rule.id;
            chainInp.dataset.valueKey = 'chain';
            chainInp.placeholder = '100';
            chainInp.value = values.chain != null ? String(values.chain) : '';
            chainInp.disabled = disabled;
            line.appendChild(chainInp);
            line.appendChild(document.createTextNode(' chain — '));
            const prizeInp = document.createElement('input');
            prizeInp.type = 'text';
            prizeInp.className = 'newsletter-input newsletter-war-rule-input';
            prizeInp.dataset.flatRuleInput = '1';
            prizeInp.dataset.flatRuleSection = sectionId;
            prizeInp.dataset.flatRuleId = rule.id;
            prizeInp.dataset.valueKey = 'prize';
            prizeInp.placeholder = '25m';
            prizeInp.value = values.prize != null ? String(values.prize) : '';
            prizeInp.disabled = disabled;
            line.appendChild(prizeInp);
            body.appendChild(line);
            return;
        }

        if (tmpl && tmpl.inputType === 'min_or') {
            const line = document.createElement('span');
            line.className = 'newsletter-war-rule-inline';
            if (tmpl.before) line.appendChild(document.createTextNode(tmpl.before));
            const primaryInp = document.createElement('input');
            primaryInp.type = 'text';
            primaryInp.inputMode = 'numeric';
            primaryInp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            primaryInp.dataset.flatRuleInput = '1';
            primaryInp.dataset.flatRuleSection = sectionId;
            primaryInp.dataset.flatRuleId = rule.id;
            primaryInp.dataset.valueKey = 'primary';
            primaryInp.placeholder = tmpl.primaryPlaceholder || '';
            primaryInp.value = values.primary != null ? String(values.primary) : '';
            primaryInp.disabled = disabled;
            line.appendChild(primaryInp);
            if (tmpl.primaryAfter) line.appendChild(document.createTextNode(tmpl.primaryAfter));
            const secondaryInp = document.createElement('input');
            secondaryInp.type = 'text';
            secondaryInp.inputMode = 'numeric';
            secondaryInp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            secondaryInp.dataset.flatRuleInput = '1';
            secondaryInp.dataset.flatRuleSection = sectionId;
            secondaryInp.dataset.flatRuleId = rule.id;
            secondaryInp.dataset.valueKey = 'secondary';
            secondaryInp.placeholder = tmpl.secondaryPlaceholder || '';
            secondaryInp.value = values.secondary != null ? String(values.secondary) : '';
            secondaryInp.disabled = disabled;
            line.appendChild(secondaryInp);
            if (tmpl.after) line.appendChild(document.createTextNode(tmpl.after));
            body.appendChild(line);
            return;
        }

        const span = document.createElement('span');
        span.className = 'newsletter-war-rule-text';
        span.textContent = rule.custom ? rule.text : tmpl && tmpl.text ? tmpl.text : '';
        body.appendChild(span);
    }

    function renderFlatSectionRulesPickerInto(parent, sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!parent || !def) return;

        const categories = getFlatSectionCategories(def);
        const activeCat = categories ? getFlatSectionCategoryDef(sectionId, getActiveFlatSectionCategoryId(sectionId)) : null;

        let html =
            '<p class="newsletter-hint">' +
            esc(def.hint) +
            '</p>';

        if (categories && activeCat) {
            html +=
                '<div class="newsletter-war-type-picker" role="radiogroup" aria-label="Payout type">' +
                categories
                    .map(function (cat) {
                        const on = cat.id === activeCat.id;
                        return (
                            '<label class="newsletter-war-type-option' +
                            (on ? ' newsletter-war-type-option--active' : '') +
                            '">' +
                            '<input type="radio" name="newsletter-flat-type-' +
                            esc(sectionId) +
                            '" value="' +
                            esc(cat.id) +
                            '" data-flat-rule-category-select="1" data-flat-rule-section="' +
                            esc(sectionId) +
                            '"' +
                            (on ? ' checked' : '') +
                            '>' +
                            '<span>' +
                            esc(cat.title) +
                            '</span></label>'
                        );
                    })
                    .join('') +
                '</div>';
        }

        html +=
            '<div class="newsletter-war-rules-panel">' +
            '<ul class="newsletter-war-rules-list"></ul>' +
            '<div class="newsletter-war-rule-add-row">' +
            '<input type="text" id="newsletter-flat-rule-new-' +
            esc(sectionId) +
            '" class="newsletter-input" placeholder="' +
            esc(
                activeCat
                    ? 'Add a custom ' + activeCat.title.toLowerCase() + ' rule…'
                    : def.addPlaceholder
            ) +
            '" maxlength="280">' +
            '<button type="button" class="btn btn-secondary" data-flat-rule-add="' +
            esc(sectionId) +
            '">Add rule</button>' +
            '</div></div>';

        parent.innerHTML = html;

        const list = parent.querySelector('.newsletter-war-rules-list');
        if (!list) return;

        const ruleTemplates = activeCat ? activeCat.rules : def.rules || [];

        ruleTemplates.forEach(function (tmpl) {
            const rule = getFlatSectionRulesArray(sectionId).find(function (r) {
                return r.id === tmpl.id;
            });
            if (!rule) return;

            const li = document.createElement('li');
            li.className = 'newsletter-war-rule-row';

            const label = document.createElement('label');
            label.className = 'newsletter-check newsletter-war-rule-check';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!rule.enabled;
            cb.dataset.flatRuleSection = sectionId;
            cb.dataset.flatRuleId = rule.id;
            label.appendChild(cb);

            appendFlatRuleInputControls(sectionId, rule, label, tmpl);
            li.appendChild(label);
            list.appendChild(li);
        });

        getFlatSectionRulesArray(sectionId)
            .filter(function (r) {
                if (!r.custom) return false;
                if (!activeCat) return true;
                return normalizeFlatSectionCategoryId(sectionId, r.category) === activeCat.id;
            })
            .forEach(function (rule) {
                const li = document.createElement('li');
                li.className = 'newsletter-war-rule-row';

                const label = document.createElement('label');
                label.className = 'newsletter-check newsletter-war-rule-check';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!rule.enabled;
                cb.dataset.flatRuleSection = sectionId;
                cb.dataset.flatRuleId = rule.id;
                label.appendChild(cb);

                appendFlatRuleInputControls(sectionId, rule, label, null);
                li.appendChild(label);

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'newsletter-war-rule-delete';
                delBtn.dataset.deleteFlatRuleSection = sectionId;
                delBtn.dataset.deleteFlatRuleId = rule.id;
                delBtn.setAttribute('aria-label', 'Remove custom rule');
                delBtn.title = 'Remove rule';
                delBtn.textContent = '×';
                li.appendChild(delBtn);

                list.appendChild(li);
            });
    }

    function renderFlatSectionRulesPicker(sectionId) {
        const block = document.querySelector('[data-section-editor="' + sectionId + '"]');
        if (!block) {
            renderNewsletterSectionEditors();
            return;
        }
        renderFlatSectionRulesPickerInto(block, sectionId);
    }

    function buildFlatSectionRulesSection(sectionId) {
        const def = getFlatSectionRuleSet(sectionId);
        if (!def) return '';
        const enabled = getEnabledFlatSectionRules(sectionId);
        const activeCat = getFlatSectionCategories(def)
            ? getFlatSectionCategoryDef(sectionId, getActiveFlatSectionCategoryId(sectionId))
            : null;
        let html = sectionHeading(def.mailHeading);
        if (!enabled.length) {
            html +=
                '<p style="' +
                bodyPStyle('font-style:italic;') +
                '">' +
                esc(def.emptyMail) +
                '</p>';
            return html;
        }
        if (activeCat && activeCat.mailLine) {
            html +=
                '<p style="' +
                bodyTextStyle('font-weight:bold;margin:14px 0 6px 0;font-size:14px;') +
                '">' +
                esc(activeCat.mailLine) +
                '</p>';
        }
        html += '<ul style="' + newsletterBulletListOpenStyle() + '">';
        enabled.forEach(function (rule) {
            html += newsletterBulletItemHtml(resolveFlatRuleDisplayText(sectionId, rule));
        });
        html += '</ul>';
        return html;
    }

    function getCompetitionTypeDef(typeId) {
        for (let i = 0; i < COMPETITION_TYPES.length; i++) {
            if (COMPETITION_TYPES[i].id === typeId) return COMPETITION_TYPES[i];
        }
        return null;
    }

    function placeOrdinal(n) {
        const v = Number(n);
        if (v === 1) return '1st';
        if (v === 2) return '2nd';
        if (v === 3) return '3rd';
        return v + 'th';
    }

    function normalizeCompetitionPrizes(placeCount, prizes) {
        const count = Math.max(1, Math.min(COMPETITION_MAX_PLACES, Number(placeCount) || 1));
        const out = [];
        for (let i = 0; i < count; i++) {
            out.push(prizes && prizes[i] != null ? String(prizes[i]) : '');
        }
        return out;
    }

    function createCompetition(typeId) {
        return {
            id: 'comp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            typeId: typeId,
            placeCount: COMPETITION_DEFAULT_PLACES,
            prizes: normalizeCompetitionPrizes(COMPETITION_DEFAULT_PLACES, [])
        };
    }

    function loadCompetitionsPrefs() {
        try {
            const raw = localStorage.getItem(INCENTIVE_COMPETITIONS_STORAGE_KEY);
            if (!raw) {
                state.competitions = [];
                state.customIncentives = [];
                return;
            }
            const parsed = JSON.parse(raw);
            state.competitions = (parsed.competitions || [])
                .filter(function (c) {
                    return c && c.typeId && getCompetitionTypeDef(c.typeId);
                })
                .map(function (c) {
                    const placeCount = Math.max(
                        1,
                        Math.min(COMPETITION_MAX_PLACES, Number(c.placeCount) || COMPETITION_DEFAULT_PLACES)
                    );
                    return {
                        id: c.id || 'comp-' + Math.random().toString(36).slice(2, 8),
                        typeId: c.typeId,
                        placeCount: placeCount,
                        prizes: normalizeCompetitionPrizes(placeCount, c.prizes)
                    };
                });
            state.customIncentives = (parsed.customIncentives || [])
                .filter(function (item) {
                    return item && String(item.text || '').trim();
                })
                .map(function (item) {
                    return {
                        id: item.id || 'inc-' + Math.random().toString(36).slice(2, 8),
                        text: String(item.text).trim()
                    };
                });
        } catch (e) {
            state.competitions = [];
            state.customIncentives = [];
        }
    }

    function saveCompetitionsPrefs() {
        try {
            localStorage.setItem(
                INCENTIVE_COMPETITIONS_STORAGE_KEY,
                JSON.stringify({
                    competitions: state.competitions.map(function (c) {
                        return {
                            id: c.id,
                            typeId: c.typeId,
                            placeCount: c.placeCount,
                            prizes: c.prizes
                        };
                    }),
                    customIncentives: state.customIncentives.map(function (item) {
                        return { id: item.id, text: item.text };
                    })
                })
            );
        } catch (e) {
            /* ignore */
        }
    }

    function getAvailableCompetitionTypes() {
        const used = {};
        state.competitions.forEach(function (c) {
            used[c.typeId] = true;
        });
        return COMPETITION_TYPES.filter(function (t) {
            return !used[t.id];
        });
    }

    function addCompetition(typeId) {
        if (!getCompetitionTypeDef(typeId)) return false;
        if (state.competitions.some(function (c) {
            return c.typeId === typeId;
        })) {
            return false;
        }
        state.competitions.push(createCompetition(typeId));
        ensureIncentivesSectionEnabled();
        saveCompetitionsPrefs();
        renderCompetitionsPicker();
        renderPreview();
        return true;
    }

    function removeCompetition(compId) {
        const idx = state.competitions.findIndex(function (c) {
            return c.id === compId;
        });
        if (idx < 0) return;
        state.competitions.splice(idx, 1);
        saveCompetitionsPrefs();
        renderCompetitionsPicker();
        renderPreview();
    }

    function setCompetitionPlaceCount(compId, count) {
        const comp = state.competitions.find(function (c) {
            return c.id === compId;
        });
        if (!comp) return;
        const placeCount = Math.max(1, Math.min(COMPETITION_MAX_PLACES, Number(count) || 1));
        comp.placeCount = placeCount;
        comp.prizes = normalizeCompetitionPrizes(placeCount, comp.prizes);
        saveCompetitionsPrefs();
        renderCompetitionsPicker();
        renderPreview();
    }

    function setCompetitionPrize(compId, placeIndex, value) {
        const comp = state.competitions.find(function (c) {
            return c.id === compId;
        });
        if (!comp) return;
        const idx = Number(placeIndex);
        if (idx < 0 || idx >= comp.placeCount) return;
        if (!comp.prizes) comp.prizes = [];
        comp.prizes[idx] = value;
        saveCompetitionsPrefs();
        renderPreview();
    }

    function addCustomIncentive(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return false;
        state.customIncentives.push({
            id: 'inc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            text: trimmed
        });
        ensureIncentivesSectionEnabled();
        saveCompetitionsPrefs();
        renderCompetitionsPicker();
        renderPreview();
        return true;
    }

    function removeCustomIncentive(incId) {
        const idx = state.customIncentives.findIndex(function (item) {
            return item.id === incId;
        });
        if (idx < 0) return;
        state.customIncentives.splice(idx, 1);
        saveCompetitionsPrefs();
        renderCompetitionsPicker();
        renderPreview();
    }

    function buildCompetitionMailHtml(comp) {
        const type = getCompetitionTypeDef(comp.typeId);
        if (!type) return '';
        const accent = getAccentHex();
        const border = bodyBoxBorderStyle();
        let prizeRows = '';
        let hasPrize = false;
        let rowIndex = 0;

        for (let i = 0; i < comp.placeCount; i++) {
            const prize = String(comp.prizes[i] || '').trim();
            if (!prize) continue;
            hasPrize = true;
            const rowBg = rowIndex % 2 === 0 ? '#0c0c0c' : '#161616';
            prizeRows +=
                '<div style="padding:8px 12px;background:' +
                rowBg +
                ';' +
                (rowIndex > 0 ? 'border-top:1px solid ' + border + ';' : '') +
                '">' +
                '<span style="color:' +
                accent +
                ';font-weight:bold;display:inline-block;min-width:2.75em;font-size:' +
                (i === 0 ? '14px' : '13px') +
                ';">' +
                esc(placeOrdinal(i + 1)) +
                '</span>' +
                '<span style="color:' +
                accent +
                ';font-weight:bold;margin-right:6px;">&#8226;</span>' +
                '<span style="font-weight:600;color:#f0f0f0;">' +
                esc(prize) +
                '</span></div>';
            rowIndex++;
        }

        if (!hasPrize) {
            prizeRows =
                '<div style="' +
                bodyTextStyle('padding:10px 12px;font-style:italic;background:#0c0c0c;') +
                '">Prizes not set</div>';
        }

        return (
            '<div style="margin-top:14px;border:1px solid ' +
            border +
            ';border-left:4px solid ' +
            accent +
            ';border-radius:4px;overflow:hidden;">' +
            '<div style="background:#000000;padding:0;">' +
            '<p style="' +
            bodyTextStyle(
                'margin:0;padding:10px 12px;font-weight:bold;font-size:14px;text-transform:uppercase;letter-spacing:0.6px;color:#f5f5f5;'
            ) +
            '">' +
            esc(type.label) +
            '</p>' +
            '<div style="height:2px;background:linear-gradient(90deg,' +
            accent +
            ' 0%,transparent 85%);line-height:0;font-size:0;">&nbsp;</div>' +
            '</div>' +
            '<div style="padding:0;">' +
            '<div style="' +
            bodyTextStyle(
                'padding:6px 12px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:' +
                    accent +
                    ';background:#000000;border-bottom:1px solid ' +
                    border +
                    ';'
            ) +
            '">Place <span style="color:#888;font-weight:normal;text-transform:none;letter-spacing:0;"> — Prize</span></div>' +
            prizeRows +
            '</div></div>'
        );
    }

    function buildCompetitionsSection() {
        let html = sectionHeading('Competitions & incentives');
        const hasCompetitions = state.competitions.length > 0;
        const hasCustom = state.customIncentives.length > 0;
        if (!hasCompetitions && !hasCustom) {
            html +=
                '<p style="' +
                bodyPStyle('font-style:italic;') +
                '">No competitions added — use the editor panel.</p>';
            return html;
        }
        state.competitions.forEach(function (comp) {
            html += buildCompetitionMailHtml(comp);
        });
        if (hasCustom) {
            html +=
                '<p style="' +
                bodyTextStyle('font-weight:bold;margin:16px 0 6px 0;font-size:13px;') +
                '">Other incentives</p>';
            html += '<ul style="' + newsletterBulletListOpenStyle() + '">';
            state.customIncentives.forEach(function (item) {
                html += newsletterBulletItemHtml(item.text);
            });
            html += '</ul>';
        }
        return html;
    }

    function buildCompetitionEditorCard(comp) {
        const type = getCompetitionTypeDef(comp.typeId);
        const card = document.createElement('div');
        card.className = 'newsletter-competition-card';
        card.dataset.competitionId = comp.id;

        const header = document.createElement('div');
        header.className = 'newsletter-competition-card-header';

        const title = document.createElement('span');
        title.className = 'newsletter-competition-card-title';
        title.textContent = type ? type.label : comp.typeId;
        header.appendChild(title);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'newsletter-war-rule-delete';
        delBtn.dataset.deleteCompetitionId = comp.id;
        delBtn.setAttribute('aria-label', 'Remove competition');
        delBtn.title = 'Remove competition';
        delBtn.textContent = '×';
        header.appendChild(delBtn);
        card.appendChild(header);

        const placesRow = document.createElement('div');
        placesRow.className = 'newsletter-competition-places-row';
        placesRow.appendChild(document.createTextNode('Places paying out: '));
        const placesSel = document.createElement('select');
        placesSel.className = 'newsletter-select newsletter-select--compact';
        placesSel.dataset.competitionPlaceCount = '1';
        placesSel.dataset.competitionId = comp.id;
        for (let n = 1; n <= COMPETITION_MAX_PLACES; n++) {
            const o = document.createElement('option');
            o.value = String(n);
            o.textContent = String(n);
            if (n === comp.placeCount) o.selected = true;
            placesSel.appendChild(o);
        }
        placesRow.appendChild(placesSel);
        card.appendChild(placesRow);

        const prizesWrap = document.createElement('div');
        prizesWrap.className = 'newsletter-competition-prizes';
        for (let i = 0; i < comp.placeCount; i++) {
            const row = document.createElement('div');
            row.className = 'newsletter-competition-prize-row';

            const label = document.createElement('span');
            label.className = 'newsletter-competition-prize-label';
            label.textContent = placeOrdinal(i + 1);
            row.appendChild(label);

            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--prize';
            inp.dataset.competitionPrizeInput = '1';
            inp.dataset.competitionId = comp.id;
            inp.dataset.placeIndex = String(i);
            inp.placeholder = 'e.g. 100m';
            inp.value = comp.prizes[i] || '';
            row.appendChild(inp);

            prizesWrap.appendChild(row);
        }
        card.appendChild(prizesWrap);

        return card;
    }

    function renderCompetitionsPickerInto(parent) {
        if (!parent) return;

        const hint = document.createElement('p');
        hint.className = 'newsletter-hint';
        hint.textContent =
            'Add a competition, choose how many places pay out, then enter the prize for each position.';
        parent.appendChild(hint);

        const available = getAvailableCompetitionTypes();
        const addRow = document.createElement('div');
        addRow.className = 'newsletter-competition-add-row';

        const select = document.createElement('select');
        select.id = 'newsletter-competition-type-select';
        select.className = 'newsletter-select newsletter-competition-type-select';
        select.disabled = !available.length;

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = available.length ? 'Select competition…' : 'All competitions added';
        select.appendChild(placeholderOpt);

        available.forEach(function (t) {
            const o = document.createElement('option');
            o.value = t.id;
            o.textContent = t.label;
            select.appendChild(o);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-secondary';
        addBtn.id = 'newsletter-competition-add';
        addBtn.textContent = 'Add competition';
        addBtn.disabled = !available.length;

        addRow.appendChild(select);
        addRow.appendChild(addBtn);
        parent.appendChild(addRow);

        const list = document.createElement('div');
        list.className = 'newsletter-competitions-list';
        state.competitions.forEach(function (comp) {
            list.appendChild(buildCompetitionEditorCard(comp));
        });
        parent.appendChild(list);

        if (state.customIncentives.length) {
            const customList = document.createElement('ul');
            customList.className = 'newsletter-competition-custom-list';
            state.customIncentives.forEach(function (item) {
                const li = document.createElement('li');
                li.className = 'newsletter-competition-custom-row';

                const span = document.createElement('span');
                span.className = 'newsletter-competition-custom-text';
                span.textContent = item.text;
                li.appendChild(span);

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'newsletter-war-rule-delete';
                delBtn.dataset.deleteCustomIncentiveId = item.id;
                delBtn.setAttribute('aria-label', 'Remove custom incentive');
                delBtn.title = 'Remove incentive';
                delBtn.textContent = '×';
                li.appendChild(delBtn);

                customList.appendChild(li);
            });
            parent.appendChild(customList);
        }

        const customAddRow = document.createElement('div');
        customAddRow.className = 'newsletter-war-rule-add-row newsletter-competition-custom-add';
        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.id = 'newsletter-custom-incentive-new';
        customInput.className = 'newsletter-input';
        customInput.placeholder = 'Add a custom incentive…';
        customInput.maxLength = 280;
        const customAddBtn = document.createElement('button');
        customAddBtn.type = 'button';
        customAddBtn.className = 'btn btn-secondary';
        customAddBtn.id = 'newsletter-custom-incentive-add';
        customAddBtn.textContent = 'Add incentive';
        customAddRow.appendChild(customInput);
        customAddRow.appendChild(customAddBtn);
        parent.appendChild(customAddRow);
    }

    function renderCompetitionsPicker() {
        const block = document.querySelector('[data-section-editor="incentives"]');
        if (!block) {
            renderNewsletterSectionEditors();
            return;
        }
        const heading = block.querySelector('.newsletter-section-editor-title');
        const titleText = heading ? heading.textContent : 'Competitions & incentives';
        block.innerHTML = '';
        const newHeading = document.createElement('h3');
        newHeading.className = 'newsletter-section-editor-title';
        newHeading.textContent = titleText;
        block.appendChild(newHeading);
        renderCompetitionsPickerInto(block);
    }

    function newsletterBulletListOpenStyle() {
        return 'margin:0 0 4px 0;padding:0;list-style-type:none;' + bodyTextStyle('');
    }

    /** Accent bullet + body text — inline colours survive Torn mail better than list-style-color. */
    function newsletterBulletItemHtml(text) {
        const accent = getAccentHex();
        return (
            '<li style="' +
            bodyTextStyle('line-height:1.5;margin:0 0 8px 0;') +
            '"><span style="color:' +
            accent +
            ';font-weight:bold;">&#8226;</span> ' +
            esc(text) +
            '</li>'
        );
    }

    function getWarRuleCategoryMailLine(catId) {
        if (normalizeWarRuleCategoryId(catId) === 'termed_war') return 'This is a Termed War';
        return 'This is a Real War!!!';
    }

    function buildWarRulesSection() {
        let html = sectionHeading('War rules & terms');
        const groups = getEnabledWarRulesGrouped();
        if (!groups.length) {
            html +=
                '<p style="' +
                bodyPStyle('font-style:italic;') +
                '">No rules selected — tick items in the War rules & terms panel.</p>';
            return html;
        }
        groups.forEach(function (group) {
            html +=
                '<p style="' +
                bodyTextStyle('font-weight:bold;margin:14px 0 6px 0;font-size:14px;') +
                '">' +
                esc(getWarRuleCategoryMailLine(getActiveWarRuleCategoryId())) +
                '</p>';
            html += '<ul style="' + newsletterBulletListOpenStyle() + '">';
            group.rules.forEach(function (rule) {
                html += newsletterBulletItemHtml(resolveWarRuleDisplayText(rule));
            });
            html += '</ul>';
        });
        return html;
    }

    function appendWarRuleInputControls(rule, label, tmpl) {
        const values = rule.values || {};
        const disabled = !rule.enabled;
        const body = document.createElement('div');
        body.className = 'newsletter-war-rule-body';
        if (tmpl && tmpl.inputType === 'scoring_limit') {
            body.classList.add('newsletter-war-rule-body--stacked');
        }
        label.appendChild(body);

        if (tmpl && tmpl.inputType === 'win_lose') {
            const line = document.createElement('span');
            line.className = 'newsletter-war-rule-inline';
            line.appendChild(document.createTextNode('We will take the '));
            const sel = document.createElement('select');
            sel.className = 'newsletter-select newsletter-select--compact newsletter-war-rule-input newsletter-war-rule-input--choice';
            sel.dataset.warRuleInput = '1';
            sel.dataset.warRuleId = rule.id;
            sel.dataset.valueKey = 'choice';
            sel.disabled = disabled;
            ['Win', 'Lose'].forEach(function (opt) {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt;
                sel.appendChild(o);
            });
            sel.value = values.choice === 'Lose' ? 'Lose' : 'Win';
            line.appendChild(sel);
            body.appendChild(line);
            return;
        }

        if (tmpl && tmpl.inputType === 'score') {
            const line = document.createElement('span');
            line.className = 'newsletter-war-rule-inline';
            line.appendChild(document.createTextNode('Loser will score '));
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.inputMode = 'numeric';
            inp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            inp.dataset.warRuleInput = '1';
            inp.dataset.warRuleId = rule.id;
            inp.dataset.valueKey = 'score';
            inp.placeholder = '4200';
            inp.value = values.score != null ? String(values.score) : '';
            inp.disabled = disabled;
            line.appendChild(inp);
            body.appendChild(line);
            return;
        }

        if (tmpl && tmpl.inputType === 'scoring_limit') {
            const wrap = document.createElement('div');
            wrap.className = 'newsletter-war-rule-scoring-options';

            const stopLabel = document.createElement('label');
            stopLabel.className = 'newsletter-war-rule-scoring-option';
            const stopRadio = document.createElement('input');
            stopRadio.type = 'radio';
            stopRadio.name = 'newsletter-scoring-' + rule.id;
            stopRadio.value = 'stop';
            stopRadio.checked = values.mode !== 'fight_on';
            stopRadio.dataset.warRuleInput = '1';
            stopRadio.dataset.warRuleId = rule.id;
            stopRadio.dataset.valueKey = 'mode';
            stopRadio.disabled = disabled;
            stopLabel.appendChild(stopRadio);
            stopLabel.appendChild(document.createTextNode('Stop scoring at '));
            const stopInp = document.createElement('input');
            stopInp.type = 'text';
            stopInp.inputMode = 'numeric';
            stopInp.className = 'newsletter-input newsletter-war-rule-input newsletter-war-rule-input--score';
            stopInp.dataset.warRuleInput = '1';
            stopInp.dataset.warRuleId = rule.id;
            stopInp.dataset.valueKey = 'stopScore';
            stopInp.placeholder = '5000';
            stopInp.value = values.stopScore != null ? String(values.stopScore) : '';
            stopInp.disabled = disabled || values.mode === 'fight_on';
            stopLabel.appendChild(stopInp);
            wrap.appendChild(stopLabel);

            const fightLabel = document.createElement('label');
            fightLabel.className = 'newsletter-war-rule-scoring-option';
            const fightRadio = document.createElement('input');
            fightRadio.type = 'radio';
            fightRadio.name = 'newsletter-scoring-' + rule.id;
            fightRadio.value = 'fight_on';
            fightRadio.checked = values.mode === 'fight_on';
            fightRadio.dataset.warRuleInput = '1';
            fightRadio.dataset.warRuleId = rule.id;
            fightRadio.dataset.valueKey = 'mode';
            fightRadio.disabled = disabled;
            fightLabel.appendChild(fightRadio);
            fightLabel.appendChild(document.createTextNode('Keep hitting till we win'));
            wrap.appendChild(fightLabel);

            body.appendChild(wrap);
            return;
        }

        const span = document.createElement('span');
        span.className = 'newsletter-war-rule-text';
        span.textContent = rule.custom ? rule.text : tmpl && tmpl.text ? tmpl.text : '';
        body.appendChild(span);
    }

    function getEditableSectionIds() {
        return WAR_SECTIONS.filter(function (sec) {
            return !sec.auto && !sec.rulesPicker && !sec.competitionsPicker;
        }).map(function (sec) {
            return sec.id;
        });
    }

    function syncSectionTextFromDom() {
        const editor = document.getElementById('newsletter-sections-editor');
        if (!editor) return;
        getEditableSectionIds().forEach(function (sectionId) {
            const el =
                editor.querySelector('textarea[data-section-text="' + sectionId + '"]') ||
                editor.querySelector('#newsletter-field-' + sectionId);
            if (el && el.tagName === 'TEXTAREA') {
                state.sectionText[sectionId] = el.value;
            }
        });
    }

    function getSectionTextSnapshot(pendingUpdate) {
        const editor = document.getElementById('newsletter-sections-editor');
        const snap = {};
        getEditableSectionIds().forEach(function (sectionId) {
            if (pendingUpdate && pendingUpdate.id === sectionId) {
                snap[sectionId] = String(pendingUpdate.value != null ? pendingUpdate.value : '');
                state.sectionText[sectionId] = snap[sectionId];
                return;
            }
            let value = state.sectionText[sectionId] != null ? String(state.sectionText[sectionId]) : '';
            if (editor) {
                const el =
                    editor.querySelector('textarea[data-section-text="' + sectionId + '"]') ||
                    editor.querySelector('#newsletter-field-' + sectionId);
                if (el && el.tagName === 'TEXTAREA') {
                    value = el.value;
                    state.sectionText[sectionId] = value;
                }
            }
            snap[sectionId] = value;
        });
        return snap;
    }

    function writeSectionTextCache(snapshot) {
        try {
            localStorage.setItem(SECTION_TEXT_STORAGE_KEY, JSON.stringify(snapshot));
        } catch (e) {
            /* ignore */
        }
    }

    function loadSectionTextCache() {
        try {
            const raw = localStorage.getItem(SECTION_TEXT_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            getEditableSectionIds().forEach(function (sectionId) {
                if (parsed[sectionId] != null) {
                    state.sectionText[sectionId] = String(parsed[sectionId]);
                }
            });
        } catch (e) {
            /* ignore */
        }
    }

    function applySectionTextToDom() {
        const editor = document.getElementById('newsletter-sections-editor');
        if (!editor) return;
        getEditableSectionIds().forEach(function (sectionId) {
            const el =
                editor.querySelector('textarea[data-section-text="' + sectionId + '"]') ||
                editor.querySelector('#newsletter-field-' + sectionId);
            if (el && el.tagName === 'TEXTAREA' && state.sectionText[sectionId] != null) {
                el.value = state.sectionText[sectionId];
            }
        });
    }

    function mergeLegacySectionTextFromDraft(d) {
        if (!d || typeof d !== 'object') return;
        if (d.sectionText && typeof d.sectionText === 'object') {
            Object.assign(state.sectionText, d.sectionText);
        }
        const legacy = {
            intro: d.intro != null ? d.intro : d.openingRally != null ? d.openingRally : d.opening_rally,
            strategy: d.strategy,
            enemy_analysis: d.enemy_analysis != null ? d.enemy_analysis : d.enemyAnalysis,
            closing: d.closing
        };
        Object.keys(legacy).forEach(function (key) {
            if (legacy[key] != null && String(legacy[key]).trim()) {
                state.sectionText[key] = String(legacy[key]);
            }
        });
    }

    function onSectionTextInput(sectionId, value) {
        const snap = getSectionTextSnapshot({ id: sectionId, value: value });
        writeSectionTextCache(snap);
        saveDraft(snap);
        renderPreview();
    }

    function ensureIncentivesSectionEnabled() {
        if (state.sectionEnabled.incentives) return;
        state.sectionEnabled.incentives = true;
        const cb = document.querySelector('.newsletter-sections-list [data-section-id="incentives"]');
        if (cb) cb.checked = true;
        saveDraft();
    }

    function appendSectionTextEditor(parent, sec) {
        if (state.sectionText[sec.id] == null) state.sectionText[sec.id] = '';
        const ta = document.createElement('textarea');
        ta.id = 'newsletter-field-' + sec.id;
        ta.className = 'newsletter-textarea';
        ta.dataset.sectionText = sec.id;
        ta.rows = 4;
        ta.placeholder = sec.placeholder || '';
        ta.value = state.sectionText[sec.id];
        ta.addEventListener('input', function () {
            onSectionTextInput(sec.id, ta.value);
        });
        ta.addEventListener('change', function () {
            onSectionTextInput(sec.id, ta.value);
        });
        ta.addEventListener('blur', function () {
            onSectionTextInput(sec.id, ta.value);
        });
        parent.appendChild(ta);
    }

    function renderWarRulesPickerInto(parent) {
        if (!parent) return;
        const activeCatId = getActiveWarRuleCategoryId();
        const activeCat = getWarRuleCategoryDef(activeCatId);

        parent.innerHTML =
            '<p class="newsletter-hint">Choose Real or Termed war — rules for that type appear below.</p>' +
            '<div class="newsletter-war-type-picker" role="radiogroup" aria-label="War type">' +
            WAR_RULE_CATEGORIES.map(function (cat) {
                const on = cat.id === activeCatId;
                return (
                    '<label class="newsletter-war-type-option' +
                    (on ? ' newsletter-war-type-option--active' : '') +
                    '">' +
                    '<input type="radio" name="newsletter-war-type" value="' +
                    esc(cat.id) +
                    '" data-war-rule-category-select="1"' +
                    (on ? ' checked' : '') +
                    '>' +
                    '<span>' +
                    esc(cat.title) +
                    '</span></label>'
                );
            }).join('') +
            '</div>' +
            '<div class="newsletter-war-rules-panel">' +
            '<ul class="newsletter-war-rules-list"></ul>' +
            '<div class="newsletter-war-rule-add-row">' +
            '<input type="text" id="newsletter-war-rule-new" class="newsletter-input" placeholder="Add a custom ' +
            esc(activeCat.title.replace(/!!!$/, '').trim()) +
            ' rule…" maxlength="280">' +
            '<button type="button" id="newsletter-war-rule-add" class="btn btn-secondary">Add rule</button>' +
            '</div></div>';

        const list = parent.querySelector('.newsletter-war-rules-list');
        if (!list) return;

        activeCat.rules.forEach(function (tmpl) {
            const rule = state.warRules.find(function (r) {
                return r.id === tmpl.id;
            });
            if (!rule) return;

            const li = document.createElement('li');
            li.className = 'newsletter-war-rule-row';

            const label = document.createElement('label');
            label.className = 'newsletter-check newsletter-war-rule-check';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!rule.enabled;
            cb.dataset.warRuleId = rule.id;
            label.appendChild(cb);

            appendWarRuleInputControls(rule, label, tmpl);
            li.appendChild(label);
            list.appendChild(li);
        });

        state.warRules
            .filter(function (r) {
                return r.custom && normalizeWarRuleCategoryId(r.category) === activeCatId;
            })
            .forEach(function (rule) {
                const li = document.createElement('li');
                li.className = 'newsletter-war-rule-row';

                const label = document.createElement('label');
                label.className = 'newsletter-check newsletter-war-rule-check';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!rule.enabled;
                cb.dataset.warRuleId = rule.id;
                label.appendChild(cb);

                const body = document.createElement('div');
                body.className = 'newsletter-war-rule-body';
                const span = document.createElement('span');
                span.className = 'newsletter-war-rule-text';
                span.textContent = rule.text;
                body.appendChild(span);
                label.appendChild(body);
                li.appendChild(label);

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'newsletter-war-rule-delete';
                delBtn.dataset.deleteWarRuleId = rule.id;
                delBtn.setAttribute('aria-label', 'Remove custom rule');
                delBtn.title = 'Remove rule';
                delBtn.textContent = '×';
                li.appendChild(delBtn);

                list.appendChild(li);
            });
    }

    function renderNewsletterSectionEditors() {
        syncSectionTextFromDom();
        const wrap = document.getElementById('newsletter-sections-editor');
        if (!wrap) return;
        wrap.innerHTML =
            '<h2 class="newsletter-block-title">Section content</h2>' +
            '<p class="newsletter-hint">Same order as the newsletter preview below.</p>';

        WAR_SECTIONS.forEach(function (sec) {
            if (sec.auto) return;

            const block = document.createElement('div');
            block.className = 'newsletter-section-editor-block';
            block.dataset.sectionEditor = sec.id;

            const heading = document.createElement('h3');
            heading.className = 'newsletter-section-editor-title';
            heading.textContent = sec.label;
            block.appendChild(heading);

            if (sec.competitionsPicker) {
                renderCompetitionsPickerInto(block);
            } else if (sec.rulesPicker) {
                if (sec.flatRulesId) {
                    renderFlatSectionRulesPickerInto(block, sec.flatRulesId);
                } else {
                    renderWarRulesPickerInto(block);
                }
            } else {
                appendSectionTextEditor(block, sec);
            }

            wrap.appendChild(block);
        });
    }

    function renderWarRulesPicker() {
        renderNewsletterSectionEditors();
    }

    function buildManualSection(sectionId, heading) {
        const text = state.sectionText[sectionId] || '';
        let html = sectionHeading(heading);
        if (text.trim()) html += textToParagraphsHtml(text);
        else html += '<p style="' + bodyPStyle('font-style:italic;') + '">(Add content in the editor panel.)</p>';
        return html;
    }

    function buildNewsletterBodyHtml() {
        const accent = getAccentHex();
        const innerStyle = buildPanelStyle();

        let body =
            '<div data-newsletter-panel="1" style="' + innerStyle + '">';
        body += buildHeaderBlock({ accent: accent, useTag: document.getElementById('newsletter-use-faction-tag')?.checked !== false });

        WAR_SECTIONS.forEach(function (sec) {
            if (!state.sectionEnabled[sec.id]) return;
            if (sec.id === 'war_overview') body += buildWarOverviewSection();
            else if (sec.id === 'enemy_stats') body += buildEnemyStatsSection();
            else if (sec.id === 'enemy_analysis') body += buildEnemyAnalysisSection();
            else if (sec.auto) return;
            else if (sec.id === 'intro') body += buildManualSection('intro', 'Message from leadership');
            else if (sec.id === 'war_rules') body += buildWarRulesSection();
            else if (sec.id === 'strategy') body += buildManualSection('strategy', 'Strategy');
            else if (sec.id === 'payout') body += buildFlatSectionRulesSection('payout');
            else if (sec.id === 'incentives') body += buildCompetitionsSection();
            else if (sec.id === 'closing') body += buildManualSection('closing', 'Closing');
        });

        body += '</div>';
        return body;
    }

    /** Full fragment for Torn editor (matches common faction newsletter pattern). */
    function buildExportHtml() {
        syncSectionTextFromDom();
        const inner = buildNewsletterBodyHtml();
        return (
            '<p class="bold m-bottom10">This is a newsletter from your faction:</p>' +
            '<div style="margin:0;padding:0;">' +
            inner +
            '</div>'
        );
    }

    function renderPreview() {
        const preview = document.getElementById('newsletter-preview');
        const source = document.getElementById('newsletter-source');
        if (!preview) return;
        try {
            syncSectionTextFromDom();
            syncPreviewThemeShell();
            const html = buildExportHtml();
            preview.innerHTML = html;
            if (source) source.value = html;
        } catch (err) {
            console.error('[newsletter] renderPreview failed', err);
        }
    }

    function saveDraft(sectionTextOverride) {
        try {
            const sectionText = sectionTextOverride || getSectionTextSnapshot();
            writeSectionTextCache(sectionText);
            const payload = {
                sectionEnabled: state.sectionEnabled,
                sectionText: sectionText,
                subtitle: document.getElementById('newsletter-subtitle')?.value || '',
                panelColor: getPanelBgHex(),
                accent: document.getElementById('newsletter-accent')?.value || 'gold',
                textTone: document.getElementById('newsletter-text-tone')?.value || 'light',
                useTag: document.getElementById('newsletter-use-faction-tag')?.checked,
                showFactionName: document.getElementById('newsletter-show-faction-name')?.checked,
                linkFaction: document.getElementById('newsletter-link-faction')?.checked,
                enemyFactionId: state.enemyFactionId,
                competitions: state.competitions.map(function (c) {
                    return {
                        id: c.id,
                        typeId: c.typeId,
                        placeCount: c.placeCount,
                        prizes: c.prizes
                    };
                }),
                customIncentives: state.customIncentives.map(function (item) {
                    return { id: item.id, text: item.text };
                })
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
            saveCompetitionsPrefs();
        } catch (e) {
            /* ignore */
        }
    }

    function loadDraft() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const d = JSON.parse(raw);
            if (d.sectionEnabled) Object.assign(state.sectionEnabled, d.sectionEnabled);
            mergeLegacySectionTextFromDraft(d);
            getEditableSectionIds().forEach(function (sectionId) {
                if (state.sectionText[sectionId] == null) state.sectionText[sectionId] = '';
            });
            loadSectionTextCache();
            if (d.subtitle != null) {
                const s = document.getElementById('newsletter-subtitle');
                if (s) s.value = d.subtitle;
            }
            if (d.panelColor) {
                setPanelBgHex(d.panelColor);
            } else if (d.background) {
                const hex = LEGACY_THEME_TO_HEX[d.background];
                if (hex) setPanelBgHex(hex);
            }
            if (d.accent) {
                const a = document.getElementById('newsletter-accent');
                if (a) a.value = d.accent;
            }
            if (d.textTone) {
                const tt = document.getElementById('newsletter-text-tone');
                if (tt) tt.value = d.textTone === 'auto' ? 'light' : d.textTone;
            }
            if (d.useTag != null) {
                const c = document.getElementById('newsletter-use-faction-tag');
                if (c) c.checked = !!d.useTag;
            }
            if (d.showFactionName != null) {
                const c = document.getElementById('newsletter-show-faction-name');
                if (c) c.checked = !!d.showFactionName;
            }
            if (d.linkFaction != null) {
                const c = document.getElementById('newsletter-link-faction');
                if (c) c.checked = !!d.linkFaction;
            }
            if (d.enemyFactionId) state.enemyFactionId = String(d.enemyFactionId);
            if (Array.isArray(d.customIncentives) && d.customIncentives.length) {
                state.customIncentives = d.customIncentives
                    .filter(function (item) {
                        return item && String(item.text || '').trim();
                    })
                    .map(function (item) {
                        return {
                            id: item.id || 'inc-' + Math.random().toString(36).slice(2, 8),
                            text: String(item.text).trim()
                        };
                    });
            }
            if (Array.isArray(d.competitions) && d.competitions.length) {
                state.competitions = d.competitions
                    .filter(function (c) {
                        return c && c.typeId && getCompetitionTypeDef(c.typeId);
                    })
                    .map(function (c) {
                        const placeCount = Math.max(
                            1,
                            Math.min(COMPETITION_MAX_PLACES, Number(c.placeCount) || COMPETITION_DEFAULT_PLACES)
                        );
                        return {
                            id: c.id || 'comp-' + Math.random().toString(36).slice(2, 8),
                            typeId: c.typeId,
                            placeCount: placeCount,
                            prizes: normalizeCompetitionPrizes(placeCount, c.prizes)
                        };
                    });
            }
        } catch (e) {
            /* ignore */
        }
    }

    function renderSectionCheckboxes() {
        const ul = document.getElementById('newsletter-sections-list');
        if (!ul) return;
        ul.innerHTML = '';
        WAR_SECTIONS.forEach(function (sec) {
            if (state.sectionEnabled[sec.id] == null) state.sectionEnabled[sec.id] = sec.defaultOn;
            const li = document.createElement('li');
            const label = document.createElement('label');
            label.className = 'newsletter-check';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!state.sectionEnabled[sec.id];
            cb.dataset.sectionId = sec.id;
            cb.addEventListener('change', function () {
                state.sectionEnabled[sec.id] = cb.checked;
                saveDraft();
                renderPreview();
            }); /* also handled by .newsletter-page delegation */
            label.appendChild(cb);
            const span = document.createElement('span');
            span.textContent = sec.label + (sec.auto ? ' (auto)' : '');
            label.appendChild(span);
            li.appendChild(label);
            ul.appendChild(li);
        });
    }

    function setWarStatus(msg, isError) {
        const el = document.getElementById('newsletter-war-status');
        if (!el) return;
        el.textContent = '';
        const text = String(msg || '');
        const idx = text.indexOf('API Settings');
        if (idx !== -1) {
            el.appendChild(document.createTextNode(text.slice(0, idx)));
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'api-settings-open-link';
            link.textContent = 'API Settings';
            el.appendChild(link);
            el.appendChild(document.createTextNode(text.slice(idx + 'API Settings'.length)));
        } else {
            el.textContent = text;
        }
        el.style.color = isError ? '#f44336' : '#9ccc9c';
    }

    async function getUserProfile(apiKey) {
        const data = await fetchJson('https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(apiKey));
        return {
            factionId: data.faction_id || data.faction?.faction_id || null,
            factionName: data.faction_name || data.faction?.faction_name || ''
        };
    }

    async function fetchFactionBasic(apiKey, factionId) {
        const data = await fetchJson(
            'https://api.torn.com/v2/faction/' + encodeURIComponent(factionId) + '?key=' + encodeURIComponent(apiKey)
        );
        const basic = data.basic || data;
        return {
            name: basic.name || data.name || null,
            tag: basic.tag != null ? String(basic.tag).trim() : '',
            respect: basic.respect != null ? Number(basic.respect) : null,
            rank: basic.rank != null ? basic.rank : null,
            capacity: basic.capacity != null ? Number(basic.capacity) : null
        };
    }

    async function fetchFactionMembers(apiKey, factionId) {
        const url =
            'https://api.torn.com/v2/faction/' +
            encodeURIComponent(factionId) +
            '/members?striptags=true&key=' +
            encodeURIComponent(apiKey);
        const data = await fetchJson(url);
        const members = data.members || [];
        return Array.isArray(members) ? members : Object.values(members);
    }

    /** Current chain only — v1 `chains` on /faction/{id} causes "Incorrect ID-entity relation" for other factions. */
    async function fetchFactionChain(apiKey, factionId) {
        const data = await fetchJson(
            'https://api.torn.com/faction/' +
                encodeURIComponent(factionId) +
                '?selections=chain&key=' +
                encodeURIComponent(apiKey)
        );
        const chain = data.chain;
        if (!chain || typeof chain !== 'object') return null;
        return {
            current: chain.current != null ? Number(chain.current) : 0,
            max: chain.max != null ? Number(chain.max) : 0,
            highest: null
        };
    }

    /** Best-effort historical max from v2 chains list (may fail for some keys/factions). */
    async function fetchFactionHighestChain(apiKey, factionId) {
        try {
            const data = await fetchJson(
                'https://api.torn.com/v2/faction/' +
                    encodeURIComponent(factionId) +
                    '/chains?limit=100&sort=DESC&key=' +
                    encodeURIComponent(apiKey)
            );
            const list = data.chains || [];
            const rows = Array.isArray(list) ? list : Object.values(list);
            let highest = null;
            rows.forEach(function (c) {
                if (!c || c.chain == null) return;
                const n = Number(c.chain);
                if (!isNaN(n) && (highest == null || n > highest)) highest = n;
            });
            return highest;
        } catch (e) {
            console.warn('[newsletter] highest chain fetch skipped', e);
            return null;
        }
    }

    /**
     * Ranked war enemy for our faction (same as War Dashboard / Battle Stats: ongoing, else next upcoming).
     */
    async function resolveWar(apiKey, ourFactionId) {
        const data = await fetchJson(
            'https://api.torn.com/v2/faction/' + encodeURIComponent(ourFactionId) + '/rankedwars?key=' + encodeURIComponent(apiKey)
        );
        const raw = data.rankedwars || [];
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
        const now = Math.floor(Date.now() / 1000);
        const ourId = String(ourFactionId);

        const ongoing = list.find(function (w) {
            return w.start <= now && (!w.end || w.end >= now);
        });
        if (ongoing && ongoing.factions && ongoing.factions.length >= 2) {
            const enemy = ongoing.factions.find(function (f) {
                return rankedWarFactionId(f) !== ourId;
            });
            if (enemy) {
                const eid = rankedWarFactionId(enemy);
                return {
                    war: ongoing,
                    enemyFactionId: eid,
                    enemyName: enemy.name || 'Faction ' + eid,
                    kind: 'ongoing'
                };
            }
        }

        const upcoming = list
            .filter(function (w) {
                return w.start > now && w.factions && w.factions.length >= 2;
            })
            .sort(function (a, b) {
                return a.start - b.start;
            })[0];

        if (upcoming) {
            const enemy = upcoming.factions.find(function (f) {
                return rankedWarFactionId(f) !== ourId;
            });
            if (enemy) {
                const eid = rankedWarFactionId(enemy);
                return {
                    war: upcoming,
                    enemyFactionId: eid,
                    enemyName: enemy.name || 'Faction ' + eid,
                    kind: 'upcoming'
                };
            }
        }
        return null;
    }

    async function loadWarData(enemyOverrideId) {
        const apiKey = getApiKey();
        if (apiKey.length !== 16) {
            document.getElementById('newsletter-api-hint').style.display = 'block';
            setWarStatus('Enter a valid 16-character API key in the sidebar.', true);
            return;
        }
        document.getElementById('newsletter-api-hint').style.display = 'none';
        if (state.loading) return;
        state.loading = true;
        setWarStatus('Loading war and faction data...', false);

        try {
            const profile = await getUserProfile(apiKey);
            if (!profile.factionId) throw new Error('Your API key is not in a faction.');
            state.ourFactionId = String(profile.factionId);
            state.ourFactionName = profile.factionName || 'Our faction';

            const ourBasic = await fetchFactionBasic(apiKey, state.ourFactionId);
            state.ourFactionTag = ourBasic.tag || '';
            state.ourBasic = ourBasic;
            if (ourBasic.name) state.ourFactionName = ourBasic.name;

            const warInfo = await resolveWar(apiKey, state.ourFactionId);
            const overrideId =
                enemyOverrideId != null && String(enemyOverrideId).trim() !== ''
                    ? String(enemyOverrideId).trim()
                    : null;

            let enemyId;
            if (overrideId) {
                enemyId = overrideId;
                if (warInfo && String(warInfo.enemyFactionId) === overrideId) {
                    state.war = warInfo.war;
                    state.warKind = warInfo.kind;
                    state.enemyFactionName = warInfo.enemyName;
                } else {
                    state.war = null;
                    state.warKind = null;
                }
            } else {
                if (!warInfo) {
                    throw new Error('No upcoming or ongoing ranked war found. Enter an enemy faction ID.');
                }
                enemyId = warInfo.enemyFactionId;
                state.war = warInfo.war;
                state.warKind = warInfo.kind;
                state.enemyFactionName = warInfo.enemyName;
            }

            state.enemyFactionId = String(enemyId);
            const enemyInput = document.getElementById('newsletter-enemy-id');
            if (enemyInput) enemyInput.value = state.enemyFactionId;

            const [enemyBasic, members, chain, highestChain] = await Promise.all([
                fetchFactionBasic(apiKey, state.enemyFactionId),
                fetchFactionMembers(apiKey, state.enemyFactionId),
                fetchFactionChain(apiKey, state.enemyFactionId),
                fetchFactionHighestChain(apiKey, state.enemyFactionId)
            ]);
            if (chain && highestChain != null && highestChain > 0) chain.highest = highestChain;
            state.enemyBasic = enemyBasic;
            state.enemyFactionName = enemyBasic.name || state.enemyFactionName || 'Enemy';
            state.enemyMembers = members;
            state.enemySummary = summarizeEnemyMembers(members);
            state.enemyChain = chain;
            state.enemyBattleStats = {};

            const memberIds = members
                .map(function (m) {
                    return m && m.id != null ? String(m.id) : '';
                })
                .filter(function (id) {
                    return /^\d+$/.test(id);
                });

            let battleStatsFetchFailed = false;
            if (memberIds.length) {
                setWarStatus('Fetching battle stat estimates (FF Scouter)…', false);
                try {
                    state.enemyBattleStats = await fetchEnemyBattleStats(apiKey, memberIds);
                    attachBattleStatsToSummary(state.enemySummary, state.enemyBattleStats);
                } catch (ffErr) {
                    battleStatsFetchFailed = true;
                    console.warn('[newsletter] FF Scouter battle stats failed', ffErr);
                    const msg = ffErr && ffErr.message ? ffErr.message : String(ffErr);
                    setWarStatus(
                        /not registered|ffscouter/i.test(msg)
                            ? 'War data loaded, but FF Scouter estimates failed. Open API Settings from the Welcome panel to add a FFScouter key, or register your Torn key at ffscouter.com.'
                            : 'War data loaded, but battle stat estimates could not be fetched.',
                        true
                    );
                }
            }

            const estCount = state.enemySummary
                ? state.enemySummary.allMembers.filter(function (m) {
                      return m.bs != null && m.bs !== '';
                  }).length
                : 0;
            const kind = state.warKind === 'upcoming' ? 'Upcoming war' : state.warKind === 'ongoing' ? 'Ongoing war' : 'Enemy loaded';
            if (!battleStatsFetchFailed) {
                setWarStatus(
                    kind +
                        ' vs ' +
                        state.enemyFactionName +
                        ' (ID ' +
                        state.enemyFactionId +
                        '). ' +
                        (state.enemySummary ? state.enemySummary.count + ' members' : '') +
                        (estCount ? ', est. stats for ' + estCount + ' members.' : '.'),
                    false
                );
            }
            saveDraft();
            syncMailTitlePlaceholder();
            renderPreview();
            if (window.logToolUsage) window.logToolUsage('newsletter');
        } catch (err) {
            setWarStatus(err.message || String(err), true);
        } finally {
            state.loading = false;
        }
    }

    async function copyToClipboard(html, plain, btn) {
        const showOk = function () {
            const msg = document.getElementById('newsletter-copy-msg');
            if (msg) {
                msg.textContent = 'Copied to clipboard!';
                setTimeout(function () {
                    msg.textContent = '';
                }, 2500);
            }
            if (btn) {
                const t = btn.textContent;
                btn.textContent = 'Copied';
                setTimeout(function () {
                    btn.textContent = t;
                }, 2000);
            }
        };
        try {
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([plain], { type: 'text/plain' })
                })
            ]);
            showOk();
        } catch (e) {
            try {
                await navigator.clipboard.writeText(plain);
                showOk();
            } catch (e2) {
                alert('Could not copy. Use Show HTML source and copy manually.');
            }
        }
    }

    function htmlToPlain(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.innerText || div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    const NEWSLETTER_LIVE_FIELD_IDS = [
        'newsletter-title',
        'newsletter-subtitle',
        'newsletter-panel-color',
        'newsletter-accent',
        'newsletter-text-tone',
        'newsletter-use-faction-tag',
        'newsletter-show-faction-name',
        'newsletter-link-faction',
        'newsletter-preview-theme'
    ];

    let newsletterEventsAbort = null;

    function onNewsletterEditorChange(e) {
        const t = e.target;
        if (!t) return;
        if (t.dataset && t.dataset.warRuleCategorySelect) {
            if (t.checked) setSelectedWarRuleCategory(t.value);
            return;
        }
        if (t.dataset && t.dataset.flatRuleCategorySelect && t.dataset.flatRuleSection) {
            if (t.checked) setSelectedFlatSectionCategory(t.dataset.flatRuleSection, t.value);
            return;
        }
        if (t.dataset && t.dataset.warRuleId && !t.dataset.warRuleInput) {
            setWarRuleEnabled(t.dataset.warRuleId, !!t.checked);
            return;
        }
        if (t.dataset && t.dataset.competitionPlaceCount && t.dataset.competitionId) {
            setCompetitionPlaceCount(t.dataset.competitionId, t.value);
            return;
        }
        if (t.dataset && t.dataset.competitionPrizeInput && t.dataset.competitionId != null) {
            setCompetitionPrize(t.dataset.competitionId, t.dataset.placeIndex, t.value);
            return;
        }
        if (t.dataset && t.dataset.flatRuleSection && t.dataset.flatRuleId && !t.dataset.flatRuleInput) {
            setFlatSectionRuleEnabled(t.dataset.flatRuleSection, t.dataset.flatRuleId, !!t.checked);
            return;
        }
        if (t.dataset && t.dataset.flatRuleInput && t.dataset.flatRuleSection && t.dataset.flatRuleId && t.dataset.valueKey) {
            setFlatSectionRuleValue(
                t.dataset.flatRuleSection,
                t.dataset.flatRuleId,
                t.dataset.valueKey,
                t.value
            );
            return;
        }
        if (t.dataset && t.dataset.warRuleInput && t.dataset.warRuleId && t.dataset.valueKey) {
            let val = t.value;
            if (t.type === 'radio') {
                if (!t.checked) return;
                val = t.value;
            }
            setWarRuleValue(t.dataset.warRuleId, t.dataset.valueKey, val);
            if (t.dataset.valueKey === 'mode') {
                renderWarRulesPicker();
            }
            return;
        }
        if (t.dataset && t.dataset.sectionId) {
            state.sectionEnabled[t.dataset.sectionId] = !!t.checked;
            saveDraft();
            renderPreview();
            return;
        }
        if (t.id && NEWSLETTER_LIVE_FIELD_IDS.indexOf(t.id) >= 0) {
            if (t.id === 'newsletter-panel-color') syncPanelColorPicker();
            saveDraft();
            renderPreview();
        }
    }

    function wireEvents() {
        if (newsletterEventsAbort) newsletterEventsAbort.abort();
        newsletterEventsAbort = new AbortController();
        const signal = newsletterEventsAbort.signal;

        const pageRoot = document.querySelector('.newsletter-page');
        if (pageRoot) {
            pageRoot.addEventListener('change', onNewsletterEditorChange, { signal: signal });
            pageRoot.addEventListener('input', onNewsletterEditorChange, { signal: signal });
            pageRoot.addEventListener('click', function (e) {
                const addCompBtn = e.target.closest('#newsletter-competition-add');
                if (addCompBtn) {
                    const sel = document.getElementById('newsletter-competition-type-select');
                    if (sel && sel.value) addCompetition(sel.value);
                    return;
                }
                const delCompBtn = e.target.closest('[data-delete-competition-id]');
                if (delCompBtn) {
                    removeCompetition(delCompBtn.getAttribute('data-delete-competition-id'));
                    return;
                }
                const addIncBtn = e.target.closest('#newsletter-custom-incentive-add');
                if (addIncBtn) {
                    const input = document.getElementById('newsletter-custom-incentive-new');
                    if (addCustomIncentive(input ? input.value : '')) {
                        if (input) input.value = '';
                    }
                    return;
                }
                const delIncBtn = e.target.closest('[data-delete-custom-incentive-id]');
                if (delIncBtn) {
                    removeCustomIncentive(delIncBtn.getAttribute('data-delete-custom-incentive-id'));
                    return;
                }
                const addBtn = e.target.closest('[data-flat-rule-add]');
                if (addBtn) {
                    const sectionId = addBtn.getAttribute('data-flat-rule-add');
                    const input = document.getElementById('newsletter-flat-rule-new-' + sectionId);
                    if (addCustomFlatSectionRule(sectionId, input ? input.value : '')) {
                        if (input) input.value = '';
                    }
                    return;
                }
                const delFlatBtn = e.target.closest('[data-delete-flat-rule-id]');
                if (delFlatBtn) {
                    removeCustomFlatSectionRule(
                        delFlatBtn.getAttribute('data-delete-flat-rule-section'),
                        delFlatBtn.getAttribute('data-delete-flat-rule-id')
                    );
                    return;
                }
                const addBtnWar = e.target.closest('#newsletter-war-rule-add');
                if (addBtnWar) {
                    const input = document.getElementById('newsletter-war-rule-new');
                    if (addCustomWarRule(input ? input.value : '')) {
                        if (input) input.value = '';
                    }
                    return;
                }
                const delBtn = e.target.closest('[data-delete-war-rule-id]');
                if (delBtn) {
                    removeCustomWarRule(delBtn.getAttribute('data-delete-war-rule-id'));
                }
            }, { signal: signal });
            pageRoot.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                const flatId = e.target && e.target.id && e.target.id.indexOf('newsletter-flat-rule-new-') === 0
                    ? e.target.id.replace('newsletter-flat-rule-new-', '')
                    : '';
                if (flatId) {
                    e.preventDefault();
                    if (addCustomFlatSectionRule(flatId, e.target.value)) e.target.value = '';
                    return;
                }
                if (e.target?.id === 'newsletter-custom-incentive-new') {
                    e.preventDefault();
                    if (addCustomIncentive(e.target.value)) e.target.value = '';
                    return;
                }
                if (e.target?.id !== 'newsletter-war-rule-new') return;
                e.preventDefault();
                if (addCustomWarRule(e.target.value)) e.target.value = '';
            }, { signal: signal });
            window.addEventListener(
                'beforeunload',
                function () {
                    saveDraft();
                },
                { signal: signal }
            );
        }

        document.getElementById('newsletter-load-war')?.addEventListener('click', function () {
            loadWarData(null);
        }, { signal: signal });
        document.getElementById('newsletter-apply-enemy')?.addEventListener('click', function () {
            const id = (document.getElementById('newsletter-enemy-id')?.value || '').trim();
            if (!id) {
                setWarStatus('Enter an enemy faction ID.', true);
                return;
            }
            loadWarData(id);
        }, { signal: signal });

        document.getElementById('newsletter-copy-mail')?.addEventListener('click', function () {
            syncSectionTextFromDom();
            renderPreview();
            const html = buildExportHtml();
            copyToClipboard(html, htmlToPlain(html), document.getElementById('newsletter-copy-mail'));
        }, { signal: signal });
        document.getElementById('newsletter-copy-source')?.addEventListener('click', function () {
            syncSectionTextFromDom();
            renderPreview();
            const html = buildExportHtml();
            copyToClipboard(html, html, document.getElementById('newsletter-copy-source'));
        }, { signal: signal });
        document.getElementById('newsletter-show-source')?.addEventListener('click', function () {
            const wrap = document.getElementById('newsletter-source-wrap');
            const btn = document.getElementById('newsletter-show-source');
            if (!wrap || !btn) return;
            const open = wrap.hidden;
            wrap.hidden = !open;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            btn.textContent = open ? 'Hide HTML source' : 'Show HTML source';
            if (open) renderPreview();
        }, { signal: signal });
    }

    function syncPreviewThemeShell() {
        const shell = document.getElementById('newsletter-preview-shell');
        const sel = document.getElementById('newsletter-preview-theme');
        if (!shell || !sel) return;
        const dark = sel.value === 'dark';
        shell.classList.toggle('newsletter-preview-shell--light', !dark);
        shell.classList.toggle('newsletter-preview-shell--dark', dark);
    }

    function initNewsletter() {
        WAR_SECTIONS.forEach(function (s) {
            if (state.sectionEnabled[s.id] == null) state.sectionEnabled[s.id] = s.defaultOn;
        });
        getEditableSectionIds().forEach(function (sectionId) {
            if (state.sectionText[sectionId] == null) state.sectionText[sectionId] = '';
        });
        renderPanelColorPicker();
        loadWarRulesPrefs();
        loadAllFlatSectionRulesPrefs();
        loadCompetitionsPrefs();
        loadDraft();
        const mailTitleEl = document.getElementById('newsletter-title');
        if (mailTitleEl) mailTitleEl.value = '';
        syncMailTitlePlaceholder();
        migrateLegacySectionTextToFlatRules('payout');
        syncPanelColorPicker();
        renderSectionCheckboxes();
        renderNewsletterSectionEditors();
        applySectionTextToDom();
        wireEvents();
        syncPreviewThemeShell();
        saveDraft();
        renderPreview();

        const key = getApiKey();
        if (key.length !== 16) {
            document.getElementById('newsletter-api-hint').style.display = 'block';
        }
        if (window.logToolUsage) window.logToolUsage('newsletter');
    }

    window.initNewsletter = initNewsletter;
})();

