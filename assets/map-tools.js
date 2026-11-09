(function () {
    'use strict';

    const isObject = l => l.kind === 'point' || l.kind === 'image';
    const validImage = value => typeof value === 'string' && value.length <= 1500000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';

    function installMapTools(map, options) {
        const opts = options || {};
        // лінії областей малюємо тією самою геометрією, що й підписи, без
        // окремого «грубого» шару: спрощення в MapLibre різало кордон довгими
        // хордами, і на карті зʼявлялася ламана лінія через пів області
        const regionLines = !!opts.regionLines;
        // стартовий стан перемикача: remount/setRegions можуть не прийти до
        // першого кадру, тож шари мусять народитись уже видимими
        let regions = opts.regionsOn === true;
        const REGION_LAYERS = ['lt-region-label']
            .concat(regionLines ? ['lt-region-casing', 'lt-region-line'] : []);
        const borderVis = {};
        const regionVis = () => (regions ? 'visible' : 'none');
        const regionField = () => {
            const lang = (window.LT && LT.lang()) || 'uk';
            const key = lang === 'en' ? 'name:en' : (lang === 'ru' ? 'name:ru' : 'name:uk');
            return ['coalesce', ['get', key], ['get', 'name:uk'], ['get', 'name:en']];
        };

        // у наборі є й сусідні області (Білорусь, Польща, Росія) з іншого джерела:
        // їхній контур іде поруч із українським і дає подвійну пунктирну лінію
        // вздовж державного кордону, тому малюємо тільки українські регіони
        const uaOnly = fc => ({
            type: 'FeatureCollection',
            features: fc.features.filter(f => f.properties && f.properties.c === 'UKR')
        });

        function mount() {
            const regionData = window.__ltRegionData || (window.__ltRegionData = (() => {
                const all = LT.geoRegions(window.LT_REGIONS_RAW);
                return { lines: uaOnly(all.lines), labels: uaOnly(all.labels) };
            })());

            if (!map.getSource('lt-region-labels')) {
                map.addSource('lt-region-labels', { type: 'geojson', data: regionData.labels, tolerance: 0 });
                const anchor = ((map.getStyle().layers || []).find(l => /^(?:f|p|l)_/.test(l.id)) || {}).id;
                const vis = regionVis();
                if (regionLines) {
                    map.addSource('lt-regions', { type: 'geojson', data: regionData.lines, tolerance: 0.4 });
                    const dash = [4, 3];
                    [
                        {
                            id: 'lt-region-casing', type: 'line', source: 'lt-regions',
                            layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
                            paint: {
                                'line-color': '#000000',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 8, 2.4, 11, 2.8],
                                'line-opacity': 0.36, 'line-blur': 0.3, 'line-dasharray': dash
                            }
                        },
                        {
                            id: 'lt-region-line', type: 'line', source: 'lt-regions',
                            layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
                            paint: {
                                'line-color': '#dbe4ef',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 8, 1.05, 11, 1.25],
                                'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 7, 0.62, 11, 0.72],
                                'line-dasharray': dash
                            }
                        }
                    ].forEach(l => map.addLayer(l, anchor));
                }
                map.addLayer({
                    id: 'lt-region-label', type: 'symbol', source: 'lt-region-labels',
                    layout: {
                        visibility: vis,
                        'text-field': regionField(),
                        'text-font': ['Noto Sans Regular'],
                        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 8, 11, 11, 13],
                        'text-letter-spacing': 0.24,
                        'text-transform': 'uppercase',
                        'text-max-width': 9,
                        'text-padding': 7,
                        'text-allow-overlap': false
                    },
                    paint: {
                        'text-color': 'rgba(230, 236, 243, .94)',
                        'text-halo-color': 'rgba(0, 0, 0, .92)',
                        'text-halo-width': 1.8,
                        'text-opacity': ['interpolate', ['linear'], ['zoom'], 5.2, 0, 6, 0.8, 9, 0.86, 11, 0.6, 12.2, 0.3]
                    }
                }, anchor);
            }
            mountBorders();
            mountRailways();
            try {
                map.setLight({ anchor: 'viewport', color: '#e5f6ff', intensity: 0.4, position: [1.4, 210, 40] });
            } catch (e) { }
        }

        // залізниці: класичний картографічний знак — біла підкладка, темна
        // основа, білий пунктир. Малює GPU шарами мапи, а не полотном: ліній
        // 2609 і ~70 тис. вершин, у кадрі 2D-полотно коштувало б десятки мс
        let railFC = null;
        let railsOn = true;
        const RAIL_LAYERS = ['lt-rail-casing', 'lt-rail-dash', 'lt-rail-casing-1m', 'lt-rail-dash-1m',
            'lt-rail-casing-1s', 'lt-rail-dash-1s', 'lt-rail-casing-2', 'lt-rail-dash-2'];

        function applyRailsVis() {
            RAIL_LAYERS.forEach(id => {
                if (map.getLayer(id)) {
                    map.setLayoutProperty(id, 'visibility', railsOn ? 'visible' : 'none');
                }
            });
        }

        function railKm(coords) {
            let s = 0;
            for (let i = 1; i < coords.length; i++) {
                const a = coords[i - 1], b = coords[i];
                const dx = (b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
                const dy = (b[1] - a[1]) * 111.32;
                s += Math.hypot(dx, dy);
            }
            return s;
        }

        function railData() {
            if (railFC !== null) return railFC;
            const raw = window.LT_RAILWAYS;
            if (!raw || !raw.lines || !LT.decodePolyline) return (railFC = false);
            const features = [];
            for (const l of raw.lines) {
                // третинні гілки — промислові тупики й під'їзні колії
                if (l.c === 3) continue;
                const coords = LT.decodePolyline(l.p);
                features.push({
                    type: 'Feature',
                    // len — довжина нитки в кілометрах: з огляду лишаємо тільки
                    // довгі коридори, короткі обривки з'являються на міському зумі
                    properties: { c: l.c, len: Math.round(railKm(coords)) },
                    geometry: { type: 'LineString', coordinates: coords }
                });
            }
            railFC = { type: 'FeatureCollection', features };
            return railFC;
        }

        function mountRailways() {
            if (map.getSource('lt-rail')) return;
            const data = railData();
            if (!data) return;
            // допуск у пікселях тайла: 0.9 прибирає зайві вершини на
            // регіональному огляді, а на міському масштабі тайл перебудовується
            // з тією ж точністю, тож лінія не грубішає
            map.addSource('lt-rail', { type: 'geojson', data, tolerance: 0.9 });
            const anchor = map.getLayer('lt-region-casing') ? 'lt-region-casing'
                : (map.getLayer('lt-region-label') ? 'lt-region-label' : undefined);
            // ширина залежить лише від зуму: MapLibre не дозволяє поєднати
            // ["zoom"] з властивістю обʼєкта в одному виразі line-width, тому
            // головні й другорядні лінії — окремі шари
            const fade = ['interpolate', ['linear'], ['zoom'], 5.2, 0, 5.9, 1];
            const width = arr => ['interpolate', ['linear'], ['zoom']].concat(arr);
            // біло-чорне чергування: біла підкладка й темний пунктир поверх.
            // з огляду видно тільки довгі головні коридори — саме вони читаються
            // як «залізниця країни». короткі обривки головних і всі другорядні
            // нитки підключаються на міському зумі, де є місце для деталі
            const layers = [
                { id: 'lt-rail-casing', color: '#fbf7ea', w: [5, 3.6, 7, 4.2, 10, 5.0, 14, 5.8], cap: 'round', dash: null },
                { id: 'lt-rail-dash', color: '#10151b', w: [5, 1.9, 7, 2.3, 10, 2.8, 14, 3.6], cap: 'butt', dash: [2.0, 2.0] }
            ];
            const tiers = [
                // каркас країни: тільки довгі вузлові магістралі (90+ км). з огляду
                // ці 60 ниток і є «залізниця країни»; усе коротше — вже міська сітка,
                // яка на такому масштабі перетворювала карту на білу павутину
                { suffix: '', filter: ['all', ['==', ['get', 'c'], 1], ['>=', ['get', 'len'], 90]], zoom: null, scale: 1 },
                // регіональні магістралі — з обласного огляду
                { suffix: '-1m', filter: ['all', ['==', ['get', 'c'], 1], ['>=', ['get', 'len'], 40], ['<', ['get', 'len'], 90]], zoom: 7.6, scale: 0.88 },
                // короткі обривки головних — тільки на міському масштабі
                { suffix: '-1s', filter: ['all', ['==', ['get', 'c'], 1], ['<', ['get', 'len'], 40]], zoom: 9.4, scale: 0.78 },
                // другорядні нитки — під'їзні до промвузлів, лише з близького зуму
                { suffix: '-2', filter: ['all', ['==', ['get', 'c'], 2], ['>=', ['get', 'len'], 40]], zoom: 9.8, scale: 0.62 }
            ];
            layers.forEach(l => {
                tiers.forEach(t => {
                    const paint = {
                        'line-color': l.color,
                        'line-width': width(l.w.map((v, i) => i % 2 ? +(v * t.scale).toFixed(2) : v)),
                        'line-opacity': t.zoom
                            ? ['interpolate', ['linear'], ['zoom'], t.zoom, 0, t.zoom + 0.6, 1]
                            : fade
                    };
                    if (l.dash) paint['line-dasharray'] = l.dash;
                    map.addLayer(Object.assign({
                        id: l.id + t.suffix, type: 'line', source: 'lt-rail',
                        filter: t.filter,
                        layout: { 'line-cap': l.cap, 'line-join': 'round' },
                        paint
                    }, t.zoom ? { minzoom: t.zoom } : {}), anchor);
                });
            });
            applyRailsVis();
        }

        // державні кордони: точні лінії OSM, розкладені на категорії ще на
        // етапі збірки (scripts/build-state-borders.js)
        function borderData() {
            if (window.__ltBorderData) return window.__ltBorderData;
            const raw = window.LT_STATE_BORDERS;
            if (!raw || !raw.cats) return null;
            const out = {};
            raw.cats.forEach(c => {
                const make = (line, thin) => {
                    const coords = LT.decodePolyline(line);
                    const f = {
                        type: 'Feature',
                        properties: { cat: c.id, thin: !!thin },
                        geometry: { type: 'LineString', coordinates: coords }
                    };
                    // рамка в градусах: за нею відсікаємо цілі лінії, не
                    // проєктуючи жодної вершини
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (let i = 0; i < coords.length; i++) {
                        const p = coords[i];
                        if (p[0] < x0) x0 = p[0];
                        if (p[0] > x1) x1 = p[0];
                        if (p[1] < y0) y0 = p[1];
                        if (p[1] > y1) y1 = p[1];
                    }
                    f._bb = [x0, y0, x1, y1];
                    // меркатор рахується один раз на завантаженні: у кадрі
                    // log/tan на кожну з 30 тисяч вершин коштували більше,
                    // ніж саме перетворення в екран
                    const m = new Float64Array(coords.length * 2);
                    for (let i = 0; i < coords.length; i++) {
                        m[i << 1] = mercX(coords[i][0]);
                        m[(i << 1) + 1] = mercY(coords[i][1]);
                    }
                    f._mx = m;
                    // меркаторська рамка: під нахилом екранну рамку лінії
                    // рахуємо за 4 кутами, не проєктуючи тисячі вершин
                    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
                    for (let i = 0; i < m.length; i += 2) {
                        const u = m[i], v = m[i + 1];
                        if (u < u0) u0 = u;
                        if (u > u1) u1 = u;
                        if (v < v0) v0 = v;
                        if (v > v1) v1 = v;
                    }
                    f._mbb = [u0, v0, u1, v1];
                    if (thin) f._thin = true;
                    return f;
                };
                const features = c.lines.map(line => make(line, false));
                // контури сусідніх країн — тонший шар під основним кордоном
                if (c.outline) c.outline.forEach(line => features.push(make(line, true)));
                out[c.id] = { meta: c, fc: { type: 'FeatureCollection', features } };
            });
            window.__ltBorderData = out;
            return out;
        }

        // кордони малюємо власним полотном поверх заливок зон. шари мапи
        // лежали під DOM-полотном blend, тому під окупованою територією лінія
        // кордону зникала — на карті це виглядало як «дірки» в кордоні
        let bHost = null, bCv = null, bCtx = null, bDirty = true;
        // DEM-тайли під нахилом приходять пачкою після зупинки камери. поки
        // вони течуть, точна проєкція бере висоти з неповного набору тайлів,
        // і контур стрибає кілька разів підряд. тому точний прохід — лише
        // після 140 мс затишшя, а під час підгрузки ведемо гомографією
        let bDemBusy = false, bQuietT = 0;

        function mercX(lon) { return (lon + 180) / 360; }
        // та сама формула, що в MapLibre: y = (1 - ln(tan(π/4 + φ/2)) / π) / 2
        function mercY(lat) {
            const φ = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
            return (1 - Math.log(Math.tan(Math.PI / 4 + φ / 2)) / Math.PI) / 2;
        }

        // плоска камера: перетворення «меркатор → екран» строго афінне, тому
        // коефіцієнти беруться з двох опорних точок і кожна вершина коштує
        // два множники замість map.project
        function flatProjector() {
            const c = map.getCenter();
            const p0 = map.project(c);
            const ep = 0.25;
            const pLon = map.project([c.lng + ep, c.lat]);
            const pLat = map.project([c.lng, c.lat + ep]);
            const mx0 = mercX(c.lng), my0 = mercY(c.lat);
            const dmx = mercX(c.lng + ep) - mx0;
            const dmy = mercY(c.lat + ep) - my0;
            if (!dmx || !dmy) return null;
            return {
                x0: p0.x, y0: p0.y, mx0, my0,
                a: (pLon.x - p0.x) / dmx, b: (pLat.x - p0.x) / dmy,
                d: (pLon.y - p0.y) / dmx, e: (pLat.y - p0.y) / dmy
            };
        }

        // перспективна камера відображає площину Меркатора на екран дробово-
        // лінійно: чотири кути кадру задають точну гомографію для будь-якої
        // вершини. на оглядовому зумі рельєф зсуває кордон у середньому на
        // 0.13 px (p95 — 0.6, максимум 1.7), тож вибірку DEM там не беремо,
        // а кожна вершина коштує 8 множників замість map.project (~10 мкс)
        function fitHomography(sw, sh) {
            const tr = map.transform;
            if (!tr || typeof tr.pointLocation !== 'function') return null;
            const q = [[0, 0], [sw, 0], [sw, sh], [0, sh]].map(([x, y]) => {
                const ll = tr.pointLocation({ x, y });
                return { u: mercX(ll.lng), v: mercY(ll.lat), x, y };
            });
            if (q.some(p => !isFinite(p.u) || !isFinite(p.v))) return null;
            const M = [];
            q.forEach(p => {
                M.push([p.u, p.v, 1, 0, 0, 0, -p.u * p.x, -p.v * p.x, p.x]);
                M.push([0, 0, 0, p.u, p.v, 1, -p.u * p.y, -p.v * p.y, p.y]);
            });
            for (let c = 0; c < 8; c++) {
                let r0 = c;
                for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[r0][c])) r0 = r;
                if (Math.abs(M[r0][c]) < 1e-12) return null;
                if (r0 !== c) { const t = M[c]; M[c] = M[r0]; M[r0] = t; }
                const d = M[c][c];
                for (let k = c; k <= 8; k++) M[c][k] /= d;
                for (let r = 0; r < 8; r++) {
                    if (r === c) continue;
                    const f = M[r][c];
                    if (!f) continue;
                    for (let k = c; k <= 8; k++) M[r][k] -= f * M[c][k];
                }
            }
            const s = M.map(r => r[8]);
            if (!s.every(Number.isFinite)) return null;
            return { a: s[0], b: s[1], c: s[2], d: s[3], e: s[4], f: s[5], g: s[6], h: s[7] };
        }

        // перо з відсіканням: перспектива за камерою дає координати в мільйони
        // пікселів, і полотно теселює такі відрізки майже як справжню лінію.
        // тому кожен відрізок відсікається рамкою кадру (Ліанг–Барскі) ще до
        // lineTo, а координати за рамкою не потрапляють у шлях узагалі
        const FRAME_M = 80;

        function makePen(ctx, sw, sh) {
            const X0 = -FRAME_M, Y0 = -FRAME_M, X1 = sw + FRAME_M, Y1 = sh + FRAME_M;
            let started = false, hasPrev = false, px = 0, py = 0;
            const seg = (x0, y0, x1, y1) => {
                const dx = x1 - x0, dy = y1 - y0;
                let t0 = 0, t1 = 1, r;
                if (dx === 0) { if (x0 < X0 || x0 > X1) return; }
                else if (dx > 0) {
                    r = (X0 - x0) / dx; if (r > t1) return; if (r > t0) t0 = r;
                    r = (X1 - x0) / dx; if (r < t0) return; if (r < t1) t1 = r;
                } else {
                    r = (X0 - x0) / dx; if (r < t0) return; if (r < t1) t1 = r;
                    r = (X1 - x0) / dx; if (r > t1) return; if (r > t0) t0 = r;
                }
                if (dy === 0) { if (y0 < Y0 || y0 > Y1) return; }
                else if (dy > 0) {
                    r = (Y0 - y0) / dy; if (r > t1) return; if (r > t0) t0 = r;
                    r = (Y1 - y0) / dy; if (r < t0) return; if (r < t1) t1 = r;
                } else {
                    r = (Y0 - y0) / dy; if (r < t0) return; if (r < t1) t1 = r;
                    r = (Y1 - y0) / dy; if (r > t1) return; if (r > t0) t0 = r;
                }
                if (t0 > t1) return;
                const ax = x0 + dx * t0, ay = y0 + dy * t0;
                if (!started || t0 > 0) { ctx.moveTo(ax, ay); started = true; }
                else ctx.lineTo(ax, ay);
                ctx.lineTo(x0 + dx * t1, y0 + dy * t1);
            };
            return {
                put(x, y) {
                    if (hasPrev) seg(px, py, x, y);
                    px = x; py = y; hasPrev = true;
                },
                cut() { started = false; hasPrev = false; }
            };
        }

        function paintFlatPath(mx, F, pen) {
            const n = mx.length >> 1;
            for (let i = 0; i < n; i++) {
                const dx = mx[i << 1] - F.mx0, dy = mx[(i << 1) + 1] - F.my0;
                pen.put(F.x0 + F.a * dx + F.b * dy, F.y0 + F.d * dx + F.e * dy);
            }
        }

        function paintHomogPath(mx, H, pen) {
            const n = mx.length >> 1;
            const a = H.a, b = H.b, c = H.c, d = H.d, e = H.e, f = H.f, g = H.g, h = H.h;
            for (let i = 0; i < n; i++) {
                const u = mx[i << 1], v = mx[(i << 1) + 1];
                const w = g * u + h * v + 1;
                // w <= 0 — точка за камерою: її екранна проєкція дзеркальна
                if (w < 1e-6) { pen.cut(); continue; }
                pen.put((a * u + b * v + c) / w, (d * u + e * v + f) / w);
            }
        }

        // рамка всієї лінії на екрані за гомографією: якщо всі кути merc-
        // рамки вийшли за один край кадру, лінію не проєктуємо взагалі.
        // під нахилом getBounds() розтягується до горизонту, тож без цього
        // відсікання в кадр потрапляли лінії за десятки кілометрів
        function boxOffscreen(mbb, H, sw, sh) {
            if (!mbb || !H) return false;
            const a = H.a, b = H.b, c = H.c, d = H.d, e = H.e, f = H.f, g = H.g, h = H.h;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < 4; i++) {
                const u = i & 1 ? mbb[2] : mbb[0];
                const v = i & 2 ? mbb[3] : mbb[1];
                const w = g * u + h * v + 1;
                if (w < 1e-6) return false;
                const x = (a * u + b * v + c) / w, y = (d * u + e * v + f) / w;
                if (!isFinite(x) || !isFinite(y)) return false;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            const M = FRAME_M + 120;
            return maxX < -M || minX > sw + M || maxY < -M || minY > sh + M;
        }

        // під нахилом на близькому зумі map.project тягне DEM на кожну
        // вершину (~7 мкс), тож шлях будується за адаптивними опорними
        // точками: середина ділянки проєктується точно, і якщо лінійна
        // інтерполяція розійшлася з нею більш ніж на AFF_TOL, ділянка
        // ділиться навпіл. похибка в кадрі лишається під пікселем
        const AFF_TOL = 0.8;

        function paintPitchedPath(pts, proj, st, pen, sw, sh) {
            const n = pts.length;
            const M = FRAME_M;
            // 0 — точка в кадрі (з запасом), інакше — умовна сторона екрана
            const side = p => p.x < -M ? 1 : p.x > sw + M ? 2 : p.y < -M ? 3 : p.y > sh + M ? 4 : 0;
            const exact = i => {
                const p = proj(pts[i][0], pts[i][1]);
                st.checks++;
                return (p && isFinite(p.x) && isFinite(p.y)) ? p : null;
            };
            const fill = (i0, p0, i1, p1, pm, depth) => {
                const im = (i0 + i1) >> 1;
                if (im <= i0) return;
                if (!pm) {
                    pm = exact(im);
                    if (!pm) {
                        pen.cut();
                        for (let i = i0 + 1; i < i1; i++) {
                            const q = exact(i);
                            if (q) pen.put(q.x, q.y); else pen.cut();
                        }
                        return;
                    }
                }
                const f = (im - i0) / (i1 - i0);
                const err = Math.hypot(pm.x - (p0.x + (p1.x - p0.x) * f), pm.y - (p0.y + (p1.y - p0.y) * f));
                if (err <= AFF_TOL || depth >= 6) {
                    // у максимум іде похибка лише прийнятої інтерполяції:
                    // ділянки, які діляться далі, лінію вже не формують
                    if (!side(pm) && err > st.err) st.err = err;
                    const dx = (p1.x - p0.x) / (i1 - i0), dy = (p1.y - p0.y) / (i1 - i0);
                    for (let i = i0 + 1; i < i1; i++) pen.put(p0.x + dx * (i - i0), p0.y + dy * (i - i0));
                } else {
                    fill(i0, p0, im, pm, null, depth + 1);
                    pen.put(pm.x, pm.y);
                    fill(im, pm, i1, p1, null, depth + 1);
                }
            };
            for (let s = 0; s < n; s += 48) {
                const e = Math.min(s + 48, n - 1);
                const p0 = exact(s);
                if (!p0) { pen.cut(); continue; }
                if (e === s) { pen.put(p0.x, p0.y); continue; }
                const p1 = exact(e);
                if (!p1) { pen.cut(); continue; }
                const pm = exact((s + e) >> 1);
                const s0 = side(p0), s1 = side(p1), sm = pm ? side(pm) : 0;
                // ділянка цілком за одним краєм кадру — креслити нічого
                if (s0 && s0 === s1 && s0 === sm) { pen.cut(); continue; }
                pen.put(p0.x, p0.y);
                fill(s, p0, e, p1, pm, 0);
                pen.put(p1.x, p1.y);
            }
        }

        function paintBorders() {
            if (!bCv) return;
            const src = map.getCanvas();
            const w = src.clientWidth || src.width;
            const h = src.clientHeight || src.height;
            if (!w || !h) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
            if (bCv.width !== pw || bCv.height !== ph) { bCv.width = pw; bCv.height = ph; }
            const ctx = bCtx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, pw, ph);
            paintBordersInto(ctx, dpr);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // той самий прохід, але в будь-якому масштабі: снимок карти рендериться
        // у 2K, тож кордони мають лягти різко, а не розтягнутою копією віконного
        // полотна
        function paintBordersInto(ctx, scale) {
            const data = borderData();
            if (!data) return;
            const t0 = performance.now();
            const st = { pts: 0, feats: 0, err: 0, checks: 0 };
            const view = map.getBounds();
            const vw = view.getWest() - 0.35, ve = view.getEast() + 0.35;
            const vs = view.getSouth() - 0.35, vn = view.getNorth() + 0.35;
            const zoom = map.getZoom();
            const pitched = (map.getPitch ? map.getPitch() : 0) > 0.5;
            const srcCv = map.getCanvas();
            const sw = srcCv.clientWidth || srcCv.width || 1280;
            const sh = srcCv.clientHeight || srcCv.height || 800;
            const flatP = pitched ? null : flatProjector();
            // під нахилом гомографія замінює по-вершинний map.project під час
            // руху камери: перспектива плоского Меркатора дробово-лінійна,
            // тож картинка та сама, а DEM-поправка (≤ пікселя на цих зумах)
            // повертається точним проходом на moveend
            const moving = (() => {
                try { return !!(map.isMoving() || map.isZooming() || map.isRotating() || map.isPitching()); }
                catch (e) { return false; }
            })();
            const homog = pitched ? fitHomography(sw, sh) : null;
            const fastPitch = pitched && homog && (moving || bDemBusy || zoom < 8.2);
            const proj = pitched ? ((lon, lat) => map.project([lon, lat])) : null;
            const pen = makePen(ctx, sw, sh);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            // три проходи: спершу тонкі контури сусідів, потім державний
            // кордон України, останнім — пунктир де-факто межі. так товста
            // лінія завжди перекриває тонку, а не навпаки
            ['thin', 'main', 'dash'].forEach(pass => {
                Object.keys(data).forEach(id => {
                    if (borderVis[id] === false) return;
                    const { meta, fc } = data[id];
                    const kind = meta.dash ? 'dash' : 'main';
                    // «thin» — окремий прохід для контурів сусідніх країн:
                    // раніше умова нижче відсікала його цілком, тож кордони
                    // МД–РО, HU–SK та інші не малювалися ніколи
                    if (pass !== 'thin' && kind !== pass) return;
                    const thin = pass === 'thin';
                    const core = thin ? '#e6ddc9' : (meta.color || '#eae3d3');
                    const base = meta.width || 2.6;
                    const wCore = (thin ? 1.4 : base) * (zoom < 6.5 ? 0.84 : 1);
                    const caseW = thin ? wCore + 0.8 : (pass === 'dash' ? wCore + 1.5 : wCore + 2.2);
                    const caseColor = thin ? 'rgba(8,11,16,.62)' : 'rgba(8,11,16,.72)';
                    ctx.globalAlpha = 1;
                    fc.features.forEach(f => {
                        if (!!f._thin !== thin) return;
                        const bb = f._bb;
                        if (bb && (bb[2] < vw || bb[0] > ve || bb[3] < vs || bb[1] > vn)) return;
                        // під нахилом рамка getBounds() сягає горизонту: лінії за
                        // десятки кілометрів проходили bbox-тест і проєктувалися
                        // по-вершинно. екранна рамка за mercator-кутами відсікає їх
                        if (pitched && boxOffscreen(f._mbb, homog, sw, sh)) return;
                        const pts = f.geometry.coordinates;
                        st.feats++;
                        st.pts += pts.length;
                        ctx.beginPath();
                        pen.cut();
                        if (pitched) {
                            if (fastPitch) paintHomogPath(f._mx, homog, pen);
                            else paintPitchedPath(pts, proj, st, pen, sw, sh);
                        } else if (flatP && f._mx) {
                            paintFlatPath(f._mx, flatP, pen);
                        } else {
                            let started = false;
                            for (let i = 0; i < pts.length; i++) {
                                const p = map.project([pts[i][0], pts[i][1]]);
                                if (!p || !isFinite(p.x) || !isFinite(p.y)) { started = false; continue; }
                                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                                else ctx.lineTo(p.x, p.y);
                            }
                        }
                        if (meta.dash) ctx.setLineDash(meta.dash);
                        // темна підкладка тримає лінію читабельною і на світлому
                        // лісі, і на темній заливці окупованої зони
                        ctx.strokeStyle = caseColor;
                        ctx.lineWidth = caseW;
                        ctx.stroke();
                        ctx.strokeStyle = core;
                        ctx.lineWidth = wCore;
                        ctx.stroke();
                        if (meta.dash) ctx.setLineDash([]);
                    });
                });
            });
            ctx.globalAlpha = 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            window.__ltBorderMs = {
                ms: +(performance.now() - t0).toFixed(2), feats: st.feats, pts: st.pts,
                checks: st.checks, err: +st.err.toFixed(2), hom: !!homog,
                z: +zoom.toFixed(2), pitch: +(map.getPitch() || 0).toFixed(0)
            };
        }

        function mountBorders() {
            if (bHost) { bDirty = true; return; }
            if (!borderData()) return;
            bHost = document.createElement('div');
            bHost.id = 'lt-borders';
            bHost.setAttribute('aria-hidden', 'true');
            bCv = document.createElement('canvas');
            bHost.appendChild(bCv);
            // під полотном малювання: анотації лишаються зверху
            const draw = document.getElementById('lt-draw-canvas');
            if (draw && draw.parentNode) draw.parentNode.insertBefore(bHost, draw);
            else document.body.appendChild(bHost);
            bCtx = bCv.getContext('2d');
            map.on('move', () => { bDirty = true; });
            map.on('resize', () => { bDirty = true; });
            // DEM-тайл під нахилом зсуває точку по екрану: кордон, намальований
            // до його завантаження, висів на пласкому профілі, поки камера
            // не рухалась. мапа при цьому render не шле, бо камера стоїть.
            // пачка тайлів дає один перемальов на затишші, а не стрибок на кожен
            map.on('sourcedata', e => {
                if (!e.tile || e.sourceId !== 'lt-dem' || !map.terrain) return;
                if (e.tile.state !== 'loaded') return;
                bDemBusy = true;
                clearTimeout(bQuietT);
                bQuietT = setTimeout(() => {
                    bDemBusy = false;
                    bDirty = true;
                    try { map.triggerRepaint(); } catch (err) { }
                }, 140);
            });
            // render приходить після кадру мапи: кордони лягають на той самий
            // ракурс, що й підкладка, і не «відʼїжджають» на жесті
            map.on('render', () => {
                if (!bDirty) return;
                bDirty = false;
                paintBorders();
            });
            map.on('remove', () => { clearTimeout(bQuietT); if (bHost) bHost.remove(); bHost = null; });
        }

        const syncRegionLang = () => {
            if (!map.getLayer('lt-region-label')) return;
            try { map.setLayoutProperty('lt-region-label', 'text-field', regionField()); } catch (e) { }
        };
        document.addEventListener('linetate:lang', syncRegionLang);
        map.on('remove', () => document.removeEventListener('linetate:lang', syncRegionLang));
        map.on('style.load', mount);
        if (map.isStyleLoaded()) mount();

        return {
            refresh: mount,
            setRegions(on) {
                regions = !!on;
                REGION_LAYERS.forEach(id => {
                    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', regions ? 'visible' : 'none');
                });
            },
            setRailways(on) {
                railsOn = !!on;
                applyRailsVis();
            },
            // кордони в снимок: малюємо їх у масштабі фото, не копією екранного
            // полотна — інакше лінія виходить удвічі тоншою й мильною
            snapBorders(ctx, W) {
                const src = map.getCanvas();
                const cssW = src.clientWidth || src.width;
                if (!cssW || !W) return;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                paintBordersInto(ctx, W / cssW);
                ctx.restore();
            },
            setBorder(id, on) {
                if (!id) return;
                borderVis[id] = !!on;
                bDirty = true;
                // перемальовуємо одразу й на вимкнення: нерухома карта не
                // шле подію render, інакше лінія висіла б до першого пану
                paintBorders();
            }
        };
    }

    function mapObjects(map, options) {
        const opts = options || {};
        const items = new Map();
        function drop(id) {
            const item = items.get(id);
            if (!item) return;
            item.marker.remove();
            items.delete(id);
        }
        function sync(l, fc, visible) {
            if (!isObject(l) || !fc.features.length) { drop(l.id); return; }
            const f = fc.features.find(f => f.geometry && f.geometry.type === 'Point');
            if (!f) { drop(l.id); return; }
            let item = items.get(l.id);
            if (!item) {
                const el = document.createElement('div');
                el.className = l.kind === 'image' ? 'lt-map-image' : 'lt-map-pin';
                if (opts.editable) el.classList.add('editable');
                if (l.kind === 'image') {
                    const img = document.createElement('img');
                    img.draggable = false;
                    el.appendChild(img);
                } else {
                    el.innerHTML = '<span class="pin-shadow"></span><span class="pin-stem"></span><span class="pin-face"></span><span class="pin-title"></span>';
                }
                const marker = new maplibregl.Marker({ element: el, anchor: l.kind === 'image' ? 'center' : 'bottom', draggable: !!opts.editable }).setLngLat(f.geometry.coordinates).addTo(map);
                item = { el, marker, layer: l };
                items.set(l.id, item);
                el.addEventListener('click', e => {
                    e.stopPropagation();
                    if (opts.onSelect) opts.onSelect(l.id, marker.getLngLat());
                });
                marker.on('dragstart', () => { if (opts.onDragStart) opts.onDragStart(); });
                marker.on('dragend', () => {
                    if (opts.onMove) opts.onMove(l.id, marker.getLngLat());
                });
            }
            item.layer = l;
            item.marker.setLngLat(f.geometry.coordinates);
            item.el.style.display = visible ? '' : 'none';
            item.el.style.setProperty('--object-size', l.style.markerSize + 'px');
            item.el.style.setProperty('--object-color', l.style.color);
            item.el.style.opacity = l.style.alpha;
            item.el.classList.toggle('no-shadow', !l.style.shadow);
            item.el.style.zIndex = String(10 + Math.round(l.z));
            item.el.title = l.desc ? l.name + ' — ' + l.desc : l.name;
            if (l.kind === 'image') {
                const img = item.el.querySelector('img');
                const uri = validImage(l.image);
                if (img.getAttribute('src') !== uri) img.src = uri;
                img.alt = l.name;
                img.style.width = l.style.markerSize + 'px';
                img.style.height = l.style.markerSize / (l.imageRatio || 1) + 'px';
            } else {
                const face = item.el.querySelector('.pin-face');
                face.className = 'pin-face icon-' + l.style.markerIcon;
                face.textContent = ({ dot: '•', diamond: '◆', cross: '+', flag: '' })[l.style.markerIcon] || '';
                item.el.querySelector('.pin-title').textContent = l.style.label ? l.style.labelText || l.name : '';
            }
        }
        function paintPhoto(ctx, W) {
            const scale = W / map.getCanvas().clientWidth;
            [...items.values()].sort((a, b) => a.layer.z - b.layer.z).forEach(item => {
                if (item.el.style.display === 'none') return;
                const l = item.layer;
                const p = map.project(item.marker.getLngLat());
                const size = l.style.markerSize * scale;
                ctx.save();
                ctx.globalAlpha = l.style.alpha;
                if (l.style.shadow) {
                    ctx.shadowColor = 'rgba(0,0,0,.7)';
                    ctx.shadowBlur = 10 * scale;
                    ctx.shadowOffsetY = 7 * scale;
                }
                if (l.kind === 'image') {
                    const img = item.el.querySelector('img');
                    if (img.complete && img.naturalWidth) ctx.drawImage(img, p.x * scale - size / 2, p.y * scale - size / (l.imageRatio || 1) / 2, size, size / (l.imageRatio || 1));
                } else {
                    const x = p.x * scale, y = p.y * scale - size * 0.5;
                    ctx.fillStyle = l.style.color;
                    ctx.beginPath();
                    ctx.arc(x, y, size * 0.42, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowColor = 'transparent';
                    ctx.strokeStyle = '#eaf5ff';
                    ctx.lineWidth = 2 * scale;
                    ctx.stroke();
                    if (l.style.markerIcon === 'flag') {
                        ctx.fillStyle = '#0057b7'; ctx.fillRect(x - size * 0.23, y - size * 0.16, size * 0.46, size * 0.16);
                        ctx.fillStyle = '#ffd700'; ctx.fillRect(x - size * 0.23, y, size * 0.46, size * 0.16);
                    } else {
                        ctx.fillStyle = '#ffffff';
                        ctx.font = '700 ' + size * 0.5 + 'px sans-serif';
                        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                        ctx.fillText(({ dot: '•', diamond: '◆', cross: '+' })[l.style.markerIcon], x, y);
                    }
                    if (l.style.label) {
                        ctx.font = '700 ' + 13 * scale + 'px sans-serif';
                        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                        ctx.strokeStyle = '#071019'; ctx.lineWidth = 4 * scale;
                        const name = l.style.labelText || l.name;
                        ctx.strokeText(name, x, p.y * scale + 4 * scale);
                        ctx.fillText(name, x, p.y * scale + 4 * scale);
                    }
                }
                ctx.restore();
            });
        }
        const manager = { sync, drop, paintPhoto };
        map._ltObjects = manager;
        return manager;
    }

    Object.assign(LT, { installMapTools, mapObjects, isObject, validImage });
})();
