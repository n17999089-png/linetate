/* LINESTATE — збірка державних кордонів України.
 *
 * Джерела:
 *   assets/regions.js — області UA/BY/PL/RU (ними ж визначаємо, з якою
 *                        країною межує ділянка кордону);
 *   assets/borders.js — точні лінії кордонів OSM (ODbL);
 *   scripts/data/ua-border-ways.json — лінії кордону України з OSM
 *                        (relation 60199): ними закриваємо дірки, яких
 *                        немає в borders.js (Придністров'я, шов Дунаю);
 *   scripts/data/region-borders.json — згенеровані
 *                        scripts/build-region-borders.js контури сусідніх
 *                        країн (Польща, Словаччина, Угорщина, Румунія,
 *                        Білорусь, Молдова, РФ) і де-факто межа
 *                        Придністров'я.
 *
 * Результат: assets/state-borders.js — категорії за країнами-сусідами
 * (РФ, Білорусь, Польща, Словаччина, Угорщина, Румунія, Молдова) плюс
 * пунктирне Придністров'я; кожна лінія стиснена polyline з точністю 1e5.
 * Переглядач лише декодує готові лінії, жодних обчислень у кадрі.
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

// ребра контурів бувають довгими: точка посередині ребра далі за поріг від
// будь-якої ВЕРШИНИ, хоча лежить на самій лінії. крок ~4 км робить відстань
// до сітки фактично відстанню до контуру
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
        if (row[1] === 'UKR') ua.push(...densify(pts, 0.04));
        else if (byCountry[row[1]]) byCountry[row[1]].push(...pts);
    });

    const uaGrid = makeGrid(ua);
    const CAT_ID = { BLR: 'by', POL: 'pl', RUS: 'ru' };
    const grids = {};
    for (const c of Object.keys(byCountry)) grids[c] = makeGrid(byCountry[c]);

    // області сусідів у regions.js є лише для BY/PL/RU. західні й південні
    // ділянки (Словаччина, Угорщина, Румунія, Молдова) класифікуємо за
    // географією: трикутники кордонів там відомі з точністю до десятків км
    function westCat(p) {
        const lng = p[0], lat = p[1];
        if (lat < 45.55 && lng > 28.0) return 'ro';   // Дунай, південь Одещини
        if (lng < 28.25 && lat < 47.95) return 'ro';  // Прут: кордон з Румунією
        if (lng < 22.9 && lat < 48.42) return 'hu';   // Закарпаття, південь
        if (lng < 22.58 && lat < 49.1) return 'sk';   // Закарпаття, захід
        if (lng >= 26.55) return 'md';                // Дністер + Придністров'я
        if (lat > 47.6 && lat < 48.6) return 'ro';    // Чернівеччина, північ
        return 'pl';
    }

    // за трикутниками кордонів починаються ВНУТРІШНІ кордони сусідів
    // (PL-SK, HU-SK, HU-RO). вони теж близькі до контуру України, тому
    // потрапляли в набір як зайві «хвости». ріжемо їх за трикутниками
    function keepWest(p) {
        const lng = p[0], lat = p[1];
        if (lat < 46.0) return lng > 28.0 && lng < 29.8; // Дунай: лише суходіл до моря
        if (lng < 23.2 && lat < 49.4) {
            if (lat < 47.94) return false;
            if (lng < 22.13 && lat < 48.6) return false;
            if (lng < 22.5 && lat > 49.05) return false;
        }
        return true;
    }

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

    const cats = { ru: [], by: [], pl: [], sk: [], hu: [], ro: [], md: [] };
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
                    if (best > CAT_KM) cat = westCat(p);
                    // сітка польських областей ловить і верхню ділянку
                    // кордону зі Словаччиною (вона за 40 км від Polish regions):
                    // у закарпатському трикутнику географія точніша
                    else if (p[0] < 22.9 && p[1] < 49.1) cat = westCat(p);
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
                    // зовсім дрібні обривки (< 1.2 км) — шум на стиках.
                    // короткі, але СПРАВЖНі ділянки (Дунай біля Рені, край
                    // молдовської петлі) лишаємо: інакше в кордоні дірки
                    if (s.length < 2 || (s.length < 12 && lenKm(s) < 1.2)) continue;
                    cats[cat].push(s);
                    keptPts += s.length;
                }
            }
            run = [];
        };
        for (const p of pts) {
            const nearUa = uaGrid.nearest(p, NEAR_UA) <= NEAR_UA;
            // Чорне море на схід від Криму + узбережжя Азову на захід від
            // гирла Кальміусу (там кордон виходить до моря біля 38.2°):
            // морські межі й берегові лінії — не державний кордон на суходолі
            const sea = (p[0] > SEA_LNG && p[1] < SEA_LAT)
                || (p[1] < 47.05 && p[0] > 32.4 && p[0] < 38.2);
            const sw = p[0] <= SW_LNG && p[1] >= SW_LAT;
            let nearForeign = false;
            if (nearUa && !sw) {
                for (const c of Object.keys(grids)) {
                    if (grids[c].nearest(p, CAT_KM) <= CAT_KM) { nearForeign = true; break; }
                }
            }
            if (!nearUa || sea || !keepWest(p) || (!sw && !nearForeign)) { flush(); continue; }
            if (run.length) {
                const a = run[run.length - 1];
                const cos = Math.cos(a[1] * Math.PI / 180);
                if (Math.sqrt(dist2(a, p, cos)) > LONG_KM) flush();
            }
            run.push(p);
        }
        flush();
    }

    // borders.js місцями має дірки (Придністров'я, шов Дунаю): між сусідніми
    // вершинами десятки кілометрів. Закриваємо їх двома джерелами:
    //   ua-border-ways.json — межа України з OSM (relation 60199), точна,
    //                         але є лише для Молдови;
    //   ne-boundary-lines.geojson — Natural Earth 10m, одна повна лінія на
    //                         кожну пару країн (BY/PL/SK/HU/RO/MD/RU з UA).
    // з кожного джерела беремо ЛИШЕ ділянки, не покриті вже наявною
    // геометрією — дірки закриваються, а паралельних ліній не з'являється
    const uaWays = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/ua-border-ways.json'), 'utf8'));

    const isSea = p => (p[0] > SEA_LNG && p[1] < SEA_LAT)
        || (p[1] < 47.05 && p[0] > 32.4 && p[0] < 38.2);

    function fillGaps(lines, forcedCat, label, opt) {
        const o = Object.assign({ covKm: 1.5, minGapKm: 0.6, snapKm: 6, endsOnly: false }, opt);
        const keptAll = [];
        const coverPts = [];
        const ends = [];
        for (const id of Object.keys(cats)) {
            for (const s of cats[id]) {
                keptAll.push(...s);
                coverPts.push(...densify(s, 0.01));
                ends.push(s[0], s[s.length - 1]);
            }
        }
        const cover = makeGrid(coverPts);
        const endGrid = o.endsOnly ? makeGrid(ends) : null;
        const snapEnd = p => {
            let best = null, bd = o.snapKm * o.snapKm;
            const cos = Math.cos(p[1] * Math.PI / 180);
            for (const q of (o.endsOnly ? ends : keptAll)) {
                const d = dist2(p, q, cos);
                if (d < bd) { bd = d; best = q; }
            }
            return best || p;
        };
        const catAt = p => {
            if (forcedCat) return forcedCat;
            let cat = null, best = Infinity;
            for (const c of Object.keys(grids)) {
                const d = grids[c].nearest(p, CAT_KM + 5);
                if (d < best) { best = d; cat = CAT_ID[c]; }
            }
            if (best > CAT_KM || (p[0] < 22.9 && p[1] < 49.1)) cat = westCat(p);
            return cat;
        };
        let runs = 0, ptsN = 0, skipped = 0;
        for (const src of lines) {
            const pts = densify(src, 0.01);
            let run = [];
            const flush = () => {
                // дрібні «хвости» NE, що просто звисають паралельно вже
                // наявній лінії, — не дірка: довжина й обидва кінці
                // мусять чіплятися за кінці наявних ліній
                const hangA = o.endsOnly && run.length >= 2 ? endGrid.nearest(run[0], o.snapKm) : 0;
                const hangB = o.endsOnly && run.length >= 2 ? endGrid.nearest(run[run.length - 1], o.snapKm) : 0;
                const usable = run.length >= 2 && lenKm(run) >= o.minGapKm
                    && (!o.endsOnly || (hangA <= o.snapKm && hangB <= o.snapKm));
                if (usable) {
                    // ділянка може перетинати межу категорій — ріжемо за країною
                    let piece = [], pieceCat = null;
                    const put = (cat, arr) => {
                        if (!cats[cat] || arr.length < 2) return;
                        const s = simplify(arr, SIMPLIFY_DEG);
                        if (s.length < 2 || lenKm(s) < 0.6) return;
                        // стик зі збереженими лініями: краї до найближчої вершини
                        s[0] = snapEnd(s[0]);
                        s[s.length - 1] = snapEnd(s[s.length - 1]);
                        cats[cat].push(s);
                        runs++;
                        ptsN += s.length;
                    };
                    for (const p of run) {
                        const cat = catAt(p);
                        if (cat !== pieceCat && piece.length) { put(pieceCat, piece); piece = []; }
                        pieceCat = cat;
                        piece.push(p);
                    }
                    if (piece.length) put(pieceCat, piece);
                } else if (run.length >= 2) skipped++;
                run = [];
            };
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const uncovered = !isSea(p) && keepWest(p) && cover.nearest(p, o.covKm + 2) > o.covKm;
                if (uncovered) {
                    if (!run.length && i) run.push(pts[i - 1]);
                    run.push(p);
                } else flush();
            }
            flush();
        }
        console.log(label + ' gap fill: runs', runs, 'pts', ptsN, 'skipped', skipped);
    }

    fillGaps(uaWays, null, 'OSM');

    // Natural Earth 10m: по одній повній лінії на пару країн. Категорію тут
    // знаємо точно з пари ADM0_A3, тому не вгадуємо її за географією
    const NE_CAT = { BLR: 'by', POL: 'pl', SVK: 'sk', HUN: 'hu', ROU: 'ro', MDA: 'md', RUS: 'ru' };
    const nePath = path.join(ROOT, 'scripts/data/ne-boundary-lines.geojson');
    if (fs.existsSync(nePath)) {
        const ne = JSON.parse(fs.readFileSync(nePath, 'utf8'));
        for (const id of Object.keys(NE_CAT)) {
            const lines = [];
            for (const f of ne.features) {
                const pr = f.properties || {};
                if (pr.TYPE !== 'Land') continue;
                const a = pr.ADM0_A3_L, b = pr.ADM0_A3_R;
                if (a !== 'UKR' && b !== 'UKR') continue;
                if ((a === 'UKR' ? b : a) !== id) continue;
                const geo = f.geometry;
                const parts = geo.type === 'LineString' ? [geo.coordinates]
                    : (geo.type === 'MultiLineString' ? geo.coordinates : []);
                for (const ln of parts) if (ln && ln.length >= 2) lines.push(ln);
            }
            if (lines.length) fillGaps(lines, NE_CAT[id], 'NE ' + id,
                { covKm: 2.5, minGapKm: 3, snapKm: 8, endsOnly: true });
        }
    }


    // повні контури сусідніх країн: тонкі лінії, які домалюють кордон
    // Польщі з Чехією, Білорусі з Литвою тощо. з Україною їх не дублюємо —
    // ці ділянки вже є вище. Придністров'я йде окремою пунктирною категорією
    const regionPath = path.join(ROOT, 'scripts/data/region-borders.json');
    const region = fs.existsSync(regionPath) ? JSON.parse(fs.readFileSync(regionPath, 'utf8')) : null;
    const outlines = {};
    // region-borders.json зберігає ВЖЕ закодовані polyline: їх не можна
    // класти в cats (там масиви точок, які кодуються нижче) — інакше
    // рядок перекодовується як координати й лінія розсипається в нулі
    let pmrLines = null;
    if (region) {
        for (const id of Object.keys(cats)) {
            if (region.outline && region.outline[id] && region.outline[id].length) {
                outlines[id] = region.outline[id];
            }
        }
        if (region.pmr && region.pmr.length) pmrLines = region.pmr;
    } else {
        console.warn('region-borders.json відсутній — контури сусідів не додано');
    }

    // стандартний картографічний дизайн: одна тепла слонова лінія з темною
    // підкладкою для всіх країн. колір не кодує країну — її показує прапор
    // у перемикачі. товщина ледь різна: кордон РФ читається на червоній
    // заливці окупованої зони, тому він трохи ширший
    const BORDER_COLOR = '#e9e2d0';
    const meta = {
        ru: {
            name: { uk: 'Кордон з РФ', en: 'Border with Russia', ru: 'Граница с РФ' },
            short: { uk: 'РФ', en: 'RU', ru: 'РФ' },
            color: BORDER_COLOR, width: 3.4
        },
        by: {
            name: { uk: 'Кордон з Білоруссю', en: 'Border with Belarus', ru: 'Граница с Беларусью' },
            short: { uk: 'Білорусь', en: 'Belarus', ru: 'Беларусь' },
            color: BORDER_COLOR, width: 2.8
        },
        pl: {
            name: { uk: 'Кордон з Польщею', en: 'Border with Poland', ru: 'Граница с Польшей' },
            short: { uk: 'Польща', en: 'Poland', ru: 'Польша' },
            color: BORDER_COLOR, width: 2.8
        },
        sk: {
            name: { uk: 'Кордон зі Словаччиною', en: 'Border with Slovakia', ru: 'Граница со Словакией' },
            short: { uk: 'Словаччина', en: 'Slovakia', ru: 'Словакия' },
            color: BORDER_COLOR, width: 2.6
        },
        hu: {
            name: { uk: 'Кордон з Угорщиною', en: 'Border with Hungary', ru: 'Граница с Венгрией' },
            short: { uk: 'Угорщина', en: 'Hungary', ru: 'Венгрия' },
            color: BORDER_COLOR, width: 2.6
        },
        ro: {
            name: { uk: 'Кордон з Румунією', en: 'Border with Romania', ru: 'Граница с Румынией' },
            short: { uk: 'Румунія', en: 'Romania', ru: 'Румыния' },
            color: BORDER_COLOR, width: 2.8
        },
        md: {
            name: { uk: 'Кордон з Молдовою', en: 'Border with Moldova', ru: 'Граница с Молдовой' },
            short: { uk: 'Молдова', en: 'Moldova', ru: 'Молдова' },
            color: BORDER_COLOR, width: 2.8
        },
        // Придністров'я малюємо як повноцінну межу, а не тонким пунктиром
        // області: пунктир читався як внутрішній регіон, і здавалося, що
        // кордон є лише в України
        pmr: {
            name: { uk: 'Придністров’я (де-факто)', en: 'Transnistria (de facto)', ru: 'Приднестровье (де-факто)' },
            short: { uk: 'Придністров’я', en: 'Transnistria', ru: 'Приднестровье' },
            color: BORDER_COLOR, width: 2.6
        }
    };

    const outCats = Object.keys(cats).map(id => {
        const cat = {
            id,
            name: meta[id].name,
            short: meta[id].short,
            color: meta[id].color,
            width: meta[id].width,
            lines: cats[id].map(encodePolyline)
        };
        if (meta[id].dash) cat.dash = meta[id].dash;
        if (outlines[id]) cat.outline = outlines[id];
        return cat;
    });
    if (pmrLines) {
        outCats.push({
            id: 'pmr',
            name: meta.pmr.name,
            short: meta.pmr.short,
            color: meta.pmr.color,
            width: meta.pmr.width,
            dash: meta.pmr.dash,
            lines: pmrLines
        });
    }

    const out = { v: 3, cats: outCats };

    fs.writeFileSync(path.join(ROOT, 'assets/state-borders.js'),
        '/* LINESTATE — державні кордони України (OpenStreetMap, ODbL).\n' +
        '   Згенеровано scripts/build-state-borders.js: точні лінії borders.js,\n' +
        '   категорії — за найближчими областями сусідів із regions.js. */\n' +
        'window.LT_STATE_BORDERS = ' + JSON.stringify(out) + ';\n');

    const sz = fs.statSync(path.join(ROOT, 'assets/state-borders.js')).size;
    console.log('raw border points kept:', rawKept, 'simplified:', keptPts, 'size:', (sz / 1024).toFixed(1) + ' KB');
    for (const id of Object.keys(cats)) console.log(id, 'lines:', cats[id].length, 'pts:', cats[id].reduce((a, b) => a + b.length, 0));
    console.log('pmr lines:', pmrLines ? pmrLines.length : 0);
}

main();
