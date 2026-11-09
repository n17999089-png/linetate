/* Прибирає з контурів областей ділянки, що йдуть відкритим морем.
 *
 * У наборі областей (geoBoundaries → regions.js) адміністративні межі
 * Одеської, Миколаївської, Херсонської областей і Криму продовжуються в
 * Чорне та Азовське море (територіальні води). На карті це читалося як
 * «пробоїна в кордоні»: довгі рівні пунктирні лінії через море біля Одеси.
 * Ріжемо їх за суходолом Natural Earth 1:10m із запасом ~1.3 км, щоб
 * берегова лінія лишалася на місці.
 *
 * Джерело суходолу: ne_10m_land (public domain), вирізаний по рамці
 * 21.5–42E / 43.5–53.5N і спрощений до 0.002° → scripts/data/ne-land-ukr.geojson.
 *
 * Запуск: node scripts/clip-regions-sea.mjs [--dry]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REG = path.join(ROOT, 'assets/regions.js');
const LAND = path.join(ROOT, 'scripts/data/ne-land-ukr.geojson');

const B = [21.5, 43.5, 42.0, 53.5];
const STEP = 0.004;
const NEAR = 3;             // клітин (≈1.3 км), у межах яких лінію ще лишаємо
const JUMP_KM = 3;          // стрибок між сусідніми точками, який перевіряємо на воду

const text = fs.readFileSync(REG, 'utf8');
const m = text.match(/window\.LT_REGIONS_RAW = (\{[\s\S]*\});\s*$/);
if (!m) throw new Error('LT_REGIONS_RAW not found');
const raw = JSON.parse(m[1]);

// ---------- сітка «суходіл + 1.3 км» ----------
const W = Math.ceil((B[2] - B[0]) / STEP), H = Math.ceil((B[3] - B[1]) / STEP);
const land = new Uint8Array(W * H);
const landFC = JSON.parse(fs.readFileSync(LAND, 'utf8'));

// точковий тест у полігон: промінь у +x
function inside(rings, x, y) {
    let c = false;
    for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const a = r[i], b = r[j];
            if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
        }
    }
    return c;
}

// раструємо полігони построково: перетин ребер із горизонтальною лінією
for (const f of landFC.features) {
    const rings = f.geometry.coordinates;
    const all = rings.flat();
    let miny = 1e9, maxy = -1e9;
    for (const p of all) { if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
    const y0 = Math.max(0, Math.floor((miny - B[1]) / STEP));
    const y1 = Math.min(H - 1, Math.ceil((maxy - B[1]) / STEP));
    for (let gy = y0; gy <= y1; gy++) {
        const y = B[1] + (gy + 0.5) * STEP;
        const xs = [];
        for (const r of rings) {
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
                const a = r[i], b = r[j];
                if ((a[1] > y) !== (b[1] > y)) xs.push((b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]);
            }
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            let gx0 = Math.max(0, Math.ceil((xs[k] - B[0]) / STEP - 0.5));
            let gx1 = Math.min(W - 1, Math.floor((xs[k + 1] - B[0]) / STEP - 0.5));
            for (let gx = gx0; gx <= gx1; gx++) land[gy * W + gx] = 1;
        }
    }
}

// дилатація на NEAR клітин
let near = land;
for (let s = 0; s < NEAR; s++) {
    const prev = near, next = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            const i = row + x;
            if (prev[i]) { next[i] = 1; continue; }
            if ((x > 0 && prev[i - 1]) || (x + 1 < W && prev[i + 1]) ||
                (y > 0 && prev[i - W]) || (y + 1 < H && prev[i + W])) next[i] = 1;
        }
    }
    near = next;
}

const onLand = p => {
    const gx = Math.floor((p[0] - B[0]) / STEP), gy = Math.floor((p[1] - B[1]) / STEP);
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return true; // поза рамкою не ріжемо
    return !!near[gy * W + gx];
};

// ---------- різання поліліній ----------
function decode(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
        let sh = 0, d = 0, b;
        do { b = str.charCodeAt(i++) - 63; d |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < str.length);
        lat += (d & 1) ? ~(d >> 1) : (d >> 1);
        sh = 0; d = 0;
        do { b = str.charCodeAt(i++) - 63; d |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < str.length);
        lng += (d & 1) ? ~(d >> 1) : (d >> 1);
        out.push([lng / 1e5, lat / 1e5]);
    }
    return out;
}
function encode(pts) {
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
const km = (a, b) => {
    const cos = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    const dx = (a[0] - b[0]) * cos * 111.32, dy = (a[1] - b[1]) * 111.32;
    return Math.sqrt(dx * dx + dy * dy);
};

let droppedPts = 0, keptPts = 0, splitRegions = 0;
const lines = (raw.l || []).map(str => {
    const pts = decode(str);
    const runs = [];
    let run = [];
    const flush = () => { if (run.length > 1) runs.push(run); run = []; };
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!onLand(p)) { droppedPts++; flush(); continue; }
        if (run.length) {
            const prev = run[run.length - 1];
            const d = km(prev, p);
            if (d > JUMP_KM) {
                const mid = [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2];
                if (!onLand(mid)) { flush(); }
            }
        }
        keptPts++;
        run.push(p);
    }
    flush();
    if (runs.length > 1) splitRegions++;
    if (runs.length === 1) return encode(runs[0]);
    return runs.map(encode);
});

const out = Object.assign({}, raw, { l: lines });
const outText = '/* LINESTATE — області UA/RU/BY/PL (OpenStreetMap через geoBoundaries, ODbL). Формат: стиснений polyline (5 знаків) — декодується в LT.geo.js */\n'
    + 'window.LT_REGIONS_RAW = ' + JSON.stringify(out) + ';\n';

console.log(JSON.stringify({ regions: lines.length, splitRegions, droppedPts, keptPts, before: text.length, after: outText.length }));
if (!process.argv.includes('--dry')) {
    fs.writeFileSync(REG, outText);
    console.log('written', REG);
}
