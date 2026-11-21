/* ------------------------------------------------------------------
 * SkorLab · günlük fikstür toplayıcı
 *
 * Amaç: her gün otomatik olarak "bugünün maçları + takım istatistikleri"
 * dosyasını üretmek. soccerstats.com Cloudflare arkasında olduğu ve sunucu
 * IP'sini engellediği için fikstür, aynı fikstürü veren açık kaynaktan
 * (365scores web API) alınır; üretilen dosya biçimi soccerstats bülteniyle
 * birebir aynıdır (data/today-YYYY-MM-DD.json), böylece site ve APK
 * tarafında hiçbir şey değişmez.
 *
 * Üretilen alanlar (analyzeMatch'in beklediğiyle uyumlu):
 *   gp  oynanan maç           ppg  puan/maç           wp   galibiyet %
 *   fts gol atamadığı %       cs  gol yemediği %      bts  KG %
 *   o15/o25/o35 üst yüzdeleri tg  toplam gol dağılımı  gf/ga gol ortalaması
 * Ev sahibi istatistikleri yalnız ev maçlarından, deplasman istatistikleri
 * yalnız deplasman maçlarından hesaplanır (soccerstats ile aynı mantık).
 * ------------------------------------------------------------------ */
'use strict';

const ORIGIN = 'https://webws.365scores.com';
const API = ORIGIN + '/web';
const BASE_Q = 'appTypeId=5&langId=1&timezoneName=Europe%2FIstanbul';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/* Lig başına hedeflenen bitmiş maç sayısı (takım başına ~6 maç için) */
const TARGET_RESULTS = Number(process.env.TARGET_RESULTS || 80);

const COUNTRY_TR = {
  Turkiye: 'Turkey', USA: 'United States', Czechia: 'Czech Republic',
  'Bosnia and Herzegovina': 'Bosnia', UAE: 'United Arab Emirates', KSA: 'Saudi Arabia',
};

const NAME_TR = {
  'Saudi League': 'Saudi Pro League', 'Super Lig': 'Süper Lig', '1. Lig': '1. Lig',
  LaLiga: 'LaLiga', 'Bundesliga 2': '2. Bundesliga', 'Liga 1': 'Liga I',
};

/* Kadın / alt yaş / rezerv / alt kademe ligleri bülten dışı */
const EXCLUDE_LEAGUE = /(\(\s*W\s*\)|\bwomen|feminin|ladies|frauen|damallsvenskan|kvinner|\bU-?1[5-9]\b|\bU-?2[0-3]\b|youth|junior|academy|primavera|reserve|\bII\b|\bB\s*team|oberliga|landesliga|verbandsliga|bezirksliga|kreisliga|regionalliga|serie d|eccellenza|promozione|torneo federal|primera c\b|primera division rfef|segunda rfef|liga 3|j3 league|npl\b|femenin|w-?league|super league.*women|u-?19|u-?20|u-?21|u-?23)/i;

/* Rezerv / B takımı / alt yaş takım adları: bülten dışı */
const EXCLUDE_TEAM = /(\(W\)|\bII\b|\bB\b\s*$|Castilla|\bU-?\d{2}\b|Youth|Academy|Reserves?\b|\bB Team\b|\bSub-?\d{2}\b)/i;

/* Ülke filtresi: kullanıcı kuralı gereği yalnızca kadın ligleri ve 4. kademe
 * altı ligler bülten dışında kalır; ülke bazlı eleme yapılmaz. */
const EXCLUDE_COUNTRY = /$^/;
const WOMEN_COMPETITION = /women|woman|women's|ladies|feminin|frauen|femminile|femenin|damallsvenskan|kvinner|toppserien|\bliga\s*f\b|\bW-?league\b|we league/i;
const NON_LEAGUE_COMPETITION = /cup|copa|trophy|shield|supercup|super cup|pokal|coupe|coppa|kupa|knockout|playoff|qualification|qualifier|friendly|youth|academy|reservas?|\bU-?\d{2}\b/i;

/* 365Scores kataloğundaki ülke içi popülerlik sırasına göre yalnızca her
 * ülkedeki en üst iki lig seçilir. Kadın ligleri, kupalar ve uluslararası
 * turnuvalar sıralamaya dahil edilmez. Böylece üçüncü ve daha alt kademeler
 * adlandırma biçiminden bağımsız elenir. */
async function getTopTwoCompetitionIds() {
  const catalog = await getJson(`${API}/competitions/?${BASE_Q}&sports=1`);
  const candidates = (catalog.competitions || []).filter(c =>
    c.sportId === 1 && c.hasStandings === true && c.competitorsType === 1 &&
    c.isInternational !== true && c.hasBrackets !== true &&
    !WOMEN_COMPETITION.test(c.name || '') && !NON_LEAGUE_COMPETITION.test(c.name || '')
  );
  const byCountry = new Map();
  for (const c of candidates) {
    const list = byCountry.get(c.countryId) || [];
    list.push(c); byCountry.set(c.countryId, list);
  }
  const allowed = new Set();
  for (const list of byCountry.values()) {
    list.sort((a, b) => (b.popularityRank || 0) - (a.popularityRank || 0));
    for (const c of list.slice(0, 2)) allowed.add(c.id);
  }
  return allowed;
}

/* ------------------------------ yardımcılar ------------------------------ */

async function getJson(url, { timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', Referer: 'https://www.365scores.com/' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.replace(API, ''));
    return await r.json();
  } finally { clearTimeout(t); }
}

/** HTML/temizlik: kaynak statusText alanında zararlı içerik olabiliyor */
const clean = (s) => String(s == null ? '' : s)
  .replace(/<[^>]*>/g, '')
  .replace(/[<>{}\\]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function istParts(iso) {
  // "2026-11-20T20:00:00+03:00" -> {date, time} İstanbul saatiyle
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return { date: `${f.year}-${f.month}-${f.day}`, time: `${f.hour}:${f.minute}` };
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

const STATUS_MAP = [
  [/postponed|ppd/i, 'PST'], [/cancel/i, 'CANC'], [/suspended|abandon/i, 'ABD'],
  [/final|ended|after penalties|after extra/i, 'FT'],
  [/1st half|2nd half|half ?time|extra time|penalties|live/i, 'LIVE'],
  [/scheduled|not started/i, 'NS'],
];

function mapStatus(statusGroup, statusText) {
  const txt = clean(statusText);
  for (const [re, code] of STATUS_MAP) if (re.test(txt)) return code;
  if (statusGroup === 4) return 'FT';
  if (statusGroup === 3) return 'LIVE';
  return 'NS';
}

/* ------------------------ istatistik hesaplama ------------------------ */

/** Bitmiş maç listesinden takım başına ev/dep splitli istatistik üretir. */
function buildTeamStats(finishedGames) {
  const T = new Map(); // competitorId -> {home:[], away:[]}
  const touch = (id, side) => {
    if (!T.has(id)) T.set(id, { home: [], away: [] });
    return T.get(id)[side];
  };
  for (const g of finishedGames) {
    const h = g.homeCompetitor, a = g.awayCompetitor;
    if (!h || !a || h.score == null || a.score == null) continue;
    // Yalnız BİTMİŞ maçlar: gelecek fikstürler skoru -1 olarak geliyor ve
    // istatistiğe girerse ppg/gol ortalamalarını bozuyor.
    if (g.statusGroup !== 4) continue;
    if (new Date(g.startTime).getTime() > Date.now()) continue;
    const hs = +h.score, as = +a.score;
    if (!isFinite(hs) || !isFinite(as) || hs < 0 || as < 0) continue;
    touch(h.id, 'home').push({ gf: hs, ga: as });
    touch(a.id, 'away').push({ gf: as, ga: hs });
  }

  const agg = (rows) => {
    const gp = rows.length;
    if (!gp) return {};
    let w = 0, d = 0, l = 0, gf = 0, ga = 0, fts = 0, cs = 0, bts = 0, o15 = 0, o25 = 0, o35 = 0;
    for (const r of rows) {
      gf += r.gf; ga += r.ga;
      if (r.gf > r.ga) w++; else if (r.gf === r.ga) d++; else l++;
      if (r.gf === 0) fts++;
      if (r.ga === 0) cs++;
      if (r.gf > 0 && r.ga > 0) bts++;
      const tt = r.gf + r.ga;
      if (tt > 1.5) o15++;
      if (tt > 2.5) o25++;
      if (tt > 3.5) o35++;
    }
    return {
      gp,
      ppg: r2((w * 3 + d) / gp),
      wp: pct(w, gp),
      dp: pct(d, gp),
      lp: pct(l, gp),
      gf: r2(gf / gp),
      ga: r2(ga / gp),
      fts: pct(fts, gp),
      cs: pct(cs, gp),
      bts: pct(bts, gp),
      o15: pct(o15, gp),
      o25: pct(o25, gp),
      o35: pct(o35, gp),
      wgp: w, dgp: d, lgp: l,
    };
  };

  const out = new Map();
  for (const [id, s] of T) out.set(id, { home: agg(s.home), away: agg(s.away), all: agg([...s.home, ...s.away]) });
  return out;
}

/* --------------------------- ana toplayıcı --------------------------- */

/**
 * Bugünün fikstürünü ve takım istatistiklerini toplar.
 * @param {string} date YYYY-MM-DD (İstanbul) — boşsa bugün
 * @param {object} opts { maxResultsPages, concurrency, log }
 */
async function collectDay(date, opts = {}) {
  const {
    maxResultsPages = 8, concurrency = 6, log = () => {},
    includeAllCountries = false,
  } = opts;

  const feed = await getJson(`${API}/games/?${BASE_Q}&sports=1`);
  const allGames = (feed.games || []).filter(g => g.sportId === 1);
  const countries = {}; for (const c of feed.countries || []) countries[c.id] = clean(c.name);
  const comps = new Map(); for (const c of feed.competitions || []) comps.set(c.id, c);
  const topTwoIds = await getTopTwoCompetitionIds();
  log(`lig filtresi: ${topTwoIds.size} lig ilk iki kademede seçildi`);

  const target = date || istParts(new Date().toISOString()).date;
  const today = allGames.filter(g => istParts(g.startTime).date === target);
  log(`kaynak: ${allGames.length} futbol maçı, ${target} için ${today.length}`);

  /* 1) lig filtresi */
  const kept = [];
  const dropped = [];
  for (const g of today) {
    const c = comps.get(g.competitionId) || {};
    const league = NAME_TR[clean(c.name)] || clean(c.name || g.competitionDisplayName);
    const country = COUNTRY_TR[clean(countries[c.countryId])] || clean(countries[c.countryId]);
    const reason = WOMEN_COMPETITION.test(league) || WOMEN_COMPETITION.test(c.name || '') ? 'kadın ligi'
      : (!topTwoIds.has(g.competitionId) || EXCLUDE_LEAGUE.test(league) || EXCLUDE_LEAGUE.test(c.nameForURL || '')) ? 'ilk iki kademe dışında'
      : (!includeAllCountries && (EXCLUDE_COUNTRY.test(country) || !country)) ? 'kapsam dışı ülke'
      : null;
    if (!reason && (EXCLUDE_TEAM.test(clean(g.homeCompetitor.name)) || EXCLUDE_TEAM.test(clean(g.awayCompetitor.name)))) {
      dropped.push({ country, league, reason: 'rezerv/alt yaş takım' }); continue;
    }
    if (reason) { dropped.push({ country, league, reason }); continue; }
    kept.push({ g, league, country, compId: g.competitionId });
  }
  log(`lig filtresi: ${kept.length} maç kaldı, ${dropped.length} elendi`);

  /* 2) lig başına sezon sonuçları + tablo */
  const compIds = [...new Set(kept.map(k => k.compId))];
  const compData = new Map();
  let done = 0;
  const queue = [...compIds];

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const rec = { finished: [], standings: null };
        // sonuçlar (sayfalı) — form/ev-dep istatistikleri
        // GERİYE doğru sayfalama: nextPage gelecek fikstüre gider, geçmiş için
        // previousPage kullanılır. Yeterli bitmiş maç toplanınca durulur.
        let url = `${API}/games/results/?${BASE_Q}&competitions=${id}`;
        const seenG = new Map();
        for (let p = 0; p < maxResultsPages && url; p++) {
          let j;
          try { j = await getJson(url); }
          catch (e) { if (p === 0) throw e; break; }
          for (const x of (j.games || [])) {
            if (x.sportId !== 1 || !x.homeCompetitor || !x.awayCompetitor) continue;
            seenG.set(x.id, x);
          }
          const finCount = [...seenG.values()].filter(x => x.statusGroup === 4).length;
          if (finCount >= TARGET_RESULTS) break;
          const prev = j.paging && j.paging.previousPage;
          url = prev ? new URL(prev, ORIGIN).href : null;
        }
        rec.finished.push(...seenG.values());
        // tablo (ppg / galibiyet yüzdesi doğrulaması)
        try {
          const s = await getJson(`${API}/standings/?${BASE_Q}&competitions=${id}`);
          rec.standings = (s.standings || [])[0] || null;
        } catch (e) { /* tablo yoksa sorun değil */ }
        compData.set(id, rec);
      } catch (e) {
        log(`  ! lig ${id}: ${e.message}`);
        compData.set(id, { finished: [], standings: null });
      }
      done++;
      if (done % 10 === 0) log(`  lig verisi ${done}/${compIds.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, compIds.length) }, worker));
  log(`lig verisi tamam: ${compData.size} lig`);

  /* 3) maç satırları */
  const matches = [];
  for (const { g, league, country, compId } of kept) {
    const st = buildTeamStats((compData.get(compId) || {}).finished || []);
    const hs = st.get(g.homeCompetitor.id) || {};
    const as = st.get(g.awayCompetitor.id) || {};
    const { date: d, time } = istParts(g.startTime);
    matches.push({
      date: d,
      time,
      slot: time,
      league,
      country,
      home: clean(g.homeCompetitor.name),
      away: clean(g.awayCompetitor.name),
      status: mapStatus(g.statusGroup, g.statusText),
      score: (g.homeCompetitor.score != null && g.awayCompetitor.score != null
        && g.statusGroup >= 3)
        ? `${Math.round(g.homeCompetitor.score)}-${Math.round(g.awayCompetitor.score)}` : null,
      url: null,
      source: '365scores',
      matchId: g.id,
      homeTeamId: g.homeCompetitor.id,
      awayTeamId: g.awayCompetitor.id,
      competitionId: compId,
      leagueId: compId,
      homeStats: hs.home || {},
      awayStats: as.away || {},
      homeAll: hs.all || {},
      awayAll: as.all || {},
    });
  }

  // saat / lig sıralaması
  matches.sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.country.localeCompare(b.country) || a.league.localeCompare(b.league));

  const statFilled = matches.filter(m => m.homeStats && m.homeStats.gp >= 2 && m.awayStats && m.awayStats.gp >= 2).length;

  return {
    generatedAt: new Date().toISOString(),
    date: target,
    source: 'soccerstats.com uyumlu günlük bülten · fikstür ve takım istatistikleri 365scores açık verisinden otomatik derlendi',
    sourceUrl: 'https://www.365scores.com/football',
    engine: 'skorlab-daily-fetcher/1.0',
    count: matches.length,
    countLeagues: new Set(matches.map(m => m.country + '|' + m.league)).size,
    countCountries: new Set(matches.map(m => m.country)).size,
    statCoverage: { total: matches.length, withStats: statFilled },
    dropped: dropped.length,
    matches,
  };
}

module.exports = { collectDay, buildTeamStats, istParts, mapStatus, clean, EXCLUDE_LEAGUE, EXCLUDE_COUNTRY };

/* CLI: node src/fixtures.js [YYYY-MM-DD] [çıktı.json] */
if (require.main === module) {
  const [date, out] = process.argv.slice(2);
  collectDay(date || null, { log: console.log })
    .then(j => {
      const fs = require('fs');
      const target = out || `/tmp/today-${j.date}.json`;
      fs.writeFileSync(target, JSON.stringify(j, null, 1));
      console.log(`✓ ${j.count} maç · ${j.countLeagues} lig · ${j.countCountries} ülke · istatistikli ${j.statCoverage.withStats}`);
      console.log('→', target);
    })
    .catch(e => { console.error('HATA:', e.message); process.exit(1); });
}
