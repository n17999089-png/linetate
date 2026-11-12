/* LINESTATE — збірка державних кордонів України.
 *
 * Основна геометрія: scripts/data/ua-border-ways.json — повний OSM relation
 * 60199 (Україна, admin_level=2, ODbL). Чужі кордони в цьому джерелі відсутні
 * структурно, тому жодна близькість до області не робить їх українськими.
 *
 * scripts/data/ne-boundary-lines.geojson — Natural Earth 10m Land: явні пари
 * ADM0_A3 UKR/neighbor розділяють суходільні ділянки за країнами й відсікають
 * морський контур relation 60199. NE також заповнює різбіжності генералізації.
 *
 * scripts/data/region-borders.json — окремий тонкий шар ЗОВНІШНІХ контурів
 * сусідів і пунктирне Придністров'я; він не змішується з основним кордоном.
 *
 * Оновлення OSM-джерела:
 *   [out:json][timeout:90];relation(60199);out geom;
 *   members way/outer geometry → масив [lng,lat] у ua-border-ways.json.
 *
 * Результат: assets/state-borders.js, polyline з точністю 1e5.
 * Запуск: node scripts/build-state-borders.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KM = 111.32;
const CAT_ID = { BLR: 'by', POL: 'pl', SVK: 'sk', HUN: 'hu', ROU: 'ro', MDA: 'md', RUS: 'ru' };
const LAND_KM = 12;
const MAX_STEP_KM = 15;
const DETAIL_KM = 0.0012;
const REGIONAL_KM = 0.0012 * KM;
const OVERVIEW_KM = 0.0035 * KM;

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

function dist2(a, b, cosLat) {
    const dx = (a[0] - b[0]) * cosLat * KM, dy = (a[1] - b[1]) * KM;
    return dx * dx + dy * dy;
}

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

function lenKm(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
        const cos = Math.cos(pts[i][1] * Math.PI / 180);
        L += Math.sqrt(dist2(pts[i - 1], pts[i], cos));
    }
    return L;
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

const pointKey = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);

// OSM ways мають довільний напрямок. Сшиваємо їх за спільними вузлами до
// спрощення: замість тисячі path-об'єктів лишаються повноцінні ділянки кордону.
function stitch(segments) {
    const used = new Uint8Array(segments.length);
    const ends = new Map();
    const register = (p, i) => {
        const k = pointKey(p);
        let a = ends.get(k);
        if (!a) ends.set(k, a = []);
        a.push(i);
    };
    segments.forEach((s, i) => { register(s[0], i); register(s[s.length - 1], i); });
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        let line = segments[i].slice();
        for (let side = 0; side < 2; side++) {
            for (;;) {
                const end = side ? line[0] : line[line.length - 1];
                const candidates = ends.get(pointKey(end));
                let next = -1;
                if (candidates) for (const j of candidates) if (!used[j]) { next = j; break; }
                if (next < 0) break;
                used[next] = 1;
                let pts = segments[next];
                if (side) {
                    if (pointKey(pts[pts.length - 1]) !== pointKey(end)) pts = pts.slice().reverse();
                    line = pts.slice(0, -1).concat(line);
                } else {
                    if (pointKey(pts[0]) !== pointKey(end)) pts = pts.slice().reverse();
                    line.push(...pts.slice(1));
                }
            }
        }
        if (line.length >= 2) out.push(line);
    }
    return out;
}

function main() {
    const cats = { ru: [], by: [], pl: [], sk: [], hu: [], ro: [], md: [] };
    const neLines = { ru: [], by: [], pl: [], sk: [], hu: [], ro: [], md: [] };
    const ne = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/ne-boundary-lines.geojson'), 'utf8'));

    for (const f of ne.features) {
        const pr = f.properties || {};
        if (pr.TYPE !== 'Land') continue;
        const a = pr.ADM0_A3_L, b = pr.ADM0_A3_R;
        if (a !== 'UKR' && b !== 'UKR') continue;
        const id = CAT_ID[a === 'UKR' ? b : a];
        if (!id) continue;
        const geo = f.geometry;
        const parts = geo.type === 'LineString' ? [geo.coordinates]
            : (geo.type === 'MultiLineString' ? geo.coordinates : []);
        for (const line of parts) if (line && line.length >= 2) neLines[id].push(line);
    }
    for (const id of Object.keys(cats)) {
        if (!neLines[id].length) throw new Error('Natural Earth: немає явної пари UKR/' + id);
    }

    const refGrids = {};
    for (const id of Object.keys(cats)) {
        const pts = [];
        neLines[id].forEach(line => pts.push(...densify(line, 0.005)));
        refGrids[id] = makeGrid(pts);
    }
    const classify = p => {
        let id = null, best = Infinity;
        for (const cat of Object.keys(refGrids)) {
            const d = refGrids[cat].nearest(p, LAND_KM + 2);
            if (d < best) { best = d; id = cat; }
        }
        return best <= LAND_KM ? { id, km: best } : null;
    };

    const uaWays = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/ua-border-ways.json'), 'utf8'));
    const segments = { ru: [], by: [], pl: [], sk: [], hu: [], ro: [], md: [] };
    let rawKept = 0, seaPts = 0;

    for (const way of uaWays) {
        let run = [], runCat = null;
        const flush = () => {
            if (runCat && run.length >= 2) {
                segments[runCat].push(run);
                rawKept += run.length;
            }
            run = [];
            runCat = null;
        };
        for (const p of way) {
            const hit = classify(p);
            if (!hit) { seaPts++; flush(); continue; }
            if (runCat && hit.id !== runCat) {
                run.push(p);
                flush();
            } else if (run.length) {
                const prev = run[run.length - 1];
                const cos = Math.cos(prev[1] * Math.PI / 180);
                if (Math.sqrt(dist2(prev, p, cos)) > MAX_STEP_KM) flush();
            }
            runCat = hit.id;
            run.push(p);
        }
        flush();
    }

    let keptPts = 0;
    for (const id of Object.keys(cats)) {
        cats[id] = stitch(segments[id]).map(line => simplify(line, DETAIL_KM)).filter(line => line.length >= 2);
        keptPts += cats[id].reduce((n, line) => n + line.length, 0);
    }

    // NE — не друга паралельна лінія, а страховка повноти: додаються лише ті
    // суходільні ділянки, яких справді немає в точному OSM-контурі.
    let gapRuns = 0, gapPts = 0;
    for (const id of Object.keys(cats)) {
        const coverPts = [], existing = [];
        cats[id].forEach(line => { coverPts.push(...densify(line, 0.01)); existing.push(...line); });
        const cover = makeGrid(coverPts);
        const snap = p => {
            let best = null, bd = 8 * 8;
            const cos = Math.cos(p[1] * Math.PI / 180);
            for (const q of existing) {
                const d = dist2(p, q, cos);
                if (d < bd) { bd = d; best = q; }
            }
            return best || p;
        };
        for (const source of neLines[id]) {
            const pts = densify(source, 0.01);
            let run = [];
            const flush = () => {
                if (run.length >= 2 && lenKm(run) >= 0.25) {
                    const s = simplify(run, DETAIL_KM);
                    s[0] = snap(s[0]);
                    s[s.length - 1] = snap(s[s.length - 1]);
                    if (s.length >= 2) {
                        cats[id].push(s);
                        gapRuns++;
                        gapPts += s.length;
                    }
                }
                run = [];
            };
            for (let i = 0; i < pts.length; i++) {
                if (cover.nearest(pts[i], 4) > 2.2) {
                    if (!run.length && i) run.push(pts[i - 1]);
                    run.push(pts[i]);
                } else flush();
            }
            flush();
        }
    }

    // Повнота перевіряється для кожної країни незалежно: жоден суходільний
    // NE-вузол не може лишитися далі ніж 3 км від згенерованого кордону.
    const coverage = {};
    for (const id of Object.keys(cats)) {
        const pts = [];
        cats[id].forEach(line => pts.push(...densify(line, 0.01)));
        const grid = makeGrid(pts);
        let worst = 0, checked = 0;
        for (const source of neLines[id]) {
            for (const p of densify(source, 0.02)) {
                worst = Math.max(worst, grid.nearest(p, 5));
                checked++;
            }
        }
        if (!(worst <= 3)) throw new Error('Дірка в кордоні ' + id + ': ' + worst.toFixed(2) + ' км');
        coverage[id] = { checked, worstKm: +worst.toFixed(2) };
    }

    const regionPath = path.join(ROOT, 'scripts/data/region-borders.json');
    const region = fs.existsSync(regionPath) ? JSON.parse(fs.readFileSync(regionPath, 'utf8')) : null;
    const outlines = {};
    let pmrLines = null;
    if (region) {
        for (const id of Object.keys(cats)) {
            if (region.outline && region.outline[id] && region.outline[id].length) outlines[id] = region.outline[id];
        }
        if (region.pmr && region.pmr.length) pmrLines = region.pmr;
    } else {
        console.warn('region-borders.json відсутній — контури сусідів не додано');
    }

    const BORDER_COLOR = '#eee3cc';
    const meta = {
        ru: { name: { uk: 'Кордон з РФ', en: 'Border with Russia', ru: 'Граница с РФ' }, short: { uk: 'РФ', en: 'RU', ru: 'РФ' }, color: BORDER_COLOR, width: 3.2 },
        by: { name: { uk: 'Кордон з Білоруссю', en: 'Border with Belarus', ru: 'Граница с Беларусью' }, short: { uk: 'Білорусь', en: 'Belarus', ru: 'Беларусь' }, color: BORDER_COLOR, width: 2.7 },
        pl: { name: { uk: 'Кордон з Польщею', en: 'Border with Poland', ru: 'Граница с Польшей' }, short: { uk: 'Польща', en: 'Poland', ru: 'Польша' }, color: BORDER_COLOR, width: 2.7 },
        sk: { name: { uk: 'Кордон зі Словаччиною', en: 'Border with Slovakia', ru: 'Граница со Словакией' }, short: { uk: 'Словаччина', en: 'Slovakia', ru: 'Словакия' }, color: BORDER_COLOR, width: 2.5 },
        hu: { name: { uk: 'Кордон з Угорщиною', en: 'Border with Hungary', ru: 'Граница с Венгрией' }, short: { uk: 'Угорщина', en: 'Hungary', ru: 'Венгрия' }, color: BORDER_COLOR, width: 2.5 },
        ro: { name: { uk: 'Кордон з Румунією', en: 'Border with Romania', ru: 'Граница с Румынией' }, short: { uk: 'Румунія', en: 'Romania', ru: 'Румыния' }, color: BORDER_COLOR, width: 2.7 },
        md: { name: { uk: 'Кордон з Молдовою', en: 'Border with Moldova', ru: 'Граница с Молдовой' }, short: { uk: 'Молдова', en: 'Moldova', ru: 'Молдова' }, color: BORDER_COLOR, width: 2.7 },
        pmr: { name: { uk: 'Придністров’я (де-факто)', en: 'Transnistria (de facto)', ru: 'Приднестровье (де-факто)' }, short: { uk: 'Придністров’я', en: 'Transnistria', ru: 'Приднестровье' }, color: BORDER_COLOR, width: 2.5 }
    };

    const outCats = Object.keys(cats).map(id => {
        const cat = {
            id,
            name: meta[id].name,
            short: meta[id].short,
            color: meta[id].color,
            width: meta[id].width,
            lines: cats[id].map(encodePolyline),
            // На региональному й оглядовому зумі похибка менша за піксель;
            // повні lines лишаються недоторканими для міського масштабу.
            regional: cats[id].map(line => simplify(line, REGIONAL_KM)).filter(line => line.length >= 2).map(encodePolyline),
            overview: cats[id].map(line => simplify(line, OVERVIEW_KM)).filter(line => line.length >= 2).map(encodePolyline)
        };
        if (outlines[id]) cat.outline = outlines[id];
        return cat;
    });
    if (pmrLines) {
        outCats.push({ id: 'pmr', name: meta.pmr.name, short: meta.pmr.short, color: meta.pmr.color, width: meta.pmr.width, lines: pmrLines });
    }

    const out = { v: 6, cats: outCats };
    fs.writeFileSync(path.join(ROOT, 'assets/state-borders.js'),
        '/* LINESTATE — державні кордони України (OSM relation 60199, ODbL).\n' +
        '   Країна-сусід і суходіл — лише за явними парами UKR у Natural Earth 10m Land.\n' +
        '   Згенеровано scripts/build-state-borders.js; чужі контури — окремий outline. */\n' +
        'window.LT_STATE_BORDERS = ' + JSON.stringify(out) + ';\n');

    const sz = fs.statSync(path.join(ROOT, 'assets/state-borders.js')).size;
    console.log('OSM points: land', rawKept, 'sea/other', seaPts, 'simplified', keptPts,
        'NE gaps', gapRuns + '/' + gapPts, 'size', (sz / 1024).toFixed(1) + ' KB');
    for (const id of Object.keys(cats)) {
        console.log(id, 'lines', cats[id].length, 'pts', cats[id].reduce((n, line) => n + line.length, 0), 'coverage', coverage[id]);
    }
    console.log('pmr lines:', pmrLines ? pmrLines.length : 0);
}

main();
