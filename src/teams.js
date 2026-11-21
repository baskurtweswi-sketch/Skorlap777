/**
 * Lig "Stats" alt sayfalarından takım bazlı veri çıkarma.
 *
 * Her sayfa için ayrı, test edilmiş ayrıştırıcı var:
 *   averagegoals · goalranges · corners · halftime · firstgoal · timing
 *   leaddurations · streaks · margins · scoredconceded · form · topscorers
 *
 * Sonuç lig bazında 20 dakika önbelleklenir; bir maçı analiz ederken
 * yalnızca eksik veri varsa ağa çıkılır.
 */
const cheerio = require('cheerio');
const { fetchHtml, BASE } = require('./ss');

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const toNum = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (t === '-' || t === '—' || t === '') return null;
  const m = t.replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
/** marj tabloları boş hücre için "-" kullanır; 0 sayılmalı */
const toNum0 = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (t === '-' || t === '—' || t === '') return 0;
  const v = toNum(t);
  return v == null ? 0 : v;
};
const toPct = (s) => {
  const m = String(s == null ? '' : s).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
};

function normTeam(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9ğüşıöç ]/g, ' ')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/\b(fc|sk|sc|ac|cf|afc|fk|club|kulubu|spor|jk|as|ss|sv|if|bk|united|utd|city|town)\b/g, ' ')
    .replace(/\s+/g, '');
}

/* ------------------------------------------------------------------ */
/* Sayfa -> satır ızgarası                                            */
/* ------------------------------------------------------------------ */
function grids($) {
  const out = [];
  $('table').each((_, t) => {
    const g = $(t).find('tr').toArray()
      .map(tr => $(tr).find('th,td').toArray().map(td => clean($(td).text())))
      .filter(r => r.some(c => c.length));
    if (g.length >= 3) out.push(g);
  });
  return out;
}

const isTeamName = (c) => {
  if (!c) return false;
  if (toNum(c) != null) return false;
  if (!/^[A-ZÇĞİÖŞÜa-z]/.test(c)) return false;
  if (/^(total|home|away|team|teams|top|bottom|matches|perc\.?|gp|avg)$/i.test(c)) return false;
  return c.length <= 40 && !/%/.test(c);
};

/**
 * Sayfadaki tabloların kapsamını belirler (Toplam / Ev / Deplasman).
 * soccerstats çok tablolu sayfalarda sırayla Total, Home, Away verir;
 * bazı sayfalarda başlık satırı "Home"/"Away" yazar. İkisini de destekler.
 */
function TableScope(gs) {
  const out = {};
  let current = 'Total';
  let seen = 0;
  gs.forEach((g, i) => {
    const firstCell = (g[0] || [])[0] || '';
    const joined = (g[0] || []).join(' ');
    if (/^home$/i.test(firstCell.trim())) current = 'Home';
    else if (/^away$/i.test(firstCell.trim())) current = 'Away';
    else if (/^total$/i.test(firstCell.trim())) current = 'Total';
    else if (i === 0) current = 'Total';
    else if (seen < 3) current = i === 1 ? 'Home' : i === 2 ? 'Away' : current;
    out[i] = current;
    seen++;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Ayrıştırıcılar                                                      */
/* ------------------------------------------------------------------ */

/** Average goals: Team | GP | Sc | Co | Tot | Sc | Co | Tot | Sc | Co | Tot */
function parseAverageGoals(gs) {
  const res = {};
  gs.forEach(g => {
    const sample = g.find(r => r.length >= 10 && toNum(r[1]) != null && isTeamName(r[0]));
    if (!sample) return;
    g.forEach(r => {
      if (r.length < 10 || toNum(r[1]) == null || !isTeamName(r[0])) return;
      res[normTeam(r[0])] = {
        name: r[0],
        avgGF: toNum(r[2]), avgGA: toNum(r[3]), avgTotal: toNum(r[4]),
        avgGFHome: toNum(r[5]), avgGAHome: toNum(r[6]), avgTotalHome: toNum(r[7]),
        avgGFAway: toNum(r[8]), avgGAAway: toNum(r[9]), avgTotalAway: toNum(r[10]),
      };
    });
  });
  return res;
}

/** Goal ranges: Team | GP | AVG | 0-1 | 2-3 | 4+  (tablo 0=Toplam, 1=Ev, 2=Dep) */
function parseGoalRanges(gs) {
  const res = {};
  const SCOPE = TableScope(gs);
  gs.forEach((g, gi) => {
    const sc = SCOPE[gi];
    if (!sc) return;
    g.forEach(r => {
      if (r.length < 6 || !isTeamName(r[0]) || toNum(r[1]) == null) return;
      const p = [toPct(r[3]), toPct(r[4]), toPct(r[5])];
      if (p.some(x => x == null)) return;
      const k = normTeam(r[0]);
      const cur = res[k] || { name: r[0] };
      cur[sc === 'Total' ? 'gr01' : sc === 'Home' ? 'gr01Home' : 'gr01Away'] = p[0];
      cur[sc === 'Total' ? 'gr23' : sc === 'Home' ? 'gr23Home' : 'gr23Away'] = p[1];
      cur[sc === 'Total' ? 'gr4p' : sc === 'Home' ? 'gr4pHome' : 'gr4pAway'] = p[2];
      res[k] = cur;
    });
  });
  return res;
}

/** Corner stats: Team | GP | For | Against | Total | (boş) | 8.5+ | 9.5+ | 10.5+ */
function parseCorners(gs) {
  const res = {};
  const SCOPE = TableScope(gs);
  gs.forEach((g, gi) => {
    const sc = SCOPE[gi];
    if (!sc) return;
    g.forEach(r => {
      if (r.length < 7 || !isTeamName(r[0])) return;
      const f = toNum(r[2]), a = toNum(r[3]), t = toNum(r[4]);
      if (f == null || a == null || t == null) return;
      if (f > 25 || a > 25 || t > 40) return;
      const k = normTeam(r[0]);
      const cur = res[k] || { name: r[0] };
      if (sc === 'Total') {
        cur.cornersFor = f; cur.cornersAgainst = a; cur.cornersTotal = t;
        cur.corners95 = toPct(r[6]); cur.corners105 = toPct(r[7]);
      } else {
        cur['cornersFor' + sc] = f; cur['cornersAgainst' + sc] = a; cur['cornersTotal' + sc] = t;
      }
      res[k] = cur;
    });
  });
  return res;
}

/** Halftime: Matches | Perc. | W | D | L | Goals | Pts | PPG  → İY sonuç yüzdeleri */
function parseHalftime(gs) {
  const res = {};
  let scopeIdx = 0; // 0: takımın önde olduğu İY'ler, 1: berabere, 2: geride ... değişken
  gs.forEach(g => {
    const hdr = (g[0] || []).join(' ').toLowerCase();
    if (!/perc/.test(hdr)) return;
    g.forEach((r, i) => {
      if (i === 0 || !isTeamName(r[0])) return;
      const pct = toPct(r[2]);
      if (pct == null) return;
      const k = normTeam(r[0]);
      const cur = res[k] || { name: r[0], htRows: [] };
      const parts = String(r[1] || '').match(/(\d+)\s*out of\s*(\d+)/i);
      cur.htRows.push({ count: parts ? +parts[1] : null, gp: parts ? +parts[2] : null, pct, w: toNum(r[3]), d: toNum(r[4]), l: toNum(r[5]) });
      res[k] = cur;
    });
  });
  // her takım için en yüksek 3 İY deseni (genelde sıralı gruplar)
  Object.values(res).forEach(t => {
    t.htRows.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    t.htTop = t.htRows.slice(0, 3);
  });
  return res;
}

/** First goal: Team | GP | (boş) | %SF | %NG | %CF | SF | NG | CF */
function parseFirstGoal(gs) {
  const res = {};
  gs.forEach(g => {
    g.forEach(r => {
      if (r.length < 6 || !isTeamName(r[0]) || toNum(r[1]) == null) return;
      const sf = toPct(r[3]), ng = toPct(r[4]), cf = toPct(r[5]);
      if (sf == null || cf == null) return;
      res[normTeam(r[0])] = {
        name: r[0], firstGoalPct: sf, noGoalPct: ng, concededFirstPct: cf,
        sf: toNum(r[6]), ng: toNum(r[7]), cf: toNum(r[8]),
      };
    });
  });
  return res;
}

/** Timing: Team | GP | 0-15 | 16-30 | ... "atılan-yenen" */
function parseTiming(gs) {
  const res = {};
  gs.forEach(g => {
    g.forEach(r => {
      if (r.length < 7 || !isTeamName(r[0]) || toNum(r[1]) == null) return;
      const segs = [];
      for (let i = 2; i <= 7; i++) {
        const m = String(r[i] || '').match(/(\d+)\s*-\s*(\d+)/);
        if (!m) return;
        segs.push({ for: +m[1], against: +m[2] });
      }
      res[normTeam(r[0])] = { name: r[0], timeSegments: segs };
    });
  });
  return res;
}

/** Lead durations: Team | GP | Leading | Level | Trailing */
function parseLeadDurations(gs) {
  const res = {};
  gs.forEach((g, gi) => {
    const scope = gi === 0 ? 'total' : gi === 1 ? 'home' : gi === 2 ? 'away' : null;
    if (!scope) return;
    g.forEach(r => {
      if (r.length < 5 || !isTeamName(r[0]) || toNum(r[1]) == null) return;
      const cur = res[normTeam(r[0])] || { name: r[0] };
      // r[2] görsel çubuk (boş) → gerçek veriler 3,4,5
      cur['lead_' + scope] = toPct(r[3]) || 0;
      cur['level_' + scope] = toPct(r[4]) || 0;
      cur['trail_' + scope] = toPct(r[5]) || 0;
      res[normTeam(r[0])] = cur;
    });
  });
  return res;
}

/** Streaks: Team | W | D | L | no W | no D | no L | no GF | no GA */
function parseStreaks(gs) {
  const res = {};
  gs.forEach((g, gi) => {
    const scope = gi === 0 ? 'total' : gi === 1 ? 'home' : gi === 2 ? 'away' : null;
    if (!scope) return;
    g.forEach(r => {
      if (r.length < 6 || !isTeamName(r[0])) return;
      const cur = res[normTeam(r[0])] || { name: r[0] };
      cur['streak_' + scope] = {
        win: toNum(r[1]), draw: toNum(r[2]), loss: toNum(r[3]),
        noWin: toNum(r[4]), noLoss: toNum(r[6]), noGF: toNum(r[7]), noGA: toNum(r[8]),
      };
      res[normTeam(r[0])] = cur;
    });
  });
  return res;
}

/** Form tablosu: # | Team | GP | W | D | L | GF | GA | GD | Pts | OppPPG */
function parseForm(gs) {
  const res = {};
  gs.forEach(g => {
    g.forEach(r => {
      if (r.length < 10 || toNum(r[0]) == null || !isTeamName(r[1])) return;
      if (toNum(r[2]) == null || toNum(r[2]) > 12) return;
      if (toNum(r[9]) == null) return;
      res[normTeam(r[1])] = {
        name: r[1], formGP: toNum(r[2]), formW: toNum(r[3]), formD: toNum(r[4]),
        formL: toNum(r[5]), formGF: toNum(r[6]), formGA: toNum(r[7]),
        formPts: toNum(r[9]), formOppPPG: toNum(r[10]),
      };
    });
  });
  return res;
}

/* ------------------------------------------------------------------ */
/* Sayfa listesi + birleştirme                                         */
/* ------------------------------------------------------------------ */
/** Goal margins (Total/Home/Away tabloları) */
function parseMargins(gs) {
  const res = {};
  const SCOPE = ['Total', 'Home', 'Away'];
  gs.forEach((g, gi) => {
    const sc = SCOPE[gi];
    if (!sc) return;
    g.forEach(r => {
      if (r.length < 11 || !isTeamName(r[0])) return;
      const w = [toNum0(r[1]), toNum0(r[2]), toNum0(r[3]), toNum0(r[4])];
      const l = [toNum0(r[8]), toNum0(r[9]), toNum0(r[10]), toNum0(r[11])];
      const gp = toNum(r[5]) != null && toNum(r[6]) != null && toNum(r[7]) != null
        ? toNum(r[5]) + toNum(r[6]) + toNum(r[7]) : null;
      if (!gp) return;   // takım satırı değil
      const k = normTeam(r[0]);
      const cur = res[k] || { name: r[0] };
      const wc = w, lc = l;
      if (sc === 'Total') {
        cur.marginsW = wc; cur.marginsL = lc;
        cur.marginsWTotal = wc.reduce((a, b) => a + b, 0);
        cur.marginsLTotal = lc.reduce((a, b) => a + b, 0);
        cur.marginsW1 = toNum(r[5]); cur.marginsD = toNum(r[6]); cur.marginsL1 = toNum(r[7]);
      } else {
        cur['marginsW' + sc] = wc.reduce((a, b) => a + b, 0);
        cur['marginsL' + sc] = lc.reduce((a, b) => a + b, 0);
      }
      res[k] = cur;
    });
  });
  return res;
}

/** Scored vs Conceded: Team | 4+|3|2|1|0 (scored) | AVG | AVG | 0|1|2|3|4+ (conceded) */
function parseScoredConceded(gs) {
  const res = {};
  gs.forEach(g => {
    g.forEach(r => {
      if (r.length < 11 || !isTeamName(r[0])) return;
      const avgScored = toNum(r[6]);
      const avgConc = toNum(r[7]);
      if (avgScored == null || avgConc == null) return;
      res[normTeam(r[0])] = {
        name: r[0],
        scoredDist: [toNum0(r[5]), toNum0(r[4]), toNum0(r[3]), toNum0(r[2]), toNum0(r[1])],
        concededDist: [toNum0(r[8]), toNum0(r[9]), toNum0(r[10]), toNum0(r[11]), toNum0(r[12])],
        avgScoredPage: avgScored, avgConcededPage: avgConc,
      };
    });
  });
  return res;
}

/** Equalizers: Team | GP | öne geçme | per game | | eşitleme | oran | % */
function parseEqualizers(gs) {
  const res = {};
  const g0 = gs[0];
  if (!g0) return res;
  let first = true;
  g0.forEach(r => {
    if (!isTeamName(r[0])) return;
    const gp = toNum(r[1]);
    if (gp == null || gp > 60) return;
    // yüzde: soldan 3. yüzde hücresi (son hücre boş olabilir)
    const pcts = r.map(toPct).filter(v => v != null);
    if (!pcts.length) return;
    const pct = pcts[pcts.length - 1];
    const k = normTeam(r[0]);
    if (res[k]) return;
    res[k] = { name: r[0], equalizerPct: pct, equalizerGP: gp };
    first = false;
  });
  return res;
}

/** Total goals dağılımı: Team | GP | AVG | 0 | 1 | 2 | 3 | 4 | 5+  (yüzdeler) */
function parseTotalGoals(gs) {
  const res = {};
  gs.forEach((g, gi) => {
    if (gi > 2) return; // Total, Home, Away
    g.forEach(r => {
      if (!isTeamName(r[0]) || toNum(r[1]) == null) return;
      const pcts = r.slice(3).map(toPct).filter(x => x != null);
      if (pcts.length < 5) return;
      const dist = pcts.slice(0, 6); // 0,1,2,3,4,5+
      const k = normTeam(r[0]);
      const cur = res[k] || { name: r[0] };
      if (gi === 0) cur.totalGoalsDist = dist;
      res[k] = cur;
    });
  });
  return res;
}

const PAGES = [
  ['table/averagegoals', parseAverageGoals],
  ['table/goalranges', parseGoalRanges],
  ['table/corners', parseCorners],
  ['halftime', parseHalftime],
  ['firstgoal', parseFirstGoal],
  ['timing', parseTiming],
  ['table/leaddurations', parseLeadDurations],
  ['table/streaks', parseStreaks],
  ['form', parseForm],
  ['table/margins', parseMargins],
  ['table/scoredconceded', parseScoredConceded],
  ['table/equalizers', parseEqualizers],
  ['table/totalgoals', parseTotalGoals],
];

const LEAGUE_TTL = 20 * 60 * 1000;
const leagueCache = new Map(); // base -> {ts, data, pending}

/**
 * Ligdeki tüm takım profillerini getirir (önbellekli).
 * @param {string} leagueBase /nodeweb/en-gb/leagues/turkey/super-lig/turkey
 * @param {{only?:string[]}} opts
 */
async function getLeagueTeamData(leagueBase, opts = {}) {
  const base = leagueBase.replace(/\/$/, '');
  const hit = leagueCache.get(base);
  if (hit && Date.now() - hit.ts < LEAGUE_TTL) return hit.data;
  if (hit && hit.pending) return hit.pending;

  const pending = (async () => {
    const merged = {};
    const pages = opts.only ? PAGES.filter(p => opts.only.includes(p[0])) : PAGES;
    const status = {};
    for (const [path, parser] of pages) {
      try {
        const html = await fetchHtml(base + '/' + path, { ttl: 1800 });
        const $ = cheerio.load(html);
        const parsed = parser(grids($));
        status[path] = Object.keys(parsed).length;
        Object.entries(parsed).forEach(([k, v]) => {
          merged[k] = Object.assign(merged[k] || {}, v);
        });
      } catch (e) {
        status[path] = 'HATA: ' + e.message.slice(0, 50);
      }
    }
    return { base, teams: merged, status, fetchedAt: new Date().toISOString() };
  })();

  leagueCache.set(base, { ts: 0, data: hit ? hit.data : null, pending });
  const data = await pending;
  leagueCache.set(base, { ts: Date.now(), data });
  return data;
}

/** Maçtaki iki takımı bul (isim normalizasyonu + kısmi eşleşme) */
function findTeam(teamsObj, name) {
  const n = normTeam(name);
  if (!n) return null;
  if (teamsObj[n]) return teamsObj[n];
  let best = null, bestLen = 0;
  for (const [k, v] of Object.entries(teamsObj)) {
    if (k && (k.includes(n) || n.includes(k))) {
      const l = Math.min(k.length, n.length);
      if (l > bestLen) { best = v; bestLen = l; }
    }
  }
  return best;
}

module.exports = { getLeagueTeamData, findTeam, normTeam, PAGES };
