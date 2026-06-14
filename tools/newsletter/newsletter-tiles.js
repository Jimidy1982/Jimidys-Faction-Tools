/**
 * Tiled newsletter backgrounds — original SVG patterns (no external license).
 * Embedded as data URIs in faction-mail HTML so tiles work when pasted into Torn.
 */
(function (global) {
    'use strict';

    function svgToDataUri(svg) {
        return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim());
    }

    /** 64×64 seamless tiles */
    const SVG = {
        brickDark:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1a1816"/>' +
            '<path fill="#2e2824" stroke="#120f0d" stroke-width="0.6" d="M0 0h30v15H0zm32 0h32v15H32zm-16 15h30v15H16zm32 0h16v15H48zm-32 15h30v15H0zm32 0h32v15H32zm-16 15h30v15H16zm32 0h16v15H48z"/>' +
            '</svg>',
        brickRed:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#2a1818"/>' +
            '<path fill="#4a2828" stroke="#1a0e0e" stroke-width="0.6" d="M0 0h28v14H0zm30 0h34v14H30zm-14 14h28v14H16zm32 0h18v14H48zm-30 14h28v14H0zm30 0h34v14H30zm-14 14h28v14H16zm32 0h18v14H48z"/>' +
            '</svg>',
        stoneGray:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#2a2a2e"/>' +
            '<circle cx="12" cy="10" r="5" fill="#38383f" opacity="0.9"/>' +
            '<circle cx="44" cy="18" r="7" fill="#323238" opacity="0.85"/>' +
            '<circle cx="28" cy="40" r="8" fill="#3a3a42" opacity="0.8"/>' +
            '<circle cx="52" cy="48" r="6" fill="#35353c" opacity="0.9"/>' +
            '<circle cx="8" cy="52" r="4" fill="#303036" opacity="0.85"/>' +
            '</svg>',
        stoneCold:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1e2430"/>' +
            '<circle cx="14" cy="12" r="6" fill="#2a3548" opacity="0.9"/>' +
            '<circle cx="40" cy="22" r="8" fill="#253040" opacity="0.85"/>' +
            '<circle cx="24" cy="44" r="7" fill="#2c384c" opacity="0.8"/>' +
            '<circle cx="50" cy="50" r="5" fill="#222c3a" opacity="0.9"/>' +
            '</svg>',
        concrete:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#2c2c2c"/>' +
            '<path stroke="#3a3a3a" stroke-width="0.8" d="M0 20h64M0 44h64M20 0v64M44 0v64" opacity="0.5"/>' +
            '<circle cx="10" cy="8" r="1.2" fill="#404040"/><circle cx="33" cy="15" r="1" fill="#3d3d3d"/>' +
            '<circle cx="55" cy="30" r="1.3" fill="#454545"/><circle cx="18" cy="52" r="1.1" fill="#3f3f3f"/>' +
            '</svg>',
        steelPlate:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#252830"/>' +
            '<path fill="#323a48" d="M0 0h32v32H0zm32 32h32v32H32z" opacity="0.35"/>' +
            '<path stroke="#4a5568" stroke-width="0.5" d="M0 32h64M32 0v64" opacity="0.4"/>' +
            '<circle cx="10" cy="10" r="2" fill="#1a1e26"/><circle cx="42" cy="10" r="2" fill="#1a1e26"/>' +
            '<circle cx="10" cy="42" r="2" fill="#1a1e26"/><circle cx="42" cy="42" r="2" fill="#1a1e26"/>' +
            '</svg>',
        rustMetal:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#2a1f18"/>' +
            '<path fill="#4a3020" opacity="0.5" d="M0 8h64v6H0zm0 24h64v5H0zm0 40h64v6H0z"/>' +
            '<path fill="#5c3828" opacity="0.35" d="M8 0v64h5V8zm24 0v64h6V8zm48 0v64h5V8z"/>' +
            '</svg>',
        warCamo:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1e241c"/>' +
            '<path fill="#2a3424" d="M0 0c20 8 12 28 0 32zm64 0c-18 10-10 26 0 30z" opacity="0.7"/>' +
            '<path fill="#243020" d="M20 20h24v24H20z" opacity="0.5"/>' +
            '<path fill="#1a2818" d="M40 0h24v40H40zM0 36h36v28H0z" opacity="0.45"/>' +
            '</svg>',
        chainMesh:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1c1c1c"/>' +
            '<path stroke="#4a4a4a" stroke-width="1.2" fill="none" d="M0 0l64 64M64 0L0 64M32 0v64M0 32h64" opacity="0.55"/>' +
            '<circle cx="32" cy="32" r="3" fill="#333" stroke="#555" stroke-width="0.8"/>' +
            '</svg>',
        asphalt:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1a1a1a"/>' +
            '<rect x="0" y="30" width="64" height="2" fill="#2e2e2e" opacity="0.6"/>' +
            '<rect x="30" y="0" width="2" height="64" fill="#282828" opacity="0.35"/>' +
            '<circle cx="8" cy="12" r="0.8" fill="#333"/><circle cx="48" cy="50" r="1" fill="#303030"/>' +
            '</svg>',
        marble:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#2a2828"/>' +
            '<path stroke="#3d3a38" stroke-width="1.5" fill="none" opacity="0.5" d="M0 40 Q20 20 40 35 T64 25"/>' +
            '<path stroke="#353230" stroke-width="1" fill="none" opacity="0.4" d="M0 15 Q30 35 64 10"/>' +
            '</svg>',
        iceFrost:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1a2430"/>' +
            '<path stroke="#6a8ab0" stroke-width="0.8" opacity="0.45" d="M32 0v64M0 32h64M0 0l64 64M64 0L0 64"/>' +
            '<circle cx="16" cy="16" r="4" fill="#2a3a50" opacity="0.5"/><circle cx="48" cy="48" r="5" fill="#283848" opacity="0.45"/>' +
            '</svg>',
        vaultGrid:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1e1e22"/>' +
            '<path stroke="#3d3a50" stroke-width="0.6" fill="none" d="M8 8h48v48H8z" opacity="0.5"/>' +
            '<path stroke="#4a4560" stroke-width="0.5" fill="none" d="M8 24h48M8 40h48M24 8v48M40 8v48" opacity="0.35"/>' +
            '</svg>',
        hazard:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#222018"/>' +
            '<path fill="#3a3420" d="M0 0h16v16H0zm16 16h16v16H16zm32 32h16v16H32z" opacity="0.5"/>' +
            '<path fill="#4a4028" d="M32 0h16v16H32zm0 32h16v16H32zm-32 16h16v16H0z" opacity="0.35"/>' +
            '</svg>',
        purpleWeave:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#1e1a28"/>' +
            '<path stroke="#5a4080" stroke-width="1" opacity="0.4" d="M0 16h64M0 48h64M16 0v64M48 0v64"/>' +
            '<path fill="#3a2858" opacity="0.25" d="M0 0h32v32H0zm32 32h32v32H32z"/>' +
            '</svg>',
        bloodMist:
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
            '<rect width="64" height="64" fill="#221818"/>' +
            '<circle cx="20" cy="18" r="8" fill="#3a2020" opacity="0.35"/>' +
            '<circle cx="48" cy="40" r="10" fill="#351c1c" opacity="0.3"/>' +
            '<circle cx="12" cy="50" r="5" fill="#2e1818" opacity="0.4"/>' +
            '</svg>'
    };

    const TILE_URI = {};
    Object.keys(SVG).forEach(function (k) {
        TILE_URI[k] = svgToDataUri(SVG[k]);
    });

    /**
     * @typedef {Object} NewsletterBackground
     * @property {string} id
     * @property {string} label
     * @property {'solid'|'gradient'|'tile'} type
     * @property {string} [tileKey] - key in TILE_URI
     * @property {string} [overlay] - extra linear-gradient for readability
     */

    const BACKGROUNDS = [
        { id: 'classic', label: 'Plain panel', type: 'solid' },
        {
            id: 'gradient-rally',
            label: 'Rally glow',
            type: 'gradient',
            overlay: 'linear-gradient(165deg, rgba(143,112,255,0.14) 0%, transparent 50%, rgba(143,112,255,0.08) 100%)'
        },
        {
            id: 'gradient-steel',
            label: 'Steel wash',
            type: 'gradient',
            overlay: 'linear-gradient(180deg, rgba(120,140,160,0.18) 0%, transparent 45%, rgba(60,70,80,0.12) 100%)'
        },
        {
            id: 'gradient-ember',
            label: 'Ember wash',
            type: 'gradient',
            overlay: 'linear-gradient(135deg, rgba(196,92,92,0.16) 0%, transparent 50%, rgba(212,168,75,0.1) 100%)'
        },
        {
            id: 'gradient-spotlight',
            label: 'Spotlight',
            type: 'gradient',
            overlay:
                'radial-gradient(ellipse at 50% 0%, rgba(143,112,255,0.22) 0%, transparent 55%),' +
                'linear-gradient(180deg, rgba(30,35,45,0.28) 0%, transparent 50%)'
        },
        { id: 'tile-brick-dark', label: 'Dark brick', type: 'tile', tileKey: 'brickDark', overlay: 'linear-gradient(rgba(0,0,0,0.42), rgba(0,0,0,0.42))' },
        { id: 'tile-brick-red', label: 'Red brick', type: 'tile', tileKey: 'brickRed', overlay: 'linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.45))' },
        { id: 'tile-stone', label: 'Stone', type: 'tile', tileKey: 'stoneGray', overlay: 'linear-gradient(rgba(0,0,0,0.38), rgba(0,0,0,0.38))' },
        { id: 'tile-stone-cold', label: 'Cold stone', type: 'tile', tileKey: 'stoneCold', overlay: 'linear-gradient(rgba(10,15,25,0.45), rgba(10,15,25,0.45))' },
        { id: 'tile-concrete', label: 'Concrete', type: 'tile', tileKey: 'concrete', overlay: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4))' },
        { id: 'tile-steel', label: 'Steel plate', type: 'tile', tileKey: 'steelPlate', overlay: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4))' },
        { id: 'tile-rust', label: 'Rusted metal', type: 'tile', tileKey: 'rustMetal', overlay: 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35))' },
        { id: 'tile-camo', label: 'War camo', type: 'tile', tileKey: 'warCamo', overlay: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4))' },
        { id: 'tile-chain', label: 'Chain mesh', type: 'tile', tileKey: 'chainMesh', overlay: 'linear-gradient(rgba(0,0,0,0.48), rgba(0,0,0,0.48))' },
        { id: 'tile-asphalt', label: 'Asphalt', type: 'tile', tileKey: 'asphalt', overlay: 'linear-gradient(rgba(0,0,0,0.42), rgba(0,0,0,0.42))' },
        { id: 'tile-marble', label: 'Dark marble', type: 'tile', tileKey: 'marble', overlay: 'linear-gradient(rgba(0,0,0,0.38), rgba(0,0,0,0.38))' },
        { id: 'tile-ice', label: 'Ice / frost', type: 'tile', tileKey: 'iceFrost', overlay: 'linear-gradient(rgba(15,25,40,0.4), rgba(15,25,40,0.4))' },
        { id: 'tile-vault', label: 'Vault grid', type: 'tile', tileKey: 'vaultGrid', overlay: 'linear-gradient(rgba(0,0,0,0.42), rgba(0,0,0,0.42))' },
        { id: 'tile-hazard', label: 'Hazard weave', type: 'tile', tileKey: 'hazard', overlay: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4))' },
        { id: 'tile-purple', label: 'Torn purple', type: 'tile', tileKey: 'purpleWeave', overlay: 'linear-gradient(rgba(0,0,0,0.38), rgba(0,0,0,0.38))' },
        { id: 'tile-blood', label: 'War mist', type: 'tile', tileKey: 'bloodMist', overlay: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4))' }
    ];

    /** Map legacy draft keys from early builds */
    const LEGACY_BG_MAP = {
        rally: 'gradient-rally',
        steel: 'gradient-steel',
        ember: 'gradient-ember',
        banner: 'gradient-spotlight'
    };

    function getBackgroundById(id) {
        const mapped = LEGACY_BG_MAP[id] || id;
        return BACKGROUNDS.find(function (b) {
            return b.id === mapped;
        });
    }

    function getSelectedBackgroundId() {
        const hidden = document.getElementById('newsletter-background');
        return (hidden && hidden.value) || 'classic';
    }

    function setSelectedBackgroundId(id) {
        const hidden = document.getElementById('newsletter-background');
        if (hidden) hidden.value = id;
        document.querySelectorAll('.newsletter-bg-option').forEach(function (btn) {
            const on = btn.dataset.bgId === id;
            btn.classList.toggle('newsletter-bg-option--selected', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    /**
     * Inline style for inner newsletter panel (faction mail).
     */
    function buildBackgroundStyle(bgId) {
        const bg = getBackgroundById(bgId) || BACKGROUNDS[0];
        let style = 'background-color:var(--te-background-color);padding:14px 12px;border-radius:5px;';
        const images = [];
        if (bg.overlay) images.push(bg.overlay);
        if (bg.type === 'tile' && bg.tileKey && TILE_URI[bg.tileKey]) {
            images.push('url("' + TILE_URI[bg.tileKey] + '")');
            style += 'background-repeat:repeat;background-size:64px 64px;';
        }
        if (images.length) style += 'background-image:' + images.join(',') + ';';
        return style;
    }

    function previewStyleForBackground(bg) {
        if (!bg) return '';
        if (bg.type === 'tile' && bg.tileKey && TILE_URI[bg.tileKey]) {
            let s = 'background-image:url("' + TILE_URI[bg.tileKey] + '");background-size:32px 32px;background-repeat:repeat;';
            if (bg.overlay) s += 'background-image:' + bg.overlay + ',url("' + TILE_URI[bg.tileKey] + '");';
            return s;
        }
        if (bg.overlay) return 'background-image:' + bg.overlay + ';background-color:var(--secondary-color,#2a2a2a);';
        return 'background-color:var(--secondary-color,#3a3a3a);';
    }

    function renderBackgroundPicker() {
        const grid = document.getElementById('newsletter-background-picker');
        if (!grid) return;
        grid.innerHTML = '';
        BACKGROUNDS.forEach(function (bg) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'newsletter-bg-option';
            btn.dataset.bgId = bg.id;
            btn.setAttribute('aria-pressed', 'false');
            btn.title = bg.label;
            btn.style.cssText = previewStyleForBackground(bg);
            const cap = document.createElement('span');
            cap.className = 'newsletter-bg-option-label';
            cap.textContent = bg.label;
            btn.appendChild(cap);
            btn.addEventListener('click', function () {
                setSelectedBackgroundId(bg.id);
                if (typeof window.newsletterOnBackgroundChange === 'function') {
                    window.newsletterOnBackgroundChange(bg.id);
                }
            });
            grid.appendChild(btn);
        });
        setSelectedBackgroundId(getSelectedBackgroundId());
    }

    global.NEWSLETTER_BACKGROUNDS = BACKGROUNDS;
    global.NEWSLETTER_TILE_URI = TILE_URI;
    global.newsletterGetBackgroundById = getBackgroundById;
    global.newsletterBuildBackgroundStyle = buildBackgroundStyle;
    global.newsletterRenderBackgroundPicker = renderBackgroundPicker;
    global.newsletterSetSelectedBackgroundId = setSelectedBackgroundId;
    global.newsletterGetSelectedBackgroundId = getSelectedBackgroundId;
    global.NEWSLETTER_LEGACY_BG_MAP = LEGACY_BG_MAP;
})(typeof window !== 'undefined' ? window : globalThis);
