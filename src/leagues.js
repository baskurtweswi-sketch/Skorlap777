/**
 * Lig filtresi: kadın ligleri ve çok alt ligler bültene alınmaz.
 *
 * İki katman çalışır:
 *  1) Kadın ligleri: adında women/woman/ladies/feminine/Toppserien gibi
 *     ifade geçen ligler doğrudan elenir.
 *  2) Alt ligler: ülke bazında kademe bilgisi tutulur; 3. kademe ve altı
 *     elenir. Bilinmeyen ligler temkinli davranıp KABUL edilir (veri
 *     kaybetmemek için), sadece bilinen alt ligler elenir.
 *
 * Filtreyi kapatmak için: SKIP_LEAGUE_FILTER=1
 */

const WOMEN_RE = /women|woman|ladies|feminin|feminine|feminina|toppserien|damallsvenskan|frauen|femminile/i;

/** Doğrudan elenecek alt lig kalıpları (3. kademe ve altı) */
const LOW_LEAGUE_PATTERNS = [
  // Almanya
  /^regionalliga/i,                 // 4. kademe
  /^oberliga/i,
  // İngiltere
  /^northern league$/i,             // 8-9. kademe
  /^southern (south|north|central)/i,
  /^isthmian/i,
  /^northern premier/i,
  // İtalya
  /^serie c/i,                      // 3. kademe
  /^serie d/i,
  // İspanya
  /^primera rfef/i,                 // 3. kademe
  /^segunda rfef/i,
  /^tercera/i,
  // Hollanda
  /^tweede divisie$/i,              // 3. kademe
  // Danimarka
  /^2nd division$/i,                // 3. kademe
  /^2\. division$/i,
  // Polonya
  /^2\. liga$/i,                    // 3. kademe
  // Japonya
  /^j3 league$/i,                   // 3. kademe
  // Fransa
  /^national$/i,                    // 3. kademe
  /^national 2$/i,
  // Portekiz
  /^liga portugal 3$/i,
  // İskoçya / İrlanda alt
  /^lowland league$/i,
  /^highland league$/i,
];

/** Ülke + lig adı birlikte değerlendirilen istisnalar */
const COUNTRY_SPECIFIC_SKIP = [
  // ÇHC'de "League One" 3. kademe
  { country: /^CHINA PR$/i, name: /^League One$/i },
  // İngiltere'de "League One"/"League Two" 3./4. kademe
  { country: /^ENGLAND$/i, name: /^League (One|Two)$/i },
];

/** Kalması gereken istisnalar (2. kademe olup adı alt lig gibi görünenler) */
const COUNTRY_SPECIFIC_KEEP = [
  { country: /^AUSTRIA$/i, name: /^2\. Liga$/i },
  { country: /^GERMANY$/i, name: /^2\. Bundesliga$/i },
];

/** Kadın ligi mi? */
function isWomensLeague(name) {
  return WOMEN_RE.test(String(name || ''));
}

/** Çok alt lig mi? */
function isLowLeague(name, country) {
  const n = String(name || '').trim();
  const c = String(country || '').trim();
  if (COUNTRY_SPECIFIC_KEEP.some(x => x.country.test(c) && x.name.test(n))) return false;
  if (COUNTRY_SPECIFIC_SKIP.some(x => x.country.test(c) && x.name.test(n))) return true;
  return LOW_LEAGUE_PATTERNS.some(re => re.test(n));
}

/**
 * Lig bültene alınsın mı?
 * @returns {{keep: boolean, reason?: string}}
 */
function shouldIncludeLeague(country, name) {
  if (process.env.SKIP_LEAGUE_FILTER === '1') return { keep: true };
  if (isWomensLeague(name)) return { keep: false, reason: 'kadın ligi' };
  if (isLowLeague(name, country)) return { keep: false, reason: 'alt lig' };
  return { keep: true };
}

module.exports = { shouldIncludeLeague, isWomensLeague, isLowLeague };
