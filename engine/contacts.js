// Turns the master contact workbook ("Contacte radio internationale - Lista globala") into the
// contact grid the rules read. Input is workbook-agnostic: [{name, rows:[[...]]}], first row = header.
// Only addresses marked Corectă or Neverificată count as contacts (same rule as the global list).

const RO_EN = {
  'ALBANIA':'Albania','AUSTRIA':'Austria','BELARUS':'Belarus','BELGIA':'Belgium','BULGARIA':'Bulgaria','CEHIA':'Czech Republic',
  'CIPRU':'Cyprus','CROATIA':'Croatia','DANEMARCA':'Denmark','ELVETIA':'Switzerland','ESTONIA':'Estonia','FINLANDA':'Finland',
  'FRANTA':'France','GERMANIA':'Germany','GRECIA':'Greece','IRLANDA':'Ireland','ISLANDA':'Iceland','ITALIA':'Italy','LETONIA':'Latvia',
  'LITUANIA':'Lithuania','MACEDONIA DE NORD':'North Macedonia','MAREA BRITANIE':'United Kingdom','MOLDOVA':'Moldova','NORVEGIA':'Norway',
  'OLANDA':'Netherlands','POLONIA':'Poland','PORTUGALIA':'Portugal','RUSIA':'Russia','SERBIA':'Serbia','SLOVACIA':'Slovakia',
  'SLOVENIA':'Slovenia','SPANIA':'Spain','SUEDIA':'Sweden','TURCIA':'Turkey','UCRAINA':'Ukraine','UNGARIA':'Hungary',
  'BOSNIA SI HERTEGOVINA':'Bosnia and Herzegovina','MUNTENEGRU':'Montenegro','KOSOVO':'Kosovo','LUXEMBURG':'Luxembourg','MALTA':'Malta',
  'COSTA RICA':'Costa Rica','GUATEMALA':'Guatemala','HONDURAS':'Honduras','MEXIC':'Mexico','PUERTO RICO':'Puerto Rico',
  'REPUBLICA DOMINICANA':'Dominican Republic','CANADA':'Canada','SUA':'United States','ARGENTINA':'Argentina','BRAZILIA':'Brazil',
  'CHILE':'Chile','COLUMBIA':'Colombia','ECUADOR':'Ecuador','ARMENIA':'Armenia','AZERBAIDJAN':'Azerbaijan','BANGLADESH':'Bangladesh',
  'COREEA DE SUD':'South Korea','INDIA':'India','KAZAHSTAN':'Kazakhstan','KARGAZSTAN':'Kyrgyzstan','PAKISTAN':'Pakistan',
  'SRI LANKA':'Sri Lanka','BAHRAIN':'Bahrain','EGIPT':'Egypt','EMIRATELE ARABE UNITE':'United Arab Emirates','KUWEIT':'Kuwait',
  'LIBAN':'Lebanon','QATAR':'Qatar','TUNISIA':'Tunisia','ZIMBABWE':'Zimbabwe','AUSTRALIA':'Australia','NOUA ZEELANDA':'New Zealand',
  'GEORGIA':'Georgia','ISRAEL':'Israel','JAPONIA':'Japan','CHINA':'China',
};
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export const countryEn = s => RO_EN[fold(s).toUpperCase()] || null;
const SKIP = /^(lista globala|_index)$/i;
const OK = /^(corecta|neverificata)$/i;

export function importContactWorkbook(sheets, opts = {}){
  const rows = [], stats = { sheets: 0, ok: 0, skipped: 0, countries: new Set(), unknown: new Set() };
  for (const sh of sheets){
    if (SKIP.test(fold(sh.name))) continue;
    const grid = sh.rows || []; if (!grid.length) continue;
    const h = grid[0].map(x => fold(x).toLowerCase());
    const iR = h.findIndex(x => /^radio|^statie|^station/.test(x)), iM = h.findIndex(x => /mail/.test(x)), iS = h.findIndex(x => /^status/.test(x));
    if (iR < 0 || iM < 0) continue;
    stats.sheets++;
    let country = countryEn(sh.name), zone = sh.name;
    for (let r = 1; r < grid.length; r++){
      const name = String(grid[r][iR] || '').trim(), mail = String(grid[r][iM] || '').trim(), st = String(iS >= 0 ? grid[r][iS] || '' : '').trim();
      if (!name || /^=/.test(name)) continue;
      if (!mail && !st){ const c = countryEn(name); if (c){ country = c; } else if (name === name.toUpperCase()) { country = null; stats.unknown.add(name); } continue; }
      if (!country){ if (!/diaspora/i.test(fold(zone))) stats.unknown.add(zone); }
      if (!OK.test(fold(st))){ stats.skipped++; continue; }
      const c = country || (/diaspora/i.test(fold(zone)) ? 'Romanian diaspora' : fold(zone));
      stats.ok++; stats.countries.add(c);
      rows.push([c, name, '', '', mail, st, zone]);
    }
  }
  // carry over the station classification (Major CHR / National / Regional / Local + format) from the previous list
  if (opts.classify) for (const row of rows){ const t = opts.classify(row[0], row[1]); if (t){ row[2] = t.type || ''; row[3] = t.format || ''; } }
  return {
    name: opts.name || 'Contacte radio internationale - Lista globala', updated: opts.updated || new Date().toISOString().slice(0, 10),
    header: ['Country', 'Station', 'Type', 'Format', 'Email', 'Status', 'Zone'], rows,
    stats: { sheets: stats.sheets, contacts: stats.ok, skipped: stats.skipped, countries: stats.countries.size, unknown: [...stats.unknown] },
  };
}

// Index of the old classified station list, so a new list inherits Type/Format by country + station core.
export function classifier(engine, seedGrid){
  const h = seedGrid[0].map(x => fold(x).toLowerCase());
  const ic = h.indexOf('country'), is = h.indexOf('station'), it = h.indexOf('type'), ifm = h.indexOf('format');
  const by = {};
  for (const r of seedGrid.slice(1)){ if (!r[ic] || !r[is]) continue; const k = engine.ctryKey(r[ic]); (by[k] = by[k] || []).push({ core: engine.stationCore(r[is], r[ic]), type: r[it], format: r[ifm] }); }
  return (country, station) => {
    const list = by[engine.ctryKey(country)]; if (!list) return null; const core = engine.stationCore(station, country);
    return list.find(x => x.core === core) || list.find(x => x.core.length >= 4 && core.length >= 4 && (` ${x.core} `.includes(` ${core} `) || ` ${core} `.includes(` ${x.core} `))) || null;
  };
}
