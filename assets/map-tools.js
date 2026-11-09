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
        function railData() {
            if (railFC !== null) return railFC;
            const raw = window.LT_RAILWAYS;
            if (!raw || !raw.lines || !LT.decodePolyline) return (railFC = false);
            railFC = {
                type: 'FeatureCollection',
                features: raw.lines.map(l => ({
                    type: 'Feature',
                    properties: { c: l.c },
                    geometry: { type: 'LineString', coordinates: LT.decodePolyline(l.p) }
                }))
            };
            return railFC;
        }

        function mountRailways() {
            if (map.getSource('lt-rail')) return;
            const data = railData();
            if (!data) return;
            map.addSource('lt-rail', { type: 'geojson', data, tolerance: 0.5 });
            const anchor = map.getLayer('lt-region-casing') ? 'lt-region-casing'
                : (map.getLayer('lt-region-label') ? 'lt-region-label' : undefined);
            // ширина залежить лише від зуму: MapLibre не дозволяє поєднати
            // ["zoom"] з властивістю обʼєкта в одному виразі line-width, тому
            // головні й другорядні лінії — окремі шари
            const fade = ['interpolate', ['linear'], ['zoom'], 5.2, 0, 5.9, 1];
            const width = arr => ['interpolate', ['linear'], ['zoom']].concat(arr);
            // біло-чорне чергування: біла підкладка й темний пунктир поверх.
            // з оглядового зуму головні лінії вже читаються, другорядні
            // з'являються лише з z7, коли є місце для деталі. підкладка досить
            // товста, щоб чорний пунктир усередині не зникав на висоті —
            // інакше залізниця стає ще одним білим пунктиром замість нитки
            const layers = [
                { id: 'lt-rail-casing', color: '#fbf7ea', w: [5, 3.6, 7, 4.2, 10, 5.0, 14, 5.8], cap: 'round', dash: null },
                { id: 'lt-rail-dash', color: '#10151b', w: [5, 1.9, 7, 2.3, 10, 2.8, 14, 3.6], cap: 'butt', dash: [2.0, 2.0] }
            ];
            layers.forEach(l => {
                map.addLayer({
                    id: l.id, type: 'line', source: 'lt-rail',
                    filter: ['==', ['get', 'c'], 1],
                    layout: { 'line-cap': l.cap, 'line-join': 'round' },
                    paint: Object.assign({
                        'line-color': l.color,
                        'line-width': width(l.w),
                        'line-opacity': fade
                    }, l.dash ? { 'line-dasharray': l.dash } : {})
                }, anchor);
                map.addLayer({
                    id: l.id + '-2', type: 'line', source: 'lt-rail', minzoom: 7,
                    filter: ['!=', ['get', 'c'], 1],
                    layout: { 'line-cap': l.cap, 'line-join': 'round' },
                    paint: Object.assign({
                        'line-color': l.color,
                        'line-width': width(l.w.map((v, i) => i % 2 ? +(v * 0.72).toFixed(2) : v)),
                        'line-opacity': fade
                    }, l.dash ? { 'line-dasharray': l.dash } : {})
                }, anchor);
            });
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

        function mercX(lon) { return (lon + 180) / 360; }
        // та сама формула, що в MapLibre: y = (1 - ln(tan(π/4 + φ/2)) / π) / 2
        function mercY(lat) {
            const φ = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
            return (1 - Math.log(Math.tan(Math.PI / 4 + φ / 2)) / Math.PI) / 2;
        }

        // плоска камера: перетворення «меркатор → екран» строго афінне, тому
        // коефіцієнти беруться з двох опорних точок і кожна вершина коштує
        // два множники замість map.project. під нахилом рамка перспективна —
        // там вершини проєктуються як є
        function projector() {
            if ((map.getPitch ? map.getPitch() : 0) > 0.5) {
                return (lon, lat) => map.project([lon, lat]);
            }
            const c = map.getCenter();
            const p0 = map.project(c);
            const ep = 0.25;
            const pLon = map.project([c.lng + ep, c.lat]);
            const pLat = map.project([c.lng, c.lat + ep]);
            const mx0 = mercX(c.lng), my0 = mercY(c.lat);
            const dmx = mercX(c.lng + ep) - mx0;
            const dmy = mercY(c.lat + ep) - my0;
            if (!dmx || !dmy) return (lon, lat) => map.project([lon, lat]);
            const a = (pLon.x - p0.x) / dmx, b = (pLat.x - p0.x) / dmy;
            const d = (pLon.y - p0.y) / dmx, e = (pLat.y - p0.y) / dmy;
            return (lon, lat) => {
                const dx = mercX(lon) - mx0, dy = mercY(lat) - my0;
                return { x: p0.x + a * dx + b * dy, y: p0.y + d * dx + e * dy };
            };
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
            const data = borderData();
            if (!data) return;
            const view = map.getBounds();
            const vw = view.getWest() - 0.35, ve = view.getEast() + 0.35;
            const vs = view.getSouth() - 0.35, vn = view.getNorth() + 0.35;
            const zoom = map.getZoom();
            const proj = projector();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
                    if (kind !== pass) return;
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
                        const pts = f.geometry.coordinates;
                        let started = false;
                        ctx.beginPath();
                        for (let i = 0; i < pts.length; i++) {
                            const p = proj(pts[i][0], pts[i][1]);
                            if (!p || !isFinite(p.x) || !isFinite(p.y)) { started = false; continue; }
                            if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                            else ctx.lineTo(p.x, p.y);
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
            // render приходить після кадру мапи: кордони лягають на той самий
            // ракурс, що й підкладка, і не «відʼїжджають» на жесті
            map.on('render', () => {
                if (!bDirty) return;
                bDirty = false;
                paintBorders();
            });
            map.on('remove', () => { if (bHost) bHost.remove(); bHost = null; });
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
