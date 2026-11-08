(function () {
    'use strict';

    const isObject = l => l.kind === 'point' || l.kind === 'image';
    const validImage = value => typeof value === 'string' && value.length <= 1500000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';

    function installMapTools(map, options) {
        const opts = options || {};
        // контури областей низькополігонні: довгі хорди ріжуть фронт навпіл
        // (скарга зі скріна під Запорізьким). У переглядачі їх більше немає
        // взагалі — лишились тільки підписи областей. Адмінці лінії потрібні
        // для орієнтування, тому вона вмикає їх окремим прапорцем.
        const regionLines = !!opts.regionLines;
        let regions = false;
        const REGION_LAYERS = ['lt-region-label']
            .concat(regionLines ? ['lt-region-casing', 'lt-region-line', 'lt-region-lo-casing', 'lt-region-lo-line'] : []);
        // за цим зумом показуємо грубшу геометрію: на дрібному масштабі деталі все одно не видно
        const LOD_Z = 7;
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
                    map.addSource('lt-regions', { type: 'geojson', data: regionData.lines, tolerance: 0.5 });
                    map.addSource('lt-regions-lo', { type: 'geojson', data: regionData.lines, tolerance: 2.2 });
                    const dash = [4, 3];
                    [
                        {
                            id: 'lt-region-casing', type: 'line', source: 'lt-regions', minzoom: LOD_Z + 1,
                            layout: { visibility: vis },
                            paint: {
                                'line-color': '#000000',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.1, 8, 2.5, 11, 3],
                                'line-opacity': 0.42, 'line-blur': 0.35, 'line-dasharray': dash
                            }
                        },
                        {
                            id: 'lt-region-line', type: 'line', source: 'lt-regions', minzoom: LOD_Z + 1,
                            layout: { visibility: vis },
                            paint: {
                                'line-color': '#eef2f7',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.1, 8, 1.15, 11, 1.4],
                                'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 0.78, 11, 0.85],
                                'line-dasharray': dash
                            }
                        },
                        {
                            id: 'lt-region-lo-casing', type: 'line', source: 'lt-regions-lo', maxzoom: LOD_Z + 1,
                            layout: { visibility: vis },
                            paint: {
                                'line-color': '#000000',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.1, 8, 2.5],
                                'line-opacity': 0.42, 'line-dasharray': dash
                            }
                        },
                        {
                            id: 'lt-region-lo-line', type: 'line', source: 'lt-regions-lo', maxzoom: LOD_Z + 1,
                            layout: { visibility: vis },
                            paint: {
                                'line-color': '#eef2f7',
                                'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.1, 8, 1.15],
                                'line-opacity': 0.78,
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
            try {
                map.setLight({ anchor: 'viewport', color: '#e5f6ff', intensity: 0.4, position: [1.4, 210, 40] });
            } catch (e) { }
        }

        // державні кордони: точні лінії OSM, розкладені на категорії ще на
        // етапі збірки (scripts/build-state-borders.js). У кадрі нічого не
        // рахується — три статичні джерела й по два шари на кожне
        function borderData() {
            if (window.__ltBorderData) return window.__ltBorderData;
            const raw = window.LT_STATE_BORDERS;
            if (!raw || !raw.cats) return null;
            const out = {};
            raw.cats.forEach(c => {
                out[c.id] = {
                    meta: c,
                    fc: {
                        type: 'FeatureCollection',
                        features: c.lines.map(line => ({
                            type: 'Feature',
                            properties: { cat: c.id },
                            geometry: { type: 'LineString', coordinates: LT.decodePolyline(line) }
                        }))
                    }
                };
            });
            window.__ltBorderData = out;
            return out;
        }

        function mountBorders() {
            if (map.getLayer('lt-b-ru')) return;
            const data = borderData();
            if (!data) return;
            const layers = map.getStyle().layers || [];
            const anchor = (layers.find(l => l.type === 'symbol') || {}).id;
            Object.keys(data).forEach(id => {
                const { meta, fc } = data[id];
                if (!map.getSource('lt-b-' + id)) {
                    map.addSource('lt-b-' + id, { type: 'geojson', data: fc, tolerance: 1.1, maxzoom: 14 });
                }
                const vis = borderVis[id] === false ? 'none' : 'visible';
                const w = meta.width || 2.4;
                map.addLayer({
                    id: 'lt-b-' + id + '-case', type: 'line', source: 'lt-b-' + id,
                    layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
                    paint: {
                        'line-color': meta.caseColor || '#05080d',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 4, w + 0.8, 8, w + 1.5, 11, w + 2.1],
                        'line-opacity': meta.caseOpacity != null ? meta.caseOpacity : 0.62, 'line-blur': 0.4
                    }
                }, anchor);
                map.addLayer({
                    id: 'lt-b-' + id, type: 'line', source: 'lt-b-' + id,
                    layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
                    paint: {
                        'line-color': meta.color,
                        'line-width': ['interpolate', ['linear'], ['zoom'], 4, w * 0.62, 8, w, 11, w * 1.25],
                        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.85, 7, 0.95, 13, 1]
                    }
                }, anchor);
            });
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
                ['lt-b-' + id + '-case', 'lt-b-' + id].forEach(lid => {
                    if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none');
                });
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
