/* LINESTATE — збірка державних кордонів України.
 *
 * Джерела:
 *   assets/regions.js — області UA/BY/PL/RU (ними ж визначаємо, з якою
 *                        країною межує ділянка кордону);
 *   assets/borders.js — точні лінії кордонів OSM (ODbL).
 *
 * Результат: assets/state-borders.js — три категорії (РФ, Білорусь, ЄС/
 * Молдова), кожна стиснена polyline з точністю 1e5. Переглядач лише декодує
 * готові лінії, жодних обчислень у кадрі.
 *
 * Запуск: node scripts/build-state-borders.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadGlobal(file, key) {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
    return ctx.window[key];
}

function decodePolyline(str) {
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

// плоска апроксимація кілометрів: широта стала, довгота множиться на cos(lat)
const KM = 111.32;
function dist2(a, b, cosLat) {
    const dx = (a[0] - b[0]) * cosLat * KM, dy = (a[1] - b[1]) * KM;
    return dx * dx + dy * dy;
}

// сітка точок: клітинка 0.1°, у ній індекси точок
function makeGrid(pts) {
    const g = new Map();
    const key = (x, y) => x + ',' + y;
    for (const p of pts) {
        const x = Math.floor(p[0] * 10), y = Math.floor(p[1] * 10);
        const k = key(x, y);
        let a = g.get(k);
        if (!a) g.set(k, a = []);
        a.push(p);
    }
    g.nearest = (p, radiusKm) => {
        const cos = Math.cos(p[1] * Math.PI / 180);
        const cx = Math.floor(p[0] * 10), cy = Math.floor(p[1] * 10);
        // 0.1° ≈ 11 км по широті; беремо із запасом
        const span = Math.ceil(radiusKm / 9) + 1;
        let best = Infinity;
        for (let x = cx - span; x <= cx + span; x++) {
            for (let y = cy - span; y <= cy + span; y++) {
                const a = g.get(key(x, y));
                if (!a) continue;
                for (const q of a) {
                    const d = dist2(p, q, cos);
                    if (d < best) best = d;
                }
            }
        }
        return Math.sqrt(best);
    };
    return g;
}

// Дуглас–Пекер: лінія залишає форму, але без зайвих точок
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
            // відстань до відрізка у «квадратних кілометрах»
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

function main() {
    const regions = loadGlobal('assets/regions.js', 'LT_REGIONS_RAW');
    const borders = loadGlobal('assets/borders.js', 'LT_BORDERS_RAW');

    const ua = [];
    const byCountry = { BLR: [], POL: [], RUS: [] };
    regions.p.forEach((row, i) => {
        const pts = decodePolyline(regions.l[i]);
        if (row[1] === 'UKR') ua.push(...pts);
        else if (byCountry[row[1]]) byCountry[row[1]].push(...pts);
    });

    const uaGrid = makeGrid(ua);
    const CAT_ID = { BLR: 'by', POL: 'eu', RUS: 'ru' };
    const grids = {};
    for (const c of Object.keys(byCountry)) grids[c] = makeGrid(byCountry[c]);

    // до 20 км від контуру області: далі вже чужі кордони, які на карті не потрібні
    const NEAR_UA = 20;
    // класифікуємо за найближчою областю сусіда; якщо сусід невідомий — ЄС/Молдова
    const CAT_KM = 45;
    const CAT_MIN_PTS = 8;
    const SIMPLIFY_DEG = 0.0012; // ≈ 130 м
    // у наборі є й морські лінії (Азов, Чорне море біля Криму) — це не
    // державний кордон на суходолі, тому лишаємо тільки ділянки, що
    // тягнуться вздовж областей сусідів, і південний захід (Молдова/ЄС)
    const SW_LNG = 30.4, SW_LAT = 44.8;
    // Чорне море на схід від Криму: морська межа й Керченська протока.
    // На оперативній карті це не кордон — лінія йшла б по воді поруч із
    // окупованим півостровом, тому такі точки відкидаємо.
    const SEA_LNG = 32.4, SEA_LAT = 46.15;
    // хорда довша за 12 км — це вже не кордон, а зріз через воду/пустелю
    const LONG_KM = 12;

    const cats = { ru: [], by: [], eu: [] };
    let keptPts = 0, rawKept = 0;

    for (const enc of borders.land) {
        const pts = decodePolyline(enc);
        let run = [];
        const flush = () => {
            if (run.length >= 2) {
                rawKept += run.length;
                let piece = [], pieceCat = null;
                const pieces = [];
                for (const p of run) {
                    let cat = 'eu', best = Infinity;
                    for (const c of Object.keys(grids)) {
                        const d = grids[c].nearest(p, CAT_KM + 5);
                        if (d < best) { best = d; cat = CAT_ID[c]; }
                    }
                    if (best > CAT_KM) cat = 'eu';
                    if (cat !== pieceCat && piece.length) { pieces.push([pieceCat, piece]); piece = []; }
                    pieceCat = cat;
                    piece.push(p);
                }
                if (piece.length) pieces.push([pieceCat, piece]);
                // дрібні перемикання на стиках («ru→eu→ru») зливаємо в сусіда
                for (let i = 1; i < pieces.length - 1; i++) {
                    if (pieces[i][1].length < CAT_MIN_PTS && pieces[i - 1][0] === pieces[i + 1][0]) {
                        pieces[i][0] = pieces[i - 1][0];
                    }
                }
                for (const [cat, arr] of pieces) {
                    if (arr.length < 2) continue;
                    const s = simplify(arr, SIMPLIFY_DEG);
                    // обривки у 10–20 точок — це шум на стиках трійників,
                    // на карті вони виглядають як випадкові риски
                    if (s.length < 40) continue;
                    cats[cat].push(s);
                    keptPts += s.length;
                }
            }
            run = [];
        };
        for (const p of pts) {
            const nearUa = uaGrid.nearest(p, NEAR_UA) <= NEAR_UA;
            const sea = p[0] > SEA_LNG && p[1] < SEA_LAT;
            const sw = p[0] <= SW_LNG && p[1] >= SW_LAT;
            let nearForeign = false;
            if (nearUa && !sw) {
                for (const c of Object.keys(grids)) {
                    if (grids[c].nearest(p, CAT_KM) <= CAT_KM) { nearForeign = true; break; }
                }
            }
            if (!nearUa || sea || (!sw && !nearForeign)) { flush(); continue; }
            if (run.length) {
                const a = run[run.length - 1];
                const cos = Math.cos(a[1] * Math.PI / 180);
                if (Math.sqrt(dist2(a, p, cos)) > LONG_KM) flush();
            }
            run.push(p);
        }
        flush();
    }

    const meta = {
        ru: {
            name: { uk: 'Кордон з РФ', en: 'Border with Russia', ru: 'Граница с РФ' },
            short: { uk: 'РФ', en: 'RU', ru: 'РФ' },
            // кордон РФ більшу частину довжини лежить на ЧЕРВОНІЙ заливці
            // окупованої зони, тому йому потрібна світла підкладка, інакше
            // червоне на червоному не читається
            color: '#ff5b6b', width: 3.6, caseColor: '#ffffff', caseOpacity: 0.45
        },
        by: {
            name: { uk: 'Кордон з Білоруссю', en: 'Border with Belarus', ru: 'Граница с Беларусью' },
            short: { uk: 'Білорусь', en: 'Belarus', ru: 'Беларусь' },
            color: '#ffc857', width: 2.9, caseColor: '#ffffff', caseOpacity: 0.32
        },
        eu: {
            name: { uk: 'Кордон з ЄС / Молдовою', en: 'Border with EU / Moldova', ru: 'Граница с ЕС / Молдовой' },
            short: { uk: 'ЄС', en: 'EU', ru: 'ЕС' },
            color: '#72d7ff', width: 2.9, caseColor: '#ffffff', caseOpacity: 0.32
        }
    };

    const out = {
        v: 1,
        cats: Object.keys(cats).map(id => ({
            id,
            name: meta[id].name,
            short: meta[id].short,
            color: meta[id].color,
            width: meta[id].width,
            caseColor: meta[id].caseColor,
            caseOpacity: meta[id].caseOpacity,
            lines: cats[id].map(encodePolyline)
        }))
    };

    fs.writeFileSync(path.join(ROOT, 'assets/state-borders.js'),
        '/* LINESTATE — державні кордони України (OpenStreetMap, ODbL).\n' +
        '   Згенеровано scripts/build-state-borders.js: точні лінії borders.js,\n' +
        '   категорії — за найближчими областями сусідів із regions.js. */\n' +
        'window.LT_STATE_BORDERS = ' + JSON.stringify(out) + ';\n');

    const sz = fs.statSync(path.join(ROOT, 'assets/state-borders.js')).size;
    console.log('raw border points kept:', rawKept, 'simplified:', keptPts, 'size:', (sz / 1024).toFixed(1) + ' KB');
    for (const id of Object.keys(cats)) console.log(id, 'lines:', cats[id].length, 'pts:', cats[id].reduce((a, b) => a + b.length, 0));
}

main();
