/**
 * SoccerStats.com veri kazıyıcı (scraper)
 * - Günlük maç bülteni (dailymatches) tablosu
 * - Maç detay sayfası (trendler, gol dağılımları, ilk gol, skor satırları ...)
 *
 * Not: Bu modül yalnızca SUNUCU tarafında çalışır. Tarayıcı asla
 * soccerstats.com'a doğrudan istek atmaz (CORS / iframe engeli olmaz).
 */
const cheerio = require('cheerio');
const { shouldIncludeLeague } = require('./leagues');

const BASE = 'https://www.soccerstats.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const cache = new Map(); // url -> {ts, html}

/* --- Nazik istek kuyruğu ---------------------------------------------
 * soccerstats.com Cloudflare bot koruması kullanıyor ve Node'un fetch'i
 * (undici) TLS parmak izi yüzünden 403 alıyor. Bu yüzden indirme katmanı
 * `curl` üzerinden yapılıyor: tek kanal + istekler arası bekleme +
 * 403/hata durumunda artan backoff + bellek içi önbellek. */
const { execFile } = require('node:child_process');
const MIN_GAP_MS = 1200;
let lastRequestAt = 0;
let chain = Promise.resolve();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function curlGet(url, timeoutSec = 45) {
  const args = [
    '-sS', '--compressed', '-L', '--max-time', String(timeoutSec),
    '-A', UA,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '-H', 'Accept-Language: en-GB,en;q=0.9,tr;q=0.8',
    '-H', 'Referer: ' + BASE + '/en-gb/',
    '-w', '\n__STATUS__%{http_code}',
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('curl: ' + (stderr || err.message).slice(0, 200)));
      const m = stdout.match(/\n__STATUS__(\d{3})$/);
      const status = m ? parseInt(m[1], 10) : 0;
      const body = m ? stdout.slice(0, m.index) : stdout;
      resolve({ status, body });
    });
  });
}

async function politeFetch(url) {
  const run = async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return curlGet(url);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

async function fetchHtml(pathOrUrl, { ttl = 240, tries = 4 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl * 1000) return hit.html;

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const { status, body } = await politeFetch(url);
      if (status !== 200) throw new Error('HTTP ' + status);
      if (body.length < 2000 || /Just a moment\.\.\./.test(body.slice(0, 4000))) {
        throw new Error('Bot koruması engeli (challenge sayfası)');
      }
      cache.set(url, { ts: Date.now(), html: body });
      if (cache.size > 120) cache.delete(cache.keys().next().value);
      return body;
    } catch (e) {
      lastErr = e;
      await sleep(3000 * (i + 1) + Math.random() * 1000);
    }
  }
  if (hit) return hit.html; // eski önbellek varsa onunla devam et
  throw new Error(`Kaynak alınamadı (${url}): ${lastErr && lastErr.message}`);
}

const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ */
/* 1) GÜNLÜK BÜLTEN                                                    */
/* ------------------------------------------------------------------ */

const STAT_KEYS = ['ppg', 'wp', 'fts', 'cs', 'bts', 'tg', 'gf', 'ga', 'o15', 'o25', 'o35'];

function parseTeamRow($, tr) {
  const tds = $(tr).find('td').toArray();
  const gp = num($(tr).find('td.freeze-col-3').first().text());
  const out = Object.fromEntries(STAT_KEYS.map(k => [k, null]));
  out.gp = gp;

  // freeze-col-3 (GP) sonrasındaki düz hücreler istatistik sırasıyla gelir
  let started = false;
  let idx = 0;
  for (const td of tds) {
    const cls = ($(td).attr('class') || '');
    if (!started) {
      if (cls.includes('freeze-col-3')) started = true;
      continue;
    }
    if (cls.includes('desktop-stat-col') || cls.includes('no-export')) continue;
    const txt = clean($(td).text());
    if (idx < STAT_KEYS.length) out[STAT_KEYS[idx]] = num(txt);
    idx++;
  }
  return out;
}

/**
 * Bugünün (kaynağın gösterdiği günlerin) tüm bülteni.
 * Dönüş: { fetchedAt, leagues:[{name, country, played, avgGoals, homeAvg, awayAvg, matches:[...]}] }
 */
async function getBulletin() {
  const html = await fetchHtml('/nodeweb/en-gb/dailymatches', { ttl: 180 });
  const $ = cheerio.load(html);
  const leagues = [];
  const skipped = [];   // filtreden elenen ligler (bilgi amaçlı)

  $('details.dm-details').each((_, det) => {
    const sum = clean($(det).find('summary').first().text());
    const m = sum.match(/^(.+?)\s+Played:\s*(\d+)/i);
    let name = m ? m[1] : sum.split('Played')[0];
    name = clean(name);
    const country = name.includes(' - ') ? name.split(' - ')[0] : '';
    const leagueName = name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name;
    const played = m ? num(m[2]) : null;
    const ag = sum.match(/Avg Goals:\s*([\d.]+)\s*\(([\d.]+)\s*at home,\s*([\d.]+)\s*away\)/i);

    const matches = [];
    $(det).find('.match-row-item').each((__, row) => {
      const trs = $(row).find('tr').toArray();
      if (!trs.length) return;
      const home = $(row).attr('data-t1');
      const away = $(row).attr('data-t2');
      if (!home || !away) return;

      const isPlayed = $(trs[0]).hasClass('played-row-bg');
      const firstSpan = clean($(trs[0]).find('td.freeze-col-1 span').first().text());
      const score = isPlayed && /^\d+\s*:\s*\d+$/.test(firstSpan) ? firstSpan.replace(/\s+/g, '') : null;
      const kickoff = $(row).attr('data-utc');
      const link = $(trs[0]).find('a.mobile-team-btn').attr('href') || $(trs[0]).find('a').attr('href') || '';

      matches.push({
        id: $(row).attr('data-matchid'),
        leagueCode: $(row).attr('data-leaguecode'),
        league: leagueName,
        country,
        home,
        away,
        utc: kickoff,
        status: isPlayed ? 'FT' : 'NS',
        score,
        url: link,
        homeStats: parseTeamRow($, trs[0]),
        awayStats: trs[1] ? parseTeamRow($, trs[1]) : {},
      });
    });

    // Kadın ligleri ve çok alt ligler bültene alınmaz
    const verdict = shouldIncludeLeague(country, leagueName);
    if (matches.length && !verdict.keep) {
      skipped.push({ country, name: leagueName, reason: verdict.reason, matches: matches.length });
    }

    if (matches.length && verdict.keep) {
      // Takım verisi için lig yolu (maç URL'sinden türetilir)
      const firstUrl = matches[0].url || '';
      const lb = firstUrl.match(/^\/(?:nodeweb\/)?([a-z-]+)\/leagues\/(.+?)\/([^/]+)\/([^/]+)\/matches\//);
      leagues.push({
        name: leagueName,
        base: lb ? `/nodeweb/${lb[1]}/leagues/${lb[2]}/${lb[3]}/${lb[4]}` : null,
        country,
        played,
        avgGoals: ag ? num(ag[1]) : null,
        homeAvg: ag ? num(ag[2]) : null,
        awayAvg: ag ? num(ag[3]) : null,
        matches,
      });
    }
  });

  const all = leagues.flatMap(l => l.matches);
  return {
    fetchedAt: new Date().toISOString(),
    source: BASE + '/nodeweb/en-gb/dailymatches',
    countLeagues: leagues.length,
    countMatches: all.length,
    skippedLeagues: skipped,
    leagues,
  };
}

/* ------------------------------------------------------------------ */
/* 2) MAÇ DETAYI (jenerik bölüm ayrıştırıcı)                            */
/* ------------------------------------------------------------------ */

function tableToRows($, table) {
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').toArray().map(td => clean($(td).text()));
    if (cells.some(c => c.length)) rows.push(cells);
  });
  return rows;
}

async function getMatchDetail(matchPath) {
  const html = await fetchHtml(matchPath, { ttl: 600 });
  const $ = cheerio.load(html);
  const main = $('main.main-content').length ? $('main.main-content') : $('body');

  const title = clean($('h1').first().text()) || 'Maç detayı';
  const sections = [];
  let cur = null;

  // Belge sırasına göre düz gezinme: her başlık yeni bir bölüm açar,
  // tablolar / listeler / paragraflar o anki bölüme eklenir.
  const walk = (el) => {
    $(el).children().each((_, node) => {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'nav' || tag === 'footer') return;

      if (['h2', 'h3', 'h4', 'h5'].includes(tag)) {
        const t = clean($(node).text());
        if (!t || t.length < 3 || /^access denied$/i.test(t)) return;
        cur = { title: t, level: tag, tables: [], bullets: [], text: [] };
        sections.push(cur);
        return;
      }
      if (tag === 'table') {
        if (!cur) {
          cur = { title: 'Genel', level: 'h3', tables: [], bullets: [], text: [] };
          sections.push(cur);
        }
        const rows = tableToRows($, node);
        if (rows.length > 1) cur.tables.push(rows);
        return; // tablo içine girme
      }
      if (tag === 'ul' || tag === 'ol') {
        if (!cur) {
          cur = { title: 'Notlar', level: 'h3', tables: [], bullets: [], text: [] };
          sections.push(cur);
        }
        $(node).find('li').each((__, li) => {
          const t = clean($(li).text());
          if (t && t.length > 12 && !cur.bullets.includes(t)) cur.bullets.push(t);
        });
        return;
      }
      if (tag === 'p') {
        const t = clean($(node).text());
        if (t && t.length > 20 && cur && cur.text.length < 6 && !cur.text.includes(t)) cur.text.push(t);
        return;
      }
      walk(node);
    });
  };
  walk(main.length ? main[0] : $('body')[0]);

  // boş bölümleri at, çok büyük tabloları kırp
  const compact = sections
    .filter(s => s.tables.length || s.bullets.length || s.text.length)
    .map(s => ({
      title: s.title,
      level: s.level,
      text: s.text.slice(0, 4),
      bullets: s.bullets.slice(0, 25),
      tables: s.tables.map(t => t.slice(0, 45)),
    }));

  // Trendler bölümünü öne çıkar
  const trendSec = compact.find(s => /trend/i.test(s.title));
  const trends = trendSec ? trendSec.bullets : [];

  return { title, url: BASE + matchPath, sections: compact, trends };
}

/* ------------------------------------------------------------------ */
/* 3) SEZON İSTATİSTİK SAYFALARI (lig görünümü)                        */
/* ------------------------------------------------------------------ */

async function getLeaguePage(path) {
  const html = await fetchHtml(path, { ttl: 900 });
  const $ = cheerio.load(html);
  const tables = [];
  $('table').each((i, t) => {
    const rows = tableToRows($, t);
    if (rows.length > 1) tables.push({ index: i, rows: rows.slice(0, 60) });
  });
  const trends = [];
  $('li').each((_, li) => {
    const t = clean($(li).text());
    if (/trend|form|scoring|conceded|average/i.test(t) && t.length > 25) trends.push(t);
  });
  return { title: clean($('h1').first().text()), url: BASE + path, tables: tables.slice(0, 12), trends: trends.slice(0, 30) };
}

module.exports = { getBulletin, getMatchDetail, getLeaguePage, getTables, fetchHtml, BASE };

/* ------------------------------------------------------------------ */
/* 4) JENERİK TABLO SAYFALARI (Stats menüsündeki alt sayfalar)          */
/*    Örn: /table/corners, /table/goalranges, /timing, /form ...        */
/* ------------------------------------------------------------------ */

/**
 * Sayfadaki tüm tabloları başlıklarıyla döndürür.
 * @returns {{title:string, url:string, tables:Array<{headers:string[],rows:string[][]}>}}
 */
async function getTables(pathOrUrl, { ttl = 1800, keep = 8, rows = 30 } = {}) {
  const html = await fetchHtml(pathOrUrl, { ttl });
  const $ = cheerio.load(html);
  const base = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;

  const tables = [];
  $('table').each((_, t) => {
    const all = $(t).find('tr').toArray();
    if (all.length < 3) return;
    const grid = all.map(tr =>
      $(tr).find('th,td').toArray().map(td => clean($(td).text()))
    ).filter(r => r.some(c => c.length));
    if (grid.length < 3) return;

    // Başlık satırını bul: ilk 4 satır içinde "sayısal olmayan hücre sayısı"
    // en yüksek olan satır başlıktır (korner tablosunda ilk sütun boş olabiliyor).
    const isNumeric = (c) => /^-?\d+([.,]\d+)?%?$/.test(String(c || '').trim());
    let headerIdx = 0, bestScore = -1;
    grid.slice(0, 4).forEach((r, i) => {
      const score = r.filter(c => c && !isNumeric(c)).length;
      if (score > bestScore) { bestScore = score; headerIdx = i; }
    });
    const headers = grid[headerIdx];
    const body = grid.slice(headerIdx + 1).filter(r => r.filter(c => c).length >= 2);
    if (!body.length) return;

    // başlık metinleri tek hücrede birleşmiş olabilir, kırp
    tables.push({ headers: headers.slice(0, 14), rows: body.slice(0, rows).map(r => r.slice(0, 14)) });
  });

  tables.sort((a, b) => b.rows.length - a.rows.length);
  const title = clean($('h1').first().text()) || clean($('title').first().text());
  return { title, url: base, tables: tables.slice(0, keep) };
}
