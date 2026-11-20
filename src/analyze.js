/**
 * Maç analiz motoru v2
 *
 * Girdi katmanları:
 *  1) Bülten tablosu (ev/dep bazlı sezon istatistikleri: GF, GA, PPG, KG, üst yüzdeler)
 *  2) Lig "Stats" sayfaları (takım profilleri: korner, gol aralığı, İY, ilk gol, timing, form)
 *  3) Lig ortalamaları (ev/dep gol ortalaması)
 *
 * Çıktı: tüm pazarlar için yüzdeler + adil oranlar, harmanlanmış xG, güven skoru,
 *        model/veri kaynağı şeffaflığı.
 */

const MAX_GOALS = 9;

function pois(k, lambda) {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}
function grid(lh, la, max = MAX_GOALS) {
  const p = [];
  for (let h = 0; h <= max; h++) {
    p[h] = [];
    for (let a = 0; a <= max; a++) p[h][a] = pois(h, lh) * pois(a, la);
  }
  return p;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const p1 = (v) => Math.round(v * 10) / 10;
const pct = (v) => Math.round(v * 1000) / 10;

/** İstenen aralık yüzdelerini Poisson ızgarasından üret */
function simulate(g) {
  const m = {
    home: 0, draw: 0, away: 0, btts: 0,
    over: { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0, 5.5: 0 },
    corr: { '0-1': 0, '2-3': 0, '4+': 0 },
    margins: {},
    ht: { home: 0, draw: 0, away: 0, over05: 0, over15: 0 },
    firstGoalHome: 0, firstGoalNone: 0,
    cleanSheetHome: 0, cleanSheetAway: 0,
    scores: [],
  };
  const halfShare = 0.44;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = g[h][a];
      const tot = h + a;
      if (h > a) m.home += p; else if (h === a) m.draw += p; else m.away += p;
      if (h > 0 && a > 0) m.btts += p;
      for (const k of Object.keys(m.over)) if (tot > parseFloat(k)) m.over[k] += p;
      if (tot <= 1) m.corr['0-1'] += p; else if (tot <= 3) m.corr['2-3'] += p; else m.corr['4+'] += p;
      const diff = h - a;
      if (Math.abs(diff) >= 1) {
        const k = (diff > 0 ? 'W' : 'L') + Math.min(Math.abs(diff), 4);
        m.margins[k] = (m.margins[k] || 0) + p;
      } else m.margins.D = (m.margins.D || 0) + p;
      if (a === 0) m.cleanSheetHome += p;
      if (h === 0) m.cleanSheetAway += p;
      if (tot === 0) m.firstGoalNone += p;
      else m.firstGoalHome += p * (h / tot);
      // İlk yarı: her takımın gollerinin %44'ü, iki bağımsız Poisson ile
      m.scores.push({ score: `${h}-${a}`, p });
    }
  }
  m.scores.sort((x, y) => y.p - x.p);

  // İlk yarı dağılımı ayrı ızgarayla
  const lhHT = null; // modelde xG'nin yarısını kullanacağız (aşağıda)
  return m;
}

function htSim(lh, la) {
  const share = 0.44;
  const gh = grid(lh * share, la * share, 6);
  let home = 0, draw = 0, away = 0, o05 = 0, o15 = 0;
  for (let h = 0; h < gh.length; h++) {
    for (let a = 0; a < gh.length; a++) {
      const p = gh[h][a];
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
      if (h + a >= 1) o05 += p;
      if (h + a >= 2) o15 += p;
    }
  }
  return { home, draw, away, over05: o05, over15: o15 };
}

/** Korner beklentisi ve üst yüzdeleri (Poisson) */
function cornerModel(homeProf, awayProf, leagueProf) {
  const fallback = 9.6; // tipik lig toplam korner
  const lf = leagueProf && leagueProf.cornersFor ? leagueProf.cornersFor : fallback / 2;
  const la = leagueProf && leagueProf.cornersAgainst ? leagueProf.cornersAgainst : fallback / 2;

  const hFor = homeProf && homeProf.cornersForHome != null ? homeProf.cornersForHome
    : homeProf && homeProf.cornersFor != null ? homeProf.cornersFor : lf;
  const aAga = awayProf && awayProf.cornersAgainstAway != null ? awayProf.cornersAgainstAway
    : awayProf && awayProf.cornersAgainst != null ? awayProf.cornersAgainst : la;
  const aFor = awayProf && awayProf.cornersForAway != null ? awayProf.cornersForAway
    : awayProf && awayProf.cornersFor != null ? awayProf.cornersFor : lf;
  const hAga = homeProf && homeProf.cornersAgainstHome != null ? homeProf.cornersAgainstHome
    : homeProf && homeProf.cornersAgainst != null ? homeProf.cornersAgainst : la;

  const expHome = clamp((hFor + aAga) / 2, 2, 9);
  const expAway = clamp((aFor + hAga) / 2, 2, 9);
  const total = expHome + expAway;
  const over = (line) => {
    const max = 40;
    let s = 0;
    for (let k = 0; k <= max; k++) if (k > line) s += pois(k, total);
    return clamp(s, 0, 1);
  };
  return {
    expHome: p1(expHome), expAway: p1(expAway), expTotal: p1(total),
    over85: over(8.5), over95: over(9.5), over105: over(10.5),
    homeMost: clamp(expHome > expAway ? (expHome / total) * 1.15 + 0.1 : 0.5 - (expAway - expHome) / 8, 0.1, 0.9),
  };
}

/**
 * @param {object} match  bülten maçı (home, away, homeStats, awayStats)
 * @param {object} league lig özeti (homeAvg, awayAvg, avgGoals)
 * @param {object} opts   { homeProf, awayProf, leagueProf }
 */
function analyzeMatch(match, league = {}, opts = {}) {
  const hs = match.homeStats || {};
  const as = match.awayStats || {};
  const homeProf = opts.homeProf || {};
  /* Ampirik Bayes küçültmesi: az maçta site yüzdeleri uç değer verir
   * (ör. 2 maçta KG 0/2 → %0, kazanma %100). Değerleri örneklemle
   * önceki değere (prior) doğru çek; maç sayısı arttıkça gerçek değer kalır. */
const shrink = (v, gp, prior = 0.5) => (v == null ? null
    : prior + (v - prior) * clamp((gp || 0) / parseFloat(process.env.SHRINK_N || '8'),
        parseFloat(process.env.SHRINK_FLOOR || '0.75'), 1));

  const awayProf = opts.awayProf || {};
  const leagueProf = opts.leagueProf || {};

  const homeAvg = league.homeAvg || 1.5;
  const awayAvg = league.awayAvg || 1.2;
  const leagueAvg = league.avgGoals || homeAvg + awayAvg;

  // ---- 1) xG: bülten (ev/dep) + gol ortalaması sayfaları harmanı ----
  const hGF = hs.gf != null ? hs.gf : (homeProf.avgGFHome != null ? homeProf.avgGFHome : homeAvg);
  const hGA = hs.ga != null ? hs.ga : (homeProf.avgGAHome != null ? homeProf.avgGAHome : awayAvg);
  const aGF = as.gf != null ? as.gf : (awayProf.avgGFAway != null ? awayProf.avgGFAway : awayAvg);
  const aGA = as.ga != null ? as.ga : (awayProf.avgGAAway != null ? awayProf.avgGAAway : homeAvg);

  const hAtt = clamp(hGF / homeAvg, 0.28, 2.6);
  const hDef = clamp(hGA / awayAvg, 0.28, 2.6);
  const aAtt = clamp(aGF / awayAvg, 0.28, 2.6);
  const aDef = clamp(aGA / homeAvg, 0.28, 2.6);

  let xgHome = hAtt * aDef * homeAvg;
  let xgAway = aAtt * hDef * awayAvg;

  // küçük örneklemde lig ortalamasına çek
  const nh = hs.gp || homeProf.formGP || 0;
  const na = as.gp || awayProf.formGP || 0;
  const wH = clamp(Math.min(1, nh / 8) * 0.7 + 0.3, 0.3, 1);
  const wA = clamp(Math.min(1, na / 8) * 0.7 + 0.3, 0.3, 1);
  xgHome = xgHome * wH + homeAvg * (1 - wH);
  xgAway = xgAway * wA + awayAvg * (1 - wA);

  /* ---- M1) Form ve rakip gücü düzeltmesi ----
   * Son N maçlık form (formPts/formGP) ve oynanan rakiplerin maç başına puanı
   * (formOppPPG) xG'yi düzeltir: formda olan takım yukarı, zor fikstür
   * geçiren takım da yukarı çekilir (form yanıltıcıysa nötrlenir). */
  const formAdjust = (prof, key) => {
    const gp = prof.formGP, pts = prof.formPts, opp = prof.formOppPPG;
    if (!gp || pts == null) return 1;
    const ppg = pts / gp;                       // 0..3
    // Az maç oynayan takımda form gürültülüdür → etkiyi örneklemle küçült
    const trust = clamp(gp / 6, 0.15, 1);
    let adj = 1 + clamp((ppg - 1.35) * 0.075, -0.14, 0.14) * trust;
    if (opp != null) adj *= 1 + clamp((opp - 1.35) * 0.045, -0.07, 0.07) * trust;
    return clamp(adj, 0.82, 1.20);
  };
  const hFormAdj = formAdjust(homeProf), aFormAdj = formAdjust(awayProf);
  xgHome = xgHome * hFormAdj * (0.5 + 0.5 * (aFormAdj ? 2 - aFormAdj : 1));
  xgAway = xgAway * aFormAdj * (0.5 + 0.5 * (hFormAdj ? 2 - hFormAdj : 1));

  /* ---- M1b) Gol dağılımı düzeltmesi (Scored vs Conceded sayfası) ----
   * Takımın kaç maçta 0/1/2/3/4+ gol attığı ve yediği dağılım, Poisson'un
   * varsaydığı düzgün dağılımdan sapıyorsa xG'yi gerçekçi yöne çeker. */
  const distMean = (d) => {
    if (!d || !d.length) return null;
    const n = d.reduce((x, y) => x + y, 0);
    if (!n) return null;
    return d.reduce((acc, c, i) => acc + c * i, 0) / n;
  };
  const hsScored = distMean(homeProf.scoredDist), asScored = distMean(awayProf.scoredDist);
  if (hsScored != null && homeProf.avgScoredPage != null && homeProf.avgScoredPage > 0) {
    // site ortalaması ile dağılım ortalaması tutarlıysa hafif düzeltme
    const r = hsScored / homeProf.avgScoredPage;
    if (r > 0) xgHome *= clamp(0.6 + 0.4 * r, 0.85, 1.15);
  }
  if (asScored != null && awayProf.avgScoredPage != null && awayProf.avgScoredPage > 0) {
    const r = asScored / awayProf.avgScoredPage;
    if (r > 0) xgAway *= clamp(0.6 + 0.4 * r, 0.85, 1.15);
  }

  // gol ortalaması sayfaları varsa hafifçe harmanla (tüm sezon, daha büyük örneklem)
  if (homeProf.avgGF != null && awayProf.avgGA != null) {
    const alt = ((homeProf.avgGF + awayProf.avgGA) / 2) * 1.0;
    xgHome = xgHome * 0.75 + alt * 0.25;
  }
  if (awayProf.avgGF != null && homeProf.avgGA != null) {
    const alt = ((awayProf.avgGF + homeProf.avgGA) / 2) * 1.0;
    xgAway = xgAway * 0.75 + alt * 0.25;
  }

  xgHome = clamp(xgHome, 0.2, 4.5);
  xgAway = clamp(xgAway, 0.2, 4.5);

  let g = grid(xgHome, xgAway);

  /* ---- Toplam gol dağılımı kalibrasyonu (Total Goals sayfası) ----
   * Sitenin sezonluk 0,1,2,3,4,5+ gol yüzdeleriyle Poisson dağılımını
   * ağırlıklı olarak harmanlar. Skorların "şekli" korunur, toplam gol
   * dağılımı gerçek veriye çekilir → üst/alt ve skor isabeti artar. */
  // Ham site dağılımı (gösterim için; kalibrasyon ayrıca karar verir)
  const tgRaw = (() => {
    const h = homeProf.totalGoalsDist, a = awayProf.totalGoalsDist;
    if (!h || !a) return null;
    const mix = [];
    for (let i = 0; i < 6; i++) mix.push(((h[i] || 0) + (a[i] || 0)) / 2 / 100);
    const sum = mix.reduce((x, y) => x + y, 0);
    if (sum <= 0.2) return null;
    return mix.map(v => v / sum);
  })();
  const tgInfo = (() => {
    if (!tgRaw) return null;
    // Örneklem küçükse (ör. CL'de 4 maç) site dağılımı uç değerler verir:
    // güvenilirliği maç sayısına göre ölçekle, güvenilmezse hiç kullanma.
    const gpMin = Math.min(
      homeProf.formGP || homeProf.avgGF != null ? (homeProf.formGP || 6) : 6,
      awayProf.formGP || awayProf.avgGF != null ? (awayProf.formGP || 6) : 6
    );
    if (gpMin < 5) return null;                  // çok az maç → Poisson kalsın
    return { dist: tgRaw, reliability: clamp((gpMin - 4) / 8, 0.15, 1) };
  })();

  const tgSite = tgInfo ? tgInfo.dist : null;
  const tgWeight = tgInfo ? 0.42 * tgInfo.reliability : 0;
  if (tgSite) {
    // Poisson'un toplam gol dağılımı
    const poisDist = [0, 0, 0, 0, 0, 0];
    let rest = 0;
    for (let hh = 0; hh <= MAX_GOALS; hh++)
      for (let aa = 0; aa <= MAX_GOALS; aa++) {
        const t2 = hh + aa;
        if (t2 <= 5) poisDist[t2] += g[hh][aa]; else rest += g[hh][aa];
      }
    const poisSum = poisDist.reduce((x, y) => x + y, 0) + rest;

    // Hedef dağılım: %72 site + %28 poisson (site ağırlıklı, ama tek başına değil)
    const W = tgWeight;
    if (W < 0.05) { /* güvenilir değil → kalibrasyon yok */ }
    const target = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) target[i] = poisDist[i] / poisSum * (1 - W) + tgSite[i] * W;
    target[5] += rest / poisSum * (1 - W);

    // Izgarayı ölçekle: her hücre, kendi toplam-gol grubundaki oranla çarpılır
    const scale = [];
    for (let i = 0; i < 6; i++) {
      const cur = i < 5 ? poisDist[i] / poisSum : (poisDist[5] + rest) / poisSum;
      scale[i] = cur > 1e-9 ? target[i] / cur : 1;
    }
    for (let hh = 0; hh <= MAX_GOALS; hh++)
      for (let aa = 0; aa <= MAX_GOALS; aa++) {
        const t2 = hh + aa;
        g[hh][aa] *= scale[Math.min(t2, 5)];
      }
    // yeniden normalize
    let tot = 0;
    for (let hh = 0; hh <= MAX_GOALS; hh++) for (let aa = 0; aa <= MAX_GOALS; aa++) tot += g[hh][aa];
    for (let hh = 0; hh <= MAX_GOALS; hh++) for (let aa = 0; aa <= MAX_GOALS; aa++) g[hh][aa] /= tot;
  }

  const sim = simulate(g);
  const ht = htSim(xgHome, xgAway);

  // ---- 2) Olasılıklar: model + sitenin yüzdeleri harmanı ----
  const blend = (model, site, w = 0.35) => (site == null ? model : model * (1 - w) + site * w);

  // Kazanma yüzdeleri de küçük örneklemde uç olur (2 maçta %100 → beraberlik ~0)
  const wpH = hs.wp != null ? shrink(hs.wp / 100, hs.gp, 1 / 3) : null;
  const wpA = as.wp != null ? shrink(as.wp / 100, as.gp, 1 / 3) : null;
  let pHome = blend(sim.home, wpH);
  let pAway = blend(sim.away, wpA);
  const notWinH = wpH != null ? 1 - wpH : null;
  const notWinA = wpA != null ? 1 - wpA : null;
  const siteDraw = notWinH != null && notWinA != null
    ? clamp(Math.sqrt(notWinH * notWinA) * 0.62, 0.16, 0.42) : null;
  let pDraw = blend(sim.draw, siteDraw, 0.35);
  const s = pHome + pDraw + pAway;
  pHome /= s; pDraw /= s; pAway /= s;

  /* Site yüzdeleri küçük örneklemde uç değer verir (ör. 2 maçta KG 0/2 → %0).
   * Ampirik Bayes: az maçta değeri 0.5'e doğru küçült, maç sayısı arttıkça
   * gerçek değere bırak. Böylece "KG %18" gibi imkânsız sonuçlar oluşmaz. */
  const bttsGp = Math.min(hs.gp != null ? hs.gp : 8, as.gp != null ? as.gp : 8);
  const o25Gp = bttsGp;

  // KG: site bülten yüzdeleri (örnekleme göre küçültülmüş)
  const bttsSite = (hs.bts != null && as.bts != null)
    ? shrink((hs.bts / 100 + as.bts / 100) / 2, bttsGp, 0.5, 0.65) : null;
  // NOT: noGoalPct harmanı backtest'te KG isabetini düşürdü (54→45), bu yüzden
  // varsayılan ağırlık 0. Site bülten yüzdeleri ana sinyal (BTTS_SITE_W=0.70).
  const bttsFromNoGoal = (() => {
    const h = homeProf.noGoalPct, a = awayProf.noGoalPct;
    if (h == null && a == null) return null;
    const avgNG = ((h || 0) + (a || 0)) / 200;      // ortalama gol-atamama oranı
    return clamp(1 - avgNG * 1.35, 0.25, 0.95);    // iki takım da atar yaklaşımı
  })();
  const NG_W = parseFloat(process.env.BTTS_NG_W || '0');
  // Harman ağırlığı da örnekleme bağlı: 2 maçlık veriye %85 güvenilmez
  const bttsW = parseFloat(process.env.BTTS_SITE_W || '0.85') * clamp(bttsGp / 8, 0.75, 1);
  let pBtts = blend(sim.btts, bttsSite, bttsW);
  if (bttsFromNoGoal != null) pBtts = pBtts * (1 - NG_W) + bttsFromNoGoal * NG_W;

  // Üst 2.5: site yüzdeleri + Goal Ranges (4+ gol) sayfası
  // NOT: O25 bültende uç değer üretmiyor (shrink uygulanınca isabet düşüyor),
  // bu yüzden ham site değeri kullanılır. Uç risk taşıyan tek alan KG.
  let pO25 = blend(sim.over[2.5],
    (hs.o25 != null && as.o25 != null) ? (hs.o25 / 100 + as.o25 / 100) / 2 : null,
    parseFloat(process.env.O25_SITE_W || '0.3'));
  const gr4plus = (homeProf.gr4p != null && awayProf.gr4p != null)
    ? (homeProf.gr4p + awayProf.gr4p) / 200 : null;
  const GR_W = parseFloat(process.env.O25_GR_W || '0.10');
  if (gr4plus != null) pO25 = pO25 * (1 - GR_W) + gr4plus * GR_W;

  // ---- 3) Gol aralıkları: model + sitenin Goal Ranges sayfası ----
  const grSite = (() => {
    const h = homeProf, a = awayProf;
    const mix = (k1, k2) => (h[k1] != null && a[k2] != null ? (h[k1] + a[k2]) / 200 : null);
    const o01 = mix('gr01Home', 'gr01Away');
    const o23 = mix('gr23Home', 'gr23Away');
    const o4p = mix('gr4pHome', 'gr4pAway');
    if (o01 == null || o23 == null || o4p == null) return null;
    const t = o01 + o23 + o4p;
    return { '0-1': o01 / t, '2-3': o23 / t, '4+': o4p / t };
  })();
  const ranges = {
    '0-1': blend(sim.corr['0-1'], grSite ? grSite['0-1'] : null, 0.3),
    '2-3': blend(sim.corr['2-3'], grSite ? grSite['2-3'] : null, 0.3),
    '4+': blend(sim.corr['4+'], grSite ? grSite['4+'] : null, 0.3),
  };
  const rsum = ranges['0-1'] + ranges['2-3'] + ranges['4+'];
  Object.keys(ranges).forEach(k => { ranges[k] = ranges[k] / rsum; });

  // ---- 4) İlk yarı ----
  const htSite = (() => {
    const h = homeProf, a = awayProf;
    // İY'de önde/berabere/geride yüzdeleri (htTop ilk eleman = en sık desen)
    return null; // yapı sayfa bazlı değişken; şimdilik model kullanılıyor
  })();
  let htHome = ht.home, htDraw = ht.draw, htAway = ht.away;
  // İY'de önde olma yüzdeleri (site) — varsa %30 harman
  const htSiteHome = homeProf.htTop && homeProf.htTop[0] && homeProf.htTop[0].w != null && homeProf.htTop[0].gp
    ? (homeProf.htTop[0].w / homeProf.htTop[0].gp) : null;
  const htSiteAway = awayProf.htTop && awayProf.htTop[0] && awayProf.htTop[0].l != null && awayProf.htTop[0].gp
    ? (awayProf.htTop[0].l / awayProf.htTop[0].gp) : null;
  // Halftime sayfası: htRows[0..2] = İY'de önde/berabere/geride yüzdeleri
  const htRow = (prof, idx) => {
    const r = prof.htRows && prof.htRows[idx];
    return r && r.pct != null ? r.pct / 100 : null;
  };
  const htLH = htRow(homeProf, 0), htDA = htRow(homeProf, 1), htTA = htRow(homeProf, 2);
  const htLA = htRow(awayProf, 0), htDB = htRow(awayProf, 1), htTB = htRow(awayProf, 2);
  if (htLH != null && htLA != null) {
    // Ev sahibinin İY'de önde bitirme olasılığı & deplasmanın geride bitirmesi
    const sHome = (htLH + htTB) / 2, sAway = (htLA + htTA) / 2;
    const sDraw = clamp(1 - sHome - sAway, 0.08, 0.9);
    const norm = sHome + sDraw + sAway;
    htHome = htHome * 0.65 + (sHome / norm) * 0.35;
    htDraw = htDraw * 0.65 + (sDraw / norm) * 0.35;
    htAway = htAway * 0.65 + (sAway / norm) * 0.35;
    // İY toplam gol beklentisi de site verisine çekilir
    const htGoalsSite = 0.5 + 0.5 * (sHome + sAway) + 0.6 * (sDraw);
    if (isFinite(htGoalsSite)) {
      const scale = clamp(htGoalsSite / Math.max(0.25, (xgHome + xgAway) * 0.42), 0.7, 1.4);
      ht.over05 = clamp(ht.over05 * (0.7 + 0.3 * scale), 0.02, 0.98);
      ht.over15 = clamp(ht.over15 * scale, 0.01, 0.95);
    }
  }
  if (htSiteHome != null) htHome = htHome * 0.8 + htSiteHome * 0.2;
  if (htSiteAway != null) htAway = htAway * 0.8 + htSiteAway * 0.2;
  const htSum = htHome + htDraw + htAway;

  // ---- 5) İlk gol ----
  const fgSiteHome = homeProf.firstGoalPct != null && awayProf.concededFirstPct != null
    ? ((homeProf.firstGoalPct + awayProf.concededFirstPct) / 200) : null;
  const pFirstHome = blend(sim.firstGoalHome / Math.max(1e-9, 1 - sim.firstGoalNone), fgSiteHome, 0.25);
  // "Gol olmaz" = site noGoalPct (0-0 maç yüzdesi) + Poisson 0-0 harmanı
  const noGoalSite = (() => {
    const h = homeProf.noGoalPct, a = awayProf.noGoalPct;
    if (h == null || a == null) return null;
    return Math.sqrt((h / 100) * (a / 100));   // her iki takımın da gol atmadığı maçlar
  })();
  const pNoGoal = clamp(blend(sim.firstGoalNone, noGoalSite, 0.4), 0.005, 0.55);

  // ---- 6) Korner ----
  const corners = cornerModel(homeProf, awayProf, leagueProf);

  // ---- 7) Güven skoru ----
  const dataRich = [
    homeProf.avgGF != null, awayProf.avgGF != null,
    homeProf.cornersTotal != null, awayProf.cornersTotal != null,
    homeProf.firstGoalPct != null, awayProf.firstGoalPct != null,
    homeProf.timeSegments != null, awayProf.timeSegments != null,
    homeProf.totalGoalsDist != null, awayProf.totalGoalsDist != null,
    homeProf.marginsW != null, awayProf.marginsW != null,
    homeProf.equalizerPct != null, awayProf.equalizerPct != null,
    homeProf.formPts != null && awayProf.formPts != null ? 1 : 0,
    homeProf.lead_total != null && awayProf.lead_total != null ? 1 : 0,
    homeProf.scoredDist != null && awayProf.scoredDist != null ? 1 : 0,
    homeProf.noGoalPct != null && awayProf.noGoalPct != null ? 1 : 0,
    homeProf.htRows != null && awayProf.htRows != null ? 1 : 0,
    homeProf.gr01 != null && awayProf.gr01 != null ? 1 : 0,
  ].filter(Boolean).length;
  const DATA_FIELDS = 17;
  const sampleScore = clamp(Math.min(nh, na) / 10, 0.2, 1);
  const clarity = clamp((Math.max(pHome, pDraw, pAway) - 0.33) / 0.34, 0, 1);
  const density = clamp((leagueAvg - 2.0) / 1.4, 0, 1);
  const richScore = dataRich / DATA_FIELDS;
  const confidence = Math.round(clamp(
    0.28 * sampleScore + 0.36 * clarity + 0.14 * density + 0.22 * richScore, 0.1, 0.97
  ) * 100);

  // ---- 8) Pazarlar ----
  const mk = (key, p) => ({ key, p, pct: pct(p), fair: p > 0.001 ? Math.round((1 / p) * 100) / 100 : null });
  const markets = [
    mk('MS 1', pHome), mk('MS X', pDraw), mk('MS 2', pAway),
    mk('Çifte Şans 1X', pHome + pDraw), mk('Çifte Şans X2', pDraw + pAway), mk('Çifte Şans 12', pHome + pAway),
    mk('KG Var', pBtts), mk('KG Yok', 1 - pBtts),
    mk('Üst 0.5', sim.over[0.5]), mk('Üst 1.5', sim.over[1.5]), mk('Üst 2.5', pO25),
    mk('Alt 2.5', 1 - pO25), mk('Üst 3.5', sim.over[3.5]), mk('Alt 3.5', 1 - sim.over[3.5]),
    mk('Üst 4.5', sim.over[4.5]),
    mk('İY Üst 0.5', ht.over05), mk('İY Üst 1.5', ht.over15),
    mk('İY 1', htHome / htSum), mk('İY X', htDraw / htSum), mk('İY 2', htAway / htSum),
    mk('İlk gol: Ev', pFirstHome), mk('İlk gol: Dep', (1 - pNoGoal) * (1 - pFirstHome)),
    mk('Gol olmaz (0-0)', pNoGoal),
    mk('Ev sahibi gol atar', 1 - Math.exp(-xgHome)),
    mk('Deplasman gol atar', 1 - Math.exp(-xgAway)),
    mk('Ev CS (gol yemez)', sim.cleanSheetHome), mk('Dep CS (gol yemez)', sim.cleanSheetAway),
    mk('Korner Üst 8.5', corners.over85), mk('Korner Üst 9.5', corners.over95), mk('Korner Üst 10.5', corners.over105),
  ].map(x => ({ ...x, pct: pct(x.p) }));

  const suggestions = markets
    .filter(x => x.pct >= 55 && x.fair && x.fair <= 2.0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8);

  const resultTag = pHome > pAway + 0.12 ? 'EV SAHİBİ ÜSTÜN'
    : pAway > pHome + 0.12 ? 'DEPLASMAN ÜSTÜN'
    : Math.abs(pHome - pAway) <= 0.08 ? 'DENGE' : 'HAFİF EV';

  return {
    xgHome: p1(xgHome), xgAway: p1(xgAway), xgTotal: p1(xgHome + xgAway),
    probs: {
      home: pct(pHome), draw: pct(pDraw), away: pct(pAway),
      btts: pct(pBtts), bttsNo: pct(1 - pBtts),
      over05: pct(sim.over[0.5]), over15: pct(sim.over[1.5]), over25: pct(pO25),
      under25: pct(1 - pO25), over35: pct(sim.over[3.5]), over45: pct(sim.over[4.5]),
      htOver05: pct(ht.over05), htOver15: pct(ht.over15),
      htHome: pct(htHome / htSum), htDraw: pct(htDraw / htSum), htAway: pct(htAway / htSum),
      firstGoalHome: pct(pFirstHome), noGoal: pct(pNoGoal),
      homeScores: pct(1 - Math.exp(-xgHome)), awayScores: pct(1 - Math.exp(-xgAway)),
      cleanSheetHome: pct(sim.cleanSheetHome), cleanSheetAway: pct(sim.cleanSheetAway),
    },
    goalRanges: { '0-1': pct(ranges['0-1']), '2-3': pct(ranges['2-3']), '4+': pct(ranges['4+']) },
    corners,
    topScores: sim.scores.slice(0, 8).map(s2 => ({ score: s2.score, pct: pct(s2.p) })),
    margins: Object.fromEntries(Object.entries(sim.margins).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
    doubleChance: { '1X': pct(pHome + pDraw), 'X2': pct(pDraw + pAway), '12': pct(pHome + pAway) },
    confidence, resultTag, markets, suggestions,
    model: {
      homeAvg, awayAvg, leagueAvg,
      weights: { home: Math.round(wH * 100) / 100, away: Math.round(wA * 100) / 100 },
      dataRich,
    },
    inputs: { home: hs, away: as },
    profiles: {
      home: pickProfile(homeProf), away: pickProfile(awayProf),
    },
    distributions: {
      // Modelin nihai toplam gol dağılımı (kalibrasyon sonrası)
      totalGoals: (() => {
        const d = [0, 0, 0, 0, 0, 0];
        for (let hh = 0; hh <= MAX_GOALS; hh++)
          for (let aa = 0; aa <= MAX_GOALS; aa++) d[Math.min(hh + aa, 5)] += g[hh][aa];
        return d.map(v => pct(v));
      })(),
      totalGoalsSite: tgRaw ? tgRaw.map(v => pct(v)) : null,
      totalGoalsCalibrated: !!(tgSite && tgWeight >= 0.05),
      marginsW: homeProf.marginsW || null,
      marginsL: homeProf.marginsL || null,
      marginsWLabel: ['1 gol', '2 gol', '3 gol', '4+ gol'],
      marginsLTotal: homeProf.marginsLTotal != null ? homeProf.marginsLTotal : null,
      scoredDist: homeProf.scoredDist || null,
      concededDist: awayProf.scoredDist || null,
      equalizerHome: homeProf.equalizerPct != null ? homeProf.equalizerPct : null,
      equalizerAway: awayProf.equalizerPct != null ? awayProf.equalizerPct : null,
      leadHome: homeProf.lead_home != null ? homeProf.lead_home : null,
      trailHome: homeProf.trail_home != null ? homeProf.trail_home : null,
      leadAway: awayProf.lead_away != null ? awayProf.lead_away : null,
      trailAway: awayProf.trail_away != null ? awayProf.trail_away : null,
      cornersForTotal: (homeProf.cornersFor != null && awayProf.cornersFor != null)
        ? Math.round(((homeProf.cornersFor + awayProf.cornersFor) / 2) * 10) / 10 : null,
      corners105: (homeProf.corners105 != null && awayProf.corners105 != null)
        ? Math.round((homeProf.corners105 + awayProf.corners105) / 2) : null,
      formPtsHome: homeProf.formPts != null && homeProf.formGP ? Math.round(homeProf.formPts / homeProf.formGP * 100) / 100 : null,
      formPtsAway: awayProf.formPts != null && awayProf.formGP ? Math.round(awayProf.formPts / awayProf.formGP * 100) / 100 : null,
      streakHome: homeProf.streak_total || null,
      streakAway: awayProf.streak_total || null,
      avgScoredHome: homeProf.avgScoredPage != null ? homeProf.avgScoredPage : null,
      avgConcededAway: awayProf.avgConcededPage != null ? awayProf.avgConcededPage : null,
    },
    sources: {
      bulletin: true,
      goalRanges: !!grSite, corners: !!(homeProf.cornersTotal || awayProf.cornersTotal),
      firstGoal: !!(homeProf.firstGoalPct || awayProf.firstGoalPct),
      timing: !!(homeProf.timeSegments || awayProf.timeSegments),
      form: !!(homeProf.formGP || awayProf.formGP),
      totalGoals: !!tgRaw,
      margins: !!((homeProf.marginsW && homeProf.marginsW.length) || (awayProf.marginsW && awayProf.marginsW.length)),
      equalizers: homeProf.equalizerPct != null || awayProf.equalizerPct != null,
      leadDurations: homeProf.lead_total != null || awayProf.lead_total != null,
      scoredConceded: !!((homeProf.scoredDist && homeProf.scoredDist.length) || (awayProf.scoredDist && awayProf.scoredDist.length)),
      streaks: !!(homeProf.streak_total || awayProf.streak_total),
      noGoal: homeProf.noGoalPct != null || awayProf.noGoalPct != null,
      halftimeRows: !!((homeProf.htRows && homeProf.htRows.length) || (awayProf.htRows && awayProf.htRows.length)),
    },
  };
}

function pickProfile(p) {
  if (!p) return null;
  const keep = ['avgGF', 'avgGA', 'avgTotal', 'avgGFHome', 'avgGAHome', 'avgGFAway', 'avgGAAway',
    'gr01', 'gr23', 'gr4p', 'cornersFor', 'cornersAgainst', 'cornersTotal', 'corners95', 'corners105',
    'firstGoalPct', 'noGoalPct', 'concededFirstPct', 'timeSegments',
    'lead_total', 'lead_home', 'lead_away', 'trail_total', 'trail_home', 'trail_away',
    'formGP', 'formW', 'formD', 'formL', 'formGF', 'formGA', 'formPts', 'formOppPPG', 'streak_total',
    'level_total', 'avgScoredPage', 'avgConcededPage', 'gr01Home', 'gr01Away', 'gr4pHome', 'gr4pAway',
    'equalizerPct', 'totalGoalsDist', 'corners95', 'corners105', 'htRows'];
  const out = {};
  keep.forEach(k => { if (p[k] != null) out[k] = p[k]; });
  return out;
}

module.exports = { analyzeMatch, cornerModel, pois };
