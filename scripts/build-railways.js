// Залізниці для переглядача: Natural Earth 10m railroads, обрізані рамкою карти
// і стиснені polyline з точністю 1e5. Стиль класичний: біла підкладка, темна
// основа і білий пунктир поверх — лінія читається на будь-якій підкладці.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.NE_RAILROADS || path.join(ROOT, 'scripts/data/railways-src.json');
const OUT = path.join(ROOT, 'assets/railways.js');
const BOUNDS = [[21.9, 43.9], [40.6, 52.6]];
const MARGIN = 0.6;
const SIMPLIFY_KM = 0.32;

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

const inBox = p => p[0] >= BOUNDS[0][0] - MARGIN && p[0] <= BOUNDS[1][0] + MARGIN
    && p[1] >= BOUNDS[0][1] - MARGIN && p[1] <= BOUNDS[1][1] + MARGIN;

function main() {
    const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const features = raw.type === 'FeatureCollection' ? raw.features : [raw];
    const out = [];
    let rawPts = 0, outPts = 0;
    const byCat = {};
    for (const f of features) {
        const pr = (f && f.properties) || {};
        const cat = pr.category == 2 ? 2 : (pr.category == 3 ? 3 : 1);
        const geo = f && f.geometry;
        if (!geo) continue;
        const parts = geo.type === 'MultiLineString' ? geo.coordinates : [geo.coordinates];
        for (const ln of parts) {
            if (!ln || ln.length < 2) continue;
            if (!ln.some(inBox)) continue;
            rawPts += ln.length;
            const s = simplify(ln, SIMPLIFY_KM);
            if (s.length < 2) continue;
            outPts += s.length;
            byCat[cat] = (byCat[cat] || 0) + 1;
            out.push({ c: cat, p: encodePolyline(s) });
        }
    }
    const body = JSON.stringify(out);
    fs.writeFileSync(OUT, 'window.LT_RAILWAYS=' + JSON.stringify({ v: 1, lines: out }) + ';\n');
    const sz = fs.statSync(OUT).size;
    console.log('railways:', out.length, 'lines, raw pts', rawPts, '->', outPts, 'cats', JSON.stringify(byCat), 'size', (sz / 1024).toFixed(1), 'KB');
}

main();
