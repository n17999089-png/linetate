#!/usr/bin/env node
// Збирає безповоротні втрати сторін з відкритих джерел:
//   РФ  — поіменний список «Медиазони» + оцінка надсмертності (Mediazona/Meduza)
//   ЗСУ — підтверджені загиблі з проєкту UALosses
// Пише data/losses.json. Жодних залежностей, тільки стандартний Node 20+.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'losses.json');

const UA_ORIGIN = 'https://ualosses.org';
// у GitHub Actions сайт доступний напряму; локально мережа його блокує,
// тому при збої один раз пробуємо через читач-проксі й далі темп уповільнюємо
const UA_PROXY = process.env.UA_PROXY || '';
const UA_BASE = UA_PROXY ? UA_PROXY.replace(/\/+$/, '') + '/' + UA_ORIGIN : UA_ORIGIN;
const UA_HEADERS = UA_PROXY ? { 'x-no-cache': 'true', 'x-return-format': 'html' } : {};
const JINA = 'https://r.jina.ai';
const JINA_HEADERS = { 'x-no-cache': 'true', 'x-return-format': 'html' };
let uaSlow = !!UA_PROXY;
const ZONA_PAGE = 'https://zona.media/casualties';
const ZONA_BUNDLE = 'https://s3.zona.media/infographics/bodycount/main.075985bf49bbe5ddf8ec.js.br';

// Втрати техніки РФ — власний підрахунок, а не зведення Генштабу: беремо
// список Oryx, де кожна одиниця підтверджена фото чи відео. Категорії сайту
// згортаємо у свої групи; добової історії джерело не віддає, тому приріст
// рахуємо між власними знімками (history), які накопичуються з кожним прогоном.
const ORYX_URL = 'https://www.oryxspioenkop.com/2022/02/attack-on-europe-documenting-equipment.html';
const EQ_FIELDS = [
    'tanks', 'armoured_fighting_vehicles', 'artillery_systems', 'mlrs',
    'aa_warfare_systems', 'planes', 'helicopters', 'vehicles_fuel_tanks',
    'warships_cutters', 'cruise_missiles', 'uav_systems',
    'special_military_equip', 'atgm_srbm_systems', 'submarines'
];
const EQ_DAYS = 30;
const EQ_HISTORY = 180;

// ключ групи → назви категорій Oryx у нижньому регістрі
const ORYX_GROUPS = {
    tanks: ['tanks'],
    armoured_fighting_vehicles: [
        'armoured fighting vehicles', 'infantry fighting vehicles',
        'armoured personnel carriers', 'mine-resistant ambush protected (mrap) vehicles'
    ],
    artillery_systems: [
        'towed artillery', 'self-propelled artillery',
        'artillery and missile support vehicles and equipment'
    ],
    mlrs: ['rocket and missile artillery'],
    aa_warfare_systems: [
        'anti-aircraft guns', 'self-propelled anti-aircraft guns',
        'surface-to-air missile systems'
    ],
    planes: ['aircraft'],
    helicopters: ['helicopters'],
    vehicles_fuel_tanks: ['trucks and similar vehicles', 'infantry mobility vehicles'],
    warships_cutters: ['naval ships and submarines'],
    uav_systems: ['unmanned combat aerial vehicles'],
    special_military_equip: [
        'command posts and communications stations',
        'engineering vehicles and equipment',
        'radars', 'jammers and deception systems'
    ],
    atgm_srbm_systems: ['self-propelled anti-tank missile systems']
};

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': 'Mozilla/5.0 (compatible; LINESTATE/1.0)', ...(opts.headers || {}) },
                signal: AbortSignal.timeout(60000)
            });
            if (res.ok) return await res.text();
            last = new Error(`${url} → HTTP ${res.status}`);
            // 429 — це пауза, а не відмова: читач-проксі рахує запити за хвилину
            if (res.status === 429) { await sleep(12000 * (i + 1)); continue; }
            if (res.status < 500) break;
        } catch (e) {
            last = e;
        }
        await sleep(1500 * (i + 1));
    }
    throw last;
}

const strip = html => html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');

const num = s => Number(String(s).replace(/[^\d]/g, ''));

/* ------------------------------- UALosses ------------------------------- */

const monthsBetween = (fromY, fromM, toY, toM) => {
    const out = [];
    let y = fromY, m = fromM;
    while (y < toY || (y === toY && m <= toM)) {
        out.push([y, m]);
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return out;
};

const pad = n => String(n).padStart(2, '0');

async function uaText(path) {
    if (UA_PROXY) return strip(await get(UA_BASE + path, { headers: UA_HEADERS }));
    try {
        return strip(await get(UA_ORIGIN + path));
    } catch (e) {
        console.warn(`  ! прямий доступ не вдався (${e.message}), читаю через ${JINA}`);
        uaSlow = true;
        return strip(await get(JINA + '/' + UA_ORIGIN + path, { headers: JINA_HEADERS }, 6));
    }
}

async function uaCount(from, to) {
    const path = `/en/soldiers/?dod_start=${from}&dod_end=${to}&casualty_type=dead`;
    const text = await uaText(path);
    const m = text.match(/Found:\s*([\d][\d ,]*?)(?=\s*people)/);
    if (!m) throw new Error(`UALosses: не знайдено лічильник для ${from}–${to}`);
    return num(m[1]);
}

async function uaStats() {
    const text = await uaText('/en/statistics/');
    // рядок виду «Killed 106285 47.3%»: беремо лише перше число
    const grab = (re, what) => {
        const m = text.match(re);
        if (!m) throw new Error(`UALosses: немає поля «${what}»`);
        return num(m[1]);
    };
    const range = text.match(/24\.02\.22\s*-\s*(\d{2})\.(\d{2})\.(\d{2})/);
    return {
        records: grab(/Post-2022 records\s+(\d+)/, 'Post-2022 records'),
        killed: grab(/Killed\s+(\d+)/, 'Killed'),
        missing: grab(/Missing\s+(\d+)/, 'Missing'),
        pow: grab(/Prisoners of war\s+(\d+)/, 'Prisoners of war'),
        asOf: range ? `20${range[3]}-${range[2]}-${range[1]}` : null
    };
}

async function collectUA(prev) {
    const now = new Date();
    const stats = await uaStats();
    // місяці після останньої дати в даних не рахуємо: там ще нічого немає
    const asOfParts = stats.asOf ? stats.asOf.split('-').map(Number) : null;
    const lastY = asOfParts ? asOfParts[0] : now.getUTCFullYear();
    const lastM = asOfParts ? asOfParts[1] : now.getUTCMonth() + 1;

    const months = monthsBetween(2022, 2, lastY, lastM);
    const old = new Map((prev.ua && prev.ua.monthly || []).map(([k, v]) => [k, v]));
    // проміжний кеш: повний прохід — 40+ запитів, і читач-проксі ріже темп.
    // Кожен успішний місяць лягає на диск, наступний запуск починає з нього.
    const CACHE = join(tmpdir(), 'linestate-losses-cache.json');
    let done = {};
    try { done = JSON.parse(readFileSync(CACHE, 'utf8')) || {}; } catch (e) { done = {}; }
    const remember = (k, v) => {
        done[k] = v;
        try { writeFileSync(CACHE, JSON.stringify(done)); } catch (e) { /* кеш не критичний */ }
    };

    const out = [];
    let fetched = 0, reused = 0, failed = [];
    // через читач-проксі ліміт запитів жорсткий: тоді тільки по одному
    const limit = uaSlow ? 1 : 4;
    let cursor = 0;
    const worker = async () => {
        while (cursor < months.length) {
            const idx = cursor++;
            const [y, m] = months[idx];
            const key = `${y}-${pad(m)}`;
            if (done[key] != null) { out[idx] = [key, done[key]]; reused++; continue; }
            if (old.has(key)) { out[idx] = [key, old.get(key)]; reused++; continue; }
            const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const from = y === 2022 && m === 2 ? '24.02.2022' : `01.${pad(m)}.${y}`;
            const to = `${pad(end)}.${pad(m)}.${y}`;
            try {
                const v = await uaCount(from, to);
                out[idx] = [key, v];
                remember(key, v);
                fetched++;
            } catch (e) {
                failed.push(key);
                console.warn(`  ! ${key}: ${e.message}`);
            }
            await sleep(uaSlow ? 3600 : 250);
        }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    if (failed.length) throw new Error(`UALosses: не вдалось отримати ${failed.join(', ')} — файл не перезаписую`);

    const yearly = {};
    for (const [k, v] of out) {
        const y = k.slice(0, 4);
        yearly[y] = (yearly[y] || 0) + v;
    }
    console.log(`  UALosses: ${out.length} міс. (${fetched} свіжих, ${reused} з кешу), убито ${stats.killed}`);
    return { ...stats, monthly: out, yearly };
}

/* ------------------------------- Mediazona ------------------------------- */

function zonaBundle(src) {
    const marker = 'GA=JSON.parse(\'';
    const i = src.indexOf(marker);
    if (i < 0) throw new Error('Mediazona: не знайдено масив GA у бандлі');
    const open = i + marker.length - 1;
    const close = src.indexOf("')", open);
    if (close < 0) throw new Error('Mediazona: обірваний масив GA');
    const raw = src.slice(open + 1, close).replace(/\\'/g, "'");
    return JSON.parse(raw);
}

function zonaPageDate(html) {
    const text = strip(html);
    const m = text.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})/);
    if (!m) return null;
    const month = MONTHS_RU.indexOf(m[2]) + 1;
    return `${m[3]}-${pad(month)}-${pad(m[1])}`;
}

const isoFromDots = s => {
    const [d, m, y] = s.split('.');
    return `${y}-${m}-${d}`;
};

async function collectRU() {
    const [page, bundle] = await Promise.all([
        get(ZONA_PAGE),
        get(ZONA_BUNDLE)
    ]);
    const rows = zonaBundle(bundle);
    const meta = {};
    const weeks = [];
    for (const r of rows) {
        if (r.w === 'last_date' || r.w === 'current_date' || r.w === 'last_total' || r.w === 'current_total') {
            meta[r.w] = r.real;
            meta[r.w + '_rnd'] = r.rnd;
        } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(r.w)) {
            weeks.push(r);
        }
    }
    if (!weeks.length) throw new Error('Mediazona: немає тижневих рядків');

    const monthly = new Map();
    const excessMonthly = new Map();
    const yearly = {};
    const excessYearly = {};
    for (const w of weeks) {
        const iso = isoFromDots(w.w);
        const key = iso.slice(0, 7);
        const y = iso.slice(0, 4);
        monthly.set(key, (monthly.get(key) || 0) + w.real);
        excessMonthly.set(key, (excessMonthly.get(key) || 0) + w.rnd);
        yearly[y] = (yearly[y] || 0) + w.real;
        excessYearly[y] = (excessYearly[y] || 0) + w.rnd;
    }
    const named = Math.round(meta.current_total || 0);
    const asOf = meta.current_date ? isoFromDots(meta.current_date) : zonaPageDate(page);
    const excess = Math.round(meta.current_total_rnd || 0);
    const excessAsOf = meta.current_date_rnd ? isoFromDots(meta.current_date_rnd) : null;

    const lastWeek = isoFromDots(weeks[weeks.length - 1].w);
    const rest = named - Object.values(yearly).reduce((a, b) => a + b, 0);
    // підтвердження запізнюються: те, що додалося після останнього тижня
    // у графіку, кладемо в рік станом на asOf
    const restYear = (asOf || lastWeek).slice(0, 4);
    if (rest > 0 && Number(restYear) >= Number(lastWeek.slice(0, 4))) {
        yearly[restYear] = (yearly[restYear] || 0) + rest;
    }
    const monthlyList = [...monthly.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    console.log(`  Mediazona: ${weeks.length} тижнів, імена ${named} на ${asOf}, надсмертність ${excess} на ${excessAsOf}, залишок ${rest}`);

    return {
        named,
        asOf,
        excess,
        excessAsOf,
        lastWeek,
        monthly: monthlyList,
        yearly,
        excessYearly: Object.fromEntries(Object.entries(excessYearly).map(([k, v]) => [k, Math.round(v)])),
        excessMonthly: [...excessMonthly.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => [k, Math.round(v)]),
        source: 'Mediazona + Meduza',
        url: ZONA_PAGE
    };
}

/* --------------------------- втрати техніки ---------------------------- */

const isoDay = d => d.toISOString().slice(0, 10);

// Oryx пише кожну категорію як <h3>Назва (1234, of which destroyed: …)</h3>
function oryxRows(html) {
    const rows = new Map();
    const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let m;
    while ((m = re.exec(html))) {
        const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
        const hit = text.match(/^(.+?)\s*\(([\d,]+),\s*of which\s+([^)]*)\)/);
        if (!hit) continue;
        const parts = {};
        for (const p of hit[3].split(',')) {
            const pm = p.trim().match(/^([a-z ]+):\s*([\d,]+)/i);
            if (pm) parts[pm[1].trim().toLowerCase()] = num(pm[2]);
        }
        rows.set(hit[1].trim().toLowerCase(), {
            name: hit[1].trim(),
            total: num(hit[2]),
            destroyed: parts.destroyed || 0
        });
    }
    return rows;
}

// знімок стану: якщо цифри не змінились, новий рядок не плодимо
function eqHistory(prev, asOf, totals) {
    const rows = ((prev && prev.history) || []).filter(r => Array.isArray(r) && r.length === EQ_FIELDS.length + 1 && r[0]);
    const row = [asOf, ...EQ_FIELDS.map(f => (totals[f] == null ? null : totals[f]))];
    const i = rows.findIndex(r => r[0] === asOf);
    if (i >= 0) rows[i] = row;
    else {
        const last = rows[rows.length - 1];
        const same = last && EQ_FIELDS.every((f, j) => last[j + 1] === row[j + 1]);
        if (same) last[0] = asOf; else rows.push(row);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return rows.slice(-EQ_HISTORY);
}

// приріст між сусідніми знімками; розрив понад 45 днів не рахуємо,
// інакше один стрибок розмазується на «добові» втрати
function eqDays(rows) {
    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const gap = (Date.parse(b[0]) - Date.parse(a[0])) / 864e5;
        if (!(gap > 0 && gap <= 45)) continue;
        out.push([b[0], ...EQ_FIELDS.map((f, j) => {
            const av = a[j + 1], bv = b[j + 1];
            return av == null || bv == null ? 0 : Math.max(0, bv - av);
        })]);
    }
    return out.slice(-EQ_DAYS);
}

async function collectEquip(prev) {
    const html = await get(ORYX_URL);
    const rows = oryxRows(html);
    if (!rows.size) throw new Error('Oryx: не знайдено жодної категорії');

    const totals = {}, destroyed = {};
    for (const f of EQ_FIELDS) {
        const names = ORYX_GROUPS[f] || [];
        const found = names.map(n => rows.get(n)).filter(Boolean);
        if (!found.length) { totals[f] = null; destroyed[f] = null; continue; }
        totals[f] = found.reduce((s, r) => s + r.total, 0);
        destroyed[f] = found.reduce((s, r) => s + r.destroyed, 0);
    }
    const overall = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        .match(/Russia\s*-\s*([\d,]+),\s*of which:\s*destroyed:\s*([\d,]+),\s*damaged:\s*([\d,]+),\s*abandoned:\s*([\d,]+),\s*captured:\s*([\d,]+)/);
    const summary = overall ? {
        total: num(overall[1]), destroyed: num(overall[2]),
        damaged: num(overall[3]), abandoned: num(overall[4]), captured: num(overall[5])
    } : null;

    const asOf = isoDay(new Date());
    const history = eqHistory(prev, asOf, totals);
    const days = eqDays(history);
    const increase = Object.fromEntries(EQ_FIELDS.map((f, i) => [f, days.length ? days[days.length - 1][i + 1] : 0]));
    console.log(`  Oryx: ${rows.size} категорій, знімок ${asOf}, історія ${history.length}, приріст ${days.length ? 'є' : 'немає'}`);
    return {
        asOf,
        day: Math.floor((Date.parse(asOf + 'T00:00:00Z') - Date.parse('2022-02-24T00:00:00Z')) / 864e5),
        source: 'Oryx',
        url: ORYX_URL,
        summary,
        fields: EQ_FIELDS,
        totals,
        destroyed,
        increase,
        days,
        history
    };
}

/* --------------------------------- main --------------------------------- */

function readPrev() {
    try { return JSON.parse(readFileSync(OUT, 'utf8')); }
    catch (e) { return { ua: {}, ru: {} }; }
}

async function main() {
    const prev = readPrev();
    const only = (process.env.ONLY || '').toLowerCase();
    let ua = prev.ua || {};
    let ru = prev.ru || {};
    let equip = prev.equip || null;
    if (only !== 'equip' && only !== 'ru') {
        console.log('Втрати: тягну UALosses…');
        ua = await collectUA(prev);
    }
    if (only !== 'equip' && only !== 'ua') {
        console.log('Втрати: тягну Mediazona…');
        ru = await collectRU();
    }
    if (only !== 'ru' && only !== 'ua') {
        console.log('Втрати: рахую техніку за списком Oryx…');
        // якщо сайт недоступний, лишаємо попередній блок, а не ламаємо весь прогін
        try { equip = await collectEquip(prev.equip); }
        catch (e) { console.log(`  Oryx: ${e.message} — лишаю попередні дані`); }
    }
    if (!ua.killed || !ru.named) throw new Error('немає даних однієї зі сторін — файл не перезаписую');

    const doc = {
        updatedAt: new Date().toISOString(),
        ru: { ...ru, source: 'Mediazona + Meduza', url: ZONA_PAGE },
        ua: { ...ua, source: 'UALosses', url: 'https://ualosses.org/en/statistics/' }
    };
    if (equip) doc.equip = equip;
    // щоденний прогін без нових цифр не має плодити коміти: показуємо час,
    // коли дані справді змінилися, а не час останньої перевірки
    if (prev.ru && prev.ua && JSON.stringify([prev.ru, prev.ua, prev.equip])
        === JSON.stringify([doc.ru, doc.ua, doc.equip])) {
        doc.updatedAt = prev.updatedAt || doc.updatedAt;
    }
    if (JSON.stringify(doc) === JSON.stringify(prev)) {
        console.log('Втрати: без змін');
        return;
    }
    writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
    console.log(`Готово → ${OUT}`);
}

main().catch(e => {
    console.error('ПОМИЛКА:', e.message);
    process.exit(1);
});
