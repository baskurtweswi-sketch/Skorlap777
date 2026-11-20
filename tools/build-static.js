/**
 * SkorLab · sunucusuz statik derleme (GitHub Pages + Actions için)
 *
 * Sunucuya (server.js) ve tünele ihtiyaç duymadan, bugünün verisini kaynaktan
 * çekip tek dosyalık index.html + version.json üretir.
 *   node tools/build-static.js [index.html] [version.json]
 *
 * Veri akışı: src/fixtures.collectDay → bülten kur (server.js buildTodayBulletin
 * ile aynı mantık) → public/index.html içine göm (build-merged-package.js ile
 * aynı yamalar) → index.html + version.json (APK'nın bütünlük kontrolü için).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { collectDay } = require('../src/fixtures');
const { analyzeMatch } = require('../src/analyze');

const ROOT = path.join(__dirname, '..');
const OUT_HTML = process.argv[2] || path.join(ROOT, 'index.html');
const OUT_VER = process.argv[3] || path.join(ROOT, 'version.json');

function todayIstanbul() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/* server.js buildTodayBulletin ile birebir aynı mantık */
function buildTodayBulletin(src) {
  if (!src || !src.matches || !src.matches.length) return null;

  const byLeague = new Map();
  for (const m of src.matches) {
    const key = m.country + '|' + m.league;
    if (!byLeague.has(key)) byLeague.set(key, { country: m.country, name: m.league, matches: [] });
    const lgMeta = { country: m.country, name: m.league, avgGoals: null, homeAvg: null, awayAvg: null };
    const match = {
      id: null,
      league: m.league,
      country: m.country,
      home: m.home,
      away: m.away,
      utc: `${m.date}T${(m.time || '00:00')}:00+03:00`,
      status: m.status || 'NS',
      score: null,
      url: m.url || null,
      homeStats: m.homeStats || {}, awayStats: m.awayStats || {},
      matchId: m.matchId || null,
      homeTeamId: m.homeTeamId || null,
      awayTeamId: m.awayTeamId || null,
      competitionId: m.competitionId || null,
    };
    let analysis;
    try {
      analysis = analyzeMatch(match, lgMeta, { homeProf: null, awayProf: null, leagueProf: {} });
    } catch (e) {
      continue;
    }
    match.analysis = analysis;
    byLeague.get(key).matches.push(match);
  }

  const leagues = [...byLeague.values()].filter(l => l.matches.length).map(l => ({
    ...l,
    matchCount: l.matches.length,
    base: null,
  }));
  const countMatches = leagues.reduce((a, l) => a + l.matches.length, 0);
  return {
    fetchedAt: src.generatedAt || null,
    source: 'soccerstats.com · bugünün fikstürü (otomatik derlendi)',
    degraded: false,
    today: true,
    countLeagues: leagues.length,
    countMatches,
    dates: [src.matches[0].date],
    leagues,
  };
}

(async () => {
  const today = todayIstanbul();
  console.log(`→ ${today} verisi kaynaktan çekiliyor…`);
  const src = await collectDay(today, { log: (m) => console.log('  ' + m) });
  if (!src || !src.matches || !src.matches.length) throw new Error('kaynakta maç bulunamadı');

  const bulletin = buildTodayBulletin(src);
  if (!bulletin) throw new Error('bülten kurulamadı');

  /* build-merged-package.js ile aynı "full" sarma (snapshot birleştirme yok) */
  const todayLeagues = bulletin.leagues.map(lg => ({
    ...lg,
    matches: lg.matches.map(m => ({
      ...m,
      full: { match: { home: m.home, away: m.away, utc: m.utc, status: m.status, score: null, url: m.url },
              league: { country: lg.country, name: lg.name },
              analysis: m.analysis, teamProfiles: { home: null, away: null },
              meta: { leagueTeams: 0, source: 'bugünün fikstürü' } },
    })),
  }));

  const merged = {
    fetchedAt: new Date().toISOString(),
    source: 'günlük bülten (otomatik derlendi)',
    countMatches: todayLeagues.reduce((a, l) => a + l.matches.length, 0),
    countLeagues: todayLeagues.length,
    dates: [...new Set([].concat(...todayLeagues.map(l => l.matches.map(m => (m.utc || '').slice(0, 10)))))].sort(),
    leagues: todayLeagues,
  };

  /* akıl sağlığı kontrolü: anormal düşük sayı yayına çıkmasın */
  if (merged.countMatches < 50) throw new Error('maç sayısı anormal derecede düşük: ' + merged.countMatches);

  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const payload = JSON.stringify(merged);
  html = html.replace('<script>\nconst state =', '<script>window.__SNAPSHOT__=' + payload + ';\nconst state =');

  /* loadData'nın TAMAMINI gömülü veriyle çalışan sürümle değiştir */
  const startMark = 'async function loadData(refresh = false) {';
  const endMark = "$('#refreshBtn').onclick = () => loadData(true);";
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error('loadData bloğu bulunamadı');
  const offlineLoadData = `async function loadData(refresh = false) {
  if (state.loading) return;
  state.loading = true;
  $('#subline').innerHTML = '<span class="loader"></span> &nbsp;bülten yükleniyor…';
  try {
    const j = JSON.parse(JSON.stringify(window.__SNAPSHOT__ || {}));
    if (!j || !j.leagues) throw new Error('Gömülü veri yok');
    j.degraded = false;
    state.data = j;
    ensureSmartDate();
    renderTabs();
    render();
    const todayDate = (j.dates || [])[0] || '';
    $('#subline').textContent = j.countMatches + ' maç · ' + j.countLeagues + ' lig · '
      + (todayDate ? new Date(todayDate + 'T12:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }) : '')
      + ' · çevrimdışı paket';
  } catch (e) {
    $('#app').innerHTML = '<div class="empty">Veri alınamadı.<br><span class="small">' + esc(e.message) + '</span></div>';
    $('#subline').textContent = 'Bağlantı hatası';
  } finally {
    state.loading = false;
  }
}
`;
  html = html.slice(0, a) + offlineLoadData + html.slice(b);

  /* bugünün fikstürü isteğini kapat (pakette birleşik) */
  html = html.replace(`      const r2 = await fetch('/api/bulletin?today=1');`, `      const r2 = null; if (r2) {`);
  html = html.replace(`      const t2 = await r2.json();`, `      const t2 = await r2.json(); }`);
  html = html.replace(`  if (window.__SNAPSHOT__) { renderAnalyzeOffline(url); return; }`,
    `  if (window.__SNAPSHOT__) {
    const S = window.__SNAPSHOT__;
    let hit = null;
    S.leagues.forEach(lg => lg.matches.forEach(mm => { if (mm.url === url) hit = { m: mm, lg }; }));
    if (hit && hit.m.full) { renderAnalyze(Object.assign({}, hit.m.full, { offline: false })); return; }
    renderAnalyzeOffline(url); return;
  }`);
  html = html.replace('async function loadDetail(url) {',
    `async function loadDetail(url) {
  if (window.__SNAPSHOT__) {
    let h = null; window.__SNAPSHOT__.leagues.forEach(lg => lg.matches.forEach(mm => { if (mm.url === url) h = mm; }));
    if (h && h.full && h.full.detail) { renderDetailSections(h.full.detail.sections || []); return; }
    const bx = $('#detailBox'); if (bx) bx.innerHTML = '<div class="small muted">Trend verisi bu pakette yok.</div>';
    return;
  }`);
  html = html.replace('async function loadLineups(m) {',
    `async function loadLineups(m) {
  if (window.__SNAPSHOT__) {
    const b0 = $('#lineupBox');
    if (b0) b0.innerHTML = '<div class="small muted">İlk 11 verisi çevrimdışı pakette yok.</div>';
    return;
  }`);

  /* statik hostta /apk ucu yok → APK dosyası aynı klasörde */
  html = html.replace('href="/apk"', 'href="SkorLab-2.9.apk"');

  /* çıktı doğrulaması: yama tutmadıysa yayına çıkma */
  const checks = [
    ['window.__SNAPSHOT__=', html.includes('window.__SNAPSHOT__=')],
    ['loadData yaması', html.includes('Gömülü veri yok')],
    ['maç detay yaması', html.includes('hit.m.full')],
    ['ilk 11 yaması', html.includes('İlk 11 verisi çevrimdışı pakette yok')],
    ['APK bağlantısı', html.includes('SkorLab-2.9.apk')],
    ['html kapanışı', html.trimEnd().endsWith('</html>')],
  ];
  for (const [name, ok] of checks) if (!ok) throw new Error('çıktı doğrulaması başarısız: ' + name);

  fs.writeFileSync(OUT_HTML, html);
  const buf = fs.readFileSync(OUT_HTML);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(OUT_VER, JSON.stringify({
    date: today,
    updatedAt: new Date().toISOString(),
    bytes: buf.length,
    sha256: sha,
    matches: merged.countMatches,
    leagues: merged.countLeagues,
  }, null, 1) + '\n');

  console.log(`✓ ${OUT_HTML} · ${merged.countMatches} maç / ${merged.countLeagues} lig · ${(buf.length / 1048576).toFixed(2)} MB`);
  console.log(`✓ ${OUT_VER} · sha256 ${sha.slice(0, 16)}…`);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
