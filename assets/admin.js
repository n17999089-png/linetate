/* LINESTATE — редактор карты: логика */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const { store, esc, toast, t } = LT;
    const EMPTY_FC = { type: 'FeatureCollection', features: [] };

    // опубліковані дані (data/map.json) вантажимо одразу, паралельно зі стилем мапи:
    // без цього редактор на чистому браузері бачить порожню карту
    const remoteReady = store.loadRemoteData('../data/map.json');

    const state = {
        date: null,
        layers: {},
        activeId: null,
        mode: 'draw',
        ghost: false,
        base: 'hybrid',
        overlays: { regions: true }
    };

    let map = null;
    let mapReady = false;
    let mounted = new Set();
    let drawing = null;
    let undoStack = [];
    let saveTimer = null;
    let savePending = false;
    let playTimer = null;
    let cal = null;
    let cityMarkers = [];
    let searchMarker = null;
    let searchPick = null;
    let searchRows = [];
    let searchActive = -1;
    let fx = null;
    let pxLabels = null;
    let blend = null;
    let objects = null;
    let mapTools = null;
    const shownFC = new Map();
    let statusKey = 'ready';

    /* ============================ СЛОИ ============================ */

    const PATTERNS = ['none', 'hatch', 'diag', 'grid', 'dots', 'cross', 'bricks', 'waves', 'hazard'];
    const BORDERS = ['solid', 'dashed', 'glow', 'none'];
    const ANIMS = ['none', 'pulse', 'flow', 'march'];

    const STYLE_PRESETS = {
        front: { color: '#ff5151', bcol: '#ffd0d0', alpha: .32, bw: 1.5, pattern: 'none', border: 'dashed', anim: 'none', glow: 40 },
        rear: { color: '#4f7bb8', bcol: '#dbe8ff', alpha: .28, bw: 1.5, pattern: 'hatch', border: 'solid', anim: 'none', glow: 30 },
        cauldron: { color: '#9a5bd6', bcol: '#e2cbff', alpha: .38, bw: 2, pattern: 'cross', border: 'glow', anim: 'pulse', glow: 80 },
        strike: { color: '#ff8a3d', bcol: '#ffd9b8', alpha: .5, bw: 2, pattern: 'hazard', border: 'glow', anim: 'flow', glow: 90 },
        water: { color: '#2fb6c9', bcol: '#bff4ff', alpha: .3, bw: 1, pattern: 'waves', border: 'solid', anim: 'none', glow: 25 },
        rad: { color: '#57e06b', bcol: '#ccffd4', alpha: .3, bw: 2, pattern: 'diag', border: 'glow', anim: 'march', glow: 70 }
    };

    function emptyLayer(id, name, kind, z) {
        const arrow = kind === 'arrow';
        return {
            id, name, kind, z,
            desc: '',
            imported: false,
            image: '',
            imageRatio: 1,
            style: {
                color: arrow ? '#ff5151' : '#4f7bb8',
                bcol: arrow ? '#ff5d5d' : '#dbe8ff',
                bw: arrow ? 1 : 1.5,
                alpha: kind === 'point' || kind === 'image' ? 1 : arrow ? .8 : .35,
                markerSize: kind === 'image' ? 96 : 40,
                markerIcon: 'dot',
                shadow: true,
                visible: true,
                maskTarget: '',
                maskTargets: [],
                hard: false,
                    water: false,
                blend: 'normal',
                grad: false,
                gcol: '#04101c',
                gdir: 90,
                pattern: 'none',
                patternScale: 22,
                border: 'solid',
                anim: 'none',
                glow: 60,
                iglow: 0,
                igcol: arrow ? '#ff8a8a' : '#ffffff',
                label: false,
                labelSize: 12,
                labelColor: '#e8eef5',
                labelText: '',
                labelPos: null,
                widthKm: 8,
                headRatio: 2.6,
                d3: arrow,
                depth: 1.6,
                taper: 0.16,
                headW: 0.95
            },
            data: { type: 'FeatureCollection', features: [] }
        };
    }

    function defaultLayers() {
        const l = emptyLayer('front', t('layer.front'), 'zone', 1);
        return { front: l };
    }

    function normalize(src) {
        const out = {};
        Object.keys(src).forEach((id, i) => {
            const l = src[id] || {};
            const s = l.style || {};
            const kind = ['arrow', 'point', 'image'].includes(l.kind) ? l.kind : 'zone';
            const anim = ANIMS.indexOf(s.anim) >= 0 ? s.anim : (s.anim ? 'pulse' : 'none');
            out[id] = {
                id,
                name: typeof l.name === 'string' && l.name ? l.name : id,
                desc: typeof l.desc === 'string' ? l.desc : '',
                imported: l.imported === true,
                image: LT.validImage(l.image),
                imageRatio: Number.isFinite(l.imageRatio) ? Math.max(0.1, Math.min(10, l.imageRatio)) : 1,
                kind,
                z: Number.isFinite(l.z) ? l.z : i,
                style: {
                    color: typeof s.color === 'string' ? s.color : '#4f7bb8',
                    bcol: typeof s.bcol === 'string' ? s.bcol : '#dbe8ff',
                    bw: Number.isFinite(s.bw) ? s.bw : 1.5,
                    alpha: Number.isFinite(s.alpha) ? s.alpha : .35,
                    visible: s.visible !== false,
                    markerSize: Number.isFinite(s.markerSize) ? Math.max(24, Math.min(200, s.markerSize)) : (kind === 'image' ? 96 : 40),
                    markerIcon: ['dot', 'diamond', 'cross', 'flag'].includes(s.markerIcon) ? s.markerIcon : 'dot',
                    shadow: s.shadow !== false,
                    maskTarget: typeof s.maskTarget === 'string' ? s.maskTarget : '',
                    maskTargets: Array.isArray(s.maskTargets)
                        ? s.maskTargets.filter(x => typeof x === 'string' && x && src[x])
                        : [],
                    hard: s.hard === true,
                    water: s.water === true,
                    blend: LT.BLENDS.indexOf(s.blend) >= 0 ? s.blend : 'normal',
                    grad: s.grad === true,
                    gcol: typeof s.gcol === 'string' ? s.gcol : '#04101c',
                    gdir: Number.isFinite(s.gdir) ? Math.min(360, Math.max(0, s.gdir)) : 90,
                    pattern: PATTERNS.indexOf(s.pattern) >= 0 ? s.pattern : 'none',
                    patternScale: Number.isFinite(s.patternScale) ? Math.min(60, Math.max(8, s.patternScale)) : 22,
                    border: BORDERS.indexOf(s.border) >= 0 ? s.border : 'solid',
                    anim,
                    glow: Number.isFinite(s.glow) ? Math.min(100, Math.max(0, s.glow)) : 60,
                    iglow: Number.isFinite(s.iglow) ? Math.min(100, Math.max(0, s.iglow)) : 0,
                    igcol: typeof s.igcol === 'string' ? s.igcol : '#ffffff',
                    label: s.label === true,
                    labelSize: Number.isFinite(s.labelSize) ? Math.min(28, Math.max(8, s.labelSize)) : 12,
                    labelColor: typeof s.labelColor === 'string' ? s.labelColor : '#e8eef5',
                    labelText: typeof s.labelText === 'string' ? s.labelText : '',
                    labelPos: Array.isArray(s.labelPos) && s.labelPos.length === 2 && Number.isFinite(+s.labelPos[0]) && Number.isFinite(+s.labelPos[1])
                        ? [+s.labelPos[0], +s.labelPos[1]] : null,
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

    function nextZoneNumber() {
        let max = 0;
        Object.values(state.layers).forEach(l => {
            if (l.kind !== 'zone') return;
            const m = /(\d+)\s*$/.exec(l.name || '');
            if (m) max = Math.max(max, +m[1]);
        });
        return max + 1;
    }

    function makeLayer(kind, name) {
        const z = Object.values(state.layers).reduce((m, l) => Math.max(m, l.z), 0) + 1;
        const id = kind + '_' + Math.random().toString(36).slice(2, 7);
        const defaultName = kind === 'point' ? t('layer.point', { n: Object.values(state.layers).filter(l => l.kind === 'point').length + 1 }) : kind === 'image' ? t('layer.image') : kind === 'arrow' ? t('layer.offensive') : t('layer.zone', { n: nextZoneNumber() });
        const l = emptyLayer(id, name || defaultName, kind, z);
        state.layers[id] = l;
        return l;
    }

    function layerFor(kind) {
        const cur = state.layers[state.activeId];
        if (cur && cur.kind === kind) return cur;
        const l = makeLayer(kind, kind === 'arrow' ? t('layer.offensive') : t('layer.zone', { n: nextZoneNumber() }));
        state.activeId = l.id;
        syncMapLayers();
        uiLayers();
        uiStyle();
        return l;
    }

    /* ============================ ДАННЫЕ ============================ */

    function maskIds(l) {
        const ids = [];
        const push = v => { if (typeof v === 'string' && v && v !== l.id && state.layers[v] && ids.indexOf(v) < 0) ids.push(v); };
        if (Array.isArray(l.style.maskTargets)) l.style.maskTargets.forEach(push);
        push(l.style.maskTarget);
        return ids;
    }

    function dropMaskRefs(ids) {
        Object.values(state.layers).forEach(l => {
            if (Array.isArray(l.style.maskTargets)) {
                l.style.maskTargets = l.style.maskTargets.filter(id => ids.indexOf(id) < 0);
            }
            if (ids.indexOf(l.style.maskTarget) >= 0) l.style.maskTarget = '';
        });
    }

    function displayFC(l) {
        if (LT.isObject(l)) return l.data;
        const ids = maskIds(l);
        if (!ids.length) return l.data;
        if (!l.data.features.length) return EMPTY_FC;

        const masks = [];
        ids.forEach(id => state.layers[id].data.features.forEach(f => masks.push(f)));
        if (!masks.length) return EMPTY_FC;

        const out = [];
        l.data.features.forEach(f => {
            masks.forEach(mf => {
                try {
                    const r = turf.intersect(f, mf);
                    if (r && r.geometry && r.geometry.coordinates.length) out.push(r);
                } catch (e) { }
            });
        });
        return { type: 'FeatureCollection', features: out };
    }

    function areaKm2(feature) {
        try { return turf.area(feature) / 1e6; } catch (e) { return 0; }
    }

    /* ============================ КАРТА ============================ */

    function addTemp() {
        if (!map.getSource('temp-draw')) {
            map.addSource('temp-draw', { type: 'geojson', data: EMPTY_FC });
            map.addLayer({
                id: 'temp-draw-line', type: 'line', source: 'temp-draw',
                paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.5] }
            });
        }
    }

    function addGhostSource() {
        if (!map.getSource('ghost')) {
            map.addSource('ghost', { type: 'geojson', data: EMPTY_FC });
            map.addLayer({
                id: 'ghost-line', type: 'line', source: 'ghost',
                paint: { 'line-color': '#a7b4c1', 'line-width': 1.2, 'line-dasharray': [3, 2], 'line-opacity': .5 },
                layout: { visibility: 'none' }
            });
        }
    }

    function applyLayer(l) {
        objects.sync(l, displayFC(l), l.style.visible);
        const src = map.getSource('s_' + l.id);
        if (!src) return;
        const fc = displayFC(l);
        shownFC.set(l.id, fc);
        src.setData(l.kind === 'zone' ? LT.rewindFC(fc) : fc);
        LT.applyLayerPaint(map, l, l.style.visible);
        LT.syncLayerDecor(map, l, fc, l.style.visible);
        if (blend) blend.draw();
    }

    function restack() {
        if (!mapReady) return;
        LT.orderLayerObjects(map, state.layers);
        ['lt-flow-halo', 'lt-flow-dot', 'search-fill', 'search-glow', 'search-line'].forEach(id => {
            if (map.getLayer(id)) map.moveLayer(id);
        });
        if (map.getLayer('ghost-line')) map.moveLayer('ghost-line');
        if (map.getLayer('temp-draw-line')) map.moveLayer('temp-draw-line');
        if (map.getLayer('lt-adv-fill')) map.moveLayer('lt-adv-fill');
        if (map.getLayer('lt-adv-line')) map.moveLayer('lt-adv-line');
        if (map.getLayer('lt-places-label')) map.moveLayer('lt-places-label');
        if (blend) blend.sync();
    }

    function refreshData() {
        if (!mapReady) return;
        Object.values(state.layers).forEach(applyLayer);
        restack();
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
        addTemp();
        addGhostSource();
        LT.ensureFlow(map);
        syncMapLayers();
        refreshGhost();
        ensureSearch();
        refreshSearch();
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        if (mapTools) { mapTools.refresh(); mapTools.setRegions(state.overlays.regions); }
        restack();
        if (blend) blend.sync();
    }

    /* ============================ РИСОВАНИЕ ============================ */

    function tempColor() {
        if (state.mode === 'erase') return '#ff5151';
        if (state.mode === 'arrow') {
            const l = state.layers[state.activeId];
            return l && l.kind === 'arrow' ? l.style.color : '#ff5151';
        }
        return '#ffffff';
    }

    function updateTemp() {
        const src = map.getSource('temp-draw');
        if (!src) return;
        src.setData(drawing && drawing.length > 1 ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: drawing } }]
        } : EMPTY_FC);
        map.setPaintProperty('temp-draw-line', 'line-color', tempColor());
    }

    function onDown(e) {
        if (state.mode === 'drag' || state.mode === 'point') return;
        if (e.originalEvent && e.originalEvent.target.closest('.lt-map-pin, .lt-map-image')) return;
        const oe = e.originalEvent || {};
        if (typeof oe.button === 'number' && oe.button !== 0) return;

        drawing = [[e.lngLat.lng, e.lngLat.lat]];
        document.body.classList.add('drawing');
        updateTemp();
    }

    function onMove(e) {
        if (!drawing) return;
        const p = [e.lngLat.lng, e.lngLat.lat];
        const last = drawing[drawing.length - 1];
        const step = state.mode === 'arrow' ? 0.0016 : 0.0011;
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < step) return;
        drawing.push(p);
        updateTemp();
    }

    function onUp() {
        if (drawing) finishDraw();
    }

    /* ---------------------------- суша ---------------------------- */

    const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json';
    let landParts = [];
    let landPromise = null;

    function ringBox(rings) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        rings.forEach(ring => ring.forEach(p => {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
        }));
        return [x0, y0, x1, y1];
    }

    function loadLand() {
        if (landPromise) return landPromise;
        landPromise = fetch(LAND_URL)
            .then(r => {
                if (!r.ok) throw new Error('land ' + r.status);
                return r.json();
            })
            .then(topo => {
                const fc = topojson.feature(topo, topo.objects.land);
                const land = fc.type === 'FeatureCollection' ? fc.features[0] : fc;
                if (!land || !land.geometry) throw new Error('land empty');
                const polys = land.geometry.type === 'MultiPolygon' ? land.geometry.coordinates : [land.geometry.coordinates];
                landParts = polys.map(coords => ({ coords, box: ringBox(coords) }));
                return landParts.length > 0;
            })
            .catch(() => null);
        return landPromise;
    }

    async function clipToLand(shape) {
        if (!landParts.length) await loadLand();
        if (!landParts.length) return shape;

        let out;
        try {
            const b = turf.bbox(shape);
            const pad = Math.max(0.02, Math.min(2, (b[2] - b[0]) * 0.2, (b[3] - b[1]) * 0.2));
            const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
            const picked = [];
            landParts.forEach(p => {
                if (p.box[2] < box[0] || p.box[0] > box[2] || p.box[3] < box[1] || p.box[1] > box[3]) return;
                picked.push(p.coords);
            });
            if (!picked.length) return null;
            out = turf.intersect(shape, turf.multiPolygon(picked));
        } catch (e) {
            return shape;
        }

        if (!out || !out.geometry || !(out.geometry.coordinates || []).length) return null;
        return out;
    }

    async function finishDraw() {
        const path = drawing;
        drawing = null;
        document.body.classList.remove('drawing');
        updateTemp();
        if (!path || path.length < 2) return;

        if (state.mode === 'arrow') {
            if (path.length < 3) { toast(t('toast.tooShort'), 'err'); return; }
            addArrow(path);
            return;
        }

        if (path.length < 3) { toast(t('toast.tooSmall'), 'err'); return; }

        let shape;
        try { shape = turf.polygon([path.concat([path[0]])]); } catch (e) { toast(t('toast.badShape'), 'err'); return; }
        if (areaKm2(shape) < 0.05) { toast(t('toast.tooSmall'), 'err'); return; }

        if (state.mode === 'erase') { eraseShape(shape); return; }

        const cur = currentLayer();
        const onWater = !!(cur && cur.kind === 'zone' && cur.style.water);
        const land = onWater ? shape : await clipToLand(shape);
        if (!land) { toast(t('toast.landOnly'), 'err'); return; }
        if (areaKm2(land) < 0.05) { toast(t('toast.tooSmall'), 'err'); return; }
        addZone(land);
    }

    /* ---------------------------- границы слоёв ---------------------------- */

    function boxesHit(a, b) {
        try {
            const x = turf.bbox(a);
            const y = turf.bbox(b);
            return !(x[2] < y[0] || x[0] > y[2] || x[3] < y[1] || x[1] > y[3]);
        } catch (e) { return true; }
    }

    function hardBlockers(excludeId) {
        const parts = [];
        Object.values(state.layers).forEach(o => {
            if (o.id === excludeId || o.kind !== 'zone' || !o.style.hard) return;
            o.data.features.forEach(f => parts.push(f));
        });
        if (!parts.length) return null;
        let u = parts[0];
        for (let i = 1; i < parts.length && u; i++) {
            try { u = turf.union(u, parts[i]); } catch (e) { return null; }
        }
        return u && u.geometry ? u : null;
    }

    function blockerName(shape, excludeId) {
        let hit = '';
        Object.values(state.layers).some(o => {
            if (o.id === excludeId || o.kind !== 'zone' || !o.style.hard) return false;
            const found = o.data.features.some(f => {
                try { return turf.booleanIntersects(shape, f); } catch (e) { return false; }
            });
            if (found) { hit = o.name; return true; }
            return false;
        });
        return hit;
    }

    function eraseUnder(drawn, self) {
        Object.values(state.layers).forEach(o => {
            if (o.id === self.id || o.kind !== 'zone' || o.style.hard) return;
            if (o.z >= self.z || !o.data.features.length) return;

            const out = [];
            let changed = false;
            o.data.features.forEach(f => {
                if (!boxesHit(f, drawn)) { out.push(f); return; }
                try {
                    const d = turf.difference(f, drawn);
                    if (!d || !d.geometry || !d.geometry.coordinates || !d.geometry.coordinates.length || areaKm2(d) < 0.02) {
                        changed = true;
                        return;
                    }
                    out.push(d);
                    changed = true;
                } catch (e) { out.push(f); }
            });
            if (changed) o.data.features = out;
        });
    }

    function addZone(shape) {
        const cur = state.layers[state.activeId];
        const selfId = cur && cur.kind === 'zone' ? cur.id : '';

        let drawn = shape;
        const blockers = hardBlockers(selfId);
        if (blockers) {
            let cut = null;
            try { cut = turf.difference(shape, blockers); } catch (e) { cut = shape; }
            if (!cut || !cut.geometry || !(cut.geometry.coordinates || []).length || areaKm2(cut) < 0.05) {
                const name = blockerName(shape, selfId);
                toast(name ? t('toast.hardBlock', { name }) : t('toast.hardBlockNoName'), 'err');
                return;
            }
            drawn = cut;
        }

        pushUndo();
        const l = layerFor('zone');

        if (!l.data.features.length) {
            l.data.features.push(drawn);
        } else {
            let merged = null;
            try {
                const all = l.data.features.concat([drawn]);
                merged = all[0];
                for (let i = 1; i < all.length && merged; i++) merged = turf.union(merged, all[i]);
            } catch (e) { merged = null; }
            if (merged && merged.geometry) l.data.features = [merged];
            else l.data.features.push(drawn);
        }

        eraseUnder(drawn, l);

        state.activeId = l.id;
        commit();
    }

    function addArrow(path) {
        const l = layerFor('arrow');
        const clean = LT.cleanPath(path);
        if (clean.length < 2) { toast(t('toast.tooShort'), 'err'); return; }

        const geom = LT.buildArrow(clean, l.style.widthKm, l.style.headRatio, { taper: l.style.taper, headW: l.style.headW });
        if (!geom) { toast(t('toast.arrowFail'), 'err'); return; }

        pushUndo();
        l.data.features.push({
            type: 'Feature',
            properties: {
                kind: 'arrow', path: clean, widthKm: l.style.widthKm, headRatio: l.style.headRatio,
                taper: l.style.taper, headW: l.style.headW
            },
            geometry: geom
        });
        state.activeId = l.id;
        commit();
    }

    function eraseShape(shape) {
        const l = currentLayer();
        if (!l) { toast(t('toast.noLayer'), 'err'); return; }

        pushUndo();
        let touched = 0;

        if (l.kind === 'arrow') {
            const before = l.data.features.length;
            l.data.features = l.data.features.filter(f => {
                try { return !turf.booleanIntersects(f, shape); } catch (e) { return true; }
            });
            touched = before - l.data.features.length;
        } else {
            const out = [];
            l.data.features.forEach(f => {
                try {
                    const d = turf.difference(f, shape);
                    if (d && d.geometry && d.geometry.coordinates.length) out.push(d);
                    else touched++;
                } catch (e) { out.push(f); }
            });
            l.data.features = out;
        }

        commit();
        if (!touched) toast(t('toast.nothingErase', { name: l.name }));
    }

    function rebuildArrows(l) {
        l.data.features = l.data.features.map(f => {
            const p = f.properties && f.properties.path;
            if (!p) return f;
            const g = LT.buildArrow(p, l.style.widthKm, l.style.headRatio, { taper: l.style.taper, headW: l.style.headW });
            if (!g) return f;
            return {
                type: 'Feature',
                properties: Object.assign({}, f.properties, {
                    widthKm: l.style.widthKm, headRatio: l.style.headRatio,
                    taper: l.style.taper, headW: l.style.headW
                }),
                geometry: g
            };
        });
    }

    /* ============================ СОХРАНЕНИЕ ============================ */

    function setStatus(key) {
        statusKey = key;
        const el = $('save-status');
        const kind = key === 'saved' ? 'saved' : key === 'draft' ? 'draft' : 'off';
        el.className = 'status ' + kind;
        el.textContent = t('status.' + key);
    }

    function commit() {
        syncMapLayers();
        uiLayers();
        uiStyle();
        autoSave();
    }

    function autoSave() {
        clearTimeout(saveTimer);
        savePending = true;
        setStatus('draft');
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                store.save(state.date, state.layers);
                savePending = false;
                setStatus('saved');
                uiUsage();
                if (cal) cal.refresh();
            } catch (e) {
                savePending = false;
                setStatus('error');
                toast(e.message, 'err');
            }
        }, 350);
    }

    function flushSave() {
        if (!saveTimer) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        try { store.save(state.date, state.layers); savePending = false; } catch (e) { }
    }

    function pushUndo() {
        undoStack.push(JSON.stringify(state.layers));
        if (undoStack.length > 40) undoStack.shift();
    }

    function undo() {
        if (!undoStack.length) { toast(t('toast.nothingUndo')); return; }
        state.layers = normalize(JSON.parse(undoStack.pop()));
        if (!state.layers[state.activeId]) state.activeId = Object.keys(state.layers)[0] || null;
        syncMapLayers();
        uiLayers();
        uiStyle();
        autoSave();
    }

    /* ============================ ДАТЫ ============================ */

    function initialDate() {
        const saved = store.lastDate();
        if (saved) return saved;
        const list = store.listDates();
        if (!list.length) return LT.todayIso();
        let best = list[0];
        list.forEach(d => { if (d.updatedAt >= best.updatedAt) best = d; });
        return best.date;
    }

    function loadDate(iso) {
        state.date = iso;
        store.setLastDate(iso);
        const doc = store.load(iso);
        const has = !!(doc && doc.layers && Object.keys(doc.layers).length);
        state.layers = has ? normalize(doc.layers) : defaultLayers();
        state.activeId = Object.keys(state.layers)[0] || null;
        undoStack = [];
        shownFC.clear();

        syncMapLayers();
        refreshGhost();
        uiLayers();
        uiStyle();
        uiDate();
        setStatus(has ? 'saved' : 'newDate');
        uiUsage();
        if (cal) cal.refresh();
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
        if (iso < LT.MIN_DATE) iso = LT.MIN_DATE;
        if (iso === state.date) return;
        const dir = iso > state.date ? 1 : -1;
        flushSave();
        loadDate(iso);
        pulseDate(dir);
    }

    function shiftDate(delta) {
        const d = LT.fromIso(state.date);
        d.setDate(d.getDate() + delta);
        switchDate(LT.isoOf(d));
    }

    function copyToDay(delta) {
        flushSave();
        const d = LT.fromIso(state.date);
        d.setDate(d.getDate() + delta);
        const iso = LT.isoOf(d);
        if (iso < LT.MIN_DATE) return;

        const doc = store.load(iso);
        const has = !!(doc && doc.layers && Object.values(doc.layers)
            .some(l => l && l.data && Array.isArray(l.data.features) && l.data.features.length));
        if (has && !confirm(t('confirm.replaceDate', { date: LT.fmtFull(iso) }))) return;

        try {
            store.save(iso, LT.clone(state.layers));
        } catch (e) {
            toast(e.message, 'err');
            return;
        }

        switchDate(iso);
        toast(t('toast.copied', { date: LT.fmtTrigger(iso) }));
    }

    function deleteCurrentMap() {
        if (!confirm(t('confirm.deleteMap', { date: LT.fmtFull(state.date) }))) return;

        clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
        store.remove(state.date);

        loadDate(state.date);
        toast(t('toast.mapDeleted'));
    }

    function deleteAllMaps() {
        const dates = store.listDates();
        if (!dates.length) { toast(t('toast.noDates'), 'err'); return; }
        if (!confirm(t('confirm.deleteAll', { n: dates.length }))) return;

        clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
        const n = store.removeAll();

        loadDate(state.date);
        if (cal) cal.refresh();
        toast(t('toast.allDeleted', { n }));
    }

    function uiDate() {
        $('date-trigger').textContent = LT.fmtTrigger(state.date);
        document.title = t('app.editorTitle') + ' — ' + LT.fmtFull(state.date);
        $('prev-date').disabled = state.date <= LT.MIN_DATE;
        $('next-date').disabled = false;
    }

    function togglePlay() {
        const btn = $('play-btn');
        if (playTimer) {
            clearInterval(playTimer);
            playTimer = null;
            btn.classList.remove('active');
            btn.textContent = t('viewer.play');
            return;
        }
        const dates = store.listDates().map(d => d.date);
        const list = dates.length ? dates : [state.date];
        if (list.length < 2) { toast(t('toast.needTwo'), 'err'); return; }

        let i = Math.max(0, list.indexOf(state.date));
        btn.classList.add('active');
        btn.textContent = t('viewer.stop');
        playTimer = setInterval(() => {
            i = (i + 1) % list.length;
            switchDate(list[i]);
        }, 1500);
    }

    /* ============================ GHOST ============================ */

    function refreshGhost() {
        if (!mapReady) return;
        addGhostSource();

        const prev = store.listDates().map(d => d.date).filter(d => d < state.date).pop();
        let features = [];
        if (prev) {
            const doc = store.load(prev);
            if (doc && doc.layers) {
                Object.values(doc.layers).forEach(l => {
                    const fs = l && l.data && Array.isArray(l.data.features) ? l.data.features : [];
                    fs.forEach(f => features.push(f));
                });
            }
        }

        const src = map.getSource('ghost');
        if (!src) return;
        src.setData({ type: 'FeatureCollection', features });
        map.setLayoutProperty('ghost-line', 'visibility', state.ghost && features.length ? 'visible' : 'none');
        if (state.ghost) map.moveLayer('ghost-line');
    }

    function toggleGhost() {
        state.ghost = !state.ghost;
        const b = $('btn-ghost');
        b.classList.toggle('active', state.ghost);
        b.textContent = t(state.ghost ? 'fx.ghostOn' : 'fx.ghostOff');
        refreshGhost();
    }

    /* ============================ ИНТЕРФЕЙС ============================ */

    function setMode(m) {
        state.mode = m;
        document.querySelectorAll('.dock-btn[data-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === m);
        });
        if (m === 'drag') map.dragPan.enable();
        else map.dragPan.disable();
        document.body.classList.toggle('drawing', m !== 'drag');
    }

    function syncGeoDelete() {
        const n = Object.values(state.layers).filter(l => l && l.imported).length;
        ['btn-del-geo', 'btn-del-imported'].forEach(id => {
            const b = $(id);
            if (!b) return;
            b.disabled = n === 0;
            b.textContent = t('file.delImported') + (n ? ' (' + n + ')' : '');
        });
    }

    function uiLayers() {
        const box = $('layer-list');
        const list = Object.values(state.layers).sort((a, b) => b.z - a.z);
        syncGeoDelete();

        if (!list.length) {
            box.innerHTML = '<div class="hint">' + t('admin.noLayers') + '</div>';
            return;
        }

        box.innerHTML = list.map(l => {
            const n = l.data.features.length;
            const meta = l.kind === 'arrow' ? (n ? n + ' ' + t('admin.featArrow') : t('admin.emptyWord')) : (n ? n + ' ' + t('admin.featZone') : t('admin.emptyWord'));
            const fx = l.style.anim !== 'none' ? ' · ' + l.style.anim.toUpperCase() : '';
            const hard = l.style.hard ? ' · ' + t('admin.hardMark') : '';
            const bm = l.style.blend !== 'normal' ? ' · ' + t('blend.' + (l.style.blend === 'soft-light' ? 'softlight' : l.style.blend)).toUpperCase() : '';
            const gr = l.style.grad ? ' · GRAD' : '';
            const geo = l.imported ? ' · GEO' : '';
            const desc = (l.desc || '').trim();
            return `<div class="layer ${l.id === state.activeId ? 'active' : ''}" data-id="${esc(l.id)}" title="${esc(desc || l.name)}">
                <span class="sw ${l.kind === 'arrow' ? 'arrow' : ''}" style="background:${esc(l.style.color)};opacity:${l.style.visible ? 1 : .25};box-shadow:0 0 9px ${esc(l.style.color)}88"></span>
                <span class="nm">${esc(l.name)}</span>
                <span class="meta">${meta}${fx}${hard}${bm}${gr}${geo}</span>
                <button class="act" data-act="up" title="${t('admin.up')}">▲</button>
                <button class="act" data-act="dn" title="${t('admin.down')}">▼</button>
                <button class="act" data-act="mrg" title="${t('admin.merge')}">⇧</button>
                <button class="act" data-act="vis" title="${t('admin.visibility')}">${l.style.visible ? '◉' : '○'}</button>
                <button class="act del" data-act="del" title="${t('admin.delete')}">✕</button>
            </div>`;
        }).join('');
    }

    function currentLayer() {
        return state.layers[state.activeId] || null;
    }

    function moveLayerZ(l, dir) {
        const list = Object.values(state.layers).sort((a, b) => a.z - b.z);
        const i = list.indexOf(l);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        pushUndo();
        const t = l.z;
        l.z = list[j].z;
        list[j].z = t;
        list.sort((a, b) => a.z - b.z).forEach((x, k) => { x.z = k; });
        restack();
        uiLayers();
        autoSave();
    }

    // слияние слоя с соседним сверху: геометрия и маски переезжают, стиль — у цели
    function mergeLayerUp(id) {
        const src = state.layers[id];
        if (!src) return;
        if (!src.data.features.length) { toast(t('admin.mergeEmpty'), 'err'); return; }
        if (src.kind !== 'zone' && src.kind !== 'arrow') { toast(t('admin.mergeKind'), 'err'); return; }

        const above = Object.values(state.layers)
            .filter(o => o.kind === src.kind && o.id !== src.id && o.z > src.z)
            .sort((a, b) => a.z - b.z)[0];
        if (!above) { toast(t('admin.mergeNone'), 'err'); return; }

        pushUndo();
        above.data.features = above.data.features.concat(src.data.features);

        const masks = maskIds(above).concat(maskIds(src)).filter(x => x !== above.id);
        above.style.maskTargets = Array.from(new Set(masks));
        above.style.maskTarget = '';
        if (src.style.hard) above.style.hard = true;

        delete state.layers[src.id];
        dropMaskRefs([src.id]);
        if (state.activeId === src.id) state.activeId = above.id;

        if (above.kind === 'arrow') rebuildArrows(above);
        syncMapLayers();
        applyLayer(above);
        restack();
        uiLayers();
        uiStyle();
        autoSave();
        toast(t('admin.merged', { name: above.name }));
    }

    // без лінії немає чому світитися: повзуни силы світіння й внутрішнього
    // світла живуть саме на контурі, тому з «без контуру» їх вимикаємо
    function syncBorderFields(l) {
        const off = l.style.border === 'none';
        $('f-glow').disabled = off;
        $('f-iglow').disabled = off;
    }

    function uiStyle() {
        const l = currentLayer();
        const body = $('style-body');
        const empty = $('style-empty');

        if (!l) {
            body.style.display = 'none';
            empty.style.display = 'block';
            return;
        }
        body.style.display = 'flex';
        empty.style.display = 'none';

        $('f-name').value = l.name;
        $('f-desc').value = l.desc || '';
        $('f-color').value = l.style.color;
        $('f-bcol').value = l.style.bcol;
        $('f-alpha').value = l.style.alpha;
        $('f-bw').value = l.style.bw;

        const ids = maskIds(l);
        $('mask-list').innerHTML = Object.values(state.layers)
            .filter(o => o.kind === 'zone' && o.id !== l.id)
            .map(o => `<button type="button" data-mask="${esc(o.id)}" class="${ids.indexOf(o.id) >= 0 ? 'on' : ''}">${esc(o.name)}</button>`)
            .join('') || `<span class="hint">${t('style.noMasks')}</span>`;

        $('f-hard').value = l.style.hard ? '1' : '0';
        $('f-hard').disabled = l.kind === 'arrow';
        $('f-water').value = l.style.water ? '1' : '0';
        $('f-water').disabled = l.kind === 'arrow';

        const arrowBlock = $('arrow-block');
        arrowBlock.classList.toggle('on', l.kind === 'arrow');
        $('f-width').value = l.style.widthKm;
        $('f-head').value = l.style.headRatio;
        $('f-d3').value = l.style.d3 ? '1' : '0';
        $('f-depth').value = l.style.depth;
        $('f-taper').value = l.style.taper;
        $('f-headw').value = l.style.headW;
        $('f-depth').disabled = !l.style.d3;
        $('f-taper').disabled = !l.style.d3;
        $('f-headw').disabled = !l.style.d3;

        $('f-blend').value = l.style.blend;
        $('f-grad').checked = l.style.grad === true;
        $('f-gcol').value = l.style.gcol || '#04101c';
        $('f-gdir').value = l.style.gdir == null ? 90 : l.style.gdir;
        $('f-gcol').disabled = !l.style.grad;
        $('f-gdir').disabled = !l.style.grad;
        $('f-pattern').value = l.style.pattern;
        $('f-pscale').value = l.style.patternScale;
        $('f-pscale').disabled = l.style.pattern === 'none';
        $('f-border').value = l.style.border;
        syncBorderFields(l);
        $('f-glow').value = l.style.glow;
        $('f-iglow').value = l.style.iglow || 0;
        $('f-igcol').value = l.style.igcol || '#ffffff';
        $('f-anim').value = l.style.anim;
        $('f-label').value = l.style.label ? '1' : '0';
        $('f-labeltext').value = l.style.labelText || '';
        $('f-lsize').value = l.style.labelSize;
        $('f-lcolor').value = l.style.labelColor;
        $('f-labeltext').disabled = !l.style.label;
        $('f-lsize').disabled = !l.style.label;
        $('f-lcolor').disabled = !l.style.label;
    }

    function applyStylePreset(key) {
        const l = currentLayer();
        const p = STYLE_PRESETS[key];
        if (!l || !p) return;
        Object.keys(p).forEach(k => { l.style[k] = p[k]; });
        applyLayer(l);
        uiStyle();
        uiLayers();
        autoSave();
    }

    /* ---------- копирование и вставка стиля ---------- */

    const STYLE_CLIP_KEY = 'LINETATE:__clip';
    const STYLE_KEYS = [
        'color', 'bcol', 'bw', 'alpha', 'hard', 'water', 'blend',
        'grad', 'gcol', 'gdir',
        'pattern', 'patternScale', 'border', 'anim', 'glow', 'iglow', 'igcol',
        'label', 'labelSize', 'labelColor',
        'widthKm', 'headRatio', 'd3', 'depth', 'taper', 'headW'
    ];

    function clippedStyle() {
        try {
            const raw = localStorage.getItem(STYLE_CLIP_KEY);
            const o = raw ? JSON.parse(raw) : null;
            return o && typeof o === 'object' ? o : null;
        } catch (e) {
            return null;
        }
    }

    function copyStyle() {
        const l = currentLayer();
        if (!l) return;
        const out = {};
        STYLE_KEYS.forEach(k => { if (l.style[k] !== undefined) out[k] = l.style[k]; });
        try { localStorage.setItem(STYLE_CLIP_KEY, JSON.stringify(out)); } catch (e) { }
        syncClipUI();
        toast(t('style.copied'));
    }

    function pasteStyle() {
        const l = currentLayer();
        if (!l) return;
        const src = clippedStyle();
        if (!src) { toast(t('style.pasteEmpty'), 'err'); return; }
        pushUndo();
        STYLE_KEYS.forEach(k => { if (src[k] !== undefined) l.style[k] = src[k]; });
        if (l.kind === 'arrow') rebuildArrows(l);
        applyLayer(l);
        restack();
        uiStyle();
        uiLayers();
        autoSave();
        toast(t('style.pasted'));
    }

    function syncClipUI() {
        const b = $('btn-paste-style');
        if (b) b.classList.toggle('active', !!clippedStyle());
    }

    function selectLayer(id) {
        if (!state.layers[id]) return;
        state.activeId = id;
        const l = state.layers[id];
        if (l.kind === 'arrow' && state.mode === 'draw') setMode('arrow');
        if (l.kind === 'zone' && state.mode === 'arrow') setMode('draw');
        uiLayers();
        uiStyle();
    }

    function selectTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.pane').forEach(p => {
            const on = p.dataset.pane === name;
            p.classList.toggle('active', on);
            p.classList.remove('anim');
            if (on) {
                void p.offsetWidth;
                p.classList.add('anim');
                setTimeout(() => p.classList.remove('anim'), 450);
            }
        });
    }

    const FX_SLIDERS = {
        br: 'fx-br', ct: 'fx-ct', st: 'fx-st', blur: 'fx-blur',
        hue: 'fx-hue', gray: 'fx-gray', sepia: 'fx-sepia', invert: 'fx-invert'
    };
    const FX_PRESETS = {
        base: { br: 100, ct: 100, st: 100, blur: 0, hue: 0, gray: 0, sepia: 0, invert: 0, vig: false, scan: false, grain: false },
        night: { br: 78, ct: 118, st: 55, blur: 0, hue: -8, gray: 0, sepia: 0, invert: 0, vig: true, scan: false, grain: true },
        thermal: { br: 105, ct: 145, st: 10, blur: 0.5, hue: 0, gray: 100, sepia: 0, invert: 100, vig: true, scan: false, grain: true },
        print: { br: 108, ct: 118, st: 0, blur: 0, hue: 0, gray: 100, sepia: 35, invert: 0, vig: false, scan: false, grain: true },
        neon: { br: 104, ct: 135, st: 220, blur: 0, hue: 170, gray: 0, sepia: 0, invert: 0, vig: true, scan: true, grain: false },
        glitch: { br: 110, ct: 170, st: 300, blur: 0, hue: 95, gray: 0, sepia: 0, invert: 0, vig: false, scan: true, grain: true }
    };

    function readFxControls() {
        const out = {};
        Object.keys(FX_SLIDERS).forEach(k => { out[k] = +$(FX_SLIDERS[k]).value; });
        document.querySelectorAll('#fx-film button').forEach(b => { out[b.dataset.film] = b.classList.contains('on'); });
        return out;
    }

    function fxKey(f) {
        const keys = Object.keys(FX_SLIDERS);
        return Object.keys(FX_PRESETS).find(k => {
            const p = FX_PRESETS[k];
            return keys.every(x => p[x] === f[x]) && ['vig', 'scan', 'grain'].every(x => !!p[x] === !!f[x]);
        }) || '';
    }

    function setFx(f, persist) {
        fx = f;
        LT.applyFX(fx);
        if (persist !== false) LT.saveFX(fx);
        syncFxUI();
    }

    function syncFxUI() {
        if (!fx) return;
        Object.keys(FX_SLIDERS).forEach(k => { $(FX_SLIDERS[k]).value = fx[k]; });
        document.querySelectorAll('#fx-film button').forEach(b => b.classList.toggle('on', !!fx[b.dataset.film]));
        const key = fxKey(fx);
        document.querySelectorAll('#fx-presets button').forEach(b => b.classList.toggle('active', b.dataset.fx === key));
    }

    function syncOverlays() {
        syncOverlayUI();
        if (mapTools) {
            mapTools.setRegions(state.overlays.regions);
        }
    }

    function syncOverlayUI() {
        document.querySelectorAll('#ov-seg button').forEach(b => {
            const on = !!state.overlays[b.dataset.ov];
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
    }

    function addCityMarker(lngLat, label) {
        const el = document.createElement('div');
        el.className = 'city-marker';
        el.innerHTML = `<span>${esc(label)}</span><b>×</b>`;
        const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
        el.querySelector('b').addEventListener('click', e => {
            e.stopPropagation();
            marker.remove();
            cityMarkers = cityMarkers.filter(m => m !== marker);
        });
        cityMarkers.push(marker);
        return marker;
    }

    /* ---------- поиск с контуром ---------- */

    const PLACE_TYPES = {
        city: 'place.city', town: 'place.city', village: 'place.village', hamlet: 'place.hamlet',
        isolated_dwelling: 'place.hut', suburb: 'place.suburb', quarter: 'place.quarter',
        municipality: 'place.municipality', county: 'place.county', state: 'place.state',
        province: 'place.state', region: 'place.region', state_district: 'place.district',
        administrative: 'place.administrative', locality: 'place.locality'
    };

    function placeType(res) {
        const dn = String(res.display_name || '').toLowerCase();
        const type = res.addresstype || res.type || '';
        if (type === 'administrative') {
            if (dn.includes('область') || dn.includes('обл.') || dn.includes('oblast')) return t('place.state');
            if (dn.includes('район') || dn.includes('raion') || dn.includes('district')) return t('place.district');
            return t('place.territory');
        }
        if (PLACE_TYPES[type]) return t(PLACE_TYPES[type]);
        if (dn.includes('область')) return t('place.state');
        if (dn.includes('район')) return t('place.district');
        return type ? String(type).toUpperCase() : t('place.object');
    }

    function shortName(res) {
        const first = String(res.display_name || '').split(',')[0].trim();
        return (res.name && String(res.name).trim()) || first || t('place.object');
    }

    function ensureSearch() {
        if (!mapReady || map.getSource('search-area')) return;
        map.addSource('search-area', { type: 'geojson', data: EMPTY_FC });
        map.addLayer({
            id: 'search-fill', type: 'fill', source: 'search-area',
            paint: { 'fill-color': '#ffcf4d', 'fill-opacity': .08 }
        });
        map.addLayer({
            id: 'search-glow', type: 'line', source: 'search-area',
            paint: { 'line-color': '#ffcf4d', 'line-width': 9, 'line-opacity': .5, 'line-blur': 8 }
        });
        map.addLayer({
            id: 'search-line', type: 'line', source: 'search-area',
            paint: { 'line-color': '#fff1b8', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': .95 }
        });
    }

    function refreshSearch() {
        if (!mapReady) return;
        ensureSearch();
        const src = map.getSource('search-area');
        if (!src) return;
        const fs = searchPick && searchPick.feature ? [searchPick.feature] : [];
        src.setData({ type: 'FeatureCollection', features: fs });
        const vis = fs.length ? 'visible' : 'none';
        ['search-fill', 'search-glow', 'search-line'].forEach(id => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
        });
        restack();
    }

    function searchDashLoop() {
        const arr = [[3, 2], [2.6, 2.4], [2.2, 2.8], [1.8, 3.2], [1.4, 3.6], [1.8, 3.2], [2.2, 2.8], [2.6, 2.4]];
        let i = 0;
        setInterval(() => {
            if (!mapReady || !searchPick || !map.getLayer('search-line')) return;
            i = (i + 1) % arr.length;
            map.setPaintProperty('search-line', 'line-dasharray', arr[i]);
        }, 150);
    }

    function setSearchMarker(lngLat, label) {
        if (searchMarker) {
            searchMarker.remove();
            cityMarkers = cityMarkers.filter(m => m !== searchMarker);
        }
        searchMarker = addCityMarker(lngLat, label);
    }

    function uiSearchResults() {
        const box = $('search-results');
        if (!searchRows.length) {
            box.innerHTML = '';
            box.classList.remove('show');
            return;
        }
        box.innerHTML = searchRows.map((res, i) => {
            const dn = String(res.display_name || '').split(',').slice(1, 3).join(',').trim();
            return `<button class="sr ${i === searchActive ? 'active' : ''}" data-i="${i}">
                <b>${esc(shortName(res).toUpperCase())}</b>
                <small>${esc(placeType(res))}${dn ? ' · ' + esc(dn) : ''}</small>
            </button>`;
        }).join('');
        box.classList.add('show');
    }

    function pickResult(res, index) {
        searchActive = index;
        searchRows = searchRows.length ? searchRows : [res];

        const geom = res.geojson;
        const feature = geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')
            ? { type: 'Feature', properties: { name: shortName(res) }, geometry: geom }
            : null;

        searchPick = { res, feature, name: shortName(res), label: placeType(res) };
        refreshSearch();

        $('sp-name').textContent = (searchPick.name + ' · ' + searchPick.label).toUpperCase();
        $('sp-add').disabled = !feature;
        $('search-pick').classList.add('show');

        let b = feature ? LT.boundsOf([feature]) : null;
        if (!b && res.boundingbox) {
            b = [+res.boundingbox[2], +res.boundingbox[0], +res.boundingbox[3], +res.boundingbox[1]];
        }
        if (b && b.every(Number.isFinite)) {
            map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 70, duration: 800, maxZoom: 12 });
        }

        if (res.lon && res.lat) setSearchMarker([+res.lon, +res.lat], searchPick.name.toUpperCase());

        document.querySelectorAll('#search-results .sr').forEach(el => {
            el.classList.toggle('active', +el.dataset.i === index);
        });

        if (!feature) toast(t('search.noContour'));
    }

    async function searchCity() {
        const q = $('q').value.trim();
        if (!q) return;
        $('q-go').disabled = true;
        try {
            const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1'
                + '&polygon_geojson=1&accept-language=' + LT.lang() + '&q=' + encodeURIComponent(q);
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
            const rows = await r.json();
            if (!Array.isArray(rows) || !rows.length) {
                searchRows = [];
                searchActive = -1;
                uiSearchResults();
                toast(t('search.notFound'), 'err');
                return;
            }
            searchRows = rows;
            searchActive = 0;
            uiSearchResults();
            pickResult(rows[0], 0);
        } catch (e) {
            toast(t('search.unavailable'), 'err');
        } finally {
            $('q-go').disabled = false;
        }
    }

    function clearSearch() {
        searchPick = null;
        searchActive = -1;
        if (mapReady) {
            const src = map.getSource('search-area');
            if (src) src.setData(EMPTY_FC);
            ['search-fill', 'search-glow', 'search-line'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            });
        }
        $('search-pick').classList.remove('show');
        $('search-results').classList.remove('show');
        $('search-results').innerHTML = '';
        if (searchMarker) {
            searchMarker.remove();
            cityMarkers = cityMarkers.filter(m => m !== searchMarker);
            searchMarker = null;
        }
        searchRows = [];
    }

    function captureSearch() {
        if (!searchPick || !searchPick.feature) { toast(t('search.noFeature'), 'err'); return; }
        let res;
        try {
            res = LT.parseGeoJSON(searchPick.feature);
        } catch (e) {
            toast(e.message || t('search.badContour'), 'err');
            return;
        }
        const name = (searchPick.name || t('search.contour')).toUpperCase().slice(0, 28);
        addGeoLayer(res.features, name);
        toast(t('search.added'));
        clearSearch();
    }

    window.LTUI = { search: searchCity };

    /* ============================ ЭКСПОРТ ============================ */

    function exportGeo() {
        const features = [];
        Object.values(state.layers).forEach(l => {
            l.data.features.forEach(f => features.push({
                type: 'Feature',
                geometry: f.geometry,
                properties: Object.assign({}, f.properties, { layer: l.name, kind: l.kind, color: l.style.color })
            }));
        });
        if (!features.length) { toast(t('toast.noExport'), 'err'); return; }
        LT.download('linestate-' + state.date + '.geojson', JSON.stringify({ type: 'FeatureCollection', features }, null, 1));
    }

    function exportJson() {
        LT.download('linestate-backup-' + LT.todayIso() + '.json', JSON.stringify(store.exportAll(), null, 1));
        toast(t('toast.exported'));
    }

    // файл для GitHub Pages: положить в data/map.json
    async function exportSite() {
        // цей файл часто несуть на GitHub вручну, тому спершу довантажуємо
        // опубліковані дати з сайту — тоді експорт містить усю історію
        try { await store.loadRemoteData('../data/map.json'); } catch (e) { }
        const data = store.exportAll();
        if (!data.maps || !Object.keys(data.maps).length) { toast(t('toast.noExport'), 'err'); return; }
        LT.download('map.json', JSON.stringify(data));
        toast(t('toast.exported') + ' · ' + Object.keys(data.maps).length);
    }

    function uiUsage() {
        const el = $('usage-line');
        if (!el || !store.storageUsage) return;
        const u = store.storageUsage();
        el.textContent = t(u.tier === 'local' ? 'file.usage' : 'file.usageIdb', { kb: u.kb, dates: u.dates });
    }

    function optimizeStorage() {
        flushSave();
        const r = store.optimizeStorage();
        toast(r.freedKB > 8 ? t('file.optimized', { kb: r.freedKB })
            : t('file.optimizedNone', { kb: r.after.kb, dates: r.after.dates }));
        uiUsage();
        if (cal) cal.refresh();
    }

    /* ============================ ПЕРЕГЛЯДИ КАРТИ ============================ */

    // null — спільний лічильник ще не питали, false — він недоступний
    let viewsNet = null;
    let viewsBusy = false;

    function uiViews() {
        const box = $('views-box');
        if (!box || !LT.views) return;
        const v = LT.views.local();
        $('v-local').textContent = String(v.total);
        // коли спільний лічильник мовчить, показуємо останню прочитану суму замість нулів
        $('v-net').textContent = viewsNet === null ? t('views.wait')
            : (viewsNet === false ? (LT.views.cached() ? String(LT.views.cached()) : '—') : String(viewsNet));
        const days = Object.keys(v.days).sort().reverse();
        const rows = [
            [t('views.days'), String(days.length)],
            [t('views.today'), String(v.days[LT.todayIso()] || 0)],
            [t('views.last'), v.last
                ? new Date(v.last).toLocaleString(LT.locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                : t('views.none')]
        ];
        if (viewsNet === false) rows.push([t('views.public'), t('views.offline')]);
        $('v-lines').innerHTML = rows.map(r =>
            '<div class="views-row"><span>' + LT.esc(r[0]) + '</span><b>' + LT.esc(r[1]) + '</b></div>').join('');
        const dl = $('v-days');
        dl.innerHTML = days.length
            ? '<div class="views-days-title">' + LT.esc(t('views.byDay')) + '</div>' + days.slice(0, 10).map(d =>
                '<div class="views-day"><span>' + LT.esc(d) + '</span><b>' + v.days[d] + '</b></div>').join('')
            : '';
    }

    function refreshViews() {
        if (viewsBusy || !LT.views) return;
        viewsBusy = true;
        const btn = $('btn-views-refresh');
        if (btn) btn.disabled = true;
        LT.views.ask('get', 8000).then(val => {
            viewsNet = val === null ? false : val;
            viewsBusy = false;
            if (btn) btn.disabled = false;
            uiViews();
        });
    }

    /* ============================ ПУБЛІКАЦІЯ НА GITHUB ============================ */
    const GH_CFG = 'LINETATE:__gh';
    const GH_TOKEN = 'LINETATE:__ghtok';
    const GH_TOKEN_DEV = 'LINETATE:__ghtokd';
    const GH_VAULT = 'linetate-device-vault';
    const GH_DEFAULT = { repo: 'n17999089-png/linetate', branch: 'main', path: 'data/map.json' };

    function ghCfg() {
        let cfg;
        try { cfg = Object.assign({}, GH_DEFAULT, JSON.parse(sessionStorage.getItem(GH_CFG) || localStorage.getItem(GH_CFG) || '{}')); }
        catch (e) { cfg = Object.assign({}, GH_DEFAULT); }
        // репозиторій перейменовано — стара назва в пам'яті браузера більше не існує
        if (/^n17999089-png\/linestate-map$/i.test(cfg.repo)) {
            cfg.repo = GH_DEFAULT.repo;
            ghSaveCfg(cfg);
        }
        return cfg;
    }

    function ghSaveCfg(cfg) {
        try { localStorage.setItem(GH_CFG, JSON.stringify(cfg)); } catch (e) { }
    }

    // токен ховаємо від сторонніх очей у цьому ж браузері. Це не шифрування:
    // мета в тім, щоб він не світився у сховищі як звичайний рядок
    function vault(text, back) {
        try {
            const key = new TextEncoder().encode(GH_VAULT);
            const src = back ? atob(text) : String(text);
            let out = '';
            for (let i = 0; i < src.length; i++) {
                out += String.fromCharCode(src.charCodeAt(i) ^ key[i % key.length]);
            }
            return back ? out : btoa(out);
        } catch (e) { return ''; }
    }

    function ghRemembered() {
        try { return !!localStorage.getItem(GH_TOKEN_DEV); } catch (e) { return false; }
    }

    function ghForget() {
        try { localStorage.removeItem(GH_TOKEN_DEV); } catch (e) { }
    }

    // без галочки — до закриття вкладки; з галочкою — доки не натиснуть «забути»
    function ghToken(value, remember) {
        if (value !== undefined) {
            try {
                if (value) {
                    if (remember) localStorage.setItem(GH_TOKEN_DEV, vault(value));
                    else sessionStorage.setItem(GH_TOKEN, value);
                } else {
                    sessionStorage.removeItem(GH_TOKEN);
                    localStorage.removeItem(GH_TOKEN_DEV);
                }
            } catch (e) { }
            return;
        }
        try {
            return sessionStorage.getItem(GH_TOKEN) || vault(localStorage.getItem(GH_TOKEN_DEV) || '', true);
        } catch (e) { return ''; }
    }

    function uiGh() {
        const cfg = ghCfg();
        $('gh-repo').value = cfg.repo || '';
        $('gh-branch').value = cfg.branch || '';
        $('gh-path').value = cfg.path || '';
        const kept = ghRemembered();
        const box = $('gh-remember');
        if (box) box.checked = kept;
        const field = $('gh-token');
        const typed = (field.value || '').trim();
        // збережений токен не потрапляє в поле: поле лишається порожнім під маскою
        field.placeholder = kept && !typed ? t('gh.saved') : t('gh.tokenPh');
        const forget = $('btn-gh-forget');
        if (forget) forget.style.display = kept ? '' : 'none';
    }

    // base64 для кирилиці/емодзі у імені коміту
    function b64utf8(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    function mapsOf(text) {
        try {
            const data = JSON.parse(text);
            return (data && data.maps && typeof data.maps === 'object') ? data.maps : null;
        } catch (e) { return null; }
    }

    // опублікований файл з GitHub: contents API віддає вміст base64, але для
    // великих карт — лише посилання; беремо звідти, аби не втратити старі дати
    async function publishedMaps(meta) {
        let text = '';
        try {
            const bin = atob(String(meta && meta.content || '').replace(/\s+/g, ''));
            if (bin) {
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                text = new TextDecoder().decode(bytes);
            }
        } catch (e) { text = ''; }
        if (text) {
            const maps = mapsOf(text);
            if (maps) return maps;
        }
        if (!meta || !meta.download_url) return null;
        try {
            const res = await fetch(meta.download_url, { cache: 'no-store' });
            return res.ok ? mapsOf(await res.text()) : null;
        } catch (e) { return null; }
    }

    let publishing = false;

    async function ghPublish() {
        if (publishing) return;
        const typed = ($('gh-token').value || '').trim();
        const token = typed || ghToken();
        const cfg = {
            repo: ($('gh-repo').value || '').trim(),
            branch: ($('gh-branch').value || '').trim() || GH_DEFAULT.branch,
            path: ($('gh-path').value || '').trim() || GH_DEFAULT.path
        };
        if (!token || !cfg.repo) { toast(t('gh.need'), 'err'); return; }
        if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) { toast(t('gh.badRepo'), 'err'); return; }
        ghSaveCfg(cfg);
        if (typed) ghToken(typed, $('gh-remember').checked);

        flushSave();
        const data = store.exportAll();
        if (!Object.keys(data.maps || {}).length) { toast(t('gh.empty'), 'err'); return; }

        const btn = $('btn-gh-publish');
        publishing = true;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = t('gh.publishing');

        const api = 'https://api.github.com/repos/' + cfg.repo + '/contents/' +
            cfg.path.split('/').map(encodeURIComponent).join('/');
        const headers = {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        try {
            let sha = null;
            const get = await fetch(api + '?ref=' + encodeURIComponent(cfg.branch), { headers });
            if (get.status === 404) sha = null;
            else {
                const meta = await get.json();
                if (!get.ok) throw new Error(t('gh.fail', { code: get.status }) + ' · ' + (meta.message || ''));
                sha = meta.sha;
                // той самий файл на GitHub містить дати, яких уже немає в цьому браузері:
                // публікуємо злиття, а не заміну
                const published = await publishedMaps(meta);
                if (published) data.maps = store.mergeMaps(published, data.maps);
            }
            const dates = Object.keys(data.maps).sort();
            const json = JSON.stringify(data);
            const body = {
                message: 'linestate: оновити карту (' + dates.length + ' дат)',
                content: b64utf8(json),
                branch: cfg.branch
            };
            if (sha) body.sha = sha;
            const put = await fetch(api, {
                method: 'PUT',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
                body: JSON.stringify(body)
            });
            if (put.status === 401 || put.status === 403) {
                ghToken('');
                $('gh-token').value = '';
                uiGh();
                throw new Error(t(put.status === 401 ? 'gh.denied' : 'gh.forbidden'));
            }
            if (!put.ok) {
                const err = await put.json().catch(() => ({}));
                throw new Error(t('gh.fail', { code: put.status }) + ' · ' + (err.message || ''));
            }
            const res = await put.json();
            if (res.commit && res.commit.html_url) window.open(res.commit.html_url, '_blank', 'noopener');
            toast(t('gh.ok', { dates: dates.length, kb: Math.round(json.length / 1024) }));
        } catch (e) {
            toast(String(e && e.message || e).slice(0, 160), 'err');
        } finally {
            publishing = false;
            btn.disabled = false;
            btn.textContent = label;
        }
    }


    function importJson(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const count = store.importAll(String(reader.result));
                toast(t('toast.imported', { n: count }));
                loadDate(state.date);
            } catch (e) {
                toast(t('toast.badFile'), 'err');
            }
        };
        reader.readAsText(file);
    }

    function addGeoLayer(features, name) {
        pushUndo();
        const l = makeLayer('zone', name || t('layer.import'));
        l.imported = true;
        l.data.features = features;
        l.style.border = 'glow';
        state.activeId = l.id;

        const b = LT.boundsOf(features);
        if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, duration: 800, maxZoom: 12 });

        commit();
        selectTab('style');
        return l;
    }

    async function importImage(file) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
            toast(t('object.imageErr'), 'err');
            return;
        }
        const date = state.date;
        try {
            const bitmap = await createImageBitmap(file);
            if (state.date !== date) { bitmap.close(); return; }
            const ratio = bitmap.width / bitmap.height;
            if (ratio < 0.1 || ratio > 10) { bitmap.close(); toast(t('object.imageErr'), 'err'); return; }
            const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            const image = canvas.toDataURL('image/webp', 0.86);
            if (!LT.validImage(image)) { toast(t('object.imageErr'), 'err'); return; }
            pushUndo();
            const l = makeLayer('image', file.name.replace(/\.[^.]+$/, '').slice(0, 32));
            l.image = image;
            l.imageRatio = ratio;
            const center = map.getCenter();
            l.data.features = [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [center.lng, center.lat] } }];
            state.activeId = l.id;
            setMode('drag');
            commit();
            selectTab('style');
            toast(t('object.imageOk'));
        } catch (e) { toast(t('object.imageErr'), 'err'); }
    }

    function placePoint(e) {
        if (state.mode !== 'point') return;
        pushUndo();
        const active = currentLayer();
        const l = active && active.kind === 'point' && !active.data.features.length ? active : makeLayer('point');
        l.data.features = [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] } }];
        state.activeId = l.id;
        commit();
    }

    function importGeo(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let res;
            try {
                res = LT.parseGeoJSON(String(reader.result));
            } catch (e) {
                toast(e.message || t('err.badGeo'), 'err');
                return;
            }

            const base = file.name.replace(/\.(geojson|json)$/i, '').replace(/[_-]+/g, ' ').trim().toUpperCase().slice(0, 28);
            addGeoLayer(res.features, base || t('layer.import'));
            toast(t('toast.geoImported', { n: res.features.length, skipped: res.skipped ? t('toast.geoSkipped', { n: res.skipped }) : '' }));
        };
        reader.readAsText(file);
    }

    /* ============================ СОБЫТИЯ ============================ */

    function bindUI() {
        document.querySelectorAll('.tab').forEach(t => {
            t.addEventListener('click', () => selectTab(t.dataset.tab));
        });

        $('collapse').addEventListener('click', () => {
            const p = $('panel');
            p.classList.toggle('collapsed');
            $('collapse').textContent = p.classList.contains('collapsed') ? '≡' : '–';
        });

        $('lang-btn').addEventListener('click', () => LT.switchLang());

        $('layer-list').addEventListener('click', e => {
            const row = e.target.closest('.layer');
            if (!row) return;
            const id = row.dataset.id;
            const act = e.target.closest('.act');
            if (act) {
                const l = state.layers[id];
                if (!l) return;
                if (act.dataset.act === 'vis') {
                    l.style.visible = !l.style.visible;
                    applyLayer(l);
                    if (blend) blend.sync();
                    uiLayers();
                    autoSave();
                } else if (act.dataset.act === 'up') {
                    moveLayerZ(l, 1);
                } else if (act.dataset.act === 'dn') {
                    moveLayerZ(l, -1);
                } else if (act.dataset.act === 'mrg') {
                    mergeLayerUp(id);
                } else if (act.dataset.act === 'del') {
                    if (!confirm(t('confirm.deleteLayer', { name: l.name }))) return;
                    pushUndo();
                    delete state.layers[id];
                    dropMaskRefs([id]);
                    if (state.activeId === id) state.activeId = Object.keys(state.layers)[0] || null;
                    syncMapLayers();
                    uiLayers();
                    uiStyle();
                    autoSave();
                }
                return;
            }
            selectLayer(id);
        });

        $('btn-add-zone').addEventListener('click', () => {
            flushSave();
            const l = makeLayer('zone');
            selectLayer(l.id);
            selectTab('style');
            syncMapLayers();
            autoSave();
        });

        $('btn-add-arrow').addEventListener('click', () => {
            flushSave();
            const l = makeLayer('arrow');
            selectLayer(l.id);
            setMode('arrow');
            selectTab('style');
            syncMapLayers();
            autoSave();
        });

        const styleChange = fn => e => {
            const l = currentLayer();
            if (!l) return;
            fn(l, e.target);
            applyLayer(l);
            uiLayers();
            autoSave();
        };

        $('f-name').addEventListener('input', styleChange((l, el) => { l.name = el.value || t('layer.noName'); }));
        $('f-desc').addEventListener('input', styleChange((l, el) => { l.desc = el.value; }));
        $('f-color').addEventListener('input', styleChange((l, el) => { l.style.color = el.value; }));
        $('f-bcol').addEventListener('input', styleChange((l, el) => { l.style.bcol = el.value; }));
        $('f-alpha').addEventListener('input', styleChange((l, el) => { l.style.alpha = +el.value; }));
        $('f-bw').addEventListener('input', styleChange((l, el) => { l.style.bw = +el.value; }));

        $('mask-list').addEventListener('click', e => {
            const b = e.target.closest('[data-mask]');
            if (!b) return;
            const l = currentLayer();
            if (!l) return;
            pushUndo();
            const id = b.dataset.mask;
            const ids = maskIds(l);
            const at = ids.indexOf(id);
            if (at >= 0) ids.splice(at, 1); else ids.push(id);
            l.style.maskTargets = ids;
            l.style.maskTarget = '';
            applyLayer(l);
            if (blend) blend.sync();
            uiStyle();
            autoSave();
        });
        $('f-hard').addEventListener('change', styleChange((l, el) => { l.style.hard = el.value === '1'; }));
        $('f-water').addEventListener('change', styleChange((l, el) => { l.style.water = el.value === '1'; }));

        $('f-width').addEventListener('input', styleChange((l, el) => {
            l.style.widthKm = +el.value;
            rebuildArrows(l);
        }));
        $('f-head').addEventListener('input', styleChange((l, el) => {
            l.style.headRatio = +el.value;
            rebuildArrows(l);
        }));
        $('f-d3').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.d3 = e.target.value === '1';
            $('f-depth').disabled = !l.style.d3;
            $('f-taper').disabled = !l.style.d3;
            $('f-headw').disabled = !l.style.d3;
            applyLayer(l);
            autoSave();
        });
        $('f-depth').addEventListener('input', styleChange((l, el) => {
            l.style.depth = Math.min(6, Math.max(0.2, +el.value));
        }));
        $('f-taper').addEventListener('input', styleChange((l, el) => {
            l.style.taper = Math.min(0.8, Math.max(0, +el.value));
            rebuildArrows(l);
        }));
        $('f-headw').addEventListener('input', styleChange((l, el) => {
            l.style.headW = Math.min(1.8, Math.max(0.5, +el.value));
            rebuildArrows(l);
        }));
        $('f-blend').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.blend = e.target.value;
            applyLayer(l);
            restack();
            autoSave();
        });

        $('f-grad').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.grad = e.target.checked;
            $('f-gcol').disabled = !l.style.grad;
            $('f-gdir').disabled = !l.style.grad;
            applyLayer(l);
            restack();
            uiLayers();
            autoSave();
        });
        $('f-gcol').addEventListener('input', styleChange((l, el) => { l.style.gcol = el.value; }));
        $('f-gdir').addEventListener('input', styleChange((l, el) => { l.style.gdir = Math.min(360, Math.max(0, +el.value)); }));

        $('f-pattern').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.pattern = e.target.value;
            $('f-pscale').disabled = l.style.pattern === 'none';
            applyLayer(l);
            autoSave();
        });
        $('f-pscale').addEventListener('input', styleChange((l, el) => { l.style.patternScale = Math.min(60, Math.max(8, +el.value)); }));
        $('f-border').addEventListener('change', styleChange((l, el) => { l.style.border = el.value; syncBorderFields(l); }));
        $('f-anim').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.anim = e.target.value;
            applyLayer(l);
            uiLayers();
            autoSave();
        });
        $('f-glow').addEventListener('input', styleChange((l, el) => { l.style.glow = +el.value; }));
        $('f-iglow').addEventListener('input', styleChange((l, el) => { l.style.iglow = +el.value; }));
        $('f-igcol').addEventListener('input', styleChange((l, el) => { l.style.igcol = el.value; }));
        $('f-label').addEventListener('change', e => {
            const l = currentLayer();
            if (!l) return;
            l.style.label = e.target.value === '1';
            $('f-labeltext').disabled = !l.style.label;
            $('f-lsize').disabled = !l.style.label;
            $('f-lcolor').disabled = !l.style.label;
            applyLayer(l);
            autoSave();
        });
        $('f-labeltext').addEventListener('input', styleChange((l, el) => { l.style.labelText = el.value; }));
        $('f-lsize').addEventListener('input', styleChange((l, el) => { l.style.labelSize = +el.value; }));
        $('f-lcolor').addEventListener('input', styleChange((l, el) => { l.style.labelColor = el.value; }));

        document.querySelectorAll('#style-presets button').forEach(b => {
            b.addEventListener('click', () => applyStylePreset(b.dataset.preset));
        });

        $('btn-copy-style').addEventListener('click', copyStyle);
        $('btn-paste-style').addEventListener('click', pasteStyle);

        $('btn-dup').addEventListener('click', () => {
            const l = currentLayer();
            if (!l) return;
            pushUndo();
            const copy = JSON.parse(JSON.stringify(l));
            copy.id = l.kind + '_' + Math.random().toString(36).slice(2, 7);
            copy.name = (l.name + ' ' + t('layer.copy')).slice(0, 32);
            copy.z = Object.values(state.layers).reduce((m, x) => Math.max(m, x.z), 0) + 1;
            copy.style.maskTarget = '';
            copy.style.maskTargets = [];
            copy.imported = false;
            state.layers[copy.id] = copy;
            state.activeId = copy.id;
            syncMapLayers();
            uiLayers();
            uiStyle();
            autoSave();
        });

        $('btn-clear-geom').addEventListener('click', () => {
            const l = currentLayer();
            if (!l) return;
            if (!l.data.features.length) { toast(t('toast.geomEmpty')); return; }
            pushUndo();
            l.data.features = [];
            commit();
            toast(t('toast.geomCleared', { name: l.name }));
        });

        function deleteImported() {
            const ids = Object.keys(state.layers).filter(id => state.layers[id].imported);
            if (!ids.length) { toast(t('toast.noImported'), 'err'); return; }
            if (!confirm(t('confirm.delImported', { n: ids.length }))) return;
            pushUndo();
            ids.forEach(id => {
                delete state.layers[id];
                LT.removeLayerObjects(map, id);
                mounted.delete(id);
            });
            dropMaskRefs(ids);
            if (!state.layers[state.activeId]) state.activeId = Object.keys(state.layers)[0] || null;
            syncMapLayers();
            uiLayers();
            uiStyle();
            autoSave();
            toast(t('toast.importedDeleted', { n: ids.length }));
        }

        $('btn-del-imported').addEventListener('click', deleteImported);
        $('btn-del-geo').addEventListener('click', deleteImported);

        $('btn-del-layer').addEventListener('click', () => {
            const l = currentLayer();
            if (!l) return;
            if (!confirm(t('confirm.deleteLayer', { name: l.name }))) return;
            pushUndo();
            delete state.layers[l.id];
            dropMaskRefs([l.id]);
            state.activeId = Object.keys(state.layers)[0] || null;
            syncMapLayers();
            uiLayers();
            uiStyle();
            autoSave();
        });

        document.querySelectorAll('.dock-btn[data-mode]').forEach(b => {
            b.addEventListener('click', () => setMode(b.dataset.mode));
        });

        $('prev-date').addEventListener('click', () => shiftDate(-1));
        $('next-date').addEventListener('click', () => shiftDate(1));
        $('play-btn').addEventListener('click', togglePlay);
        $('date-trigger').addEventListener('click', () => cal.toggle(state.date));

        Object.keys(FX_SLIDERS).forEach(k => {
            $(FX_SLIDERS[k]).addEventListener('input', () => setFx(readFxControls()));
        });
        document.querySelectorAll('#fx-film button').forEach(b => {
            b.addEventListener('click', () => {
                b.classList.toggle('on');
                setFx(readFxControls());
            });
        });
        document.querySelectorAll('#fx-presets button').forEach(b => {
            b.addEventListener('click', () => {
                if (FX_PRESETS[b.dataset.fx]) setFx(Object.assign({}, FX_PRESETS[b.dataset.fx]));
            });
        });
        $('fx-reset').addEventListener('click', () => setFx(Object.assign({}, FX_PRESETS.base)));

        document.querySelectorAll('#base-seg button').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('#base-seg button').forEach(x => x.classList.toggle('active', x === b));
                state.base = b.dataset.base;
                setBase(b.dataset.base);
                if (pxLabels) pxLabels.setOn(b.dataset.base === 'hybrid');
                LT.ensurePlaceLabels(map, state.base);
            });
        });

        document.querySelectorAll('#ov-seg button').forEach(b => {
            b.addEventListener('click', () => {
                state.overlays[b.dataset.ov] = !state.overlays[b.dataset.ov];
                syncOverlays();
            });
        });

        $('btn-ghost').addEventListener('click', toggleGhost);
        $('q-go').addEventListener('click', searchCity);
        $('search-results').addEventListener('click', e => {
            const row = e.target.closest('.sr');
            if (!row) return;
            const res = searchRows[+row.dataset.i];
            if (res) pickResult(res, +row.dataset.i);
        });
        $('sp-add').addEventListener('click', captureSearch);
        $('sp-clear').addEventListener('click', clearSearch);

        $('btn-copy-prev').addEventListener('click', () => copyToDay(-1));
        $('btn-copy-next').addEventListener('click', () => copyToDay(1));
        $('btn-del-map').addEventListener('click', deleteCurrentMap);
        $('btn-del-all').addEventListener('click', deleteAllMaps);

        $('btn-export-json').addEventListener('click', exportJson);
        $('btn-export-site').addEventListener('click', exportSite);
        const optBtn = $('btn-optimize');
        if (optBtn) optBtn.addEventListener('click', optimizeStorage);
        const vBtn = $('btn-views-refresh');
        if (vBtn) vBtn.addEventListener('click', refreshViews);
        $('btn-gh-publish').addEventListener('click', ghPublish);
        $('gh-token').addEventListener('input', e => ghToken(e.target.value.trim()));
        // галочка = один і той самий токен живе на пристрої; зняв — він забувається
        $('gh-remember').addEventListener('change', e => {
            const v = ($('gh-token').value || '').trim() || ghToken();
            if (e.target.checked) {
                if (!v) { e.target.checked = false; toast(t('gh.need'), 'err'); return; }
                try { sessionStorage.removeItem(GH_TOKEN); } catch (err) { }
                ghToken(v, true);
                $('gh-token').value = '';
                toast(t('gh.kept'));
            } else {
                ghForget();
            }
            uiGh();
        });
        $('btn-gh-forget').addEventListener('click', () => {
            ghForget();
            try { sessionStorage.removeItem(GH_TOKEN); } catch (e) { }
            $('gh-token').value = '';
            $('gh-remember').checked = false;
            uiGh();
            toast(t('gh.forgot'));
        });
        ['gh-repo', 'gh-branch', 'gh-path'].forEach(id => $(id).addEventListener('change', () => {
            ghSaveCfg({
                repo: ($('gh-repo').value || '').trim(),
                branch: ($('gh-branch').value || '').trim() || GH_DEFAULT.branch,
                path: ($('gh-path').value || '').trim() || GH_DEFAULT.path
            });
        }));
        $('btn-export-geo').addEventListener('click', exportGeo);
        $('btn-import-json').addEventListener('click', () => $('import-file').click());
        $('import-file').addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            if (f) importJson(f);
            e.target.value = '';
        });

        $('btn-import-geo').addEventListener('click', () => $('geojson-file').click());
        $('geojson-file').addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            if (f) importGeo(f);
            e.target.value = '';
        });

        let dragDepth = 0;
        const dropEl = $('drop');
        document.addEventListener('dragenter', e => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            dragDepth++;
            dropEl.classList.add('show');
        });
        document.addEventListener('dragover', e => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });
        document.addEventListener('dragleave', () => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) dropEl.classList.remove('show');
        });
        document.addEventListener('drop', e => {
            if (!e.dataTransfer) return;
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            e.preventDefault();
            dragDepth = 0;
            dropEl.classList.remove('show');
            importGeo(f);
        });

        $('btn-reset').addEventListener('click', () => {
            if (!confirm(t('confirm.reset'))) return;
            try { localStorage.clear(); } catch (e) { }
            location.reload();
        });

        document.addEventListener('keydown', e => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                undo();
                return;
            }
            if (e.key === '1') setMode('draw');
            if (e.key === '2') setMode('arrow');
            if (e.key === '3') setMode('erase');
            if (e.key === '0') setMode('drag');
        });

        window.addEventListener('beforeunload', flushSave);
        window.addEventListener('pagehide', flushSave);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);

        syncClipUI();
        syncOverlayUI();
    }

    /* ============================ СТАРТ ============================ */

    LT.initDevice();
    map = LT.createMap('map', { center: [37.6, 48.35], zoom: 7 });
    mapTools = LT.installMapTools(map);
    objects = LT.mapObjects(map, {
        editable: true,
        onSelect: id => { selectLayer(id); selectTab('style'); },
        onDragStart: pushUndo,
        onMove: (id, pos) => {
            const l = state.layers[id];
            if (!l) return;
            l.data.features[0].geometry.coordinates = [pos.lng, pos.lat];
            commit();
        }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(LT.scaleBar(map), 'bottom-right');
    LT.smoothZoom(map);

    const UKRAINE_BOUNDS = [[22.0, 44.2], [40.6, 52.6]];
    map.fitBounds(UKRAINE_BOUNDS, {
        padding: LT.device().mobile
            ? { top: 64, bottom: 128, left: 14, right: 14 }
            : { top: 44, bottom: 128, left: 404, right: 44 },
        duration: 0
    });

    LT.initI18n();
    pxLabels = LT.pixelLabels(map);
    pxLabels.setOn(state.base === 'hybrid');

    function syncLangUI() {
        $('lang-btn').innerHTML = LT.flagSVG(LT.lang()).replace('<svg ', '<svg width="22" height="15" ') + '<span>' + LT.lang().toUpperCase() + '</span>';
        uiUsage();
        uiViews();
        if (!mapReady) return;
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        if (pxLabels) pxLabels.relabel();
        uiLayers();
        uiStyle();
        uiDate();
        setStatus(statusKey);
        if (cal) cal.refresh();
        $('btn-ghost').textContent = t(state.ghost ? 'fx.ghostOn' : 'fx.ghostOff');
        $('play-btn').textContent = playTimer ? t('viewer.stop') : t('viewer.play');
    }

    document.addEventListener('linetate:lang', syncLangUI);

    syncLangUI();

    const setBase = LT.baseSwitcher(map, remount);

    function boot() {
        if (mapReady) return;
        mapReady = true;
        $('splash').classList.add('gone');
        setTimeout(() => $('splash').remove(), 600);
        LT.initFX();
        fx = LT.loadFX();
        syncFxUI();
        addTemp();
        addGhostSource();
        ensureSearch();
        searchDashLoop();

        bindUI();
        uiGh();
        uiUsage();
        uiViews();
        // спільну суму тягнемо з мережі лише один раз на відкриття адмінки
        refreshViews();
        cal = LT.Calendar({
            el: $('cal'),
            trigger: $('date-trigger'),
            current: () => state.date,
            // той самий знак «день існує», що й раніше, але без розбору всього
            // сховища на кожну клітину календаря
            hasData: iso => !!store.dateInfo(iso),
            minDate: () => LT.MIN_DATE,
            onPick: iso => switchDate(iso)
        });

        map.on('mousedown', onDown);
        map.on('mousemove', onMove);
        map.on('mouseup', onUp);

        remoteReady.then(startUp);
    }

    // дата-залежна частина: вже відомо, які дати існують (локально + опубліковані)
    function startUp() {
        const start = initialDate();
        loadDate(start < LT.MIN_DATE ? LT.MIN_DATE : start);
        uiUsage();
        setMode('draw');
        $('play-btn').textContent = t('viewer.play');
        $('btn-ghost').textContent = t(state.ghost ? 'fx.ghostOn' : 'fx.ghostOff');
        loadLand();
        LT.applyMapLang(map);
        LT.ensurePlaceLabels(map, state.base);
        blend = LT.blendEngine(map, () => state.layers, l => l.style.visible, l => shownFC.get(l.id) || displayFC(l));
        blend.sync();
        LT.startAnimations(map, () => state.layers, l => l.style.visible);
        if (cal) cal.refresh();
    }

    map.once('style.load', boot);
    setTimeout(() => { if (map.isStyleLoaded()) boot(); }, 1200);
})();
