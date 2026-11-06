// Songstats Enterprise API -> the "sections" the rules were written for (the old ZIP export).
// Shared by the weekly sync (Node, GitHub Actions) and the in-app week build (browser).

export const API = 'https://api.songstats.com/enterprise/v1';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dmy = iso => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00Z'); return isNaN(d) ? '' : `${String(d.getUTCDate()).padStart(2,'0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
let REGION = null;
export function countryName(code){
  if (!code) return '';
  try { REGION = REGION || new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return code; }
  let n = REGION.of(String(code).toUpperCase()) || code;
  return n.replace(/ & /g, ' and ').replace(/^Türkiye$/, 'Turkey').replace(/^Czechia$/, 'Czech Republic').replace(/^United States$/, 'United States');
}
const days = (a, b) => (a ? Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 864e5)) : '');

// raw = { info, radio, spotify, shazam, social } as saved by the sync (each = the API "data" object for that source)
export function toSections(raw){
  if (!raw) return null;
  const S = {};
  const st = raw.radio && raw.radio.radio_stations;
  if (st && st.length){
    S['Radiostats Radio'] = [['Station','City','Country','Plays','First Play']].concat(
      st.map(s => [s.name || '', s.city_name || '', countryName(s.country_code), String(s.radio_plays_total || 0), dmy(s.first_played_at)]));
  }
  const pl = raw.spotify && raw.spotify.playlists;
  if (pl && pl.length){
    S['Spotify Playlists'] = [['Name','Owner','Position','Followers','Removed']].concat(
      pl.map(p => [p.name || '', p.owner_name || '', p.current_position != null ? String(p.current_position) : (p.top_position != null ? String(p.top_position) : '-'), String(p.followers_count || 0), p.removed_at ? dmy(p.removed_at) : "'-"]));
  }
  const ch = raw.shazam && raw.shazam.charts;
  if (ch && ch.length){
    S['Shazam Charts'] = [['Name','Type','Current','Peak','Days In']].concat(
      ch.map(c => [c.name || '', c.location_type || '', c.current_position != null ? String(c.current_position) : "'-", c.top_position != null ? '#' + c.top_position : '', String(days(c.added_at, c.removed_at))]));
  }
  const so = raw.social || {};
  if (so.tiktok) S['TikTok Top Videos'] = [['Views','Likes'], [String(so.tiktok.views_total || 0), String(so.tiktok.likes_total || 0)]];
  if (so.instagram) S['Instagram Top Reels'] = [['Views','Likes'], [String(so.instagram.views_total || 0), String(so.instagram.likes_total || 0)]];
  if (so.youtube){
    S['YouTube Videos'] = [['Views','Likes'], [String(so.youtube.video_views_total || 0), String(so.youtube.video_likes_total || 0)]];
    S['YouTube Shorts'] = [['Views','Likes'], [String(so.youtube.short_views_total || 0), String(so.youtube.short_likes_total || 0)]];
  }
  return Object.keys(S).length ? S : null;
}

// Facts the old export could not carry: exact totals, used to correct counts that the rules derive from row counts.
export function extraFacts(raw){
  if (!raw) return {};
  const so = raw.social || {}, x = {};
  if (so.tiktok) x.tk_vids = so.tiktok.videos_total || 0;
  if (so.instagram) x.ig_vids = so.instagram.videos_total || 0;
  if (raw.spotify){ x.ss_streams_total = raw.spotify.streams_total || null; x.editorial_cur = raw.spotify.playlists_editorial_current || 0; }
  if (raw.shazam) x.shazams_total = raw.shazam.shazams_total || null;
  if (raw.radio){ x.radio_plays_api = raw.radio.radio_plays_total; }
  if (raw.info && raw.info.avatar) x.cover = raw.info.avatar;
  return x;
}
