/**
 * Faction Newsletter — Upcoming War template.
 * Builds Torn faction-mail HTML with section toggles and API-filled blocks.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'newsletter_war_draft_v1';

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
        { id: 'enemy_stats', label: 'Enemy stats', defaultOn: true, auto: true },
        { id: 'enemy_analysis', label: 'Enemy analysis', defaultOn: true, fieldLabel: 'Enemy analysis notes', placeholder: 'Key targets, chains to watch, respect gap, etc. Auto table of top members is included when data is loaded.' },
        { id: 'war_rules', label: 'War rules & terms', defaultOn: true, fieldLabel: 'Rules & terms', placeholder: 'Term length, min score, outside hits, terms, etc.' },
        { id: 'strategy', label: 'Strategy', defaultOn: true, fieldLabel: 'Strategy', placeholder: 'Chains, timing, who hits whom, hospital rules...' },
        { id: 'payout', label: 'Payout method', defaultOn: true, fieldLabel: 'Payout method', placeholder: 'How war pay will be calculated and when it will be sent.' },
        { id: 'incentives', label: 'Competitions & incentives', defaultOn: false, fieldLabel: 'Competitions & incentives', placeholder: 'Bonus pools, MVPs, chain rewards...' },
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
        loading: false
    };

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

    function attachBattleStatsToSummary(summary, bsMap) {
        if (!summary || !summary.topByLevel || !bsMap) return;
        summary.topByLevel = summary.topByLevel.map(function (m) {
            const id = String(m.id);
            const bs = bsMap[id] != null ? bsMap[id] : bsMap[m.id];
            return {
                id: m.id,
                name: m.name,
                level: m.level,
                bs: bs != null && bs !== '' ? bs : null
            };
        });
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

    function tableHeaderCellStyle(align) {
        const a = align || 'left';
        return 'text-align:' + a + ';background:#000000;color:#e8e8e8;padding:4px;';
    }

    function tableBodyCellStyle(align, extra) {
        let s = 'padding:4px;text-align:' + (align || 'left') + ';' + (extra || '');
        return bodyTextStyle(s);
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
        const titleLine = document.getElementById('newsletter-title')?.value?.trim() || defaultMailTitle();
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
            esc(tag + titleLine) +
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

    function defaultMailTitle() {
        const enemy = state.enemyFactionName || 'Enemy';
        if (state.warKind === 'upcoming') return 'Upcoming war vs ' + enemy;
        if (state.warKind === 'ongoing') return 'Ranked war vs ' + enemy;
        return 'War briefing - ' + enemy;
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
        const byLevel = members
            .map(function (m) {
                return {
                    id: m.id,
                    name: m.name || 'Unknown',
                    level: m.level != null ? Number(m.level) : 0
                };
            })
            .sort(function (a, b) {
                return b.level - a.level;
            });
        return {
            count: members.length,
            topByLevel: byLevel.slice(0, 8)
        };
    }

    function buildEnemyStatsSection() {
        let html = sectionHeading('Enemy stats');
        const b = state.enemyBasic;
        const sum = state.enemySummary;
        if (!b && !sum) {
            html += '<p style="' + bodyPStyle() + '">Load war data to fill enemy intel.</p>';
            return html;
        }
        html +=
            '<table border="0" cellpadding="4" cellspacing="0" style="border-collapse:collapse;margin-top:10px;font-size:13px;"><tbody>';
        function row(label, val) {
            return (
                '<tr><td style="' +
                bodyTextStyle('padding:6px 8px 6px 0;') +
                '">' +
                esc(label) +
                '</td><td style="' +
                bodyTextStyle('padding:6px 0;font-weight:600;') +
                '">' +
                esc(val) +
                '</td></tr>'
            );
        }
        if (state.enemyFactionName) html += row('Faction', state.enemyFactionName);
        if (b && b.respect != null) html += row('Respect', formatNumber(b.respect));
        if (sum) html += row('Members', formatNumber(sum.count));
        if (state.enemyChain && state.enemyChain.highest != null && state.enemyChain.highest > 0) {
            html += row('Highest chain', formatNumber(state.enemyChain.highest));
        }
        html += '</tbody></table>';
        return html;
    }

    function buildEnemyAnalysisSection() {
        let html = sectionHeading('Enemy analysis');
        const notes = state.sectionText.enemy_analysis || '';
        if (notes.trim()) html += textToParagraphsHtml(notes);

        const sum = state.enemySummary;
        if (sum && sum.topByLevel.length) {
            const hasEstStats = sum.topByLevel.some(function (m) {
                return m.bs != null && m.bs !== '';
            });
            html +=
                '<p style="' +
                bodyPStyle('font-size:12px;') +
                '">Top members by level' +
                (hasEstStats ? ' (est. stats from FF Scouter, same as Faction Battle Stats)' : '') +
                ':</p>';
            html +=
                '<table border="0" cellpadding="4" cellspacing="0" style="border-collapse:collapse;margin-top:6px;font-size:12px;"><thead><tr>' +
                '<th style="' +
                tableHeaderCellStyle('left') +
                '">Name</th>' +
                '<th style="' +
                tableHeaderCellStyle('right') +
                '">Lvl</th>' +
                '<th style="' +
                tableHeaderCellStyle('right') +
                '">Est. stats</th></tr></thead><tbody>';
            sum.topByLevel.forEach(function (m) {
                html +=
                    '<tr><td style="' +
                    tableBodyCellStyle('left') +
                    '"><a href="https://www.torn.com/profiles.php?XID=' +
                    encodeURIComponent(String(m.id)) +
                    '">' +
                    esc(m.name) +
                    '</a></td><td style="' +
                    tableBodyCellStyle('right') +
                    '">' +
                    esc(String(m.level)) +
                    '</td><td style="' +
                    tableBodyCellStyle('right') +
                    '">' +
                    esc(formatEstimatedBattleStat(m.bs)) +
                    '</td></tr>';
            });
            html += '</tbody></table>';
        } else if (!notes.trim()) {
            html += '<p style="' + bodyPStyle() + '">Add notes above or load war data for a member snapshot.</p>';
        }
        return html;
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
            else if (sec.id === 'war_rules') body += buildManualSection('war_rules', 'War rules & terms');
            else if (sec.id === 'strategy') body += buildManualSection('strategy', 'Strategy');
            else if (sec.id === 'payout') body += buildManualSection('payout', 'Payout method');
            else if (sec.id === 'incentives') body += buildManualSection('incentives', 'Competitions & incentives');
            else if (sec.id === 'closing') body += buildManualSection('closing', 'Closing');
        });

        body += '</div>';
        return body;
    }

    /** Full fragment for Torn editor (matches common faction newsletter pattern). */
    function buildExportHtml() {
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
            syncPreviewThemeShell();
            const html = buildExportHtml();
            preview.innerHTML = html;
            if (source) source.value = html;
        } catch (err) {
            console.error('[newsletter] renderPreview failed', err);
        }
    }

    function saveDraft() {
        try {
            const payload = {
                sectionEnabled: state.sectionEnabled,
                sectionText: state.sectionText,
                title: document.getElementById('newsletter-title')?.value || '',
                subtitle: document.getElementById('newsletter-subtitle')?.value || '',
                panelColor: getPanelBgHex(),
                accent: document.getElementById('newsletter-accent')?.value || 'gold',
                textTone: document.getElementById('newsletter-text-tone')?.value || 'light',
                useTag: document.getElementById('newsletter-use-faction-tag')?.checked,
                showFactionName: document.getElementById('newsletter-show-faction-name')?.checked,
                linkFaction: document.getElementById('newsletter-link-faction')?.checked,
                enemyFactionId: state.enemyFactionId
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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
            if (d.sectionText) Object.assign(state.sectionText, d.sectionText);
            if (d.title != null) {
                const t = document.getElementById('newsletter-title');
                if (t) t.value = d.title;
            }
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

    function renderTextFields() {
        const wrap = document.getElementById('newsletter-fields-wrap');
        if (!wrap) return;
        wrap.innerHTML = '<h2 class="newsletter-block-title">Section text</h2>';
        WAR_SECTIONS.filter(function (s) {
            return !s.auto;
        }).forEach(function (sec) {
            if (state.sectionText[sec.id] == null) state.sectionText[sec.id] = '';
            const label = document.createElement('label');
            label.className = 'newsletter-field-label';
            label.setAttribute('for', 'newsletter-field-' + sec.id);
            label.textContent = sec.fieldLabel || sec.label;
            const ta = document.createElement('textarea');
            ta.id = 'newsletter-field-' + sec.id;
            ta.className = 'newsletter-textarea';
            ta.rows = 4;
            ta.placeholder = sec.placeholder || '';
            ta.value = state.sectionText[sec.id];
            ta.addEventListener('input', function () {
                state.sectionText[sec.id] = ta.value;
                saveDraft();
                renderPreview();
            });
            wrap.appendChild(label);
            wrap.appendChild(ta);
        });
    }

    function setWarStatus(msg, isError) {
        const el = document.getElementById('newsletter-war-status');
        if (!el) return;
        el.textContent = msg;
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
     * Prefer upcoming war for newsletter; fall back to ongoing.
     */
    async function resolveWar(apiKey, ourFactionId) {
        const data = await fetchJson(
            'https://api.torn.com/v2/faction/' + encodeURIComponent(ourFactionId) + '/rankedwars?key=' + encodeURIComponent(apiKey)
        );
        const raw = data.rankedwars || [];
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
        const now = Math.floor(Date.now() / 1000);

        const upcoming = list
            .filter(function (w) {
                return w.start > now && w.factions && w.factions.length >= 2;
            })
            .sort(function (a, b) {
                return a.start - b.start;
            })[0];

        if (upcoming) {
            const enemy = upcoming.factions.find(function (f) {
                return rankedWarFactionId(f) !== String(ourFactionId);
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

        const ongoing = list.find(function (w) {
            return w.start <= now && (!w.end || w.end >= now);
        });
        if (ongoing && ongoing.factions && ongoing.factions.length >= 2) {
            const enemy = ongoing.factions.find(function (f) {
                return rankedWarFactionId(f) !== String(ourFactionId);
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

            let enemyId = enemyOverrideId || state.enemyFactionId;
            let warInfo = null;
            if (!enemyId) {
                warInfo = await resolveWar(apiKey, state.ourFactionId);
                if (!warInfo) throw new Error('No upcoming or ongoing ranked war found. Enter an enemy faction ID.');
                enemyId = warInfo.enemyFactionId;
                state.war = warInfo.war;
                state.warKind = warInfo.kind;
                state.enemyFactionName = warInfo.enemyName;
            } else {
                warInfo = await resolveWar(apiKey, state.ourFactionId);
                if (warInfo && String(warInfo.enemyFactionId) === String(enemyId)) {
                    state.war = warInfo.war;
                    state.warKind = warInfo.kind;
                } else {
                    state.war = warInfo && warInfo.war ? warInfo.war : null;
                    state.warKind = warInfo ? warInfo.kind : null;
                }
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
                            ? 'War data loaded, but FF Scouter estimates failed. Register your API key at ffscouter.com (same as Faction Battle Stats).'
                            : 'War data loaded, but battle stat estimates could not be fetched.',
                        true
                    );
                }
            }

            const titleEl = document.getElementById('newsletter-title');
            if (titleEl && !titleEl.value.trim()) titleEl.value = defaultMailTitle();

            const estCount = state.enemySummary
                ? state.enemySummary.topByLevel.filter(function (m) {
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
                        (estCount ? ', est. stats for top targets.' : '.'),
                    false
                );
            }
            saveDraft();
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
            renderPreview();
            const html = buildExportHtml();
            copyToClipboard(html, htmlToPlain(html), document.getElementById('newsletter-copy-mail'));
        }, { signal: signal });
        document.getElementById('newsletter-copy-source')?.addEventListener('click', function () {
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
        renderPanelColorPicker();
        loadDraft();
        syncPanelColorPicker();
        renderSectionCheckboxes();
        renderTextFields();
        wireEvents();
        syncPreviewThemeShell();
        renderPreview();

        const key = getApiKey();
        if (key.length !== 16) {
            document.getElementById('newsletter-api-hint').style.display = 'block';
        }
        if (window.logToolUsage) window.logToolUsage('newsletter');
    }

    window.initNewsletter = initNewsletter;
})();

