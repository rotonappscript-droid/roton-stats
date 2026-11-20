// Builds one report week for every track that has data. Same code runs in the browser and in Node.
import { toSections, extraFacts } from './songstats.js';

// S4A exports are named "<Track>-timeline.csv". Returns {songId: csvText} plus the files it could not place.
export function matchTimelines(engine, files){
  const out = {}, unmatched = [];
  for (const f of files){
    const name = String(f.name).replace(/\.csv$/i, '').split(/-timeline/i)[0].trim();
    const s = engine.songFor(name);
    if (s) out[s.id] = f.text; else unmatched.push(f.name);
  }
  return { bySong: out, unmatched };
}

// Songstats "Track Report" ZIP export -> sections. Files are "<Title> - <Section> - Songstats Report.csv"; titles may contain " - ".
export function zipSections(engine, files){
  const out = {};
  for (const f of files){ if (!/\.csv$/i.test(f.name)) continue;
    const parts = f.name.split('/').pop().replace(/ - Songstats Report\.csv$/i, '').split(' - ');
    out[parts[parts.length - 1]] = engine.parseCsv(f.text); }
  return Object.keys(out).length ? out : null;
}
export const zipTitle = name => String(name).replace(/\.zip$/i, '').split(/ - Songstats Track Report/i)[0].trim();

export function buildWeek({ engine, week, songs, songstats = {}, zips = {}, timelines = {}, radiomon = null }){
  const built = [], skipped = [];
  for (const s of songs){
    const raw = songstats[s.id] || null, tl = timelines[s.id] || null;
    const sections = toSections(raw) || zips[s.id] || null;   // API pull first, a dropped Songstats ZIP export as fallback
    if (!sections && !tl){ skipped.push({ id: s.id, name: s.name, reason: 'no data' }); continue; }
    const F = engine.buildTrackWeek({ display: s.name, week, timeline: tl, sections, radiomon, extra: extraFacts(raw) });
    if (F.cover && !s.cover) s.cover = F.cover;
    built.push({ id: s.id, name: s.name, inputs: F.inputs });
  }
  engine.flushToClassify(week);
  const contacts = built.length ? engine.weeklyContacts(week) : null;
  return { week, built, skipped, contacts };
}
