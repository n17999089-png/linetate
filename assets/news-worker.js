/* Новини з фронту рахуються тут, а не в головному потоці: turf.difference
   на великих полігонах тримав кадри мапи по 200–550 мс. Воркер отримує
   шари дат і спільний список НП, повертає готові картки (назву НП головний
   потік підставляє сам, щоб не тягнути сюди локалізацію). */
importScripts('vendor/turf.min.js');

const NEWS_MIN_KM2 = 0.5;
const NEWS_MAX_ITEMS = 6;
const NEWS_DIRS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];

let places = null;           // [lon0, lat0, lon1, lat1, ...] — прямокутник України
const docs = new Map();      // date -> { savedAt, layers: { ukr|rus|grey|land: features[] } }
const zoneCache = new Map(); // date|savedAt|role -> union Feature

function geomOk(g) {
    return !!(g && g.type && Array.isArray(g.coordinates) && g.coordinates.length);
}

function areaKm2(f) {
    try { return f && geomOk(f.geometry) ? turf.area(f) / 1e6 : 0; } catch (e) { return 0; }
}

function diff(a, b) {
    if (!a) return null;
    if (!b) return a;
    try {
        const d = turf.difference(a, b);
        return d && geomOk(d.geometry) ? d : null;
    } catch (e) { return null; }
}

function cut(a, b) {
    if (!a || !b) return null;
    try {
        const d = turf.intersect(a, b);
        return d && geomOk(d.geometry) ? d : null;
    } catch (e) { return null; }
}

function unionOf(fs) {
    if (!fs || !fs.length) return null;
    let u = fs[0];
    for (let i = 1; i < fs.length && u; i++) {
        try { u = turf.union(u, fs[i]); } catch (e) { return null; }
    }
    return u && geomOk(u.geometry) ? u : null;
}

function zoneOf(date, role) {
    const d = docs.get(date);
    const fs = d && d.layers ? d.layers[role] : null;
    if (!fs || !fs.length) return null;
    const key = date + '|' + d.savedAt + '|' + role;
    if (zoneCache.has(key)) return zoneCache.get(key);
    const f = unionOf(fs);
    zoneCache.set(key, f);
    return f;
}

function polys(f) {
    if (!f || !f.geometry) return [];
    const g = f.geometry;
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
}

function polyFeat(ring) {
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: ring } };
}

function findPlace(lon, lat) {
    const n = places ? places.length / 2 : 0;
    const cos = Math.cos(lat * Math.PI / 180) || 1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
        const dx = (places[i * 2] - lon) * cos;
        const dy = places[i * 2 + 1] - lat;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : { i: best, km: Math.sqrt(bd) * 111.32 };
}

function dirKey(lon, lat, i) {
    const dx = (lon - places[i * 2]) * Math.cos(lat * Math.PI / 180);
    const dy = lat - places[i * 2 + 1];
    const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    return NEWS_DIRS[Math.round(deg / 45) % 8];
}

// дзеркало newsPair із core.js: та сама геометрія, та сама семантика карток
function pair(prevDate, curDate) {
    const p = {}, c = {};
    ['ukr', 'rus', 'grey'].forEach(r => {
        p[r] = zoneOf(prevDate, r);
        c[r] = zoneOf(curDate, r);
    });
    const land = zoneOf(curDate, 'land') || zoneOf(prevDate, 'land');
    const items = [];
    // спершу площа кожного кільця, класифікація джерела й пошук НП — лише для
    // тих шести, що підуть у картки
    const rings = [];
    ['rus', 'ukr'].forEach(side => {
        if (!p[side] || !c[side]) return;
        let gain = diff(c[side], p[side]);
        if (gain && land) gain = cut(gain, land) || gain;
        polys(gain).forEach(ring => {
            const poly = polyFeat(ring);
            const a = areaKm2(poly);
            if (a < NEWS_MIN_KM2) return;
            rings.push({ side, poly, area: a });
        });
    });
    rings.sort((a, b) => b.area - a.area);
    rings.slice(0, NEWS_MAX_ITEMS).forEach(({ side, poly, area }) => {
        let rest = poly;
        const srcs = [];
        ['ukr', 'rus', 'grey'].forEach(src => {
            if (src === side || !p[src] || !rest) return;
            const part = cut(rest, p[src]);
            if (!part) return;
            const a = areaKm2(part);
            if (a > 0.005) srcs.push([src, a]);
            rest = diff(rest, part);
        });
        if (rest) {
            const a = areaKm2(rest);
            if (a > 0.005) srcs.push(['empty', a]);
        }
        srcs.sort((a, b) => b[1] - a[1]);
        let pt = null;
        try { pt = turf.pointOnFeature(poly); } catch (e) { pt = null; }
        if (!pt) return;
        const lon = pt.geometry.coordinates[0], lat = pt.geometry.coordinates[1];
        const near = findPlace(lon, lat);
        if (!near) return;
        let inside = false;
        try {
            inside = turf.booleanPointInPolygon(turf.point([places[near.i * 2], places[near.i * 2 + 1]]), poly);
        } catch (e) { inside = false; }
        const src = srcs.length ? srcs[0][0] : 'empty';
        const taking = (side === 'rus' && src === 'ukr') || (side === 'ukr' && src === 'rus');
        const suffix = taking ? (inside ? 'Take' : 'TakeArea') : (inside ? 'Area' : 'Near');
        const bbox = turf.bbox(poly);
        items.push({
            side, src, inside,
            key: side + suffix,
            dir: inside || near.km < 1 ? '' : dirKey(lon, lat, near.i),
            area,
            place: near.i,
            bbox: [bbox[0], bbox[1], bbox[2], bbox[3]]
        });
    });
    items.sort((a, b) => b.area - a.area);
    return { date: curDate, savedAt: (docs.get(curDate) || {}).savedAt || 0, items: items.slice(0, NEWS_MAX_ITEMS) };
}

self.onmessage = ev => {
    const m = ev.data;
    if (!m || !m.t) return;
    if (m.t === 'places') { places = m.pts; return; }
    if (m.t === 'date') {
        docs.set(m.date, { savedAt: Number(m.savedAt) || 0, layers: m.layers || {} });
        return;
    }
    if (m.t === 'pair') {
        let group = null, err = null;
        try { group = pair(m.prev, m.cur); }
        catch (e) { err = String((e && e.message) || e); }
        self.postMessage({ t: 'pair', id: m.id, group, err });
    }
};
