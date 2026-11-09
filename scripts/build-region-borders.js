/* LINESTATE — контурні кордони сусідніх країн і де-факто межа Придністров'я.
 *
 * Джерела:
 *   scripts/data/ne-boundary-lines.geojson — Natural Earth 1:10m
 *       admin_0_boundary_lines_land (public domain): лише суходільні
 *       кордони, без берегових ліній, з парою країн у властивостях;
 *   scripts/data/pmr.json — OSM relation 65335 (Nominatim, ODbL):
 *       де-факто контур Придністров'я;
 *   scripts/data/ua-border-ways.json — лінії кордону України (OSM 60199),
 *       щоб не дублювати пунктиром уже намальовану межу з Україною.
 *
 * Результат: scripts/data/region-borders.json — готові polyline, розкладені
 * за категоріями-прапорами переглядача (by, pl, sk, hu, ro, md, ru) плюс
 * окрема пунктирна категорія pmr. Збірка сторінки лише зливає їх із
 * state-borders.js, тож у кадрі жодних обчислень немає.
 *
 * Запуск: node scripts/build-region-borders.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const KM = 111.32;
function dist2(a, b, cosLat) {
    const dx = (a[0] - b[0]) * cosLat * KM, dy = (a[1] - b[1]) * KM;
    return dx * dx + dy * dy;
}

function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const cos = Math.cos((pts[0][1] + pts[pts.length - 1][1]) / 2 * Math.PI / 180);
    const stack = [[0, pts.length - 1]];
    const t2 = (tol / KM) * (tol / KM);
    while (stack.length) {
        const [a, b] = stack.pop();
        const p = pts[a], q = pts[b];
        let best = -1, bi = -1;
        for (let i = a + 1; i < b; i++) {
            const r = pts[i];
            const vx = (q[0] - p[0]) * cos * KM, vy = (q[1] - p[1]) * KM;
            const wx = (r[0] - p[0]) * cos * KM, wy = (r[1] - p[1]) * KM;
            const len = vx * vx + vy * vy;
            let t = len ? (wx * vx + wy * vy) / len : 0;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const dx = wx - vx * t, dy = wy - vy * t;
            const d = dx * dx + dy * dy;
            if (d > best) { best = d; bi = i; }
        }
        if (best > t2) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
}

function encodePolyline(pts) {
    let out = '', pLat = 0, pLng = 0;
    const enc = n => {
        let v = n < 0 ? ~(n << 1) : (n << 1), s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        return s + String.fromCharCode(v + 63);
    };
    for (const p of pts) {
        const lat = Math.round(p[1] * 1e5), lng = Math.round(p[0] * 1e5);
        out += enc(lat - pLat) + enc(lng - pLng);
        pLat = lat; pLng = lng;
    }
    return out;
}

function densify(pts, stepDeg) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
        out.push(pts[i]);
        const q = pts[i + 1];
        if (!q) continue;
        const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]);
        const n = Math.floor(d / stepDeg);
        for (let k = 1; k <= n; k++) {
            out.push([pts[i][0] + (q[0] - pts[i][0]) * k / (n + 1), pts[i][1] + (q[1] - pts[i][1]) * k / (n + 1)]);
        }
    }
    return out;
}

function makeGrid(pts) {
    const g = new Map();
    for (const p of pts) {
        const k = Math.floor(p[0] * 10) + ',' + Math.floor(p[1] * 10);
        let a = g.get(k);
        if (!a) g.set(k, a = []);
        a.push(p);
    }
    g.within = (p, radiusKm) => {
        const cos = Math.cos(p[1] * Math.PI / 180);
        const cx = Math.floor(p[0] * 10), cy = Math.floor(p[1] * 10);
        const span = Math.ceil(radiusKm / 9) + 1;
        const r2 = radiusKm * radiusKm;
        for (let x = cx - span; x <= cx + span; x++) {
            for (let y = cy - span; y <= cy + span; y++) {
                const a = g.get(x + ',' + y);
                if (!a) continue;
                for (const q of a) if (dist2(p, q, cos) <= r2) return true;
            }
        }
        return false;
    };
    return g;
}

function lenKm(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
        const cos = Math.cos(pts[i][1] * Math.PI / 180);
        L += Math.sqrt(dist2(pts[i - 1], pts[i], cos));
    }
    return L;
}

// контури країн малюються тонкою лінією; до 20 км хорд у наборі NE немає,
// але дрібні обривки на стиках не потрібні
const SIMPLIFY_DEG = 0.0012; // ≈ 130 м
const REGION = [14, 42, 43, 56]; // lon0, lon1, lat0, lat1
const MIN_KM = 0.8;

// країни, чиї повні контури додаються до вже наявних кордонів з Україною.
// порядок = пріоритет категорії, якщо обидві сторони мають свій прапор
const COUNTRY_CAT = {
    Belarus: 'by', Moldova: 'md', Romania: 'ro', Hungary: 'hu',
    Slovakia: 'sk', Poland: 'pl', Russia: 'ru'
};
const PRIORITY = ['by', 'md', 'ro', 'hu', 'sk', 'pl', 'ru'];

function inRegion(bb) {
    return !(bb[2] < REGION[0] || bb[0] > REGION[1] || bb[3] < REGION[2] || bb[1] > REGION[3]);
}

function parts(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
}

function main() {
    const ne = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/ne-boundary-lines.geojson'), 'utf8'));
    const outline = { by: [], pl: [], sk: [], hu: [], ro: [], md: [], ru: [] };
    const outlinePts = { by: 0, pl: 0, sk: 0, hu: 0, ro: 0, md: 0, ru: 0 };
    let features = 0, skippedWater = 0;
    for (const f of ne.features) {
        const p = f.properties;
        // через воду — не суходільний кордон і на карті читався б як лінія в морі
        if (p.TYPE === 'Water Indicator') { skippedWater++; continue; }
        const L = p.ADM0_LEFT, R = p.ADM0_RIGHT;
        if (L === 'Ukraine' || R === 'Ukraine') continue;
        const bb = f.bbox;
        if (!bb || !inRegion(bb)) continue;
        // кавказькі кордони РФ поза оперативною картою
        if ((L === 'Georgia' && R === 'Russia') || (L === 'Russia' && R === 'Georgia')) continue;
        const cl = COUNTRY_CAT[L], cr = COUNTRY_CAT[R];
        if (!cl && !cr) continue;
        let cat = null;
        for (const id of PRIORITY) {
            if (cl === id || cr === id) { cat = id; break; }
        }
        if (!cat) continue;
        for (const coords of parts(f.geometry)) {
            // ріжемо на виході з рамки, а не filter: інакше лінія, що вийшла
            // й повернулась, зшилася б хордою через чужий край
            let run = [];
            const flush = () => {
                if (run.length < 2) { run = []; return; }
                const s = simplify(run, SIMPLIFY_DEG);
                run = [];
                if (s.length < 2 || lenKm(s) < MIN_KM) return;
                outline[cat].push(encodePolyline(s));
                outlinePts[cat] += s.length;
                features++;
            };
            for (const q of coords) {
                const inside = q[0] >= REGION[0] - 0.5 && q[0] <= REGION[1] + 0.5
                    && q[1] >= REGION[2] - 0.5 && q[1] <= REGION[3] + 0.5;
                if (!inside) { flush(); continue; }
                run.push(q);
            }
            flush();
        }
    }

    // Придністров'я: беремо зовнішнє кільце де-факто контуру, а ділянки, що
    // збігаються з державним кордоном України, відкидаємо — там уже є
    // суцільна лінія, другий пунктир поверх неї виглядав би як артефакт
    const pmrRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/pmr.json'), 'utf8'));
    const uaWays = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/ua-border-ways.json'), 'utf8'));
    const uaPts = [];
    uaWays.forEach(w => uaPts.push(...densify(w, 0.01)));
    const uaGrid = makeGrid(uaPts);
    const ring = pmrRaw.type === 'Polygon' ? pmrRaw.coordinates[0] : pmrRaw.coordinates[0][0];
    const pmr = [];
    let pmrPts = 0;
    let run = [];
    const flush = () => {
        if (run.length >= 2) {
            const s = simplify(run, SIMPLIFY_DEG);
            if (s.length >= 2 && lenKm(s) >= MIN_KM) { pmr.push(encodePolyline(s)); pmrPts += s.length; }
        }
        run = [];
    };
    for (const p of ring) {
        if (uaGrid.within(p, 2.5)) { flush(); continue; }
        run.push(p);
    }
    flush();

    const out = { v: 1, outline, pmr };
    const file = path.join(ROOT, 'scripts/data/region-borders.json');
    fs.writeFileSync(file, JSON.stringify(out));
    console.log('NE features used:', features, 'water skipped:', skippedWater);
    for (const id of Object.keys(outline)) {
        console.log(id, 'lines:', outline[id].length, 'pts:', outlinePts[id]);
    }
    console.log('pmr lines:', pmr.length, 'pts:', pmrPts);
    console.log('size:', (fs.statSync(file).size / 1024).toFixed(1) + ' KB');
}

main();
