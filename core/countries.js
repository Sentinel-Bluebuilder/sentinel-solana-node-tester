/**
 * Sentinel Node Tester (Solana) — Country helpers.
 * Same exports as the Cosmos tester's core/countries.js (which re-exported
 * blue-js-sdk); self-contained here so no Cosmos SDK is pulled in.
 */

const NAME_BY_CODE = Object.freeze({
  AE: 'United Arab Emirates', AL: 'Albania', AR: 'Argentina', AT: 'Austria', AU: 'Australia', BA: 'Bosnia and Herzegovina',
  BD: 'Bangladesh', BE: 'Belgium', BG: 'Bulgaria', BH: 'Bahrain', BO: 'Bolivia', BR: 'Brazil', CA: 'Canada', CD: 'DR Congo',
  CH: 'Switzerland', CL: 'Chile', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CY: 'Cyprus', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', DO: 'Dominican Republic', EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', ES: 'Spain', FI: 'Finland',
  FR: 'France', GB: 'United Kingdom', GE: 'Georgia', GR: 'Greece', GT: 'Guatemala', HK: 'Hong Kong', HN: 'Honduras',
  HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IN: 'India', IS: 'Iceland',
  IT: 'Italy', JM: 'Jamaica', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan', KR: 'South Korea', KZ: 'Kazakhstan', LT: 'Lithuania',
  LU: 'Luxembourg', LV: 'Latvia', MA: 'Morocco', MD: 'Moldova', ME: 'Montenegro', MK: 'North Macedonia', MN: 'Mongolia',
  MT: 'Malta', MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand',
  PA: 'Panama', PE: 'Peru', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PR: 'Puerto Rico', PT: 'Portugal', PY: 'Paraguay',
  RO: 'Romania', RS: 'Serbia', RU: 'Russia', SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia',
  SV: 'El Salvador', TH: 'Thailand', TJ: 'Tajikistan', TR: 'Türkiye', TT: 'Trinidad and Tobago', TW: 'Taiwan', UA: 'Ukraine',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VE: 'Venezuela', VN: 'Vietnam', XK: 'Kosovo', ZA: 'South Africa',
});

export const COUNTRY_MAP = Object.freeze(Object.fromEntries(Object.entries(NAME_BY_CODE).map(([c, n]) => [n.toLowerCase(), c])));

export function countryNameToCode(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_MAP[s.toLowerCase()] || null;
}

export function countryCodeToName(code) {
  const c = countryNameToCode(code);
  return c ? (NAME_BY_CODE[c] || c) : null;
}

export function getFlagUrl(code, size = 'w40') {
  const c = countryNameToCode(code);
  return c ? `https://flagcdn.com/${size}/${c.toLowerCase()}.png` : null;
}

export function getFlagEmoji(code) {
  const c = countryNameToCode(code);
  if (!c) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

const CONTINENT_BY_CODE = Object.freeze({
  DE: 'EU', FR: 'EU', GB: 'EU', NL: 'EU', ES: 'EU', IT: 'EU', SE: 'EU', NO: 'EU', FI: 'EU', CH: 'EU', AT: 'EU', IE: 'EU',
  PT: 'EU', CZ: 'EU', HU: 'EU', BG: 'EU', GR: 'EU', UA: 'EU', RU: 'EU', RO: 'EU', PL: 'EU', TR: 'EU', LV: 'EU', LT: 'EU',
  EE: 'EU', HR: 'EU', RS: 'EU', DK: 'EU', BE: 'EU', LU: 'EU', MT: 'EU', CY: 'EU', IS: 'EU', SK: 'EU', AL: 'EU', MD: 'EU',
  BA: 'EU', MK: 'EU', ME: 'EU', XK: 'EU', SI: 'EU', GE: 'EU',
  JP: 'AS', SG: 'AS', IN: 'AS', KR: 'AS', HK: 'AS', TW: 'AS', TH: 'AS', VN: 'AS', ID: 'AS', PH: 'AS', MY: 'AS', BD: 'AS',
  PK: 'AS', CN: 'AS', SA: 'AS', KZ: 'AS', MN: 'AS', IL: 'AS', AE: 'AS', KG: 'AS', UZ: 'AS', TJ: 'AS', BH: 'AS',
  US: 'NA', CA: 'NA', MX: 'NA', GT: 'NA', PR: 'NA', JM: 'NA', CR: 'NA', PA: 'NA', DO: 'NA', SV: 'NA', HN: 'NA', NI: 'NA',
  CU: 'NA', HT: 'NA', TT: 'NA',
  BR: 'SA', AR: 'SA', CL: 'SA', CO: 'SA', PE: 'SA', VE: 'SA', BO: 'SA', EC: 'SA', UY: 'SA', PY: 'SA',
  ZA: 'AF', NG: 'AF', EG: 'AF', KE: 'AF', MA: 'AF', CD: 'AF',
  AU: 'OC', NZ: 'OC',
});

export const CONTINENT_NAMES = Object.freeze({
  EU: 'Europe', AS: 'Asia', NA: 'North America', SA: 'South America',
  AF: 'Africa', OC: 'Oceania', AN: 'Antarctica', ZZ: 'Unknown',
});

export function countryToContinent(country) {
  const code = countryNameToCode(country);
  return code ? (CONTINENT_BY_CODE[code] || null) : null;
}

export function groupNodesByCountry(nodes) {
  const groups = {};
  for (const node of nodes) {
    const key = node.countryCode || countryNameToCode(node.country) || 'ZZ';
    if (!groups[key]) groups[key] = { country: node.country || 'Unknown', countryCode: key, flagEmoji: getFlagEmoji(key), flagUrl: getFlagUrl(key), nodes: [] };
    groups[key].nodes.push(node);
  }
  return Object.values(groups).sort((a, b) => {
    if (a.countryCode === 'ZZ') return 1;
    if (b.countryCode === 'ZZ') return -1;
    return b.nodes.length - a.nodes.length;
  });
}
