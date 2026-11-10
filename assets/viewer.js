/* LINESTATE — просмотр карты: логика */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const { store, esc } = LT;
    const EMPTY_FC = { type: 'FeatureCollection', features: [] };
    const state = {
        date: null,
        layers: {},
        hidden: new Set(),
        savedAt: 0,
        base: 'hybrid',
        regions: true,
        labels: true,
        advance: false,
        relief3d: true,
        reliefFlat: false,
        places: true,
        zones3d: true,
        outlines: true,
        rails: true
    };

    let map = null;
    let mapReady = false;
    let mounted = new Set();
    let cal = null;
    let lastVer = store.version();
    let lastFx = '';
    let playTimer = null;
    let pxLabels = null;
    let blend = null;
    const shownFC = new Map();

    /* ---------------------------- данные ---------------------------- */

    function normalize(src) {
        const out = {};
        Object.keys(src || {}).forEach((id, i) => {
            const l = src[id] || {};
            const s = l.style || {};
            const anim = ['none', 'pulse', 'flow', 'march'].indexOf(s.anim) >= 0 ? s.anim : (s.anim ? 'pulse' : 'none');
            out[id] = {
                id,
                name: typeof l.name === 'string' && l.name ? l.name : id,
                desc: typeof l.desc === 'string' ? l.desc : '',
                imported: l.imported === true,
                image: LT.validImage(l.image),
                imageRatio: Number.isFinite(l.imageRatio) ? Math.max(0.1, Math.min(10, l.imageRatio)) : 1,
                kind: ['arrow', 'point', 'image'].includes(l.kind) ? l.kind : 'zone',
                z: Number.isFinite(l.z) ? l.z : i,
                style: {
                    color: typeof s.color === 'string' ? s.color : '#4f7bb8',
                    bcol: typeof s.bcol === 'string' ? s.bcol : '#dbe8ff',
                    bw: Number.isFinite(s.bw) ? s.bw : 1.5,
                    alpha: Number.isFinite(s.alpha) ? s.alpha : .35,
                    visible: s.visible !== false,
                    markerSize: Number.isFinite(s.markerSize) ? Math.max(24, Math.min(200, s.markerSize)) : (l.kind === 'image' ? 96 : 40),
                    markerIcon: ['dot', 'diamond', 'cross', 'flag'].includes(s.markerIcon) ? s.markerIcon : 'dot',
                    shadow: s.shadow !== false,
                    maskTarget: typeof s.maskTarget === 'string' ? s.maskTarget : '',
                    maskTargets: Array.isArray(s.maskTargets)
                        ? s.maskTargets.filter(x => typeof x === 'string' && x && src[x])
                        : [],
                    hard: s.hard === true,
                    water: s.water === true,
                    pattern: ['none', 'hatch', 'diag', 'grid', 'dots', 'cross', 'bricks', 'waves', 'hazard'].indexOf(s.pattern) >= 0 ? s.pattern : 'none',
                    patternScale: Number.isFinite(s.patternScale) ? Math.min(60, Math.max(8, s.patternScale)) : 22,
                    border: ['solid', 'dashed', 'glow', 'none'].indexOf(s.border) >= 0 ? s.border : 'solid',
                    anim,
                    glow: Number.isFinite(s.glow) ? Math.min(100, Math.max(0, s.glow)) : 60,
                    iglow: Number.isFinite(s.iglow) ? Math.min(100, Math.max(0, s.iglow)) : 0,
                    igcol: typeof s.igcol === 'string' ? s.igcol : '#ffffff',
                    grad: s.grad === true,
                    gcol: typeof s.gcol === 'string' ? s.gcol : '#04101c',
                    gdir: Number.isFinite(s.gdir) ? Math.min(360, Math.max(0, s.gdir)) : 90,
                    label: s.label === true,
                    labelSize: Number.isFinite(s.labelSize) ? Math.min(28, Math.max(8, s.labelSize)) : 12,
                    labelColor: typeof s.labelColor === 'string' ? s.labelColor : '#e8eef5',
                    labelText: typeof s.labelText === 'string' ? s.labelText : '',
                    labelPos: Array.isArray(s.labelPos) && s.labelPos.length === 2 && Number.isFinite(+s.labelPos[0]) && Number.isFinite(+s.labelPos[1])
                        ? [+s.labelPos[0], +s.labelPos[1]] : null,
                    blend: LT.BLENDS.indexOf(s.blend) >= 0 ? s.blend : 'normal',
                    widthKm: Number.isFinite(s.widthKm) ? s.widthKm : 8,
                    headRatio: Number.isFinite(s.headRatio) ? s.headRatio : 2.6,
                    d3: s.d3 !== false,
                    depth: Number.isFinite(s.depth) ? Math.min(6, Math.max(0.2, s.depth)) : 1.6,
                    taper: Number.isFinite(s.taper) ? Math.min(0.8, Math.max(0, s.taper)) : 0.16,
                    headW: Number.isFinite(s.headW) ? Math.min(1.8, Math.max(0.5, s.headW)) : 0.95
                },
                data: l.data && Array.isArray(l.data.features)
                    ? { type: 'FeatureCollection', features: l.data.features }
                    : { type: 'FeatureCollection', features: [] }
            };
        });
        return out;
    }

    function maskIds(l, layers) {
        const src = layers || state.layers;
        const ids = [];
        const push = v => { if (typeof v === 'string' && v && v !== l.id && src[v] && ids.indexOf(v) < 0) ids.push(v); };
        if (Array.isArray(l.style.maskTargets)) l.style.maskTargets.forEach(push);
        push(l.style.maskTarget);
        return ids;
    }

    // Перетин масок у turf лишає в зонах внутрішні кільця там, де жодної
    // іншої зони немає: це артефакт побудови, а не розрив території, і саме
    // він читається як «зона зникла». Справжній виріз (під сусідню зону)
    // завжди лежить на її межі, тому дірку прибираємо лише тоді, коли її
    // вершини далі за HEAL_CELL від вершин усіх інших зон.
    const HEAL_CELL = 0.05; // ~5.5 км: справжні вирізи ≤1.4 км, сміттєві ≥11.5 км
    const HEAL_KX = Math.cos(50 * Math.PI / 180);

    function zoneCells(l) {
        if (l._ltCells && l._ltCells.data === l.data) return l._ltCells.cells;
        const cells = new Set();
        const ring = r => {
            for (let i = 0; i < r.length; i++) {
                cells.add(Math.floor(r[i][0] * HEAL_KX / HEAL_CELL) + ':' + Math.floor(r[i][1] / HEAL_CELL));
            }
        };
        l.data.features.forEach(f => {
            const g = f && f.geometry;
            if (!g || !g.coordinates) return;
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
            polys.forEach(p => p.forEach(ring));
        });
        l._ltCells = { data: l.data, cells };
        return cells;
    }

    function healZoneHoles(l, fc, layers) {
        if (l.kind !== 'zone' || !fc || !fc.features.length) return fc;
        if (!l._ltHeal || l._ltHeal.layers !== layers) {
            const cells = new Set();
            Object.keys(layers).forEach(id => {
                const o = layers[id];
                if (id === l.id || !o || o.kind !== 'zone' || !o.data || !o.data.features.length) return;
                zoneCells(o).forEach(c => cells.add(c));
            });
            l._ltHeal = { layers, cells };
        }
        const cells = l._ltHeal.cells;
        if (!cells.size) return fc;

        let changed = false;
        const features = fc.features.map(f => {
            const g = f && f.geometry;
            if (!g || !g.coordinates) return f;
            const isPoly = g.type === 'Polygon';
            if (!isPoly && g.type !== 'MultiPolygon') return f;
            const polys = isPoly ? [g.coordinates] : g.coordinates;
            let touched = false;
            const healed = polys.map(p => {
                if (p.length < 2) return p;
                const keep = p.filter((r, ri) => {
                    if (!ri) return true;
                    for (let i = 0; i < r.length; i++) {
                        const cx = Math.floor(r[i][0] * HEAL_KX / HEAL_CELL);
                        const cy = Math.floor(r[i][1] / HEAL_CELL);
                        for (let dx = -1; dx <= 1; dx++) {
                            for (let dy = -1; dy <= 1; dy++) {
                                if (cells.has((cx + dx) + ':' + (cy + dy))) return true;
                            }
                        }
                    }
                    touched = true;
                    return false;
                });
                return keep;
            });
            if (!touched) return f;
            changed = true;
            return {
                type: 'Feature',
                properties: f.properties || {},
                geometry: { type: g.type, coordinates: isPoly ? healed[0] : healed }
            };
        });
        return changed ? { type: 'FeatureCollection', features } : fc;
    }

    function displayFC(l, layers) {
        const src = layers || state.layers;
        if (l._ltDfc && l._ltDfc.layers === src) return l._ltDfc.fc;
        const memo = fc => { l._ltDfc = { layers: src, fc }; return fc; };

        const ids = maskIds(l, src);
        if (!ids.length) return memo(healZoneHoles(l, l.data, src));
        if (!l.data.features.length) return memo(EMPTY_FC);

        const masks = [];
        ids.forEach(id => src[id].data.features.forEach(f => masks.push(f)));
        if (!masks.length) return memo(EMPTY_FC);

        const out = [];
        l.data.features.forEach(f => {
            masks.forEach(mf => {
                try {
                    const r = turf.intersect(f, mf);
                    if (r && r.geometry && r.geometry.coordinates.length) out.push(r);
                } catch (e) { }
            });
        });
        return memo(healZoneHoles(l, { type: 'FeatureCollection', features: out }, src));
    }

    function areaKm2(feature) {
        try { return turf.area(feature) / 1e6; } catch (e) { return 0; }
    }

    // На телефоні тримаємо лише поточну й попередню дату: кеші WeakMap
    // дозволяють звільнити геометрію решти після перемикання.
    const docCache = new Map();
    let currentDoc = null;

    function loadDoc(date, fresh) {
        const doc = store.load(date);
        const key = doc && doc.savedAt ? doc.savedAt : 0;
        const hit = docCache.get(date);
        if (!fresh && hit && hit.key === key) return hit;
        const entry = {
            key,
            savedAt: key,
            layers: doc && doc.layers ? normalize(doc.layers) : {},
            doc
        };
        docCache.set(date, entry);
        if (isMobileUI()) {
            docCache.forEach((value, cachedDate) => {
                if (docCache.size <= 2) return;
                if (cachedDate === date || cachedDate === state.date) return;
                docCache.delete(cachedDate);
                warmState.done.delete(cachedDate);
            });
        }
        return entry;
    }

    /* ------------------------- повна підготовка ------------------------- */

    // ПК готує решту дат у паузах; телефон — лише обрану, щоб одночасні
    // Path2D усіх дат не перевищували ліміт пам'яті браузерного процесу.
    const warmState = { dates: [], date: null, ids: null, idx: 0, timer: 0, done: new Set() };

    function zoneIds(layers) {
        return Object.keys(layers).filter(id => {
            const l = layers[id];
            return l.kind === 'zone' && l.data.features.length > 0;
        });
    }

    function stopWarm() {
        if (warmState.timer) {
            clearInterval(warmState.timer);
            warmState.timer = 0;
        }
    }

    function startWarm() {
        if (!warmState.dates.length) {
            stopWarm();
            return;
        }
        if (!warmState.timer) warmState.timer = setInterval(warmTick, 70);
    }

    function warmTick() {
        if (document.hidden) return;
        // під час жесту мапа має тримати кадр, а не наш розрахунок
        if (map && map.isMoving && map.isMoving()) return;
        warmStep();
    }

    function warmStep() {
        if (!warmState.date) {
            warmState.date = warmState.dates.shift() || null;
            if (!warmState.date) {
                stopWarm();
                return;
            }
            const entry = loadDoc(warmState.date);
            warmState.ids = zoneIds(entry.layers);
            warmState.idx = 0;
            if (!warmState.ids.length) {
                warmState.done.add(warmState.date);
                warmState.date = null;
            }
            return;
        }
        const entry = docCache.get(warmState.date);
        if (!entry) {
            warmState.done.add(warmState.date);
            warmState.date = null;
            return;
        }
        if (warmState.idx < warmState.ids.length) {
            const l = entry.layers[warmState.ids[warmState.idx]];
            if (l) {
                try { LT.warmGeometry([displayFC(l, entry.layers)], { paths: 'off' }); } catch (e) { }
            }
        }
        warmState.idx++;
        if (warmState.idx >= warmState.ids.length) {
            warmState.done.add(warmState.date);
            warmState.date = null;
            warmState.ids = null;
        }
    }

    function warmCurrent() {
        const entry = currentDoc || loadDoc(state.date);
        const fcs = [];
        zoneIds(entry.layers).forEach(id => fcs.push(displayFC(entry.layers[id], entry.layers)));
        warmState.done.add(state.date);
        return LT.warmGeometry(fcs, { paths: 'all' });
    }

    function preloadRest() {
        if (isMobileUI()) return;
        const cur = state.date;
        warmState.dates = store.listDates().map(d => d.date)
            .filter(d => d !== cur && !warmState.done.has(d) && d !== warmState.date)
            .sort((a, b) => Math.abs(Date.parse(a) - Date.parse(cur)) - Math.abs(Date.parse(b) - Date.parse(cur)));
        startWarm();
    }

    // користувач перемкнув день: готуємо його першим, решта чекає
    function warmPriority(date) {
        if (warmState.done.has(date) || warmState.date === date) return;
        const i = warmState.dates.indexOf(date);
        if (i > 0) warmState.dates.splice(i, 1);
        else if (i < 0) warmState.dates.unshift(date);
        startWarm();
    }

    /* ---------------------------- карта ---------------------------- */

    function isVisible(l) {
        return l.style.visible && !state.hidden.has(l.id);
    }

    function applyLayer(l) {
        const src = map.getSource('s_' + l.id);
        if (!src) return;
        const fc = displayFC(l);
        shownFC.set(l.id, fc);
        src.setData(l.kind === 'zone' ? LT.rewindFC(fc) : fc);
        LT.applyLayerPaint(map, l, isVisible(l));
        LT.syncLayerDecor(map, l, fc, isVisible(l));
        if (blend) blend.draw();
    }

    function restack() {
        if (!mapReady) return;
        LT.orderLayerObjects(map, state.layers);
        ['lt-flow-halo', 'lt-flow-dot'].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
        if (map.getLayer('lt-adv-fill')) map.moveLayer('lt-adv-fill');
        if (map.getLayer('lt-adv-line')) map.moveLayer('lt-adv-line');
        orderToolLayers();
        if (map.getLayer('lt-places-label')) map.moveLayer('lt-places-label');
        ['lt-sel-glow', 'lt-sel-line'].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
        if (blend) blend.sync();
    }

    /* ---------------------------- выбор слоя ---------------------------- */

    const SEL_SRC = 'lt-sel';
    let sel = null;

    function ensureSelectionLayers() {
        if (!mapReady) return;
        if (!map.getSource(SEL_SRC)) {
            map.addSource(SEL_SRC, { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('lt-sel-glow')) {
            map.addLayer({
                id: 'lt-sel-glow', type: 'line', source: SEL_SRC,
                paint: { 'line-color': '#ffffff', 'line-width': 16, 'line-blur': 15, 'line-opacity': .5 }
            });
        }
        if (!map.getLayer('lt-sel-line')) {
            map.addLayer({
                id: 'lt-sel-line', type: 'line', source: SEL_SRC,
                paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 1 }
            });
        }
    }

    function selMeta(l) {
        const shown = displayFC(l);
        const total = l.data.features.length;
        if (l.kind === 'arrow') {
            const word = LT.countWord(total, 'viewer.arrow');
            return LT.t('viewer.arrows') + ' · ' + (total ? total + ' ' + word : LT.t('viewer.emptyVal'));
        }
        const km = Math.round(areaKm2(shown));
        return LT.t('viewer.zone') + ' · ' + (total ? km.toLocaleString(LT.locale()) + ' ' + LT.t('viewer.km') : LT.t('viewer.emptyVal'));
    }

    function selLabel(l) {
        const el = document.createElement('div');
        el.className = 'sel-label';
        const desc = (l.desc || '').trim();
        el.innerHTML = `<i></i><span class="sl-txt"><b>${esc(l.name)}</b><small>${esc(selMeta(l))}</small>${desc ? `<small class="sl-desc">${esc(desc)}</small>` : ''}</span><em title="${esc(LT.t('viewer.close'))}">×</em>`;
        el.querySelector('em').addEventListener('click', e => {
            e.stopPropagation();
            clearSelection();
        });
        return el;
    }

    // Шари, які належать шару даних і їх можна вибирати кліком. cs_/sh_/gw_/rh_
    // сюди НЕ входять: у 3D тінь від зони лежить ПОНАД самою зоною, і без цього
    // списку queryRenderedFeatures віддавав саме її — regex її не знав, тож клік
    // у середину зони провалювався й вибір зникав. fe_/fr_ — об'ємні стіна й
    // верхня грань, їх теж треба бачити як клікабельні.
    const PICK_PREFIX = ['f', 'p', 'l', 'g', 'ig', 'xb', 'xs', 'xh', 'fe', 'fr'];

    function pickLayer(point) {
        const ids = [];
        Object.keys(state.layers).forEach(id => {
            for (let i = 0; i < PICK_PREFIX.length; i++) {
                const li = PICK_PREFIX[i] + '_' + id;
                if (map.getLayer(li)) ids.push(li);
            }
        });
        let hits = [];
        try {
            hits = ids.length ? map.queryRenderedFeatures(point, { layers: ids }) : map.queryRenderedFeatures(point);
        } catch (e) { return ''; }
        for (const f of hits) {
            const m = /^(?:f|p|l|g|ig|xb|xs|xh|fe|fr)_(.+)$/.exec(f.layer.id);
            if (m && state.layers[m[1]]) return m[1];
        }
        return '';
    }

    function selectLayer(id, lngLat) {
        const l = state.layers[id];
        if (!l) return;
        clearSelection();
        ensureSelectionLayers();

        const src = map.getSource(SEL_SRC);
        if (src) src.setData(displayFC(l));
        ['lt-sel-glow', 'lt-sel-line'].forEach(x => { if (map.getLayer(x)) map.moveLayer(x); });

        const el = selLabel(l);
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -14] })
            .setLngLat(lngLat)
            .addTo(map);
        sel = { id, marker, el, lngLat };

        legendRow(id, row => row.classList.add('sel'));
    }

    function relabelSelection() {
        if (!sel) return;
        const l = state.layers[sel.id];
        if (!l) { clearSelection(); return; }
        const next = selLabel(l);
        sel.marker.remove();
        sel.el = next;
        sel.marker = new maplibregl.Marker({ element: next, anchor: 'bottom', offset: [0, -14] })
            .setLngLat(sel.lngLat)
            .addTo(map);
    }

    function clearSelection() {
        if (sel) {
            if (sel.marker) sel.marker.remove();
            sel = null;
        }
        const src = map.getSource(SEL_SRC);
        if (src) src.setData(EMPTY_FC);
        document.querySelectorAll('#legend-list .lg-row.sel').forEach(r => r.classList.remove('sel'));
    }

    function legendRow(id, fn) {
        document.querySelectorAll('#legend-list .lg-row').forEach(row => {
            if (row.dataset.id === id) fn(row);
        });
    }

    /* ---------------------------- инструменты карты ---------------------------- */

    const ANNO_PREFIX = 'LINETATE:A:';
    const COLOR_KEY = 'LINETATE:__color';
    const DRAW_KEY = 'LINETATE:__draw';
    const LEGACY_ARROW_KEY = 'LINETATE:__arrow';
    const DRAW_DEFAULT = '#ffffff';
    const DRAW_LEGACY = '#ffd45e';
    const W_MIN = 1;
    const W_MAX = 8;
    const HEAD_MIN = 8;
    const HEAD_MAX = 30;
    const DRAW_TOOLS = ['pen', 'arrow', 'rect', 'circle', 'zone', 'erase'];
    const TOOL_HINT = {
        pen: 'tools.penHint', arrow: 'tools.arrowHint', rect: 'tools.rectHint',
        circle: 'tools.circleHint', zone: 'tools.zoneHint', erase: 'tools.eraseHint'
    };
    let anno = [];
    let tool = '';
    let rulerPts = [];
    let rulerDone = false;
    let rulerClosed = false;
    let rulerLabels = [];
    let rulerTotal = null;
    let pen = null;
    let shape = null;
    let arrow = null;
    let drawW = 2.6;
    let drawHead = 15;
    let drawPanelOpen = false;
    let drawFold = false;
    let zonePts = [];
    let drawColor = DRAW_DEFAULT;
    let touchTap = null;
    let suppressClick = null;
    const clampNum = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    try {
        const savedColor = localStorage.getItem(COLOR_KEY);
        if (/^#[0-9a-f]{6}$/i.test(savedColor || '')) drawColor = savedColor === DRAW_LEGACY ? DRAW_DEFAULT : savedColor;
    } catch (e) { }
    {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(DRAW_KEY) || 'null'); } catch (e) { }
        if (saved) {
            drawW = clampNum(saved.w, W_MIN, W_MAX, drawW);
            drawHead = clampNum(saved.head, HEAD_MIN, HEAD_MAX, drawHead);
        } else {
            // настройки старой панели стрелки хранили индексы 0..2
            let old = null;
            try { old = JSON.parse(localStorage.getItem(LEGACY_ARROW_KEY) || 'null'); } catch (e) { }
            if (old) {
                drawW = [1.8, 2.6, 3.8][old.w] || drawW;
                drawHead = [11, 15, 21][old.h] || drawHead;
            }
        }
    }
    let searchRows = [];
    let searchActive = -1;
    let searchPick = null;
    let searchMarker = null;
    let searchSeq = 0;
    let searchTimer = 0;

    /* ---------------- рисунки поверх слоёв карты ---------------- */

    // заливки с градиентом и режимом наложения рисуются на DOM-canvas над картой;
    // рисунки держим на своём слое выше, иначе они тонут под цветом зоны
    let drawCv = null;
    let drawCtx = null;
    let drawQueued = false;
    let drawDirty = true;
    let drawCam = '';
    let draftFC = EMPTY_FC;
    let rulerFC = EMPTY_FC;

    const MAP_DRAW_LAYERS = [
        'lt-anno-fill-shadow', 'lt-anno-fill', 'lt-anno-rim', 'lt-anno-glow', 'lt-anno-shadow',
        'lt-anno-casing', 'lt-anno-line',
        'lt-draft-fill', 'lt-draft-glow', 'lt-draft-casing', 'lt-draft-line', 'lt-draft-pts',
        'lt-ruler-fill', 'lt-ruler-glow', 'lt-ruler-shadow', 'lt-ruler-casing', 'lt-ruler-line',
        'lt-ruler-halo', 'lt-ruler-dots'
    ];

    function rgba(hex, a) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return 'rgba(255,255,255,' + a + ')';
        const n = parseInt(m[1], 16);
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    function ensureDrawCanvas() {
        if (drawCv || !mapReady) return;
        drawCv = document.createElement('canvas');
        drawCv.id = 'lt-draw-canvas';
        document.body.appendChild(drawCv);
        drawCtx = drawCv.getContext('2d');
        map.on('render', () => scheduleDraw(false));
        map.on('resize', () => scheduleDraw(true));
        scheduleDraw(true);
    }

    function isMobileUI() {
        return document.documentElement.classList.contains('dev-mobile');
    }

    function drawCamKey() {
        try {
            const c = map.getCenter();
            const cv = map.getCanvas();
            return c.lng.toFixed(5) + '|' + c.lat.toFixed(5) + '|' + map.getZoom().toFixed(4)
                + '|' + (map.getBearing ? map.getBearing().toFixed(2) : '0')
                + '|' + (map.getPitch ? map.getPitch().toFixed(2) : '0')
                + '|' + cv.width + 'x' + cv.height;
        } catch (e) { return ''; }
    }

    function scheduleDraw(force) {
        if (force !== false) drawDirty = true;
        if (drawQueued) return;
        if (!drawDirty && drawCamKey() === drawCam) return;
        drawQueued = true;
        const run = () => {
            drawQueued = false;
            drawDirty = false;
            drawCam = drawCamKey();
            paintDraw();
        };
        if (isMobileUI()) setTimeout(run, 30);
        else requestAnimationFrame(run);
    }

    function pathGeo(g, geo) {
        if (!geo) return false;
        const ring = pts => {
            if (!Array.isArray(pts) || pts.length < 2) return;
            pts.forEach((c, i) => {
                if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
                let p;
                try { p = map.project(c); } catch (e) { return; }
                if (i === 0) g.moveTo(p.x, p.y);
                else g.lineTo(p.x, p.y);
            });
        };
        if (geo.type === 'Polygon') {
            g.beginPath();
            (geo.coordinates || []).forEach(ring);
            g.closePath();
            return true;
        }
        if (geo.type === 'MultiPolygon') {
            g.beginPath();
            (geo.coordinates || []).forEach(poly => (poly || []).forEach(ring));
            g.closePath();
            return true;
        }
        if (geo.type === 'LineString') {
            g.beginPath();
            ring(geo.coordinates);
            return true;
        }
        if (geo.type === 'MultiLineString') {
            g.beginPath();
            (geo.coordinates || []).forEach(ring);
            return true;
        }
        if (geo.type === 'Point') {
            const c = geo.coordinates || [];
            if (!isFinite(c[0]) || !isFinite(c[1])) return false;
            let p;
            try { p = map.project(c); } catch (e) { return false; }
            g.beginPath();
            g.arc(p.x, p.y, 1, 0, Math.PI * 2);
            return true;
        }
        return false;
    }

    function fillGeo(g, geo, color, alpha, ox, oy) {
        if (!pathGeo(g, geo)) return;
        g.save();
        g.globalAlpha = alpha == null ? 1 : alpha;
        g.fillStyle = color;
        if (ox || oy) g.translate(ox || 0, oy || 0);
        try { g.fill('evenodd'); } catch (e) { g.fill(); }
        g.restore();
    }

    function lineGeo(g, geo, color, width, alpha, dash, ox, oy, blur) {
        if (!pathGeo(g, geo)) return;
        g.save();
        g.globalAlpha = alpha == null ? 1 : alpha;
        g.strokeStyle = color;
        g.lineWidth = width;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        if (dash && dash.length) g.setLineDash(dash);
        if (ox || oy) g.translate(ox || 0, oy || 0);
        if (blur) {
            g.shadowColor = color;
            g.shadowBlur = blur;
        }
        g.stroke();
        g.restore();
    }

    function drawDot(g, at, radius, fill, stroke, strokeW, halo) {
        let p;
        try { p = map.project(at); } catch (e) { return; }
        if (halo) {
            g.save();
            g.globalAlpha = halo;
            g.beginPath();
            g.arc(p.x, p.y, radius * 2.2, 0, Math.PI * 2);
            g.fillStyle = fill;
            g.shadowColor = fill;
            g.shadowBlur = 5;
            g.fill();
            g.restore();
        }
        g.beginPath();
        g.arc(p.x, p.y, radius, 0, Math.PI * 2);
        g.fillStyle = fill;
        g.fill();
        if (stroke) {
            g.lineWidth = strokeW;
            g.strokeStyle = stroke;
            g.stroke();
        }
    }

    // малюнок цілком поза екраном — не проектуємо його точки щоперерисовки
    function onScreenAnno(f) {
        if (!LT.featBox || !LT.onScreen) return true;
        const box = LT.featBox(f);
        if (!box) return true;
        const src = map.getCanvas();
        const cssW = src.clientWidth || src.width || 1;
        const cssH = src.clientHeight || src.height || 1;
        return LT.onScreen(map, box, 1, 1, cssW, cssH, 140);
    }

    function paintAnnoFeature(f) {
        const g = drawCtx;
        const geo = f && f.geometry;
        if (!g || !geo) return;
        if (!onScreenAnno(f)) return;
        const p = f.properties || {};
        const col = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : DRAW_DEFAULT;
        const w = Number(p.w) || 2.4;
        const poly = geo.type === 'Polygon' || geo.type === 'MultiPolygon';
        if (poly) {
            fillGeo(g, geo, '#000000', .38, 3, 4);
            fillGeo(g, geo, rgba(col, .24), Number(p.alpha) || .2);
            lineGeo(g, geo, 'rgba(255,255,255,.22)', 1.1, 1, null, -1, -1);
        }
        lineGeo(g, geo, rgba(col, .38), w + 6.6, 1, null, 0, 0, 14);
        lineGeo(g, geo, '#000000', w + 3.6, .42, null, 3, 3, 6);
        lineGeo(g, geo, '#0a0a0b', w + 2.8, .5);
        lineGeo(g, geo, col, w, 1);
    }

    function paintDraft() {
        const g = drawCtx;
        if (!g || !draftFC) return;
        (draftFC.features || []).forEach(f => {
            const geo = f.geometry;
            const p = f.properties || {};
            const col = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : DRAW_DEFAULT;
            const w = Number(p.w) || 2.4;
            if (geo.type === 'Point') {
                let pt;
                try { pt = map.project(geo.coordinates); } catch (e) { return; }
                g.beginPath();
                g.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
                g.fillStyle = '#141414';
                g.fill();
                g.lineWidth = 2;
                g.strokeStyle = col;
                g.stroke();
                return;
            }
            if (geo.type === 'Polygon') fillGeo(g, geo, rgba(col, .18), 1, 1, 2);
            lineGeo(g, geo, rgba(col, .34), w + 5, 1, null, 0, 0, 12);
            lineGeo(g, geo, '#0a0a0b', w + 2.2, .42, [2 * w, 1.5 * w]);
            lineGeo(g, geo, rgba(col, .96), w, 1, [2 * w, 1.5 * w]);
        });
    }

    function paintRuler() {
        const g = drawCtx;
        if (!g || !rulerFC) return;
        let line = null;
        let poly = null;
        const pts = [];
        (rulerFC.features || []).forEach(f => {
            const geo = f.geometry || {};
            if (geo.type === 'LineString') line = geo;
            else if (geo.type === 'Polygon') poly = geo;
            else if (geo.type === 'Point' && Array.isArray(geo.coordinates)) pts.push(geo.coordinates);
        });
        if (poly) fillGeo(g, poly, 'rgba(255,233,168,.14)');
        if (line) {
            lineGeo(g, line, 'rgba(255,233,168,.45)', 12, 1, null, 0, 0, 24);
            lineGeo(g, line, '#000000', 5, .4, null, 3, 3, 6);
            lineGeo(g, line, '#0a0a0b', 5, .55);
            lineGeo(g, line, '#ffe9a8', 2.2, 1, [2.4 * 2.2, 1.8 * 2.2]);
        }
        pts.forEach(c => drawDot(g, c, 4.5, '#141414', '#ffe9a8', 2, .16));
    }

    function paintDraw() {
        if (!drawCv || !drawCtx || !mapReady) return;
        const src = map.getCanvas();
        const cw = src.width;
        const ch = src.height;
        if (!cw || !ch) return;
        if (drawCv.width !== cw || drawCv.height !== ch) {
            drawCv.width = cw;
            drawCv.height = ch;
        }
        const cssW = src.clientWidth || cw;
        const cssH = src.clientHeight || ch;
        const g = drawCtx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, cw, ch);
        g.scale(cw / cssW, ch / cssH);
        anno.forEach(paintAnnoFeature);
        paintDraft();
        paintRuler();
        paintSearchArea();
    }

    // територія знайденого міста — на DOM-полотні над заливками зон.
    // шари lt-ps-* у мапі лежали ПІД полотном blend, тому під окупованою
    // зоною контур міста зникав (скарга «пошук з отрисовкою не працює»)
    function paintSearchArea() {
        if (!searchPick || !searchPick.feature || map._lt3d) return;
        const geo = searchPick.feature.geometry;
        const g = drawCtx;
        fillGeo(g, geo, '#ffcf4d', .1);
        lineGeo(g, geo, '#ffcf4d', 9, .5, null, 0, 0, 8);
        lineGeo(g, geo, '#fff1b8', 2, .95, [3, 2]);
    }

    function addSourceSafe(id) {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY_FC });
    }

    function ensureToolLayers() {
        if (!mapReady) return;

        addSourceSafe('lt-anno');
        addSourceSafe('lt-draft');
        addSourceSafe('lt-ruler');
        addSourceSafe('lt-ps');

        const drawColorExpr = ['coalesce', ['get', 'color'], DRAW_DEFAULT];
        const drawW = ['coalesce', ['get', 'w'], 2.4];
        const drawWCasing = ['+', drawW, 2.8];
        const drawWGlow = ['+', drawW, 6.6];
        const drawWHit = ['+', drawW, 16];

        if (!map.getLayer('lt-anno-fill-shadow')) map.addLayer({
            id: 'lt-anno-fill-shadow', type: 'fill', source: 'lt-anno',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#000000', 'fill-opacity': .38, 'fill-translate': [3, 4] }
        });
        if (!map.getLayer('lt-anno-fill')) map.addLayer({
            id: 'lt-anno-fill', type: 'fill', source: 'lt-anno',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
                'fill-color': drawColorExpr,
                'fill-opacity': ['coalesce', ['get', 'alpha'], .2]
            }
        });
        if (!map.getLayer('lt-anno-rim')) map.addLayer({
            id: 'lt-anno-rim', type: 'line', source: 'lt-anno',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'line-color': '#ffffff', 'line-width': 1.1, 'line-opacity': .22, 'line-translate': [-1, -1] }
        });
        if (!map.getLayer('lt-anno-glow')) map.addLayer({
            id: 'lt-anno-glow', type: 'line', source: 'lt-anno',
            paint: { 'line-color': drawColorExpr, 'line-width': drawWGlow, 'line-blur': 7, 'line-opacity': .38 }
        });
        if (!map.getLayer('lt-anno-shadow')) map.addLayer({
            id: 'lt-anno-shadow', type: 'line', source: 'lt-anno',
            paint: { 'line-color': '#000000', 'line-width': ['+', drawW, 3.6], 'line-blur': 3, 'line-opacity': .42, 'line-translate': [3, 3] }
        });
        if (!map.getLayer('lt-anno-casing')) map.addLayer({
            id: 'lt-anno-casing', type: 'line', source: 'lt-anno',
            paint: { 'line-color': '#0a0a0b', 'line-width': drawWCasing, 'line-opacity': .5 }
        });
        if (!map.getLayer('lt-anno-line')) map.addLayer({
            id: 'lt-anno-line', type: 'line', source: 'lt-anno',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': drawColorExpr, 'line-width': drawW, 'line-opacity': 1 }
        });
        if (!map.getLayer('lt-anno-hit')) map.addLayer({
            id: 'lt-anno-hit', type: 'line', source: 'lt-anno',
            paint: { 'line-color': '#000000', 'line-width': drawWHit, 'line-opacity': .01 }
        });
        if (!map.getLayer('lt-anno-hit-fill')) map.addLayer({
            id: 'lt-anno-hit-fill', type: 'fill', source: 'lt-anno',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#000000', 'fill-opacity': .01 }
        });

        if (!map.getLayer('lt-draft-fill')) map.addLayer({
            id: 'lt-draft-fill', type: 'fill', source: 'lt-draft',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': drawColorExpr, 'fill-opacity': .18, 'fill-translate': [1, 2] }
        });
        if (!map.getLayer('lt-draft-glow')) map.addLayer({
            id: 'lt-draft-glow', type: 'line', source: 'lt-draft',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': drawColorExpr, 'line-width': ['+', drawW, 5], 'line-blur': 6, 'line-opacity': .34 }
        });
        if (!map.getLayer('lt-draft-casing')) map.addLayer({
            id: 'lt-draft-casing', type: 'line', source: 'lt-draft',
            filter: ['!=', ['geometry-type'], 'Point'],
            paint: { 'line-color': '#0a0a0b', 'line-width': ['+', drawW, 2.2], 'line-opacity': .42 }
        });
        if (!map.getLayer('lt-draft-line')) map.addLayer({
            id: 'lt-draft-line', type: 'line', source: 'lt-draft',
            filter: ['!=', ['geometry-type'], 'Point'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': drawColorExpr, 'line-width': drawW, 'line-dasharray': [2, 1.5], 'line-opacity': .96 }
        });
        if (!map.getLayer('lt-draft-pts')) map.addLayer({
            id: 'lt-draft-pts', type: 'circle', source: 'lt-draft',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-radius': 5, 'circle-color': '#141414',
                'circle-stroke-width': 2, 'circle-stroke-color': drawColorExpr
            }
        });

        if (!map.getLayer('lt-ruler-fill')) map.addLayer({
            id: 'lt-ruler-fill', type: 'fill', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#ffe9a8', 'fill-opacity': .14 }
        });
        if (!map.getLayer('lt-ruler-glow')) map.addLayer({
            id: 'lt-ruler-glow', type: 'line', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#ffe9a8', 'line-width': 12, 'line-blur': 8, 'line-opacity': .45 }
        });
        if (!map.getLayer('lt-ruler-shadow')) map.addLayer({
            id: 'lt-ruler-shadow', type: 'line', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#000000', 'line-width': 5, 'line-blur': 3, 'line-opacity': .4, 'line-translate': [3, 3] }
        });
        if (!map.getLayer('lt-ruler-casing')) map.addLayer({
            id: 'lt-ruler-casing', type: 'line', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#0a0a0b', 'line-width': 5, 'line-opacity': .55 }
        });
        if (!map.getLayer('lt-ruler-line')) map.addLayer({
            id: 'lt-ruler-line', type: 'line', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#ffe9a8', 'line-width': 2.2, 'line-dasharray': [2.4, 1.8], 'line-opacity': 1 }
        });
        if (!map.getLayer('lt-ruler-halo')) map.addLayer({
            id: 'lt-ruler-halo', type: 'circle', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 10, 'circle-color': '#ffe9a8', 'circle-opacity': .16, 'circle-blur': 1 }
        });
        if (!map.getLayer('lt-ruler-dots')) map.addLayer({
            id: 'lt-ruler-dots', type: 'circle', source: 'lt-ruler',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 4.5, 'circle-color': '#141414', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffe9a8' }
        });

        if (!map.getLayer('lt-ps-fill')) map.addLayer({
            id: 'lt-ps-fill', type: 'fill', source: 'lt-ps',
            paint: { 'fill-color': '#ffcf4d', 'fill-opacity': .08 }
        });
        if (!map.getLayer('lt-ps-glow')) map.addLayer({
            id: 'lt-ps-glow', type: 'line', source: 'lt-ps',
            paint: { 'line-color': '#ffcf4d', 'line-width': 9, 'line-opacity': .5, 'line-blur': 8 }
        });
        if (!map.getLayer('lt-ps-line')) map.addLayer({
            id: 'lt-ps-line', type: 'line', source: 'lt-ps',
            paint: { 'line-color': '#fff1b8', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': .95 }
        });

        // визуал рисунков теперь на DOM-canvas над картой; в карте остаются только слои попадания
        MAP_DRAW_LAYERS.forEach(id => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        });
    }

    function orderToolLayers() {
        if (!mapReady) return;
        [
            'lt-anno-fill-shadow', 'lt-anno-fill', 'lt-anno-rim', 'lt-anno-glow', 'lt-anno-shadow', 'lt-anno-casing', 'lt-anno-line', 'lt-anno-hit', 'lt-anno-hit-fill',
            'lt-draft-fill', 'lt-draft-glow', 'lt-draft-casing', 'lt-draft-line', 'lt-draft-pts',
            'lt-ruler-fill', 'lt-ruler-glow', 'lt-ruler-shadow', 'lt-ruler-casing', 'lt-ruler-line', 'lt-ruler-halo', 'lt-ruler-dots',
            'lt-ps-fill', 'lt-ps-glow', 'lt-ps-line', 'lt-ps-3d-plate', 'lt-ps-3d-rim'
        ].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
    }

    function refreshAnno() {
        if (!mapReady) return;
        ensureToolLayers();
        const src = map.getSource('lt-anno');
        if (src) src.setData({ type: 'FeatureCollection', features: anno });
        scheduleDraw();
    }

    function loadAnno() {
        let items = [];
        try {
            const raw = localStorage.getItem(ANNO_PREFIX + state.date);
            const doc = raw ? JSON.parse(raw) : null;
            if (doc && Array.isArray(doc.items)) {
                items = doc.items.filter(f => f && f.geometry && f.properties);
            }
        } catch (e) { items = []; }
        anno = items;
        refreshAnno();
    }

    function saveAnno() {
        try {
            if (anno.length) {
                localStorage.setItem(ANNO_PREFIX + state.date, JSON.stringify({ v: 1, savedAt: Date.now(), items: anno }));
            } else {
                localStorage.removeItem(ANNO_PREFIX + state.date);
            }
        } catch (e) { }
    }

    function annoId() {
        return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function setDraft(features) {
        draftFC = { type: 'FeatureCollection', features: features || [] };
        const src = map.getSource('lt-draft');
        if (src) src.setData(draftFC);
        scheduleDraw();
    }

    function fmtDist(km) {
        if (km < 1) return Math.round(km * 1000) + ' ' + LT.t('tools.m');
        if (km < 10) return km.toFixed(2) + ' ' + LT.t('tools.km');
        if (km < 100) return km.toFixed(1) + ' ' + LT.t('tools.km');
        return Math.round(km).toLocaleString(LT.locale()) + ' ' + LT.t('tools.km');
    }

    function syncColorUI() {
        const inp = $('draw-color');
        if (inp && String(inp.value).toLowerCase() !== drawColor) inp.value = drawColor;
        const custom = document.querySelector('.dp-custom');
        if (custom) custom.style.setProperty('--c', drawColor);
        document.querySelectorAll('#dp-colors .dp-sw').forEach(b => {
            b.classList.toggle('active', String(b.dataset.color).toLowerCase() === drawColor);
        });
    }

    function setDrawColor(c) {
        if (!/^#[0-9a-f]{6}$/i.test(c || '')) return;
        drawColor = c.toLowerCase();
        try { localStorage.setItem(COLOR_KEY, drawColor); } catch (e) { }
        syncColorUI();
        if (pen) drawPenDraft();
        if (shape) drawShapeDraft();
        if (arrow) drawArrowDraft();
        if (zonePts.length) drawZoneDraft();
    }

    function midPoint(a, b) {
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }

    function samePoint(a, b) {
        return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    }

    function nearPoint(lngLat, point, px) {
        try {
            const a = map.project(lngLat);
            return Math.hypot(a.x - point.x, a.y - point.y) < px;
        } catch (e) { return false; }
    }

    function ensureRulerLabels(n) {
        while (rulerLabels.length < n) {
            const el = document.createElement('div');
            el.className = 'lt-measure seg';
            rulerLabels.push({
                el,
                marker: new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -9] })
                    .setLngLat([0, 0])
                    .addTo(map)
            });
        }
        while (rulerLabels.length > n) {
            const last = rulerLabels.pop();
            last.marker.remove();
        }
    }

    function setRulerTotal(text, lngLat) {
        if (!text) {
            if (rulerTotal) {
                rulerTotal.marker.remove();
                rulerTotal = null;
            }
            return;
        }
        if (!rulerTotal) {
            const el = document.createElement('div');
            el.className = 'lt-measure total';
            rulerTotal = {
                el,
                marker: new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -10] })
                    .setLngLat([0, 0])
                    .addTo(map)
            };
        }
        rulerTotal.el.textContent = text;
        rulerTotal.marker.setLngLat(lngLat);
    }

    function drawRuler(cursor) {
        const src = map.getSource('lt-ruler');
        if (!src) return;

        const preview = !rulerDone && rulerPts.length > 0 && cursor && !samePoint(cursor, rulerPts[rulerPts.length - 1]);
        const coords = rulerPts.slice();
        if (preview) coords.push(cursor);

        const fc = [];
        let lineCoords = coords;
        if (rulerClosed && rulerDone && coords.length >= 3) lineCoords = coords.concat([coords[0]]);
        if (lineCoords.length >= 2) {
            fc.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: lineCoords } });
        }
        if (rulerClosed && rulerDone && coords.length >= 3) {
            fc.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [lineCoords] } });
        }
        coords.forEach(p => {
            fc.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
        });
        rulerFC = { type: 'FeatureCollection', features: fc };
        src.setData(rulerFC);
        scheduleDraw();

        const segs = [];
        for (let i = 1; i < coords.length; i++) segs.push([coords[i - 1], coords[i]]);
        if (rulerClosed && rulerDone && coords.length >= 3) segs.push([coords[coords.length - 1], coords[0]]);

        ensureRulerLabels(segs.length);
        segs.forEach((seg, i) => {
            let km = 0;
            try { km = turf.distance(seg[0], seg[1], { units: 'kilometers' }); } catch (e) { km = 0; }
            rulerLabels[i].el.textContent = fmtDist(km);
            rulerLabels[i].marker.setLngLat(midPoint(seg[0], seg[1]));
        });

        if (rulerDone && rulerPts.length >= 3) {
            let total = 0;
            try {
                total = turf.length(turf.lineString(rulerClosed ? rulerPts.concat([rulerPts[0]]) : rulerPts), { units: 'kilometers' });
            } catch (e) { total = 0; }
            let text = 'Σ ' + fmtDist(total);
            let at = rulerPts[rulerPts.length - 1];
            if (rulerClosed) {
                try {
                    const poly = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [rulerPts.concat([rulerPts[0]])] } };
                    const area = turf.area(poly) / 1e6;
                    text += ' · ' + Math.round(area).toLocaleString(LT.locale()) + ' ' + LT.t('viewer.km');
                    at = turf.centroid(poly).geometry.coordinates;
                } catch (e) { }
            }
            setRulerTotal(text, at);
        } else {
            setRulerTotal('', null);
        }

        if (!rulerPts.length) ensureRulerLabels(0);
    }

    function resetRulerState() {
        rulerPts = [];
        rulerDone = false;
        rulerClosed = false;
        ensureRulerLabels(0);
        setRulerTotal('', null);
    }

    function clearRuler() {
        resetRulerState();
        rulerFC = EMPTY_FC;
        const src = map.getSource('lt-ruler');
        if (src) src.setData(rulerFC);
        scheduleDraw();
    }

    function rulerFinish() {
        if (!rulerPts.length || rulerDone) return;
        rulerPts = dedupePts(rulerPts);
        if (rulerPts.length < 2) { clearRuler(); return; }
        rulerDone = true;
        rulerClosed = false;
        drawRuler();
    }

    function rulerClick(e) {
        const p = e.lngLat.toArray();
        if (rulerDone) {
            resetRulerState();
            rulerPts = [p];
            drawRuler();
            return;
        }
        if (rulerPts.length >= 3 && e.point && nearPoint(rulerPts[0], e.point, 18)) {
            rulerClosed = true;
            rulerDone = true;
            drawRuler();
            return;
        }
        if (rulerPts.length >= 2 && e.point && nearPoint(rulerPts[rulerPts.length - 1], e.point, 16)) {
            rulerDone = true;
            drawRuler();
            return;
        }
        if (rulerPts.length && samePoint(p, rulerPts[rulerPts.length - 1])) return;
        rulerPts.push(p);
        drawRuler();
    }

    function drawPenDraft() {
        if (!pen) return;
        setDraft([{
            type: 'Feature', properties: { color: drawColor, w: drawW },
            geometry: { type: 'LineString', coordinates: pen.pts.slice() }
        }]);
    }

    function penStart(e) {
        const oe = e.originalEvent;
        if (oe && typeof oe.button === 'number' && oe.button !== 0) return;
        pen = { pts: [e.lngLat.toArray()] };
        drawPenDraft();
    }

    function penMove(e) {
        if (!pen) return;
        const p = e.lngLat.toArray();
        const last = pen.pts[pen.pts.length - 1];
        let a;
        let b;
        try {
            a = map.project(last);
            b = e.point || map.project(p);
        } catch (err) { return; }
        if (Math.hypot(a.x - b.x, a.y - b.y) < 2.5) return;
        pen.pts.push(p);
        drawPenDraft();
    }

    function penEnd() {
        if (!pen) return;
        const pts = pen.pts;
        pen = null;
        setDraft([]);
        if (pts.length < 2) return;
        let km = 0;
        try { km = turf.length(turf.lineString(pts), { units: 'kilometers' }); } catch (e) { km = 0; }
        if (km < 0.02) { LT.toast(LT.t('tools.tooShort'), 'err'); return; }
        anno.push({
            type: 'Feature',
            properties: { aid: annoId(), kind: 'pen', color: drawColor, w: drawW },
            geometry: { type: 'LineString', coordinates: pts }
        });
        saveAnno();
        refreshAnno();
    }

    function draftPoint(p) {
        return { type: 'Feature', properties: { color: drawColor }, geometry: { type: 'Point', coordinates: p } };
    }

    function drawZoneDraft(cursor) {
        const pts = zonePts.slice();
        if (cursor) pts.push(cursor);
        const fc = [];
        if (pts.length >= 2) {
            fc.push({ type: 'Feature', properties: { color: drawColor, w: drawW }, geometry: { type: 'LineString', coordinates: pts } });
        }
        if (pts.length >= 3) {
            fc.push({ type: 'Feature', properties: { color: drawColor, w: drawW }, geometry: { type: 'Polygon', coordinates: [pts.concat([pts[0]])] } });
        }
        zonePts.forEach(p => fc.push(draftPoint(p)));
        setDraft(fc);
    }

    function dedupePts(pts) {
        const out = [];
        pts.forEach(p => {
            const q = out[out.length - 1];
            if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
        });
        if (out.length > 1) {
            const f = out[0];
            const l = out[out.length - 1];
            if (Math.abs(f[0] - l[0]) < 1e-7 && Math.abs(f[1] - l[1]) < 1e-7) out.pop();
        }
        return out;
    }

    function zoneClick(e) {
        if (zonePts.length >= 3 && e.point) {
            const first = map.project(zonePts[0]);
            if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 18) {
                zoneFinish();
                return;
            }
        }
        zonePts.push(e.lngLat.toArray());
        drawZoneDraft();
    }

    function zoneFinish() {
        const pts = dedupePts(zonePts);
        zonePts = [];
        setDraft([]);
        if (pts.length < 3) return;
        anno.push({
            type: 'Feature',
            properties: { aid: annoId(), kind: 'zone', color: drawColor, w: drawW, alpha: .18 },
            geometry: { type: 'Polygon', coordinates: [pts.concat([pts[0]])] }
        });
        saveAnno();
        refreshAnno();
    }

    function shapeRing(kind, a, b) {
        const w = Math.min(a[0], b[0]);
        const e = Math.max(a[0], b[0]);
        const s = Math.min(a[1], b[1]);
        const n = Math.max(a[1], b[1]);
        if (kind === 'rect') {
            return [[w, s], [e, s], [e, n], [w, n], [w, s]];
        }
        const cx = (w + e) / 2;
        const cy = (s + n) / 2;
        const rx = (e - w) / 2;
        const ry = (n - s) / 2;
        const ring = [];
        const steps = 72;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps * Math.PI * 2;
            ring.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
        return ring;
    }

    function drawShapeDraft() {
        if (!shape) return;
        const ring = shapeRing(shape.kind, shape.start, shape.cur);
        setDraft([
            { type: 'Feature', properties: { color: drawColor, w: drawW }, geometry: { type: 'Polygon', coordinates: [ring] } },
            { type: 'Feature', properties: { color: drawColor }, geometry: { type: 'Point', coordinates: shape.start } },
            { type: 'Feature', properties: { color: drawColor }, geometry: { type: 'Point', coordinates: shape.cur } }
        ]);
    }

    function shapeStart(e) {
        const oe = e.originalEvent;
        if (oe && typeof oe.button === 'number' && oe.button !== 0) return;
        shape = { kind: tool, start: e.lngLat.toArray(), cur: e.lngLat.toArray() };
        drawShapeDraft();
    }

    function shapeMove(e) {
        if (!shape) return;
        shape.cur = e.lngLat.toArray();
        drawShapeDraft();
    }

    function shapeEnd() {
        if (!shape) return;
        const s = shape;
        shape = null;
        setDraft([]);
        let a;
        let b;
        try {
            a = map.project(s.start);
            b = map.project(s.cur);
        } catch (e) { return; }
        if (Math.hypot(a.x - b.x, a.y - b.y) < 6) return;
        const ring = shapeRing(s.kind, s.start, s.cur);
        anno.push({
            type: 'Feature',
            properties: { aid: annoId(), kind: 'shape', shape: s.kind, color: drawColor, w: drawW, alpha: .24 },
            geometry: { type: 'Polygon', coordinates: [ring] }
        });
        saveAnno();
        refreshAnno();
    }

    function arrowWidth() {
        return drawW;
    }

    function arrowHeadPx() {
        return drawHead;
    }

    function saveDrawCfg() {
        try { localStorage.setItem(DRAW_KEY, JSON.stringify({ w: drawW, head: drawHead })); } catch (e) { }
    }

    function arrowGeometry(a, b) {
        let pa;
        let pb;
        try {
            pa = map.project(a);
            pb = map.project(b);
        } catch (e) { return null; }
        const px = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        if (px < 1) return null;
        let km = 0;
        let bearing = 0;
        try {
            km = turf.distance(a, b, { units: 'kilometers' });
            bearing = turf.bearing(a, b);
        } catch (e) { return null; }
        if (!(km > 0)) return null;
        const head = Math.min(km * .42, arrowHeadPx() * km / px);
        let left;
        let right;
        try {
            left = turf.destination(b, head, bearing + 152, { units: 'kilometers' }).geometry.coordinates;
            right = turf.destination(b, head, bearing - 152, { units: 'kilometers' }).geometry.coordinates;
        } catch (e) { return null; }
        return { type: 'MultiLineString', coordinates: [[a, b], [left, b], [right, b]] };
    }

    function drawArrowDraft() {
        if (!arrow) return;
        const geo = arrowGeometry(arrow.a, arrow.b);
        setDraft(geo ? [{ type: 'Feature', properties: { color: drawColor, w: arrowWidth() }, geometry: geo }] : []);
    }

    function arrowStart(e) {
        const oe = e.originalEvent;
        if (oe && typeof oe.button === 'number' && oe.button !== 0) return;
        const p = e.lngLat.toArray();
        arrow = { a: p, b: p };
        drawArrowDraft();
    }

    function arrowMove(e) {
        if (!arrow) return;
        arrow.b = e.lngLat.toArray();
        drawArrowDraft();
    }

    function arrowEnd() {
        if (!arrow) return;
        const s = arrow;
        arrow = null;
        setDraft([]);
        let pa;
        let pb;
        try {
            pa = map.project(s.a);
            pb = map.project(s.b);
        } catch (e) { return; }
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 8) return;
        const geo = arrowGeometry(s.a, s.b);
        if (!geo) return;
        anno.push({
            type: 'Feature',
            properties: { aid: annoId(), kind: 'arrow', color: drawColor, w: arrowWidth() },
            geometry: geo
        });
        saveAnno();
        refreshAnno();
    }

    function eraseAt(point) {        let hits = [];
        try {
            hits = map.queryRenderedFeatures(point, { layers: ['lt-anno-hit', 'lt-anno-hit-fill'] });
        } catch (e) { return; }
        if (!hits.length) return;
        const ids = new Set();
        hits.forEach(f => {
            const aid = f.properties && f.properties.aid;
            if (aid) ids.add(String(aid));
        });
        if (!ids.size) return;
        anno = anno.filter(f => !ids.has(String(f.properties && f.properties.aid)));
        saveAnno();
        refreshAnno();
    }

    function clearDrawings() {
        if (!anno.length) return;
        if (!window.confirm(LT.t('tools.clearAsk'))) return;
        anno = [];
        saveAnno();
        resetDrafts();
        refreshAnno();
        LT.toast(LT.t('tools.cleared'));
    }

    function paintRange(inp) {
        const min = +inp.min;
        const max = +inp.max;
        const v = +inp.value;
        const p = max > min ? Math.round((v - min) / (max - min) * 100) : 0;
        inp.style.setProperty('--p', p + '%');
    }

    function updateDrawHint() {
        const hint = $('dp-hint');
        if (!hint) return;
        hint.textContent = tool && TOOL_HINT[tool] ? LT.t(TOOL_HINT[tool]) : LT.t('tools.drawHint');
    }

    function syncDrawUI() {
        document.querySelectorAll('#dp-tools .dp-tool').forEach(b => {
            const on = b.dataset.tool === tool;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        const wInp = $('draw-width');
        if (wInp) {
            wInp.value = String(drawW);
            paintRange(wInp);
            const out = $('draw-width-val');
            if (out) out.textContent = drawW.toFixed(1) + ' px';
        }
        const hInp = $('draw-head');
        if (hInp) {
            hInp.value = String(Math.round(drawHead));
            paintRange(hInp);
            const out = $('draw-head-val');
            if (out) out.textContent = Math.round(drawHead) + ' px';
        }
        const headSec = $('dp-head-sec');
        if (headSec) headSec.classList.toggle('collapsed', tool !== 'arrow');
        updateDrawHint();
    }

    function setDrawFold(fold) {
        drawFold = !!fold;
        const box = $('draw-panel');
        if (box) box.classList.toggle('folded', drawFold);
        const btn = $('dp-fold');
        if (btn) btn.setAttribute('aria-expanded', String(!drawFold));
    }

    function setDrawPanel(open, keepTool) {
        open = !!open;
        if (open === drawPanelOpen) return;
        drawPanelOpen = open;
        if (open) {
            setDrawFold(false);
            if (menuOpen && isMobileUI()) setMenu(false);
            if (statsOpen) setStats(false);
            const sp = $('place-search');
            if (sp && sp.classList.contains('open')) setSearch(false);
        }
        const box = $('draw-panel');
        if (box) {
            box.classList.toggle('open', open);
            box.setAttribute('aria-hidden', String(!open));
        }
        const tab = $('tool-draw');
        if (tab) {
            const drawing = DRAW_TOOLS.indexOf(tool) >= 0;
            tab.classList.toggle('active', open || drawing);
            tab.setAttribute('aria-expanded', String(open));
            tab.setAttribute('aria-pressed', String(open || drawing));
        }
        if (!open && !keepTool && DRAW_TOOLS.indexOf(tool) >= 0) setTool('');
        if (open) {
            if (typeof setSearch === 'function') setSearch(false);
            syncDrawUI();
        }
    }

    function syncToolUI() {
        // «3Д» у цій же рейці — не інструмент малювання, а режим камери.
        // інакше кожен вибір лінійки знімав би з нього підсвітку, хоча 3D
        // залишався б увімкненим
        document.querySelectorAll('.tool-btn:not(#tool-3d)').forEach(btn => {
            const on = btn.id === 'tool-' + tool;
            btn.classList.toggle('active', on);
            if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(on));
        });
        syncDrawUI();
        if (map) {
            const c = map.getCanvas();
            if (c) c.style.cursor = tool ? 'crosshair' : '';
        }
    }

    function setTool(next) {
        if (next === tool) next = '';
        if (tool === 'pen') {
            pen = null;
            setDraft([]);
        }
        if (tool === 'rect' || tool === 'circle') {
            shape = null;
            setDraft([]);
        }
        if (tool === 'arrow') {
            arrow = null;
            setDraft([]);
        }
        if (tool === 'zone') {
            zonePts = [];
            setDraft([]);
        }
        tool = next;
        if (tool !== 'ruler') clearRuler();
        if (map) {
            if (tool === 'pen' || tool === 'rect' || tool === 'circle' || tool === 'arrow') map.dragPan.disable();
            else map.dragPan.enable();
            if (tool === 'zone' || tool === 'ruler') map.doubleClickZoom.disable();
            else map.doubleClickZoom.enable();
        }
        const wantsPanel = DRAW_TOOLS.indexOf(tool) >= 0;
        if (wantsPanel !== drawPanelOpen) setDrawPanel(wantsPanel);
        syncToolUI();
    }

    function resetDrafts() {
        pen = null;
        shape = null;
        arrow = null;
        zonePts = [];
        setDraft([]);
        clearRuler();
    }

    /* ---------------------------- поиск мест ---------------------------- */

    const PLACE_TYPES = {
        city: 'place.city', town: 'place.town', village: 'place.village', hamlet: 'place.hamlet',
        isolated_dwelling: 'place.hut', suburb: 'place.suburb', quarter: 'place.quarter',
        municipality: 'place.municipality', county: 'place.county', state: 'place.state',
        province: 'place.state', region: 'place.region', state_district: 'place.district',
        administrative: 'place.administrative', locality: 'place.locality'
    };

    function placeType(res) {
        // локальна класифікація НП має пріоритет над Nominatim: там смт
        // приходить як town, і Купʼянськ-Вузловий показувався «СМТ», хоч на
        // мапі він уже місто
        if (res._ltKind === 'city') return LT.t('place.city');
        if (res._ltKind === 'village') return LT.t('place.village');
        const type = res.addresstype || res.type || '';
        const dn = String(res.display_name || '').toLowerCase();
        if (type === 'administrative') {
            if (dn.includes('область') || dn.includes('обл.') || dn.includes('oblast')) return LT.t('place.state');
            if (dn.includes('район') || dn.includes('raion') || dn.includes('district')) return LT.t('place.district');
            // «Охтирська міська рада» — це громада, а не область
            if (dn.includes('громада') || dn.includes('рада') || dn.includes('municipal')) return LT.t('place.municipality');
            return LT.t('place.territory');
        }
        if (PLACE_TYPES[type]) return LT.t(PLACE_TYPES[type]);
        if (dn.includes('область')) return LT.t('place.state');
        if (dn.includes('район')) return LT.t('place.district');
        return type ? String(type).toUpperCase() : LT.t('place.object');
    }

    // іконка рядка: місто — квадрат, село — кружок, інші обʼєкти — шпилька,
    // бо в них немає класу НП
    const SEARCH_PIN = '<path d="M12 21s6.4-5.7 6.4-11A6.4 6.4 0 1 0 5.6 10c0 5.3 6.4 11 6.4 11z"/><circle cx="12" cy="10" r="2.3"/>';

    function searchKind(res) {
        const t = res._ltKind || (res._local ? res.type : String(res.addresstype || res.type || ''));
        return (t === 'city' || t === 'town') ? 'city'
            : (t === 'village' || t === 'hamlet' || t === 'isolated_dwelling' || t === 'locality') ? 'vil'
            : 'obj';
    }

    function searchIcon(res) {
        const kind = searchKind(res);
        if (kind === 'city') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor"/></svg>';
        if (kind === 'vil') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.4" fill="currentColor"/></svg>';
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SEARCH_PIN}</svg>`;
    }

    // підсвічуємо тільки те, що справді збіглося в назві; якщо нормалізація
    // зсунула індекси (апострофи, подвійні пробіли) — краще без підсвітки,
    // ніж обрізати слово не там
    function markMatch(text, q) {
        const t = String(text || '');
        const needle = String(q || '').trim().toLowerCase();
        if (!needle) return esc(t);
        const i = t.toLowerCase().indexOf(needle);
        if (i < 0 || !needle.length) return esc(t);
        return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + needle.length)) + '</mark>' + esc(t.slice(i + needle.length));
    }

    function shortName(res) {
        const first = String(res.display_name || '').split(',')[0].trim();
        return (res.name && String(res.name).trim()) || first || LT.t('place.object');
    }

    function setSearch(open) {
        const panel = $('place-search');
        const btn = $('search-btn');
        if (!panel) return;
        panel.classList.toggle('open', open);
        panel.setAttribute('aria-hidden', String(!open));
        if (open && drawPanelOpen) setDrawPanel(false, true);
        if (open && menuOpen) setMenu(false);
        if (open && statsOpen) setStats(false);
        if (btn) {
            btn.classList.toggle('active', open);
            btn.setAttribute('aria-expanded', String(open));
        }
        if (open) {
            setTimeout(() => { const q = $('ps-q'); if (q) q.focus(); }, 60);
        } else {
            // на телефоні фокус тримає клавіатуру відкритою навіть після
            // приховування панелі — знімаємо його явно
            const q = $('ps-q');
            if (q && document.activeElement === q) q.blur();
        }
    }

    // рядки перемальовуємо лише коли список справді змінився: інакше на
    // кожну літеру анімація каскаду стартує заново й список смикається
    let rowsHtml = '';

    function searchRowsHtml() {
        const q = String(($('ps-q') && $('ps-q').value) || '').trim();
        return searchRows.map((res, i) => {
            const dn = String(res.display_name || '').split(',').slice(1, 3).join(',').trim();
            return `<button type="button" class="sr" data-i="${i}" data-kind="${searchKind(res)}" role="option" style="--i:${i}">
                <span class="sr-ico" aria-hidden="true">${searchIcon(res)}</span>
                <span class="sr-txt"><b>${markMatch(shortName(res).toUpperCase(), q)}</b><small><em>${esc(placeType(res))}</em>${dn ? ' · ' + esc(dn) : ''}</small></span>
                <svg class="sr-go" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
            </button>`;
        }).join('');
    }

    function renderSearchRows(emptyMsg) {
        const box = $('ps-results');
        const pop = $('ps-pop');
        if (!box) return;
        const html = searchRows.length ? searchRowsHtml()
            : (emptyMsg ? `<div class="ps-empty">${esc(emptyMsg)}</div>` : '');
        if (html !== rowsHtml) {
            box.innerHTML = html;
            rowsHtml = html;
        }
        const count = $('ps-count');
        if (count) count.textContent = searchRows.length ? String(searchRows.length).padStart(2, '0') : '';
        if (pop) {
            pop.classList.toggle('has-rows', !!searchRows.length);
            pop.classList.toggle('is-empty', !searchRows.length);
        }
        if (searchRows.length) markSearchActive();
        if (pop) pop.classList.toggle('show', searchRows.length ? true : !!emptyMsg);
        syncSearchHint();
    }

    function markSearchActive() {
        const rows = document.querySelectorAll('#ps-results .sr');
        rows.forEach(el => {
            const on = +el.dataset.i === searchActive;
            el.classList.toggle('active', on);
            el.setAttribute('aria-selected', String(on));
        });
    }

    let hintLast = '';

    function syncSearchHint() {
        const hint = $('ps-hint');
        if (!hint) return;
        let text = '';
        if (searchPick) {
            if (!searchPick.feature) {
                text = searchPick.res && searchPick.res._local
                    ? searchPick.label
                    : LT.t('search.noContour');
            } else {
                let km2 = 0;
                try { km2 = turf.area(searchPick.feature) / 1e6; } catch (e) { km2 = 0; }
                text = LT.t('search.area') + ' — ' + Math.round(km2).toLocaleString(LT.locale()) + ' ' + LT.t('viewer.km');
            }
        }
        if (text === hintLast) return;
        hintLast = text;
        hint.textContent = text;
        // нова підказка проявляється зсувом; reduced-motion свідомо не
        // перевіряємо — на Android він увімкнений системно й гасив анімацію
        if (!text || !hint.animate) return;
        try {
            hint.animate([{ transform: 'translateY(5px)' }, { transform: 'none' }],
                { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
        } catch (e) { }
    }

    function refreshSearchArea() {
        if (!mapReady) return;
        ensureToolLayers();
        const src = map.getSource('lt-ps');
        if (!src) return;
        const fs = searchPick && searchPick.feature ? [searchPick.feature] : [];
        src.setData({ type: 'FeatureCollection', features: fs });
        // плоский контур малює DOM-полотно поверх зон (paintSearchArea),
        // а в 3D — обʼємна пластина ядра; шари мапи лишаються приховані,
        // інакше вони дублювали б контур під заливками
        ['lt-ps-fill', 'lt-ps-glow', 'lt-ps-line'].forEach(id => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        });
        LT.setSearch3D(map, fs.length ? searchPick.feature : null);
        restack();
        scheduleDraw(true);
    }

    function clearSearchMarker() {
        if (searchMarker) {
            searchMarker.remove();
            searchMarker = null;
        }
    }

    function setSearchMarker(lngLat, label) {
        clearSearchMarker();
        const el = document.createElement('div');
        el.className = 'search-marker';
        // анімація живе на внутрішній обгортці: MapLibre пише власний
        // inline transform маркеру на кожному кадрі й гасив би анімацію
        el.innerHTML = `<span class="sm-in"><span>${esc(label)}</span><b title="${esc(LT.t('viewer.close'))}">×</b></span>`;
        searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -8] })
            .setLngLat(lngLat)
            .addTo(map);
        el.querySelector('b').addEventListener('click', e => {
            e.stopPropagation();
            clearSearch();
        });
    }

    // той самий НП чи лише однойменний? у Nominatim «Кривий Ріг» — це і місто
    // на Дніпропетровщині, і село на Херсонщині: без перевірки координат
    // справжній контур села перетягував камеру за сотні кілометрів
    function samePlace(res, lon, lat) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return true;
        let x = Number(res.lon), y = Number(res.lat);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            if (!res.geojson) return true;
            const b = LT.boundsOf([{ type: 'Feature', properties: {}, geometry: res.geojson }]);
            if (!b) return true;
            x = (b[0] + b[2]) / 2;
            y = (b[1] + b[3]) / 2;
        }
        const dx = (x - lon) * Math.cos(lat * Math.PI / 180), dy = y - lat;
        return Math.hypot(dx, dy) <= 0.55;
    }

    // локальний індекс знає лише точку, тож перший клік може статися до
    // відповіді Nominatim. коли приходить справжній контур того ж міста —
    // підміняємо вибір, щоб зона намалювалася. камеру не чіпаємо, якщо
    // контур уже в кадрі; інакше підганяємо рамку — інакше велике місто
    // лишалось за екраном і виглядало як «територія не намалювалась»
    function upgradeLocalPick(rows) {
        if (!searchPick || !searchPick.res || !searchPick.res._local || searchPick.feature) return;
        const key = foldSearchName(searchPick.name);
        const lon = Number(searchPick.res.lon), lat = Number(searchPick.res.lat);
        const hit = rows.find(r => r.geojson
            && foldSearchName(r.name || shortName(r)) === key
            && samePlace(r, lon, lat));
        if (!hit) return;
        pickSearch(hit, 0, { keepCamera: true });
        const b = searchPick && searchPick.feature ? LT.boundsOf([searchPick.feature]) : null;
        if (!b) return;
        const mb = map.getBounds();
        const framed = b[0] >= mb.getWest() && b[2] <= mb.getEast()
            && b[1] >= mb.getSouth() && b[3] <= mb.getNorth();
        if (!framed) {
            map.fitBounds([[b[0], b[1]], [b[2], b[3]]],
                { padding: 70, duration: 700, maxZoom: 12 });
        }
    }

    function pickSearch(res, index, opts) {
        const keepCamera = !!(opts && opts.keepCamera);
        searchActive = index;
        const geom = res.geojson;
        const feature = geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')
            ? { type: 'Feature', properties: { name: shortName(res) }, geometry: geom }
            : null;

        searchPick = { res, feature, name: shortName(res), label: placeType(res) };
        refreshSearchArea();
        renderSearchRows();
        syncSearchHint();

        let b = feature ? LT.boundsOf([feature]) : null;
        if (!b && !res._local && res.boundingbox) {
            b = [+res.boundingbox[2], +res.boundingbox[0], +res.boundingbox[3], +res.boundingbox[1]];
        }
        if (keepCamera) {
            // контур уже намальовано; камера лишається там, куди її поставив вибір
        } else if (b && b.every(Number.isFinite)) {
            map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 70, duration: 700, maxZoom: 12 });
        } else if (res.lon && res.lat) {
            // локальний індекс знає лише точку: синтетична рамка давала
            // оманливо широкий кадр, тому летимо до точки й не дрібніше 12.5
            map.easeTo({ center: [+res.lon, +res.lat], zoom: Math.max(map.getZoom(), 12.5), duration: 700 });
        }
        if (res.lon && res.lat) setSearchMarker([+res.lon, +res.lat], searchPick.name.toUpperCase());
        if (!feature && !res._local) LT.toast(LT.t('search.noContour'));
        // на телефоні після вибору ховаємо панель: результат уже на мапі,
        // а лист із клавіатурою закривав би пів-екрана. маркер лишається
        if (isMobileUI()) setSearch(false);
    }

    // локальный индекс городов: результаты есть сразу, даже если Nominatim
    // на мобильной сети долго молчит или недоступен
    function localSearchRows(q) {
        const data = window.LT_PLACES;
        if (!data || !data.length) return [];
        // дані НП пишуть апострофи по-різному (Купянськ / Куп'янськ), тож
        // для порівняння прибираємо їх і розділові знаки зовсім
        const norm = s => String(s || '').toLowerCase()
            .replace(/[’`'ʼʹ]/g, '').replace(/[\s\-–—.,]+/g, '');
        const needle = norm(q);
        if (!needle) return [];
        const hits = [];
        const ruOf = e => (LT.placeRu ? LT.placeRu(e[0], e[2], e[3]) : e[0]);
        for (let i = 0; i < data.length; i++) {
            const e = data[i];
            const uk = norm(e[0]), en = norm(e[1] || ''), ru = norm(ruOf(e));
            const iu = uk.indexOf(needle), ie = en.indexOf(needle), ir = ru.indexOf(needle);
            if (iu < 0 && ie < 0 && ir < 0) continue;
            const starts = (iu === 0 || ie === 0 || ir === 0) ? 1 : 0;
            const rank = e[4] || 4;
            hits.push({ e, score: (starts ? -1000 : 0) + rank * 10 - Math.min(9, (+e[6] || 0) / 1e6) });
        }
        if (!hits.length) return [];
        hits.sort((a, b) => a.score - b.score);
        const lang = LT.lang();
        const seen = new Set();
        const rows = [];
        for (let i = 0; i < hits.length && rows.length < 6; i++) {
            const e = hits[i].e;
            const name = String((lang === 'en' ? (e[1] || e[0]) : lang === 'ru' ? ruOf(e) : e[0]) || '').trim();
            const key = name.toLowerCase() + '@' + e[2] + ',' + e[3];
            if (!name || seen.has(key)) continue;
            seen.add(key);
            const lon = e[2] / 1e5, lat = e[3] / 1e5;
            // тип рахуємо тим самим правилом, що й клас на мапі: там місто
            // починається з minZoom 7, а не з 5 — через це Куп'янськ-Вузловий
            // (mz7, 8 тис. мешканців) і сотні таких сіл підписувались «СЕЛО»
            const mz = +e[4] || 4;
            const city = !!e[5] || mz <= 7 || (+e[6] || 0) >= 20000;
            rows.push({
                _local: true,
                name,
                display_name: name,
                type: city ? 'city' : 'village',
                lon, lat,
                // порядок як у Nominatim: південь, північ, захід, схід. із
                // іншим порядком fitBounds отримував перевернуту рамку й
                // кидав камеру в випадкову точку на іншому кінці карти
                boundingbox: [lat - 0.07, lat + 0.07, lon - 0.1, lon + 0.1]
            });
        }
        return rows;
    }

    const normSearchName = s => String(s || '').toLowerCase()
        .replace(/[’`'ʼ]/g, "'").replace(/\s+/g, ' ').trim();

    // той самий ключ без апострофів і розділових знаків: у LT_PLACES місто
    // записане «Купянськ», а Nominatim віддає «Куп'янськ» — інакше тип НП
    // з локального індексу не переносився на мережевий рядок
    const foldSearchName = s => normSearchName(s).replace(/['\s\-–—.,]+/g, '');

    const searchHasArea = res => {
        const g = res && res.geojson;
        return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
    };

    const SEARCH_TIER = { city: 70, town: 55, municipality: 45, borough: 40, village: 25, hamlet: 10, suburb: 5 };

    const searchIsSettlement = res => {
        if (!res) return false;
        if (res._local) return res.type === 'city' || res.type === 'town' || res.type === 'village';
        const t = String(res.addresstype || res.type || '');
        return !!SEARCH_TIER[t];
    };

    // Nominatim за запитом «Дніпро» ставить річку вище міста, а за «Львів» —
    // хутір у Криму вище міста: без власного рейтингу камера летіла не туди
    // й зона не малювалась, бо в результату не було полігону
    function searchScore(res, q) {
        const n = normSearchName(shortName(res)), needle = normSearchName(q);
        let s = 0;
        if (n === needle) s += 120;
        else if (n.startsWith(needle)) s += 45;
        const cc = String((res.address && res.address.country_code) || '');
        const ua = cc === 'ua' || (res._local && res.lon > 21 && res.lon < 41 && res.lat > 44 && res.lat < 53);
        if (ua) s += 80;
        if (searchHasArea(res)) s += 35;
        const tier = String(res.addresstype || res.type || '');
        s += SEARCH_TIER[tier] || 0;
        if (res._local) s += 20;
        if (tier === 'state' || tier === 'region' || tier === 'county' || tier === 'province') s -= 10;
        if (res.class === 'waterway' || res.class === 'natural' || tier === 'river' || tier === 'stream') s -= 80;
        s += Math.max(0, Math.min(100, (Number(res.importance) || 0) * 100));
        return s;
    }

    // камера не виходить за межі карти: результат поза ними все одно
    // притиснувся б до краю й виглядав як «кинуло невідомо куди»
    function searchInView(res) {
        const mb = map && map.getMaxBounds && map.getMaxBounds();
        if (!mb) return true;
        let lon = Number(res.lon), lat = Number(res.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            const bb = res.boundingbox;
            if (bb && bb.length === 4) {
                lon = (+bb[2] + +bb[3]) / 2;
                lat = (+bb[0] + +bb[1]) / 2;
            } else if (res.geojson) {
                const b = LT.boundsOf([{ type: 'Feature', properties: {}, geometry: res.geojson }]);
                if (b) { lon = (b[0] + b[2]) / 2; lat = (b[1] + b[3]) / 2; }
            }
        }
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return true;
        const pad = 0.02;
        return lon >= mb.getWest() - pad && lon <= mb.getEast() + pad
            && lat >= mb.getSouth() - pad && lat <= mb.getNorth() + pad;
    }

    // тип НП беремо з локального індексу: він рахує клас тим самим
    // правилом, що й мапа, а Nominatim для смт віддає addresstype=town.
    // одноіменних сіл буває кілька, тож тип шукаємо не за назвою, а за
    // найближчим локальним записом — інакше село в іншій області
    // переписувало місто в «СЕЛО»
    function localKind(local, res) {
        const key = foldSearchName(shortName(res));
        let lon = Number(res.lon), lat = Number(res.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            const bb = res.boundingbox;
            if (!bb || bb.length !== 4) return '';
            lon = (+bb[2] + +bb[3]) / 2;
            lat = (+bb[0] + +bb[1]) / 2;
        }
        let kind = '', best = 0.45;
        for (const x of local) {
            if (x.type !== 'city' && x.type !== 'village') continue;
            if (foldSearchName(x.name) !== key) continue;
            const d = Math.hypot((x.lon - lon) * Math.cos(lat * Math.PI / 180), x.lat - lat);
            if (d < best) { best = d; kind = x.type; }
        }
        return kind;
    }

    function mergeSearchRows(netRows, local, q) {
        // локальний рядок викидаємо лише тоді, коли мережа знає такий самий
        // населений пункт або його полігон, а не однойменну річку чи область
        const merged = netRows.concat(local.filter(x => {
            const n = foldSearchName(x.name);
            return !netRows.some(r => foldSearchName(shortName(r)) === n && (searchHasArea(r) || searchIsSettlement(r)));
        }));
        merged.sort((a, b) => searchScore(b, q) - searchScore(a, q));
        const seen = new Set();
        const out = [];
        for (let r of merged) {
            if (!r._local) {
                const k = localKind(local, r);
                if (k) r = Object.assign({}, r, { _ltKind: k });
            }
            if (!searchInView(r)) continue;
            const key = foldSearchName(shortName(r)) + '|' + String((r.address && r.address.country_code) || '');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(r);
            if (out.length >= 8) break;
        }
        return out;
    }

    // відповіді Nominatim кешуємо: повторний запит того ж НП не мусить чекати
    // мережу, а коли геокодер відповідає 429 чи недоступний — контур усе одно
    // намалюється з кешу замість «місто знайдено, території немає»
    const NOM_KEY = 'LINETATE:search1';
    let nomCache = null;
    function nomCacheRead() {
        if (nomCache) return nomCache;
        nomCache = {};
        try {
            const raw = localStorage.getItem(NOM_KEY);
            const o = raw ? JSON.parse(raw) : null;
            if (o && typeof o === 'object') nomCache = o;
        } catch (e) { nomCache = {}; }
        return nomCache;
    }
    function nomCacheGet(q) {
        const e = nomCacheRead()[LT.lang() + '|' + normSearchName(q)];
        if (!e || !Array.isArray(e.rows) || !(Date.now() - e.t < 7 * 864e5)) return null;
        return e.rows;
    }
    function nomCachePut(q, rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        const c = nomCacheRead();
        const k = LT.lang() + '|' + normSearchName(q);
        c[k] = { t: Date.now(), rows };
        const keys = Object.keys(c).sort((a, b) => (c[b].t || 0) - (c[a].t || 0));
        keys.slice(24).forEach(x => delete c[x]);
        try { localStorage.setItem(NOM_KEY, JSON.stringify(c)); }
        catch (e) {
            // квота: лишаємо найсвіжіший запит, інакше пошук знову чекав би мережу
            nomCache = {}; nomCache[k] = c[k];
            try { localStorage.setItem(NOM_KEY, JSON.stringify(nomCache)); } catch (e2) { }
        }
    }

    async function doSearch(autoPick) {
        const q = String($('ps-q') && $('ps-q').value || '').trim();
        if (!q) return;
        const wrap = $('place-search');
        const seq = ++searchSeq;
        const local = localSearchRows(q).filter(searchInView);
        if (local.length) {
            searchRows = local;
            searchActive = 0;
            renderSearchRows();
        }
        if (wrap) wrap.classList.add('ps-busy');
        try {
            const cached = nomCacheGet(q);
            let rows;
            if (cached) {
                rows = cached;
            } else {
                const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1'
                    + '&polygon_geojson=1&accept-language=' + LT.lang() + '&q=' + encodeURIComponent(q);
                const r = await fetch(url, { headers: { Accept: 'application/json' } });
                if (seq !== searchSeq) return;
                if (!r.ok) throw new Error('http');
                rows = await r.json();
                if (seq !== searchSeq) return;
                nomCachePut(q, rows);
            }
            if (Array.isArray(rows) && rows.length) {
                const merged = mergeSearchRows(rows, local, q);
                if (merged.length) {
                    searchRows = merged;
                    searchActive = 0;
                    renderSearchRows();
                    upgradeLocalPick(merged);
                    if (autoPick) pickSearch(merged[0], 0);
                } else {
                    searchRows = [];
                    searchActive = -1;
                    renderSearchRows(LT.t('search.notFound'));
                    if (autoPick) LT.toast(LT.t('search.notFound'), 'err');
                }
            } else if (local.length) {
                searchRows = local;
                searchActive = 0;
                renderSearchRows();
                if (autoPick) pickSearch(local[0], 0);
            } else {
                searchRows = [];
                searchActive = -1;
                renderSearchRows(LT.t('search.notFound'));
                if (autoPick) LT.toast(LT.t('search.notFound'), 'err');
            }
        } catch (e) {
            if (seq !== searchSeq) return;
            if (local.length) {
                searchRows = local;
                searchActive = 0;
                renderSearchRows();
                if (autoPick) pickSearch(local[0], 0);
            } else {
                renderSearchRows(LT.t('search.unavailable'));
                if (autoPick) LT.toast(LT.t('search.unavailable'), 'err');
            }
        } finally {
            if (seq === searchSeq && wrap) wrap.classList.remove('ps-busy');
        }
    }

    // на телефоні аркуш результатів закриває майже весь екран: два пальці на
    // ньому скролили список, і масштаб карти не змінювався взагалі.
    // перекидаємо двопальцевий жест на полотно карти; скрол списку одним
    // пальцем лишається як був
    function forwardSearchPinch() {
        if (!isMobileUI() || !map) return;
        const panel = $('place-search');
        const host = map.getCanvasContainer && map.getCanvasContainer();
        if (!panel || !host || !window.Touch || !window.TouchEvent) return;
        try {
            new Touch({ identifier: 1, target: host, clientX: 0, clientY: 0 });
        } catch (e) {
            // Safari без конструктора Touch: лишаємо стандартну поведінку
            return;
        }
        let on = false;
        const touchesOf = e => Array.from(e.touches || [], t => new Touch({
            identifier: t.identifier, target: host,
            clientX: t.clientX, clientY: t.clientY,
            screenX: t.screenX, screenY: t.screenY,
            pageX: t.pageX, pageY: t.pageY,
            radiusX: t.radiusX || 1, radiusY: t.radiusY || 1,
            rotationAngle: t.rotationAngle || 0, force: t.force || 1
        }));
        const send = (type, e) => {
            try {
                const touches = touchesOf(e);
                host.dispatchEvent(new TouchEvent(type, {
                    touches, targetTouches: touches, changedTouches: touches,
                    bubbles: true, cancelable: true
                }));
            } catch (err) { }
        };
        panel.addEventListener('touchstart', e => {
            if (e.touches.length !== 2) return;
            on = true;
            e.preventDefault();
            send('touchstart', e);
        }, { passive: false });
        panel.addEventListener('touchmove', e => {
            if (!on) return;
            e.preventDefault();
            send('touchmove', e);
        }, { passive: false });
        const end = e => {
            if (!on) return;
            on = false;
            try {
                host.dispatchEvent(new TouchEvent(e.type === 'touchcancel' ? 'touchcancel' : 'touchend', {
                    touches: [], targetTouches: [], changedTouches: [], bubbles: true, cancelable: true
                }));
            } catch (err) { }
        };
        panel.addEventListener('touchend', end);
        panel.addEventListener('touchcancel', end);
    }

    function clearSearch() {
        searchPick = null;
        searchRows = [];
        searchActive = -1;
        searchSeq++;
        clearSearchMarker();
        LT.clearSearch3D(map);
        const src = map.getSource('lt-ps');
        if (src) src.setData(EMPTY_FC);
        ['lt-ps-fill', 'lt-ps-glow', 'lt-ps-line'].forEach(id => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        });
        renderSearchRows();
        syncSearchHint();
        scheduleDraw(true);
    }

    function toolClick(e) {
        if (tool === 'ruler') rulerClick(e);
        else if (tool === 'zone') zoneClick(e);
        else if (tool === 'erase') eraseAt(e.point);
    }

    function toolHover(e) {
        if (tool === 'ruler') {
            if (!rulerDone && rulerPts.length) drawRuler(e.lngLat.toArray());
            return;
        }
        if (tool === 'zone' && zonePts.length) drawZoneDraft(e.lngLat.toArray());
    }

    function syncMapLayers() {
        if (!mapReady) return;

        Array.from(mounted).forEach(id => {
            if (state.layers[id]) return;
            LT.removeLayerObjects(map, id);
            mounted.delete(id);
        });

        Object.values(state.layers).forEach(l => {
            if (!mounted.has(l.id)) {
                LT.removeLayerObjects(map, l.id);
                LT.createLayerObjects(map, l);
                mounted.add(l.id);
            }
            applyLayer(l);
        });

        restack();
    }

    function remount() {
        mounted.clear();
        clearSelection();
        LT.ensureFlow(map);
        syncMapLayers();
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        if (mapTools) { mapTools.refresh(); mapTools.setRegions(state.regions); }
        ensureSelectionLayers();
        ensureToolLayers();
        refreshAnno();
        refreshSearchArea();
        if (rulerPts.length) drawRuler();
        restack();
        if (blend) blend.sync();
        // підкладка перебудувала стиль і знесла DEM: рельєф повертаємо за
        // режимом, інакше після перемикання темна/гібрид він зникає назавжди
        LT.syncRelief(map);
        scheduleDraw();
    }

    /* ---------------------------- дата и слои ---------------------------- */

    function clampDate(iso) {
        const b = LT.dateBounds();
        if (iso < b.min) return b.min;
        if (iso > b.max) return b.max;
        return iso;
    }

    function pickDate() {
        const saved = store.lastDate();
        if (saved) return saved;
        const list = store.listDates();
        if (!list.length) return LT.todayIso();
        let best = null;
        list.forEach(d => { if (d.features > 0) best = d.date; });
        return best || list[list.length - 1].date;
    }

    function readDate() {
        store.setLastDate(state.date);
        shownFC.clear();
        clearSelection();
        currentDoc = loadDoc(state.date);
        state.layers = currentDoc.layers;
        state.savedAt = currentDoc.savedAt;
        resetDrafts();
        loadAnno();
        Object.keys(state.layers).forEach(id => {
            state.layers[id].viewLabel = state.labels;
            if (!state.layers[id].style.visible) state.hidden.add(id);
        });
        syncMapLayers();
        updateLegend();
        updateEmpty();
        syncAdvanceButton();
        if (isMobileUI()) warmCurrent();
        else warmPriority(state.date);
    }

    function zoneSnapshot() {
        const out = {};
        Object.values(state.layers).forEach(l => {
            if (l.kind !== 'zone' || !isVisible(l)) return;
            out[l.id] = { fc: displayFC(l) };
        });
        return out;
    }

    function pulseDate(dir) {
        const el = $('date-trigger');
        el.classList.remove('shift-up', 'shift-down');
        void el.offsetWidth;
        el.classList.add(dir > 0 ? 'shift-up' : 'shift-down');
        setTimeout(() => el.classList.remove('shift-up', 'shift-down'), 500);
    }

    function switchDate(iso) {
        if (!LT.DATE_RE.test(iso)) return;
        iso = clampDate(iso);
        if (iso === state.date) return;
        const dir = iso > state.date ? 1 : -1;
        state.date = iso;
        state.hidden.clear();
        readDate();
        uiDate();
        if (cal) cal.refresh();
        if (state.advance) refreshAdvance();
        pulseDate(dir);
    }

    function shiftDate(delta) {
        const d = LT.fromIso(state.date);
        d.setDate(d.getDate() + delta);
        switchDate(LT.isoOf(d));
    }

    function uiDate() {
        $('date-trigger').textContent = LT.fmtTrigger(state.date);
        document.title = LT.t('app.title') + ' — ' + LT.fmtFull(state.date);
        const b = LT.dateBounds();
        $('prev-date').disabled = state.date <= b.min;
        $('next-date').disabled = state.date >= b.max;
    }

    /* ---------------------------- интерфейс ---------------------------- */

    // скрытые слои (visible:false) — служебные, в списке их не показываем;
    // маски показываем: это обычные видимые слои, которые режут другие
    function publicLayers() {
        return Object.values(state.layers)
            .filter(l => l.style.visible !== false)
            .sort((a, b) => b.z - a.z);
    }

    function updateLegend() {
        const list = publicLayers();
        const box = $('legend-list');

        $('legend-count').textContent = String(list.length);

        if (!list.length) {
            box.innerHTML = '<div class="hint" style="padding:6px">' + LT.t('viewer.noLayers') + '</div>';
        } else {
            box.innerHTML = list.map(l => {
                const shown = shownFC.get(l.id) || displayFC(l);
                const area = l.kind === 'zone' ? areaKm2(shown) : 0;
                const total = l.data.features.length;
                const val = l.kind === 'arrow'
                    ? (total ? total + ' ' + LT.countWord(total, 'viewer.arrow') : LT.t('viewer.emptyVal'))
                    : (total ? Math.round(area).toLocaleString(LT.locale()) + ' ' + LT.t('viewer.km') : LT.t('viewer.emptyVal'));
                const meta = l.kind === 'arrow' ? LT.t('viewer.arrows') : LT.t('viewer.zone');
                const desc = (l.desc || '').trim();
                const hasLabel = !!((l.style.labelText || '').trim() || l.name);
                return `<div class="lg-row ${isVisible(l) ? '' : 'off'}" data-id="${esc(l.id)}" title="${esc(desc || l.name)}">
                    <span class="sw ${l.kind === 'arrow' ? 'arrow' : ''}" style="background:${esc(l.style.color)};box-shadow:0 0 9px ${esc(l.style.color)}88"></span>
                    <span class="lg-txt"><b>${esc(l.name)}</b><small>${esc(desc || meta)}</small></span>
                    <span class="lg-val">${val}</span>
                    ${hasLabel ? `<button type="button" class="lg-center" data-center="${esc(l.id)}" title="${esc(LT.t('viewer.center'))}" aria-label="${esc(LT.t('viewer.center'))}">◎</button>` : ''}
                </div>`;
            }).join('');
        }

        const when = state.savedAt
            ? new Date(state.savedAt).toLocaleTimeString(LT.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '—';
        $('legend-foot').innerHTML = LT.t('viewer.updated') + ' <b>' + when + '</b>';
    }

    function updateEmpty() {
        const total = Object.values(state.layers).reduce((n, l) => n + l.data.features.length, 0);
        $('empty').classList.toggle('hidden', total > 0);
    }

    let menuOpen = false;
    let statsOpen = false;
    let statsRes = null;
    let statsBusy = false;
    let statsTab = 'front';
    let statsLoss = null;
    let statsLossErr = false;
    let lossBusy = false;
    let newsRes = null;
    let newsBusy = false;

    function statsTabIndex(tab) {
        const i = ['front', 'ua', 'losses', 'news'].indexOf(tab);
        return i < 0 ? 0 : i;
    }

    function syncStatsTabs() {
        document.querySelectorAll('.lt-stats-tab').forEach(btn => {
            const on = btn.dataset.tab === statsTab;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', String(on));
        });
        const wrap = document.querySelector('.lt-stats-tabs');
        if (wrap) wrap.style.setProperty('--tab-i', statsTabIndex(statsTab));
    }
    function ensureLosses(force) {
        if (lossBusy) return;
        // дані втрат не залежать від дати: повторний похід у вкладку не має
        // перезавантажувати їх і перемальовувати вже показані графіки
        if (!force && statsLoss) return;
        lossBusy = true;
        statsLossErr = false;
        if (statsTab === 'losses') renderStats();
        LT.loadLosses(force).then(doc => {
            statsLoss = doc;
            lossBusy = false;
            if (statsTab === 'losses') renderStats();
        }).catch(() => {
            lossBusy = false;
            statsLoss = null;
            statsLossErr = true;
            if (statsTab === 'losses') renderStats();
        });
    }

    function setStatsTab(tab) {
        tab = tab === 'ua' ? 'ua' : tab === 'losses' ? 'losses' : tab === 'news' ? 'news' : 'front';
        if (statsTab === tab) return;
        statsTab = tab;
        if (tab === 'losses') ensureLosses(false);
        if (tab === 'news') ensureNews();
        // переписуємо вміст, щоб ріст стовпчиків діаграми стартував заново
        renderStats();
    }

    // новини рахуються з різниць зон між сусідніми датами: це важча операція,
    // ніж огляд, тому вантажимо її лише коли вкладку справді відкрили
    function ensureNews() {
        if (newsBusy || newsRes) return;
        newsBusy = true;
        if (statsTab === 'news') renderStats();
        LT.frontNews((i, n) => {
            if (statsTab !== 'news') return;
            const body = $('stats-body');
            if (body) body.innerHTML = `<div class="lt-stats-loading">${LT.esc(LT.t('stats.newsLoading'))} ${n ? i + '/' + n : ''}</div>`;
        }).then(res => {
            newsBusy = false;
            newsRes = res;
            if (statsTab === 'news') renderStats();
        }).catch(() => {
            newsBusy = false;
            if (statsTab === 'news') renderStats();
        });
    }

    let countRuns = new Set();
    // групування тисяч як у розмітці: у EN кома, в uk/ru — пробіл
    const countFmts = {};
    function fmtCount(n) {
        const loc = LT.locale();
        let f = countFmts[loc];
        if (f === undefined) {
            try { f = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }); } catch (e) { f = null; }
            countFmts[loc] = f;
        }
        return f ? String(f.format(Math.round(n || 0))).replace(/[\u00a0\u202f]/g, ' ') : String(Math.round(n || 0));
    }
    // км² зі знаком і одним десятковим знаком — той самий формат, що й у
    // розмітці (statsFmt/statsSigned), щоб докручування не стрибало іншим числом
    function fmtKm(n) {
        n = +n || 0;
        const a = Math.abs(n);
        const v = a < 100 ? Math.round(a * 10) / 10 : Math.round(a);
        let s;
        try { s = new Intl.NumberFormat(LT.locale(), { maximumFractionDigits: 1 }).format(v); }
        catch (e) { s = String(v); }
        s = s.replace(/[\u00a0\u202f]/g, ' ');
        return n > 0.05 ? '+' + s : n < -0.05 ? '−' + s : '0';
    }
    function fmtCountEl(el, n) { return el.dataset.fmt === 'km' ? fmtKm(n) : fmtCount(n); }
    function stopCounts() {
        countRuns.forEach(r => cancelAnimationFrame(r.f));
        countRuns.clear();
    }
    // цифри втрат докручуються від нуля; reduced-motion тут навмисно не
    // перевіряється: Android із «прибрати анімації» репортить його завжди,
    // і саме через це на телефоні не було жодного руху цифр
    function animateCounts(root) {
        if (!root) return;
        const els = Array.from(root.querySelectorAll('.lt-count[data-count]'));
        if (!els.length) return;
        // у розмітці вже стоїть підсумок — обнуляємо в тому ж кадрі, інакше
        // перший кадр показує фінальне число, а далі воно стрибає в нуль
        for (const el of els) el.textContent = '0';
        const dur = 900, t0 = performance.now();
        const ease = p => 1 - Math.pow(1 - p, 3);
        const run = { f: 0 };
        const tick = now => {
            // мітка кадру може бути раніше за performance.now() — без нижньої
            // межі перший кадр дає відʼємні числа
            const p = Math.max(0, Math.min(1, (now - t0) / dur));
            const k = ease(p);
            for (const el of els) el.textContent = fmtCountEl(el, p >= 1 ? el.dataset.count : (+el.dataset.count || 0) * k);
            if (p < 1) run.f = requestAnimationFrame(tick);
            else countRuns.delete(run);
        };
        run.f = requestAnimationFrame(tick);
        countRuns.add(run);
    }

    // анімації діаграм стартують не при відкритті вкладки, а коли блок
    // справді потрапляє в кадр під час скролу. Кожен блок анімується рівно
    // один раз за сеанс: повторний показ уже не перезапускає рух
    const animSeen = new Set();
    let animIO = null;

    function animVisible(el, viewport) {
        const a = el.getBoundingClientRect(), b = viewport.getBoundingClientRect();
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return overlap > Math.min(a.height, b.height) * 0.25;
    }

    function runAnim(el, viewport) {
        const key = el.dataset.anim || '';
        if (key) animSeen.add(key);
        el.classList.add('lt-anim');
        animateCounts(el);
        if (animIO) animIO.unobserve(el);
    }

    function setupAnims(body) {
        if (animIO) animIO.disconnect();
        animIO = null;
        stopCounts();
        if (!body) return;
        // закрита панель не має «програвати» анімації: геометрія в неї є,
        // тому без цієї перевірки все відпрацювало б у невидимому стані
        if (!statsOpen) return;
        const pending = [];
        for (const el of body.querySelectorAll('[data-anim]')) {
            if (animSeen.has(el.dataset.anim)) continue;
            // видимі вже зараз запускаємо в тому ж кадрі — без блимання
            // готового стану перед початком анімації
            if (animVisible(el, body)) runAnim(el, body);
            else pending.push(el);
        }
        if (!pending.length) return;
        if (typeof IntersectionObserver !== 'function') {
            pending.forEach(el => runAnim(el, body));
            return;
        }
        animIO = new IntersectionObserver(entries => {
            for (const en of entries) if (en.isIntersecting) runAnim(en.target, body);
        }, { root: body, threshold: 0.25 });
        pending.forEach(el => animIO.observe(el));
    }

    // панель закрили посеред анімації: зупиняємо кадри й повертаємо
    // підсумкові числа, інакше на екрані лишилися б нулі
    function teardownAnims() {
        if (animIO) {
            animIO.disconnect();
            animIO = null;
        }
        stopCounts();
        const body = $('stats-body');
        if (!body) return;
        for (const el of body.querySelectorAll('.lt-count[data-count]')) el.textContent = fmtCountEl(el, el.dataset.count);
    }

    function renderStats() {
        const body = $('stats-body');
        if (body) {
            body.innerHTML = LT.statsRender(statsRes, statsTab, statsLoss, statsLossErr, newsRes);
            setupAnims(body);
        }
        // підзаголовок читається як «скільки триває війна», а не як дата
        // початку даних: цифра однакова для всіх вкладок і рахується від 24.02
        const sub = $('stats-sub');
        if (sub) {
            const n = LT.warDays();
            sub.textContent = LT.t('stats.warDay', { n: n.toLocaleString(LT.locale()) });
        }
        syncStatsTabs();
    }

    function loadStats() {
        if (statsBusy) return;
        statsBusy = true;
        renderStats();
        LT.statsCompute((i, n) => {
            // прогрес «рахуємо площі» належить вкладці «Огляд»: без цієї
            // перевірки він затирав «Втрати» й «Новини», які вже показали
            // свої дані, поки площі ще довантажувались
            if (statsRes || statsTab !== 'front') return;
            const body = $('stats-body');
            if (body) body.innerHTML = `<div class="lt-stats-loading">${LT.esc(LT.t('stats.loading'))} ${n ? i + '/' + n : ''}</div>`;
        }).then(res => {
            statsBusy = false;
            statsRes = res;
            // перемальовуємо лише ту вкладку, якій потрібні ці дані: інакше
            // пізня відповідь знищує вже показані «Втрати» й гасить анімації
            if (statsTab === 'front') renderStats();
        }).catch(() => {
            statsBusy = false;
            if (statsTab === 'front') renderStats();
        });
    }

    function setStats(open) {
        open = !!open;
        statsOpen = open;
        if (open) {
            if (menuOpen) setMenu(false);
            const sp = $('place-search');
            if (sp && sp.classList.contains('open')) setSearch(false);
            if (drawPanelOpen && isMobileUI()) setDrawPanel(false);
        }
        const panel = $('stats');
        const btn = $('stats-btn');
        if (panel) {
            panel.classList.toggle('open', open);
            panel.setAttribute('aria-hidden', String(!open));
        }
        syncBackdrop();
        if (btn) {
            btn.classList.toggle('active', open);
            btn.setAttribute('aria-expanded', String(open));
        }
        if (open) {
            loadStats();
            // тягнемо заздалегідь, щоб вкладка «Втрати» відкривалась уже з даними
            ensureLosses(false);
        } else {
            teardownAnims();
        }
    }

    // на телефоні «Шари» й статистика — однакові аркуші над мапою: підкладка
    // приглушує карту й закриває аркуш тапом
    function syncBackdrop() {
        const b = $('legend-backdrop');
        if (b) b.classList.toggle('show', isMobileUI() && (menuOpen || statsOpen));
    }

    function setMenu(open) {
        menuOpen = open;
        // панелі не нашаровуються одна на одну: меню закриває пошук і малювання,
        // інакше на телефоні аркуш «Шари» ховав би панель малювання під собою
        if (open) {
            const sp = $('place-search');
            if (sp && sp.classList.contains('open')) setSearch(false);
            if (statsOpen) setStats(false);
            if (drawPanelOpen && isMobileUI()) setDrawPanel(false);
        }
        const legend = $('legend');
        const toggle = $('viewer-menu-toggle');
        if (legend) legend.classList.toggle('open', open);
        syncBackdrop();
        if (toggle) {
            toggle.classList.toggle('active', open);
            toggle.setAttribute('aria-expanded', String(open));
        }
    }

    /* ---------------------------- подписи и продвижение ---------------------------- */

    function markDocSaved() {
        lastVer = store.version();
        const hit = docCache.get(state.date);
        if (!hit) return;
        const doc = store.load(state.date);
        hit.key = doc && doc.savedAt ? doc.savedAt : hit.key;
        hit.savedAt = hit.key;
        state.savedAt = hit.key;
        currentDoc = hit;
    }

    // назви шарів на мапі завжди ввімкнені: перемикач прибрано, лишилися
    // перетягування підпису та скидання в центр шару
    function setLabels(on) {
        state.labels = !!on;
        Object.values(state.layers).forEach(l => {
            l.viewLabel = state.labels;
            if (!mapReady) return;
            LT.applyLayerPaint(map, l, isVisible(l));
            LT.syncLayerDecor(map, l, shownFC.get(l.id) || displayFC(l), isVisible(l));
        });
    }

    function set3DView(on, deferRelief) {
        if (!mapReady) return;
        // перемикач живе в двох місцях: у рейці інструментів (завжди на екрані)
        // і в панелі шарів. обидва мають показувати один і той самий стан
        ['view-3d', 'tool-3d'].forEach(id => {
            const btn = $(id);
            if (!btn) return;
            btn.classList.toggle('active', !!on);
            btn.setAttribute('aria-pressed', String(!!on));
        });
        try { localStorage.setItem('LINETATE:3d', on ? '1' : '0'); } catch (e) { }
        LT.set3D(map, !!on, {
            layers: state.layers,
            isVisible,
            deferRelief: !!deferRelief,
            // вихід із 3D завершується асинхронно: доки камера не ляже рівно,
            // map._lt3d ще true, і полотна зон створювати не можна. Тому
            // перебудову бленд-полотен робимо в момент, коли режим справді
            // знято, а не одразу після кліку (там ще діє старий режим).
            onExit: () => { if (blend) blend.sync(); }
        });
        // набір полотен залежить від режиму: у 3D зони малює екструзія, тож
        // їхні градієнтні полотна прибираються (і повертаються в площині)
        if (blend) blend.sync();
        // знайдена територія теж міняє вигляд: пластина в 3D, заливка в площині
        if (searchPick) refreshSearchArea();
        // «РЕЛЬЄФ» має два різні стани (3D/площина) — після перемикання
        // показуємо той, що діє в новому режимі
        syncReliefBtn();
    }

    // стан читаємо з самої мапи, а не з класу кнопки: два перемикачі не зможуть
    // розійтися, навіть якщо хтось натисне під час анімації нахилу.
    // під час переходу _lt3d ще показує старий режим, тому ціль беремо з _lt3dWant
    function toggle3D() {
        const want = map._lt3dWant == null ? !!map._lt3d : !!map._lt3dWant;
        set3DView(!want);
    }

    /* ------------------- перемикачі шарів: рельєф / НП / зони ------------------- */

    // «РЕЛЬЄФ» працює за режимом: у 3D керує горами обʼємної карти (типово
    // увімкнено), у площині вмикає тініювання (типово вимкнено)
    function mode3d() {
        return map._lt3dWant == null ? !!map._lt3d : !!map._lt3dWant;
    }

    function syncReliefBtn() {
        const btn = $('view-relief');
        if (!btn) return;
        const on = mode3d() ? state.relief3d : state.reliefFlat;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function setReliefToggle(on) {
        on = !!on;
        if (mode3d()) state.relief3d = on; else state.reliefFlat = on;
        try {
            localStorage.setItem(mode3d() ? 'LINETATE:relief3d' : 'LINETATE:reliefflat', on ? '1' : '0');
        } catch (e) { }
        LT.setReliefUser(map, on);
        syncReliefBtn();
    }

    function syncPlacesBtn() {
        const btn = $('view-places');
        if (!btn) return;
        btn.classList.toggle('active', !!state.places);
        btn.setAttribute('aria-pressed', String(!!state.places));
    }

    function setPlacesToggle(on) {
        state.places = !!on;
        try { localStorage.setItem('LINETATE:places', state.places ? '1' : '0'); } catch (e) { }
        LT.setPlacesVisible(map, state.places);
        syncPlacesBtn();
    }

    function syncZonesBtn() {
        const btn = $('view-zones');
        if (!btn) return;
        btn.classList.toggle('active', !!state.zones3d);
        btn.setAttribute('aria-pressed', String(!!state.zones3d));
    }

    function setZonesToggle(on) {
        state.zones3d = !!on;
        try { localStorage.setItem('LINETATE:zones3d', state.zones3d ? '1' : '0'); } catch (e) { }
        LT.setZones3d(map, state.zones3d);
        // перезастосовуємо paint: fe_ (екструзія) зникає, а плоска заливка
        // повертається, коли обʼємні зони вимкнено
        Object.values(state.layers).forEach(l => {
            if (mapReady) LT.applyLayerPaint(map, l, isVisible(l));
        });
        if (blend) blend.sync();
        syncZonesBtn();
    }

    // «ОБВОДКА»: контури всіх шарів одним перемикачем. це не зміна стилю
    // (стиль лишається в даних) — рушій просто не малює лінії контуру й
    // світлу кромку, поки прапорець вимкнено
    function syncOutlinesBtn() {
        const btn = $('view-outlines');
        if (!btn) return;
        btn.classList.toggle('active', !!state.outlines);
        btn.setAttribute('aria-pressed', String(!!state.outlines));
    }

    function setOutlinesToggle(on) {
        state.outlines = !!on;
        try { localStorage.setItem('LINETATE:outlines', state.outlines ? '1' : '0'); } catch (e) { }
        LT.setOutlines(map, state.outlines);
        Object.values(state.layers).forEach(l => {
            if (mapReady) LT.applyLayerPaint(map, l, isVisible(l));
        });
        if (blend) blend.sync();
        syncOutlinesBtn();
    }

    function syncRailsBtn() {
        const btn = $('view-rails');
        if (!btn) return;
        btn.classList.toggle('active', !!state.rails);
        btn.setAttribute('aria-pressed', String(!!state.rails));
    }

    function setRailsToggle(on) {
        state.rails = !!on;
        try { localStorage.setItem('LINETATE:rails', state.rails ? '1' : '0'); } catch (e) { }
        if (mapTools) mapTools.setRailways(state.rails);
        syncRailsBtn();
    }

    function centerLabel(id) {
        const l = state.layers[id];
        if (!l) return;
        delete l.style.labelPos;
        store.saveLabelPos(state.date, id, null);
        markDocSaved();
        if (!state.labels) setLabels(true);
        else if (mapReady) {
            LT.applyLayerPaint(map, l, isVisible(l));
            LT.syncLayerDecor(map, l, shownFC.get(l.id) || displayFC(l), isVisible(l));
        }
        updateLegend();
    }

    function hasDataDoc(entry) {
        return Object.values(entry.layers).some(l => l.data.features.length);
    }

    function dateHasData(date) {
        const entry = docCache.get(date);
        if (entry) return hasDataDoc(entry);
        const info = store.dateInfo(date);
        if (info) return info.features > 0;
        return false;
    }

    function snapshotFor(layers) {
        const out = {};
        Object.values(layers).forEach(l => {
            if (l.kind !== 'zone' || !l.style.visible) return;
            out[l.id] = { fc: displayFC(l, layers) };
        });
        return out;
    }

    function refreshAdvance() {
        if (!state.advance) { LT.clearAdvance(map); return; }
        const dates = store.listDates()
            .filter(d => dateHasData(d.date))
            .map(d => d.date);
        const i = dates.indexOf(state.date);
        if (i < 0 || dates.length < 2) {
            state.advance = false;
            syncAdvanceButton();
            LT.clearAdvance(map);
            LT.toast(LT.t('viewer.advanceNone'), 'err');
            return;
        }
        const ref = i > 0 ? dates[i - 1] : dates[i + 1];
        const refLayers = loadDoc(ref).layers;
        const current = zoneSnapshot();
        const other = snapshotFor(refLayers);
        const roles = (() => { try { return localStorage.getItem('LINETATE:__roles') || ''; } catch (e) { return ''; } })();
        const key = ref + '>' + state.date + '|' + roles;
        const stats = ref < state.date
            ? LT.showAdvance(map, other, current, key)
            : LT.showAdvance(map, current, other, key);
        LT.advanceToast(stats, true);
    }

    function setAdvance(on) {
        state.advance = !!on;
        syncAdvanceButton();
        if (state.advance) refreshAdvance();
        else LT.clearAdvance(map);
    }

    function syncAdvanceButton() {
        const btn = $('advance-btn');
        if (!btn) return;
        btn.classList.toggle('active', state.advance);
        btn.setAttribute('aria-pressed', String(state.advance));
    }

    // картка новин веде на ту саму дату й вмикає «Просування»: людина бачить
    // рівно ту ділянку, про яку прочитала
    function focusNews(date, bbox) {
        if (!date || !LT.DATE_RE.test(date)) return;
        setStats(false);
        if (date !== state.date) switchDate(date);
        if (state.advance) refreshAdvance();
        else setAdvance(true);
        if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite)) return;
        const dev = LT.device();
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
            padding: dev.mobile
                ? { top: 90, bottom: 150, left: 24, right: 24 }
                : { top: 80, bottom: 110, left: 40, right: 40 },
            maxZoom: 12.5, duration: 750
        });
    }

    function togglePlay() {
        const btn = $('play-btn');
        if (playTimer) {
            clearInterval(playTimer);
            playTimer = null;
            btn.classList.remove('active');
            btn.textContent = LT.t('viewer.play');
            return;
        }
        const b = LT.dateBounds();
        const dates = store.listDates()
            .filter(d => {
                if (d.date < b.min || d.date > b.max) return false;
                return d.features > 0;
            })
            .map(d => d.date);

        if (dates.length < 2) { LT.toast(LT.t('viewer.playErr'), 'err'); return; }

        let i = Math.max(0, dates.indexOf(state.date));
        btn.classList.add('active');
        btn.textContent = LT.t('viewer.stop');
        playTimer = setInterval(() => {
            i = (i + 1) % dates.length;
            switchDate(dates[i]);
        }, 1500);
    }

    function startAnimations() {
        LT.startAnimations(map, () => state.layers, isVisible);
    }

    /* ---------------------------- снимок карты ---------------------------- */

    function stampPhoto(ctx, W, H) {
        const k = Math.max(1, W / 1500);
        const pad = Math.round(26 * k);

        ctx.save();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        ctx.fillStyle = '#f5f5f6';
        ctx.fillRect(pad, H - pad - Math.round(56 * k), Math.round(52 * k), Math.round(3 * k));

        ctx.font = `900 ${Math.round(30 * k)}px 'Tektur', 'Handjet', monospace`;
        ctx.fillStyle = 'rgba(235,242,250,.96)';
        ctx.fillText('LINESTATE', pad, H - pad - Math.round(18 * k));

        ctx.font = `700 ${Math.round(13 * k)}px 'Handjet', 'Tektur', monospace`;
        ctx.fillStyle = 'rgba(158,182,205,.92)';
        ctx.fillText(LT.fmtFull(state.date), pad, H - pad);

        const c = map.getCenter();
        const right = 'ZOOM ' + map.getZoom().toFixed(1) + ' · ' + Math.abs(c.lat).toFixed(2) + (c.lat >= 0 ? 'N' : 'S')
            + ' ' + Math.abs(c.lng).toFixed(2) + (c.lng >= 0 ? 'E' : 'W');
        ctx.textAlign = 'right';
        ctx.font = `700 ${Math.round(13 * k)}px 'Handjet', 'Tektur', monospace`;
        ctx.fillStyle = 'rgba(158,182,205,.92)';
        ctx.fillText(right, W - pad, H - pad);
        ctx.restore();
    }

    function photoFx(ctx, W, H, k) {
        if (document.querySelector('#fx-scan.on')) {
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,.5)';
            const step = Math.max(2, Math.round(3 * k));
            const th = Math.max(1, Math.round(k));
            for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, th);
            ctx.restore();
        }

        if (document.querySelector('#fx-grain.on')) {
            const n = document.createElement('canvas');
            n.width = 128;
            n.height = 128;
            const nc = n.getContext('2d');
            const img = nc.createImageData(128, 128);
            for (let i = 0; i < img.data.length; i += 4) {
                const v = 128 + Math.round(Math.random() * 96 - 48);
                img.data[i] = v;
                img.data[i + 1] = v;
                img.data[i + 2] = v;
                img.data[i + 3] = 255;
            }
            nc.putImageData(img, 0, 0);
            ctx.save();
            ctx.globalCompositeOperation = 'overlay';
            ctx.globalAlpha = 0.3;
            ctx.fillStyle = ctx.createPattern(n, 'repeat');
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
        }
    }

    function photoSelLabel(ctx, W) {
        if (!sel) return;
        const l = state.layers[sel.id];
        if (!l) return;

        const src = map.getCanvas();
        const dpr = W / (src.clientWidth || 1);
        const p = map.project(sel.lngLat);
        const x = p.x * dpr;
        const yBottom = p.y * dpr - 14 * dpr;

        const name = l.name;
        const meta = selMeta(l);
        const desc = (l.desc || '').trim();

        const fsName = 15 * dpr, fsMeta = 12 * dpr, fsDesc = 11 * dpr;
        const padX = 10 * dpr, gap = 9 * dpr, barW = 3 * dpr, closeW = 12 * dpr;
        const padY = 6 * dpr;

        ctx.save();
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.font = `700 ${fsName}px 'Handjet', 'Tektur', monospace`;
        const nameW = ctx.measureText(name).width;
        ctx.font = `700 ${fsMeta}px 'Handjet', 'Tektur', monospace`;
        const metaW = ctx.measureText(meta).width;

        let descText = '';
        let descW = 0;
        if (desc) {
            ctx.font = `700 ${fsDesc}px 'Handjet', 'Tektur', monospace`;
            descText = desc;
            const maxW = Math.max(220 * dpr, Math.max(nameW, metaW));
            while (descText.length > 4 && ctx.measureText(descText + '…').width > maxW) descText = descText.slice(0, -2);
            if (descText !== desc) descText += '…';
            descW = ctx.measureText(descText).width;
        }

        const boxH = padY * 2 + fsName + 2 * dpr + fsMeta + (descText ? fsDesc + 3 * dpr : 0);
        const boxW = padX * 2 + barW + gap + Math.max(nameW, metaW, descW) + gap + closeW;
        const bx = x - boxW / 2;
        const by = yBottom - boxH;

        ctx.fillStyle = 'rgba(10, 13, 17, .96)';
        ctx.strokeStyle = 'rgba(255, 255, 255, .22)';
        ctx.lineWidth = Math.max(1, dpr);
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, 5 * dpr);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.fillRect(bx, by, boxW, boxH);
            ctx.strokeRect(bx, by, boxW, boxH);
        }

        ctx.fillStyle = '#f5f5f6';
        ctx.fillRect(bx + padX, by + padY, barW, boxH - padY * 2);

        const tx = bx + padX + barW + gap;
        ctx.font = `700 ${fsName}px 'Handjet', 'Tektur', monospace`;
        ctx.fillStyle = '#e8eef5';
        ctx.fillText(name, tx, by + padY);
        ctx.font = `700 ${fsMeta}px 'Handjet', 'Tektur', monospace`;
        ctx.fillStyle = 'rgba(107, 120, 133, .95)';
        ctx.fillText(meta, tx, by + padY + fsName + 2 * dpr);

        if (descText) {
            ctx.font = `700 ${fsDesc}px 'Handjet', 'Tektur', monospace`;
            ctx.fillStyle = 'rgba(146, 160, 174, .92)';
            ctx.fillText(descText, tx, by + padY + fsName + 2 * dpr + fsMeta + 3 * dpr);
        }

        ctx.font = `700 ${fsName}px 'Handjet', 'Tektur', monospace`;
        ctx.fillStyle = 'rgba(107, 120, 133, .9)';
        ctx.textAlign = 'right';
        ctx.fillText('×', bx + boxW - padX - 2 * dpr, by + padY);

        ctx.restore();
    }

    function snapPhoto() {
        try {
            const src = map.getCanvas();
            const W = src.width, H = src.height;
            if (!W || !H) { LT.toast(LT.t('viewer.photoErr'), 'err'); return; }

            const cv = document.createElement('canvas');
            cv.width = W;
            cv.height = H;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#05080b';
            ctx.fillRect(0, 0, W, H);

            // фильтры FX применяются CSS-фильтром к контейнеру карты — вшиваем в снимок
            let flt = 'none';
            try {
                const cc = map.getCanvasContainer();
                const cf = getComputedStyle(cc).filter;
                if (cf && cf !== 'none') flt = cf;
            } catch (e) { }

            ctx.filter = flt;
            ctx.drawImage(src, 0, 0);

            const pc = map.getCanvasContainer().querySelector('canvas.lt-places-canvas');
            if (pc && pc.width && pc.height) ctx.drawImage(pc, 0, 0, W, H);
            ctx.filter = 'none';

            // градиентные заливки живут на DOM-canvas: после смены DPR их нужно
            // перерисовать синхронно, иначе в снимок попадает пустой/мыльный холст
            if (blend) blend.sync(src.width / (src.clientWidth || 1));

            document.querySelectorAll('#lt-blend canvas').forEach(c => {
                const m = String(c.style.mixBlendMode || '');
                let mode = 'source-over';
                if (LT.BLENDS.indexOf(m) >= 0 && m !== 'normal') mode = m;
                try { ctx.globalCompositeOperation = mode; } catch (e) { ctx.globalCompositeOperation = 'source-over'; }
                ctx.drawImage(c, 0, 0, W, H);
            });
            ctx.globalCompositeOperation = 'source-over';

            // кордони живуть на власному DOM-полотні (#lt-borders) і в кадр
            // мапи не входять — без цього рядка снимок виходив без них
            try { mapTools.snapBorders(ctx, W); } catch (e) { }

            paintDraw();
            if (drawCv && drawCv.width) ctx.drawImage(drawCv, 0, 0, W, H);

            const k = Math.max(1, W / 1500);
            photoFx(ctx, W, H, k);

            const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .34, W / 2, H / 2, Math.max(W, H) * .78);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(0,0,0,.52)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            photoSelLabel(ctx, W);

            ctx.strokeStyle = 'rgba(190,215,245,.22)';
            ctx.lineWidth = Math.max(1, k * 1.2);
            ctx.strokeRect(k * 10, k * 10, W - k * 20, H - k * 20);

            stampPhoto(ctx, W, H);

            cv.toBlob(blob => {
                if (!blob) { LT.toast(LT.t('viewer.photoErr'), 'err'); return; }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'LINESTATE-front-' + state.date + '.png';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                LT.toast(LT.t('viewer.photoOk'));
            }, 'image/png');
        } catch (e) {
            LT.toast(LT.t('viewer.photoErr'), 'err');
        }
    }

    // снимок рендерится заново в повышенном DPR: карта даёт ~2K по ширине,
    // а не размер окна браузера
    function photo() {
        const src = map.getCanvas();
        const cssW = src.clientWidth || src.width;
        const cssH = src.clientHeight || src.height;
        if (!cssW || !cssH) { LT.toast(LT.t('viewer.photoErr'), 'err'); return; }

        const base = map.getPixelRatio();
        let ratio = Math.max(base, 2048 / cssW);
        ratio = Math.max(base, Math.min(ratio, 3.2, 3072 / cssH));

        const restore = () => {
            try {
                map.setPixelRatio(base === (window.devicePixelRatio || 1) ? null : base);
                LT.setPlaceDpr(map, 0);
                if (blend) blend.sync();
            } catch (e) { }
        };

        // без preserveDrawingBuffer WebGL-буфер живёт только внутри кадра,
        // поэтому копию снимаем синхронно в обработчике render — одинаково
        // на десктопе и телефоне
        const capture = () => {
            let got = false;
            const grab = () => {
                if (got) return;
                got = true;
                try { snapPhoto(); } finally { restore(); }
            };
            map.once('render', grab);
            map.triggerRepaint();
            setTimeout(grab, 600);
        };

        if (ratio <= base + 0.01) { capture(); return; }

        let fired = false;
        const finish = () => {
            if (fired) return;
            fired = true;
            capture();
        };
        try {
            map.setPixelRatio(ratio);
            LT.setPlaceDpr(map, ratio);
            map.once('idle', finish);
            setTimeout(finish, 1000);
            map.triggerRepaint();
        } catch (e) {
            finish();
        }
    }

    /* ---------------------------- обновление ---------------------------- */

    function refresh() {
        const clamped = clampDate(state.date);
        const changedDate = clamped !== state.date;
        if (changedDate) {
            state.date = clamped;
            state.hidden.clear();
        }
        const entry = loadDoc(state.date);
        if (!changedDate && entry === currentDoc) {
            updateLegend();
            uiDate();
            return;
        }
        readDate();
        uiDate();
        if (cal) cal.refresh();
        if (state.advance) refreshAdvance();
    }

    function watchLive() {
        setInterval(() => {
            let fxk = '';
            try { fxk = localStorage.getItem('LINETATE:__fx') || ''; } catch (e) { }
            if (fxk !== lastFx) {
                lastFx = fxk;
                LT.applyFX();
            }
            const v = store.version();
            if (v !== lastVer) {
                lastVer = v;
                refresh();
            }
        }, 2500);

        window.addEventListener('storage', e => {
            const key = String(e.key || '');
            if (e.key === null || key.startsWith('LINETATE:')) {
                if (key === 'LINETATE:__fx' || e.key === null) LT.applyFX();
                if (key === ANNO_PREFIX + state.date) loadAnno();
                lastVer = store.version();
                refresh();
            }
        });

        // документи дат тепер живуть у IndexedDB: сусідня вкладка сповіщає лише службовим ключем,
        // тому перегляд оновлюється ще раз після того, як свіжу копію витягнуто з бази
        store.onMirrorUpdate(() => {
            lastVer = store.version();
            refresh();
            if (statsOpen) {
                statsRes = null;
                newsRes = null;
                loadStats();
                if (statsTab === 'news') ensureNews();
            }
        });
    }

    /* ---------------------------- старт ---------------------------- */

    LT.initI18n();
    LT.initDevice();
    LT.initFX();
    state.date = clampDate(LT.todayIso());

    try {
        map = LT.createMap('map', { center: [37.6, 48.35], zoom: 7 });
    } catch (e) {
        // без WebGL сцена не підніметься взагалі: без пояснення це чорний
        // екран, тому знімаємо завісу й кажемо причину
        const veil = document.getElementById('boot');
        if (veil) veil.remove();
        LT.gfxFail('Телефон не зміг створити графічне ядро карти (WebGL). Закрийте інші вкладки й спробуйте ще раз.');
        return;
    }
    const mapTools = LT.installMapTools(map, { regionLines: true, regionsOn: state.regions });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(LT.scaleBar(map), 'bottom-right');
    LT.smoothZoom(map);

    // категорії державних кордонів: кожна вмикається окремо, стан живе
    // в памʼяті сесії (жодних збережених прапорців зі старих версій)
    const borderOn = {};
    function buildBorderChips() {
        const box = $('border-box');
        const wrap = $('border-chips');
        const raw = window.LT_STATE_BORDERS;
        if (!box || !wrap) return;
        if (!raw || !raw.cats || !raw.cats.length) { box.hidden = true; return; }
        box.hidden = false;
        const lang = LT.lang();
        wrap.innerHTML = '';
        raw.cats.forEach(c => {
            const on = borderOn[c.id] !== false;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'border-chip' + (on ? ' active' : '');
            btn.dataset.cat = c.id;
            const label = (c.name && (c.name[lang] || c.name.uk)) || c.id;
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.setAttribute('aria-pressed', String(on));
            // країну показує прапор, без текстових підписів у рейці
            btn.innerHTML = LT.flagHtml(c.id, 'lt-flag-chip');
            btn.addEventListener('click', () => {
                const next = borderOn[c.id] === false;
                borderOn[c.id] = next;
                btn.classList.toggle('active', next);
                btn.setAttribute('aria-pressed', String(next));
                if (mapTools) mapTools.setBorder(c.id, next);
            });
            wrap.appendChild(btn);
        });
    }
    buildBorderChips();
    document.addEventListener('linetate:lang', buildBorderChips);

    // після повороту екрана або появи/зникнення клавіатури полотно мусить
    // збігатися з вікном, інакше карта зсувається відносно екрана
    function keepViewport() {
        try { map.resize(); } catch (e) { }
    }
    window.addEventListener('orientationchange', () => setTimeout(keepViewport, 160));
    if (window.visualViewport) {
        let vvT = 0;
        window.visualViewport.addEventListener('resize', () => {
            clearTimeout(vvT);
            vvT = setTimeout(keepViewport, 90);
        });
    }

    LT.setLayerLabelDrag(map, (id, pos) => {
        const l = state.layers[id];
        if (!l) return;
        l.style.labelPos = pos;
        store.saveLabelPos(state.date, id, pos);
        markDocSaved();
        updateLegend();
    });

    const UKRAINE_BOUNDS = [[22.0, 44.2], [40.6, 52.6]];
    function fitUkraine() {
        const dev = LT.device();
        map.fitBounds(UKRAINE_BOUNDS, {
            padding: dev.mobile
                ? { top: 78, bottom: 140, left: 14, right: 14 }
                : { top: 46, bottom: 84, left: 26, right: 26 },
            duration: 0
        });
    }
    // після аварійного перезавантаження камеру вже повернуто в createMap:
    // підгонка під Україну викинула б людину з її місця
    if (!map._ltRecovered) fitUkraine();

    // стан перемикачів шарів зі сховища. не плутати з підписами шарів:
    // relief — гори, places — НП, zones3d — обʼємні 3D-зони
    // lite-старт (після повторної втрати графічного контексту): темна
    // векторна база без растру й без 3D-рельєфу — менше памʼяті на кадр
    if (LT.lite) {
        state.base = 'dark';
        state.relief3d = false;
    }
    map._ltBase = state.base;
    try {
        const r3 = localStorage.getItem('LINETATE:relief3d');
        const rf = localStorage.getItem('LINETATE:reliefflat');
        const pl = localStorage.getItem('LINETATE:places');
        const zn = localStorage.getItem('LINETATE:zones3d');
        const ol = localStorage.getItem('LINETATE:outlines');
        const rw = localStorage.getItem('LINETATE:rails');
        state.relief3d = r3 !== '0';
        state.reliefFlat = rf === '1';
        state.places = pl !== '0';
        state.zones3d = zn !== '0';
        state.outlines = ol !== '0';
        state.rails = rw !== '0';
        // назви шарів на самій мапі завжди ввімкнені: збережене «вимкнено»
        // більше не має сили, бо повернути їх було б нічим
        state.labels = true;
    } catch (e) { }
    LT.setReliefPrefs(map, { relief3d: state.relief3d, reliefFlat: state.reliefFlat });
    LT.setZones3d(map, state.zones3d);
    LT.setOutlines(map, state.outlines);
    map._ltWhiteRims = true;
    mapTools.setRailways(state.rails);
    syncOutlinesBtn();
    syncRailsBtn();

    pxLabels = LT.pixelLabels(map);
    pxLabels.setOn(state.base === 'hybrid');

    function syncLangUI() {
        const langBtn = $('lang-btn');
        if (langBtn) langBtn.innerHTML = LT.flagHtml(LT.lang(), 'lt-flag-mini') + '<span>' + LT.lang().toUpperCase() + '</span>';
        if (!mapReady) return;
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        if (pxLabels) pxLabels.relabel();
        relabelSelection();
        updateLegend();
        uiDate();
        $('play-btn').textContent = playTimer ? LT.t('viewer.stop') : LT.t('viewer.play');
        if (searchRows.length) renderSearchRows();
        syncSearchHint();
        syncDrawUI();
        if (statsOpen) renderStats();
    }

    document.addEventListener('linetate:lang', syncLangUI);

    syncLangUI();

    const setBase = LT.baseSwitcher(map, remount);

    let dataReady = false;
    let styleReady = false;

    // чорна завіса на старті: під нею мапа розмита і в чорно-білому, тому
    // перші кадри не показують сирі тайли. знімаємо коли готові меню,
    // поточний день і геометрія всіх дат — перший дотик не рахує нічого
    let veilLifted = false;
    const veilStart = Date.now();
    let bootProg = 0;
    let preloadStarted = false;
    const BOOT_STEPS = ['map', 'data', 'warm', 'render'];

    // смуга тільки росте: етапи йдуть паралельно і не мають права відкотити
    // відсоток назад, інакше прогрес читається як глюк
    function bootPct(p) {
        const veil = $('boot');
        if (!veil) return;
        bootProg = Math.max(bootProg, Math.min(100, p));
        veil.style.setProperty('--p', bootProg + '%');
        const el = $('boot-pct');
        if (el) el.textContent = Math.round(bootProg) + '%';
    }
    function bootStage(key, p, note) {
        const idx = BOOT_STEPS.indexOf(String(key).split('.').pop());
        if (!veilLifted) {
            const el = $('boot-state');
            if (el) el.textContent = LT.t(key);
            const nt = $('boot-note');
            if (nt) nt.textContent = note || '';
            const box = $('boot-steps');
            if (box && idx >= 0) {
                box.querySelectorAll('.boot-step').forEach(n => {
                    const i = BOOT_STEPS.indexOf(n.dataset.step);
                    n.classList.toggle('done', i < idx);
                    n.classList.toggle('on', i === idx);
                });
            }
        }
        if (p != null) bootPct(p);
    }
    // кадр або таймер: у прихованій вкладці rAF не приходить зовсім, і без
    // страховки черга прогріву застрягла б назавжди
    function yieldFrame() {
        return new Promise(res => {
            let fin = false;
            const go = () => { if (!fin) { fin = true; res(); } };
            requestAnimationFrame(go);
            setTimeout(go, 60);
        });
    }
    function withTimeout(p, ms) {
        if (!p) return Promise.resolve();
        return Promise.race([Promise.resolve(p).catch(() => { }), new Promise(r => setTimeout(r, ms))]);
    }

    // геометрія дати друкується під завісою: base — лише поточний LOD, all —
    // усі сходи, щоб зум не перебудовував Path2D під час першого жесту
    function warmDate(date, paths, zoom) {
        const entry = docCache.get(date) || loadDoc(date);
        const fcs = [];
        zoneIds(entry.layers).forEach(id => fcs.push(displayFC(entry.layers[id], entry.layers)));
        if (fcs.length) {
            try { LT.warmGeometry(fcs, { paths, zoom }); } catch (e) { }
        }
        warmState.done.add(date);
    }

    function liftVeil() {
        if (veilLifted) return;
        const veil = $('boot');
        if (!veil) return;
        // WebKit може віддати перший render пізніше за готовність даних:
        // це ще не збій, тому чекаємо кадр до справжнього дедлайну.
        if (!map._ltFrames && !map._ltGlLost && Date.now() - veilStart < 16000) {
            setTimeout(liftVeil, 250);
            return;
        }
        if (map._ltGlLost || !map._ltFrames) {
            LT.gfxFail('Телефон не зміг відмалювати карту. Закрийте інші вкладки й спробуйте ще раз.');
        }
        veilLifted = true;
        const box = $('boot-steps');
        if (box) box.querySelectorAll('.boot-step').forEach(n => { n.classList.remove('on'); n.classList.add('done'); });
        bootPct(100);
        // карту показали — це і є один перегляд; адмінка сама не рахується
        try { LT.views.record(); } catch (e) { }
        // решта дат додрукована в фоні: жоден перебір календаря не має туманити
        setTimeout(preloadRest, 600);
        // новини рахують різниці зон по всіх парах дат — це секунди важкої
        // роботи. рахуємо їх заздалегідь, у паузі після завіси, щоб вкладка
        // відкривалась без очікування. жест відсуває старт: кадри належать мапі
        scheduleNewsWarm();
        // на швидкій мережі завіса мигнула б за сто мілісекунд — тримаємо
        // мінімум, щоб перехід читався як завантаження, а не як глітч
        setTimeout(() => {
            veil.classList.add('done');
            setTimeout(() => veil.remove(), 750);
            // перший кадр показано — тепер гори можна й завантажувати
            LT.reliefArm(map);
        }, Math.max(0, 900 - (Date.now() - veilStart)));
    }

    // усе під завісою: меню, шрифти, поточний день, решта дат і перший кадр
    // полотен. кожна дата дає кадру подихати, щоб смуга рухалась, а браузер
    // не застигав на довгому синхронному розрахунку
    let newsWarmRuns = false;
    let newsWarmArmed = false;
    // на телефоні камера сама дрібно підправляється щокадру й сипле
    // movestart — підписка на жест тут перезапускала б таймер вічно.
    // тому чекаємо спокійний кадр за isMoving/isEasing, а не за подією
    function scheduleNewsWarm() {
        if (newsWarmRuns || newsWarmArmed) return;
        newsWarmArmed = true;
        const start = () => {
            if (newsWarmRuns) return;
            if (document.visibilityState === 'hidden'
                || (map.isMoving && (map.isMoving() || map.isEasing()))) {
                setTimeout(start, 800);
                return;
            }
            newsWarmRuns = true;
            let p;
            try {
                p = Promise.resolve(LT.frontNews(null, {
                    gap: isMobileUI() ? 60 : 0,
                    pause: () => !!(map.isMoving && (map.isMoving() || map.isEasing()))
                        || document.visibilityState === 'hidden'
                }));
            } catch (e) { newsWarmRuns = false; return; }
            p.then(() => { }, () => { newsWarmRuns = false; });
        };
        setTimeout(start, isMobileUI() ? 1000 : 500);
    }

    async function preloadAll() {
        if (preloadStarted) return;
        preloadStarted = true;
        stopWarm();
        warmState.date = null;
        warmState.ids = null;
        const t0 = Date.now();
        const cap = (window.matchMedia && matchMedia('(max-width: 700px)').matches) ? 7000 : 5500;
        const cur = state.date;
        if (!warmState.done.has(cur)) warmDate(cur, 'all');
        const rest = isMobileUI() ? [] : store.listDates().map(d => d.date)
            .filter(d => d !== cur)
            .sort((a, b) => Math.abs(Date.parse(a) - Date.parse(cur)) - Math.abs(Date.parse(b) - Date.parse(cur)));
        const total = rest.length + 1;
        let k = 1;
        bootStage('boot.warm', 34, k + '/' + total);
        for (let i = 0; i < rest.length; i++) {
            if (Date.now() - t0 > cap) break;
            await yieldFrame();
            warmDate(rest[i], 'base', map.getZoom());
            k++;
            bootStage('boot.warm', 34 + Math.round(52 * k / total), k + '/' + total);
        }
        // хвіст, що не встиг під завісою, добирає фоновий прогрів
        warmState.dates = rest.filter(d => !warmState.done.has(d));
        bootStage('boot.render', 90, '');
        if (document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 1200);
        await withTimeout(fetch('data/losses.json', { cache: 'force-cache' }), 900);
        bootPct(96);
        // перший кадр полотен малюємо тут: після підняття завіси заливки вже
        // на місці й не «проявляються» окремим кадром
        try { if (blend) blend.sync(); } catch (e) { }
        await yieldFrame();
        liftVeil();
    }
    setTimeout(liftVeil, 16000);

    function markStyleReady() {
        if (styleReady) return;
        styleReady = true;
        bootStage('boot.data', 22);
        boot();
    }

    function boot() {
        if (mapReady || !dataReady || !styleReady) return;
        mapReady = true;

        cal = LT.Calendar({
            el: $('cal'),
            trigger: $('date-trigger'),
            current: () => state.date,
            hasData: iso => {
                const info = store.dateInfo(iso);
                return !!info && info.features > 0;
            },
            minDate: () => LT.dateBounds().min,
            maxDate: () => LT.dateBounds().max,
            onPick: iso => { setMenu(false); switchDate(iso); }
        });

        readDate();
        uiDate();
        const bootDate = $('boot-date');
        if (bootDate) bootDate.textContent = LT.fmtTrigger(state.date);
        $('play-btn').textContent = LT.t('viewer.play');
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        LT.setPlacesVisible(map, state.places);
        blend = LT.blendEngine(map, () => state.layers, isVisible, l => shownFC.get(l.id) || displayFC(l));
        blend.sync();
        // вимірювальний шов, той самий, що в ядрі для підписів і полотен:
        // «просування працює» має бути числом із браузера, а не словами
        if (window.__ltViewerDebug) {
            window.__ltViewerDebug(() => ({
                map, state, blend, dates: () => store.listDates(),
                snapshot: zoneSnapshot, layer: id => state.layers[id]
            }));
        }
        // 3D-режим, обраний минулого разу, повертається разом зі сторінкою.
        // гори при цьому не вмикаються: DEM-тайли з мережі затримали б перший
        // кадр під завісою, тож reliefArm кличе їх, коли завіса вже впала
        try {
            if (localStorage.getItem('LINETATE:3d') === '1') set3DView(true, true);
        } catch (e) { }
        // поточний день друкується тут: далі жест не має право нічого спрощувати
        bootStage('boot.warm', 30);
        try { warmCurrent(); } catch (e) { }
        startAnimations();
        watchLive();

        ensureSelectionLayers();
        ensureToolLayers();
        ensureDrawCanvas();

        map.on('click', e => {
            if (suppressClick) {
                const s = suppressClick;
                suppressClick = null;
                if (performance.now() - s.time < 700 && e.point && Math.hypot(e.point.x - s.x, e.point.y - s.y) < 24) return;
            }
            if (menuOpen) setMenu(false);
            if (isMobileUI()) {
                const sp = $('place-search');
                if (sp && sp.classList.contains('open')) setSearch(false);
            }
            if (tool) { toolClick(e); return; }
            const id = pickLayer(e.point);
            if (!id) { clearSelection(); return; }
            selectLayer(id, e.lngLat);
        });

        map.on('dblclick', () => {
            if (tool === 'zone') zoneFinish();
            if (tool === 'ruler') rulerFinish();
        });

        // на телефоне первое касание карты убирает панель, но оставляет инструмент —
        // иначе лист на пол-экрана просто не даёт рисовать
        const collapseForMap = () => {
            if (drawPanelOpen && isMobileUI()) setDrawPanel(false, true);
        };

        map.on('mousedown', e => {
            collapseForMap();
            if (tool === 'pen') penStart(e);
            else if (tool === 'arrow') arrowStart(e);
            else if (tool === 'rect' || tool === 'circle') shapeStart(e);
        });
        map.on('mouseup', () => {
            if (pen) penEnd();
            if (shape) shapeEnd();
            if (arrow) arrowEnd();
        });
        map.on('touchstart', e => {
            if (!e.lngLats || e.lngLats.length !== 1) {
                touchTap = null;
                if (pen || shape || arrow) {
                    pen = null;
                    shape = null;
                    arrow = null;
                    setDraft([]);
                }
                return;
            }
            collapseForMap();
            touchTap = (tool === 'ruler' || tool === 'zone' || tool === 'erase') && e.point
                ? { tool, x: e.point.x, y: e.point.y } : null;
            if (tool === 'pen') {
                pen = { pts: [e.lngLats[0].toArray()] };
                drawPenDraft();
            } else if (tool === 'arrow') {
                const p = e.lngLats[0].toArray();
                arrow = { a: p, b: p };
                drawArrowDraft();
            } else if (tool === 'rect' || tool === 'circle') {
                const p = e.lngLats[0].toArray();
                shape = { kind: tool, start: p, cur: p };
                drawShapeDraft();
            }
        });
        map.on('touchmove', e => {
            if (!e.lngLats || e.lngLats.length !== 1) { touchTap = null; return; }
            if (touchTap && e.point && Math.hypot(e.point.x - touchTap.x, e.point.y - touchTap.y) > 10) touchTap = null;
            if (pen) penMove({ lngLat: e.lngLats[0], point: e.points && e.points[0] });
            else if (arrow) arrowMove({ lngLat: e.lngLats[0], point: e.points && e.points[0] });
            else if (shape) shapeMove({ lngLat: e.lngLats[0], point: e.points && e.points[0] });
        });
        map.on('touchend', e => {
            if (touchTap && e.point && tool === touchTap.tool && Math.hypot(e.point.x - touchTap.x, e.point.y - touchTap.y) <= 12) {
                suppressClick = { time: performance.now(), x: e.point.x, y: e.point.y };
                toolClick(e.lngLat ? e : { lngLat: map.unproject(e.point), point: e.point });
            }
            touchTap = null;
            const touches = e.originalEvent && e.originalEvent.touches;
            if (!touches || !touches.length) {
                if (pen) penEnd();
                if (shape) shapeEnd();
                if (arrow) arrowEnd();
            }
        });
        map.on('touchcancel', () => {
            touchTap = null;
            pen = null;
            shape = null;
            arrow = null;
            setDraft([]);
        });

        let hoverTimer = 0;
        let hoverPt = null;
        const hoverPick = () => {
            hoverTimer = 0;
            if (!hoverPt) return;
            try { map.getCanvas().style.cursor = pickLayer(hoverPt) ? 'pointer' : ''; } catch (err) { }
        };
        // у 3D запит «що під курсором» — це кілька синхронних читань кадрів із
        // GPU (readPixels), по п’ять на запит. Під час жесту це ламає кожен
        // кадр, тому курсор наводимо лише коли камера стала: на moveend
        const queueHover = pt => {
            hoverPt = pt;
            if (map.isMoving && map.isMoving()) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(hoverPick, 90);
        };
        map.on('mousemove', e => {
            if (pen) { penMove(e); return; }
            if (shape) { shapeMove(e); return; }
            if (arrow) { arrowMove(e); return; }
            if (tool) { toolHover(e); return; }
            if (e.originalEvent && e.originalEvent.buttons) return;
            queueHover(e.point);
        });
        map.on('moveend', () => {
            if (hoverPt && !hoverTimer) hoverTimer = setTimeout(hoverPick, 60);
        });

        $('prev-date').addEventListener('click', () => shiftDate(-1));
        $('next-date').addEventListener('click', () => shiftDate(1));
        $('play-btn').addEventListener('click', togglePlay);
        $('photo-btn').addEventListener('click', photo);
        $('view-regions').addEventListener('click', e => {
            const on = !e.currentTarget.classList.contains('active');
            e.currentTarget.classList.toggle('active', on);
            e.currentTarget.setAttribute('aria-pressed', String(on));
            state.regions = on;
            mapTools.setRegions(on);
        });
        $('view-relief').addEventListener('click', () => setReliefToggle(!(map._lt3d ? state.relief3d : state.reliefFlat)));
        $('view-places').addEventListener('click', () => setPlacesToggle(!state.places));
        $('view-zones').addEventListener('click', () => setZonesToggle(!state.zones3d));
        $('view-outlines').addEventListener('click', () => setOutlinesToggle(!state.outlines));
        $('view-rails').addEventListener('click', () => setRailsToggle(!state.rails));
        $('view-3d').addEventListener('click', toggle3D);
        const rail3d = $('tool-3d');
        if (rail3d) rail3d.addEventListener('click', toggle3D);
        $('advance-btn').addEventListener('click', () => setAdvance(!state.advance));
        const statsBtn = $('stats-btn');
        if (statsBtn) statsBtn.addEventListener('click', () => setStats(!statsOpen));
        const statsClose = $('stats-close');
        if (statsClose) statsClose.addEventListener('click', () => setStats(false));
        document.querySelectorAll('.lt-stats-tab').forEach(btn => {
            btn.addEventListener('click', () => setStatsTab(btn.dataset.tab));
        });
        const statsBody = $('stats-body');
        if (statsBody) statsBody.addEventListener('click', e => {
            if (e.target.closest('.lt-loss-retry')) { ensureLosses(true); return; }
            const card = e.target.closest('[data-news-date]');
            if (!card) return;
            const bbox = String(card.dataset.newsBbox || '').split(',').map(Number);
            focusNews(card.dataset.newsDate, bbox);
        });
        $('date-trigger').addEventListener('click', () => { setMenu(false); cal.toggle(state.date); });

        $('lang-btn').addEventListener('click', () => LT.switchLang());

        $('search-btn').addEventListener('click', () => setSearch(!$('place-search').classList.contains('open')));
        const psQ = $('ps-q');
        const psClear = $('ps-clear');
        const psClose = $('ps-close');
        if (psClose) psClose.addEventListener('click', () => setSearch(false));
        if (psClear) psClear.addEventListener('click', () => {
            if (psQ) { psQ.value = ''; psQ.focus(); }
            psClear.hidden = true;
            clearSearch();
        });
        if (psQ) {
            psQ.addEventListener('input', () => {
                const q = psQ.value.trim();
                if (psClear) psClear.hidden = !q;
                searchSeq++;
                clearTimeout(searchTimer);
                if (!q) {
                    searchRows = [];
                    searchActive = -1;
                    renderSearchRows();
                    return;
                }
                const local = q.length >= 2 ? localSearchRows(q) : [];
                searchRows = local;
                searchActive = local.length ? 0 : -1;
                renderSearchRows();
                if (q.length >= 2) searchTimer = setTimeout(() => doSearch(false), 560);
            });
            psQ.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(searchTimer);
                    doSearch(true);
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    if (!searchRows.length) return;
                    e.preventDefault();
                    const step = e.key === 'ArrowDown' ? 1 : -1;
                    searchActive = (searchActive + step + searchRows.length) % searchRows.length;
                    markSearchActive();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearch(false);
                }
            });
        }
        $('ps-results').addEventListener('click', e => {
            const row = e.target.closest('.sr');
            if (!row) return;
            const res = searchRows[+row.dataset.i];
            if (res) pickSearch(res, +row.dataset.i);
        });
        forwardSearchPinch();

        $('tool-draw').addEventListener('click', () => setDrawPanel(!drawPanelOpen));
        $('dp-close').addEventListener('click', () => setDrawPanel(false));
        const foldBtn = $('dp-fold');
        if (foldBtn) foldBtn.addEventListener('click', () => setDrawFold(!drawFold));
        $('tool-ruler').addEventListener('click', () => setTool('ruler'));
        document.querySelectorAll('#dp-tools .dp-tool').forEach(b => {
            b.addEventListener('click', () => {
                setTool(b.dataset.tool);
                // на телефоне лист закрываем сразу: иначе он занимает пол-экрана
                // и рисовать банально негде — режим остаётся включённым
                if (tool && isMobileUI()) {
                    setDrawPanel(false, true);
                    if (TOOL_HINT[tool]) LT.toast(LT.t(TOOL_HINT[tool]));
                }
            });
        });
        $('dp-clear').addEventListener('click', clearDrawings);

        const widthInp = $('draw-width');
        if (widthInp) widthInp.addEventListener('input', () => {
            drawW = clampNum(widthInp.value, W_MIN, W_MAX, drawW);
            saveDrawCfg();
            syncDrawUI();
            if (pen) drawPenDraft();
            if (shape) drawShapeDraft();
            if (arrow) drawArrowDraft();
            if (zonePts.length) drawZoneDraft();
        });
        const headInp = $('draw-head');
        if (headInp) headInp.addEventListener('input', () => {
            drawHead = clampNum(headInp.value, HEAD_MIN, HEAD_MAX, drawHead);
            saveDrawCfg();
            syncDrawUI();
            if (arrow) drawArrowDraft();
        });

        document.querySelectorAll('#dp-colors .dp-sw').forEach(b => {
            b.addEventListener('click', () => setDrawColor(b.dataset.color));
        });
        syncColorUI();
        syncDrawUI();
        const colorInp = $('draw-color');
        if (colorInp) {
            colorInp.addEventListener('input', () => setDrawColor(colorInp.value));
            colorInp.addEventListener('change', () => setDrawColor(colorInp.value));
        }

        $('viewer-menu-toggle').addEventListener('click', () => setMenu(!menuOpen));
        const backdrop = $('legend-backdrop');
        if (backdrop) backdrop.addEventListener('click', () => { setMenu(false); setStats(false); });
        const legendClose = $('legend-close');
        if (legendClose) legendClose.addEventListener('click', () => setMenu(false));
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (menuOpen) setMenu(false);
            if (statsOpen) setStats(false);
            if (drawPanelOpen) setDrawPanel(false);
            if (tool) setTool('');
            const search = $('place-search');
            if (search && search.classList.contains('open')) setSearch(false);
        });
        document.addEventListener('linetate:device', e => { if (!e.detail.mobile) setMenu(false); });

        $('legend-list').addEventListener('click', e => {
            const center = e.target.closest('.lg-center');
            if (center) {
                e.stopPropagation();
                centerLabel(center.dataset.center);
                return;
            }
            const row = e.target.closest('.lg-row');
            if (!row) return;
            const id = row.dataset.id;
            if (!state.layers[id]) return;
            if (state.hidden.has(id)) state.hidden.delete(id);
            else state.hidden.add(id);
            if (sel && sel.id === id && state.hidden.has(id)) clearSelection();
            applyLayer(state.layers[id]);
            if (blend) blend.sync();
            updateLegend();
        });

        document.querySelectorAll('#base-seg button').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('#base-seg button').forEach(x => x.classList.toggle('active', x === b));
                state.base = b.dataset.base;
                // тема підкладки потрібна рельєфу для кольорів тініювання
                map._ltBase = b.dataset.base;
                setBase(b.dataset.base);
                if (pxLabels) pxLabels.setOn(b.dataset.base === 'hybrid');
                LT.ensurePlaceLabels(map, state.base);
            });
        });

        syncReliefBtn();
        syncPlacesBtn();
        syncZonesBtn();

        // далі — повна предзагрузка всіх дат і першого кадру під завісою
        preloadAll();
    }

    // опубликованные данные лежат рядом с сайтом: data/map.json
    LT.store.loadRemoteData('data/map.json').then(() => {
        dataReady = true;
        bootStage('boot.warm', 30);
        if (!mapReady) state.date = clampDate(pickDate());
        else if (!dateHasData(state.date)) state.date = clampDate(pickDate());
        boot();
        if (mapReady) refresh();
    });

    // телефон повертається до вкладки через години: свіжа публікація має
    // прийти одразу, а не після перезавантаження сторінки
    let lastCheck = Date.now();
    function recheckRemote() {
        const now = Date.now();
        if (now - lastCheck < 15000) return;
        lastCheck = now;
        LT.store.loadRemoteData('data/map.json').then(n => {
            if (!n || !mapReady) return;
            if (!dateHasData(state.date)) state.date = clampDate(pickDate());
            refresh();
        });
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) recheckRemote();
    });
    window.addEventListener('focus', recheckRemote);

    map.once('style.load', markStyleReady);
    // style.load приходит раньше, чем догружаются глифы; подписи не должны держать карту закрытой
    const bootPoll = setInterval(() => {
        if (mapReady) { clearInterval(bootPoll); return; }
        if (!styleReady && map.isStyleLoaded()) markStyleReady();
    }, 200);
    setTimeout(() => clearInterval(bootPoll), 20000);
})();
