import { createEngine } from './engine/rules.js';
import { buildWeek, matchTimelines, zipSections, zipTitle } from './engine/build.js';
import { importContactWorkbook, classifier } from './engine/contacts.js';
import { GitHubStore, DemoStore, savedConnection, saveConnection } from './store.js';

/* ---------------- state ---------------- */
const S = { store: null, D: null, E: null, view: { week: {}, cmp: {}, tab: {} }, inbox: { timelines: [], rm: null, zips: {} }, busy: false };
const $ = (s, el = document) => el.querySelector(s);
const app = () => $('#view');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US');
const human = n => n == null || isNaN(n) ? '—' : S.E.human(n);
const wk = w => { const m = String(w || '').match(/Week\s+(\d+)/i); return m ? 'W' + m[1] : String(w || ''); };
const weekId = w => { const m = String(w).match(/Week\s+(\d+)\s+(\d{4})/); return m ? `${m[2]}-W${m[1].padStart(2, '0')}` : w; };
const vsLabel = c => c === 'release' ? 'since release' : c ? 'vs ' + wk(c) : '';
const widx = w => S.E.repWeekIdx(w);
const SHEET_ID = '19Ea-TEkzIIQoLJa-7qAAZrj6SvNoEcMQHsdqtFYzUJE';
const DATA = { songs: 'db/songs.json', history: 'db/history.json', contacts: 'db/contacts.json', registry: 'db/registry.json', airplay: 'db/airplay.json', tasks: 'db/tasks.json', lists: 'db/lists.json' };

function delta(cur, prev, { pct = false, money = false } = {}){
  if (cur == null || prev == null) return '<span class="delta fl">—</span>';
  const d = pct ? (prev ? (cur - prev) / prev * 100 : null) : cur - prev;
  if (d == null) return '<span class="delta fl">—</span>';
  const cls = d > 0.0001 ? 'up' : d < -0.0001 ? 'dn' : 'fl', sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `<span class="delta ${cls}">${sign}${pct ? Math.abs(d).toFixed(1) + '%' : human(Math.abs(d))}</span>`;
}
function toast(msg, ms = 2600){ const t = document.createElement('div'); t.className = 'toast glass'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
const cover = (s, cls = '') => `<span class="cover ${cls}">${s.cover ? `<img src="${esc(s.cover)}" alt="" onerror="this.remove()">` : ''}</span>`;
const LOGO = () => 'data:image/png;base64,' + S.E.LOGO_B64;

/* ---------------- data ---------------- */
async function load(){
  const entries = await Promise.all(Object.entries(DATA).map(async ([k, p]) => [k, await S.store.readJSON(p)]));
  const D = Object.fromEntries(entries);
  D.songs = D.songs || []; D.history = D.history || {}; D.registry = D.registry || []; D.airplay = D.airplay || { manual: [], tracker: [] };
  D.tasks = D.tasks || { tasks: [], cands: {} }; D.lists = D.lists || {};
  S.D = D; engine();
}
function engine(){
  const D = S.D;
  S.E = createEngine({ songs: D.songs, history: D.history, registry: D.registry, contacts: D.contacts, airplayManual: D.airplay.manual, airplayTracker: D.airplay.tracker, tasks: D.tasks.tasks, cands: D.tasks.cands });
}
const snaps = s => S.E.trackSnaps(s.name);
function latestWeek(){ let best = null; for (const l of Object.values(S.D.history)) for (const r of l) if (!best || widx(r.week) > widx(best)) best = r.week; return best; }

/* ---------------- shell ---------------- */
function shell(){
  const root = document.getElementById('root') || document.body;
  root.innerHTML = `<div class="ambient" id="amb"></div>
  <header class="bar"><nav class="bar-in glass" aria-label="Main">
    <a class="brand" href="#tracks"><img src="${LOGO()}" alt=""> Roton <span>Stats</span></a>
    <div class="tabs" role="tablist">
      <button class="tab" data-go="tracks">Tracks</button><button class="tab" data-go="week">This week</button><button class="tab" data-go="contacts">Contacts</button>
    </div><div class="sp"></div>
    <span class="chip" id="conn"><i class="dot ${S.store.mode === 'github' ? 'ok' : 'warn'}"></i>${S.store.mode === 'github' ? esc(S.store.repo) : 'preview'}</span>
    <button class="iconbtn" data-go="connect" aria-label="Settings"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/></svg></button>
  </nav></header><main id="view"></main>`;
  document.body.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g){ e.preventDefault(); go(g.dataset.go); } });
}
function go(h){ if (location.hash.slice(1) === h) route(); else location.hash = h; }
function ambient(src){ $('#amb').innerHTML = src ? `<img src="${esc(src)}" alt="">` : ''; }
function route(){
  const h = location.hash.slice(1) || 'tracks';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-current', h.startsWith(t.dataset.go) || (t.dataset.go === 'tracks' && h.startsWith('t-')) ? 'page' : 'false'));
  ambient(null); window.scrollTo(0, 0);
  if (h.startsWith('t-')) return viewTrack(h.slice(2));
  ({ tracks: viewTracks, week: viewWeek, contacts: viewContacts, connect: viewSettings }[h] || viewTracks)();
}

/* ---------------- small charts ---------------- */
function spark(vals){
  const v = vals.filter(x => x != null); if (v.length < 2) return '<svg class="spark" viewBox="0 0 100 34"></svg>';
  const mx = Math.max(...v), mn = Math.min(...v), W = 100, H = 30, pts = v.map((x, i) => [i / (v.length - 1) * W, 2 + H - (mx === mn ? H / 2 : (x - mn) / (mx - mn) * H)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
  <path d="${d} L${W} 34 L0 34 Z" fill="url(#sg)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="var(--accent)"/></svg>`;
}
function areaChart(series, { cur, cmp, fmtY = human, h = 210 } = {}){
  // series: [{w, v}] in week order
  const s = series.filter(x => x.v != null); if (s.length < 2) return '<div class="empty">Needs at least two report weeks.</div>';
  const W = 760, H = h, L = 48, R = 14, T = 16, B = 26, mx = Math.max(...s.map(x => x.v)) * 1.08 || 1;
  const x = i => L + i / (s.length - 1) * (W - L - R), y = v => T + (1 - v / mx) * (H - T - B);
  const ticks = [0, .5, 1].map(f => mx / 1.08 * f);
  const d = s.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(t) + 3.5}" text-anchor="end">${fmtY(t)}</text>`).join('');
  const every = Math.ceil(s.length / 9);
  const xl = s.map((p, i) => (i % every === 0 || i === s.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${wk(p.w)}</text>` : '').join('');
  const marks = s.map((p, i) => p.w === cur ? `<circle cx="${x(i)}" cy="${y(p.v)}" r="5" fill="var(--accent)" stroke="var(--bg)" stroke-width="2"/><text x="${x(i)}" y="${y(p.v) - 10}" text-anchor="middle" style="fill:var(--fg);font-weight:700">${fmtY(p.v)}</text>`
    : p.w === cmp ? `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" fill="var(--bg)" stroke="var(--muted)" stroke-width="2"/>` : `<circle cx="${x(i)}" cy="${y(p.v)}" r="2.2" fill="var(--accent)" opacity=".7"/>`).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="chart"><defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${d} L${x(s.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z" fill="url(#ag)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>${marks}${xl}</svg></div>`;
}
function heatmap(list, curWeek){
  // GitHub-style: rows = markets, columns = report weeks, cell = radio plays gained in that market that week
  const weeks = list.map(r => r.week), mk = {};
  list.forEach((r, i) => (r.f.markets || []).forEach(([m, p]) => { (mk[m] = mk[m] || Array(list.length).fill(null))[i] = p; }));
  const last = list.findIndex(r => r.week === curWeek), ref = last >= 0 ? last : list.length - 1;
  const rows = Object.entries(mk).filter(([m]) => m && m !== 'Unknown').sort((a, b) => (b[1][ref] || 0) - (a[1][ref] || 0)).slice(0, 9);
  if (!rows.length || list.length < 2) return '<div class="empty">Market history starts with the second report week.</div>';
  const gains = rows.map(([m, arr]) => [m, arr.map((v, i) => (i === 0 || v == null || arr[i - 1] == null) ? null : Math.max(0, v - arr[i - 1]))]);
  const all = gains.flatMap(g => g[1]).filter(v => v != null && v > 0).sort((a, b) => a - b);
  const q = f => all.length ? all[Math.min(all.length - 1, Math.floor(all.length * f))] : 1;
  const lv = v => v == null ? 'na' : v <= 0 ? '' : v <= q(.25) ? 'l1' : v <= q(.5) ? 'l2' : v <= q(.8) ? 'l3' : 'l4';
  const n = weeks.length;
  return `<div class="heat" style="--n:${n}">
    ${gains.map(([m, g]) => `<div class="hr"><span class="m">${esc(m)}</span>${g.map((v, i) => `<span class="cell ${lv(v)} ${weeks[i] === curWeek ? 'cur' : ''}" title="${esc(m)} · ${wk(weeks[i])}: ${v == null ? 'no data' : '+' + fmt(v) + ' plays'}"></span>`).join('')}<span></span></div>`).join('')}
    <div class="hr"><span></span>${weeks.map(w => `<span class="wk">${wk(w)}</span>`).join('')}<span></span></div></div>
    <div class="legend">Less <span class="cell" style="background:var(--h0)"></span><span class="cell" style="background:var(--h1)"></span><span class="cell" style="background:var(--h2)"></span><span class="cell" style="background:var(--h3)"></span><span class="cell" style="background:var(--h4)"></span> More · plays gained per week</div>`;
}
const bars = rows => { if (!rows.length) return '<div class="empty">No data this week.</div>'; const mx = Math.max(...rows.map(r => r[1]), 1);
  return `<div class="bars">${rows.map(([k, v]) => `<div class="barrow"><span class="k">${esc(k)}</span><span class="t"><span class="f" style="display:block;width:${(v / mx * 100).toFixed(1)}%"></span></span><span class="x">${human(v)}</span></div>`).join('')}</div>`; };

/* ---------------- Tracks ---------------- */
function viewTracks(){
  const lw = latestWeek(), songs = S.D.songs;
  const card = s => {
    const sn = snaps(s), last = sn[sn.length - 1], prev = sn[sn.length - 2], F = last && last.f, P = prev && prev.f;
    const fresh = last && last.week === lw;
    const tags = [];
    if (!last) tags.push(`<span class="tag">${s.releaseDate && s.releaseDate > new Date().toISOString().slice(0, 10) ? 'Out ' + esc(s.releaseDate.slice(5).split('-').reverse().join('.')) : 'No report yet'}</span>`);
    else { if (!fresh) tags.push(`<span class="tag">Last ${wk(last.week)}</span>`); if (F.new_adds > 0) tags.push(`<span class="tag hot">+${F.new_adds} new station${F.new_adds > 1 ? 's' : ''}</span>`);
      const pct = F.avg_day != null && P && P.avg_day ? (F.avg_day - P.avg_day) / P.avg_day * 100 : null; if (pct != null && pct <= -15) tags.push('<span class="tag warn">Spotify cooling</span>'); if (pct != null && pct >= 5) tags.push('<span class="tag ok">Spotify up</span>'); }
    return `<article class="card glass" data-open="${s.id}" tabindex="0" aria-label="${esc(s.name)}">
      <div class="card-top">${cover(s)}<div class="ttl"><h3>${esc(s.name)}</h3><p>${esc(s.artist)}</p></div>
        <button class="cardact" data-arch="${s.id}" title="${s.archived ? 'Bring back' : 'Archive'}" aria-label="${s.archived ? 'Bring back' : 'Archive'} ${esc(s.name)}">${s.archived ? ICON_RESTORE : ICON_ARCHIVE}</button></div>
      ${`<div class="card-nums"><div class="mini"><div class="l">Radio plays</div><div class="v">${F ? human(F.radio_plays) : '—'}</div>${delta(F && F.radio_plays, P && P.radio_plays)}</div>
        <div class="mini"><div class="l">Spotify / day</div><div class="v">${F ? human(F.avg_day) : '—'}</div>${delta(F && F.avg_day, P && P.avg_day, { pct: true })}</div></div>
        ${spark(sn.slice(-10).map(r => r.f.radio_plays))}`}
      <div class="card-foot"><div class="tags">${tags.join('') || '<span class="tag">—</span>'}</div><span class="mono faint" style="font-size:11px">${last ? wk(last.week) : ''}</span></div></article>`;
  };
  const score = s => { const sn = snaps(s), l = sn[sn.length - 1]; return l ? (l.week === lw ? 1e9 : 0) + (l.f.radio_plays || 0) : -1; };
  const active = songs.filter(s => !s.archived).sort((a, b) => score(b) - score(a)), archived = songs.filter(s => s.archived);
  const totalPlays = active.reduce((a, s) => { const sn = snaps(s), l = sn[sn.length - 1]; return a + (l && l.week === lw ? l.f.radio_plays || 0 : 0); }, 0);
  app().innerHTML = `<section class="head"><div><div class="eyebrow">${esc(lw || '—')} · ${active.length} active · ${fmt(totalPlays)} radio plays</div><h1 class="h1">Tracks</h1></div>
      <div class="row"><button class="btn" id="addTrack">Add track</button><button class="btn primary" data-go="week">Update this week</button></div></section>
    <section class="grid">${active.map(card).join('')}</section>
    ${archived.length ? `<details class="fold" ${S.view.openArch ? 'open' : ''}><summary>Archived · ${archived.length} · not in weekly updates</summary><div class="grid">${archived.map(card).join('')}</div></details>` : ''}`;
  $('#addTrack').onclick = addTrackSheet;
  const fold = $('details.fold'); if (fold) fold.ontoggle = () => { S.view.openArch = fold.open; };
  document.querySelectorAll('[data-open]').forEach(c => { c.onclick = e => { if (!e.target.closest('[data-arch]')) go('t-' + c.dataset.open); }; c.onkeydown = e => { if (e.key === 'Enter') go('t-' + c.dataset.open); }; });
  document.querySelectorAll('[data-arch]').forEach(b => b.onclick = async e => { e.stopPropagation();
    const t = S.D.songs.find(x => x.id === b.dataset.arch); if (!t) return; t.archived = !t.archived; viewTracks();
    try { await saveSongs(`${t.archived ? 'Archive' : 'Restore'} ${t.name}`); toast(t.archived ? `${t.name} archived · out of weekly updates` : `${t.name} is back in weekly updates`); }
    catch { t.archived = !t.archived; viewTracks(); } });
}
function addTrackSheet(){
  const sc = document.createElement('div'); sc.className = 'scrim';
  sc.innerHTML = `<form class="sheet glass" style="width:min(440px,100%);grid-template-rows:auto auto" aria-label="Add track"><div class="sheet-h"><span class="grow">Add track</span><button class="btn sm" type="button" id="cl">Close</button></div>
    <div class="form"><label>Title, as on Spotify<input id="nt" required autocomplete="off" placeholder="On And On 2026 (Akem Remix Extended)"></label>
      <label>Artist<input id="na" required autocomplete="off" placeholder="Akcent"></label>
      <label>Release date<input id="nr" type="date"></label>
      <div class="row"><button class="btn primary" type="submit">Add</button><span class="note">Songstats links it on the next sync</span></div></div></form>`;
  document.body.appendChild(sc);
  const close = () => sc.remove(); $('#cl', sc).onclick = close; sc.onclick = e => { if (e.target === sc) close(); };
  $('form', sc).onsubmit = async e => { e.preventDefault();
    const name = $('#nt', sc).value.trim(), artist = $('#na', sc).value.trim(); if (!name) return;
    if (S.E.songFor(name) && S.E.norm(S.E.songFor(name).name) === S.E.norm(name)){ toast('That track is already in the list'); return; }
    const id = 't' + Date.now().toString(36);
    S.D.songs.push({ id, name, artist, aliases: [], songstatsId: '', cover: '', releaseDate: $('#nr', sc).value || '', createdWeek: S.E.weekLabelFor(new Date()), archived: false, territories: [], pluggers: [], licensing: [], djpromo: [], notes: '' });
    try { await saveSongs('Add ' + name); close(); toast(name + ' added'); go('t-' + id); } catch { S.D.songs.pop(); } };
  setTimeout(() => $('#nt', sc).focus(), 50);
}
const ICON_ARCHIVE = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 15 5.995v7.255A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V5.995A1.75 1.75 0 0 1 0 4.25ZM2.5 6v7.25c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V6Zm-.75-3.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM6 8.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 6 8.25Z"/></svg>';
const ICON_RESTORE = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>';

/* ---------------- Track ---------------- */
function viewTrack(id){
  const s = S.D.songs.find(x => x.id === id); if (!s) return viewTracks();
  ambient(s.cover);
  const sn = snaps(s), weeks = sn.map(r => r.week).reverse();
  const tab = S.view.tab[id] || 'overview';
  const week = S.view.week[id] && weeks.includes(S.view.week[id]) ? S.view.week[id] : weeks[0];
  const prevOf = w => { const i = weeks.indexOf(w); return weeks[i + 1] || null; };
  let cmp = S.view.cmp[id]; if (cmp === undefined || cmp === week || (cmp && cmp !== 'release' && !weeks.includes(cmp))) cmp = prevOf(week);
  const rel = s.releaseDate ? `Released ${new Date(s.releaseDate + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : '';
  const head = `<section class="hero">${cover(s, 'lg')}
    <div class="meta"><div class="eyebrow"><a href="#tracks" style="text-decoration:none">Tracks</a> / ${s.archived ? 'Archived' : 'Active'}${rel ? ' · ' + rel : ''}</div>
      <h1 class="t">${esc(s.name)}</h1><div class="a">${esc(s.artist)}</div>
      ${weeks.length ? `<div class="controls"><select class="pill" id="selWeek" aria-label="Report week">${weeks.map(w => `<option ${w === week ? 'selected' : ''} value="${esc(w)}">${esc(w)}</option>`).join('')}</select>
        <span class="vs">vs</span><select class="pill" id="selCmp" aria-label="Compare with">${weeks.filter(w => w !== week).map(w => `<option ${w === cmp ? 'selected' : ''} value="${esc(w)}">${esc(w)}</option>`).join('')}<option value="release" ${cmp === 'release' ? 'selected' : ''}>since release</option><option value="" ${!cmp ? 'selected' : ''}>no comparison</option></select>
        <span class="sp" style="flex:1"></span><button class="btn primary" id="btnPartner"><svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/></svg>Partner report</button></div>` : ''}
    </div></section>`;
  if (!weeks.length){ app().innerHTML = head + `<section class="panel glass"><div class="ph"><h2>No report yet</h2></div><p class="muted">This track gets its first numbers the next time you build a week that includes it.</p></section>` + setupPanel(s); bindSetup(s); return; }
  const A = S.E.analyze(s.name, week, cmp === 'release' ? null : (cmp || null));
  if (cmp === 'release'){ A.prev = { radio_plays: 0, radio_stations: 0, reach: 0, playlists_cur: 0, combined: 0, shazam_rows: 0, tk_views: 0, ig_views: 0, yt_views: 0, avg_day: null }; A.cmpWeek = 'release'; }
  const Ap = cmp && cmp !== 'release' ? S.E.analyze(s.name, cmp, null) : null;
  const tabs = [['overview', 'Overview'], ['radio', 'Radio', A.stations.length], ['servicing', 'Servicing'], ['streaming', 'Streaming & social'], ['setup', 'Setup']];
  app().innerHTML = head + `<nav class="subtabs" role="tablist">${tabs.map(([k, l, n]) => `<button class="subtab" role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</nav><div id="tabbody"></div>`;
  const body = { overview: tOverview, radio: tRadio, servicing: tServicing, streaming: tStreaming, setup: () => setupPanel(s) }[tab](s, A, Ap, sn, week, cmp);
  $('#tabbody').innerHTML = body; $('#tabbody').style.display = 'grid'; $('#tabbody').style.gap = '14px';
  if (tab === 'setup') bindSetup(s);
  $('#selWeek').onchange = e => { S.view.week[id] = e.target.value; S.view.cmp[id] = undefined; viewTrack(id); };
  $('#selCmp').onchange = e => { S.view.cmp[id] = e.target.value || null; viewTrack(id); };
  $('#btnPartner').onclick = () => partnerSheet(s, week);
  document.querySelectorAll('.subtab').forEach(b => b.onclick = () => { S.view.tab[id] = b.dataset.tab; viewTrack(id); });
  const q = $('#stq'); if (q) q.oninput = () => { const v = q.value.toLowerCase(); document.querySelectorAll('#sttable tbody tr').forEach(tr => tr.hidden = !tr.textContent.toLowerCase().includes(v)); };
}

function kpi(l, v, d, sub){ return `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d || ''}${sub ? `<span>${sub}</span>` : ''}</div></div>`; }
function rr(sv){ return sv && sv.contactsOk && sv.mode !== 'none' && sv.contacted ? sv.playing / sv.contacted * 100 : null; }

function pillar(label, state, ok, value, sub){
  return `<div class="pill-t"><div class="k">${label}<span class="st ${ok ? 'ok' : 'warn'}">${esc(state)}</span></div><div class="v">${value}</div><div class="s">${sub || '&nbsp;'}</div></div>`;
}
function tOverview(s, A, Ap, sn, week, cmp){
  const F = A.F, P = A.prev, V = A.read.verdicts, vs = vsLabel(cmp);
  const r = rr(A.servicing), rp = Ap ? rr(Ap.servicing) : null;
  const kp = `<section class="kpis glass">
    ${kpi('Radio plays', human(F.radio_plays), delta(F.radio_plays, P && P.radio_plays), vs)}
    ${kpi('Stations', F.radio_stations != null ? fmt(F.radio_stations) : '—', delta(F.radio_stations, P && P.radio_stations), vs)}
    ${kpi('New stations', fmt(F.new_adds || 0), F.new_major_n ? `<span class="delta up">${F.new_major_n} priority</span>` : '', 'first play ≤ 7 days')}
    ${kpi('Spotify / day', human(F.avg_day), delta(F.avg_day, P && P.avg_day, { pct: true }), vs)}
    ${kpi('Response rate', r == null ? '—' : r.toFixed(0) + '%', r != null && rp != null ? `<span class="delta ${r > rp ? 'up' : r < rp ? 'dn' : 'fl'}">${r >= rp ? '+' : '−'}${Math.abs(r - rp).toFixed(0)} pts</span>` : '', A.servicing && A.servicing.contacted ? `${A.servicing.playing}/${A.servicing.contacted} mailed` : 'nothing sent')}
    ${kpi('Playlist reach', human(F.reach), delta(F.reach, P && P.reach), F.playlists_total ? `${F.playlists_total} playlists` : '')}
  </section>`;
  const topShz = (F.shazam || []).slice().sort((a, b) => (parseInt(String(a.peak).replace('#', '')) || 999) - (parseInt(String(b.peak).replace('#', '')) || 999))[0];
  const topMk = (F.markets || []).find(m => S.E.norm(m[0]) !== S.E.norm(S.E.HOME_MARKET));
  const status = `<section class="pillars glass">
    ${pillar('Radio', V.radio.verdict, V.radio.badge === 'ok', `${human(F.radio_plays)}<small> plays</small>`, topMk ? `Top abroad: ${esc(topMk[0])} · ${human(topMk[1])}` : 'Home market only')}
    ${pillar('Streaming', V.streaming.verdict, V.streaming.badge === 'ok', `${human(F.avg_day)}<small> / day</small>`, `${fmt(F.playlists_cur)} playlists · ${(F.dropped || []).length} dropped`)}
    ${pillar('Shazam', V.shazam.verdict, V.shazam.badge === 'ok', `${fmt(F.shazam_rows || 0)}<small> charts</small>`, topShz ? `Peak: ${esc(String(topShz.name).split(' - ')[0])} ${esc(topShz.peak)}` : 'Not charting')}
    ${pillar('Social', V.social.verdict, V.social.badge === 'ok', `${human((F.tk_views || 0) + (F.ig_views || 0) + (F.yt_sh_views || 0))}<small> short-form</small>`, `TikTok ${human(F.tk_views)} · IG ${human(F.ig_views)}`)}
  </section>`;
  const flags = [];
  A.read.checks.forEach(c => flags.push(`<span class="flag bad" title="${esc(c)}">Data check: ${esc(c.replace(/^[^:]*:\s*/, '').slice(0, 70))}</span>`));
  if (F.radio_old) flags.push(`<span class="flag">Radio carried from ${esc(wk(F.radio_old))}</span>`);
  if (F.songstats_old) flags.push(`<span class="flag">Songstats carried from ${esc(wk(F.songstats_old))}</span>`);
  if (F.legacy) flags.push(`<span class="flag">Imported week · top 60 stations</span>`);
  const flagRow = flags.length ? `<div class="flags">${flags.join('')}</div>` : '';
  const series = sn.map(r => ({ w: r.week, v: r.f.radio_plays }));
  const charts = `<section class="cols"><div class="panel glass c7"><div class="ph"><h2>Radio plays</h2><span class="s">cumulative · by report week</span></div>${areaChart(series, { cur: week, cmp })}</div>
    <div class="panel glass c5"><div class="ph"><h2>Activity by market</h2><span class="s">plays gained per week</span></div>${heatmap(sn, week)}</div></section>`;
  const I = A.insights;
  const expand = [].concat(
    I.send.map(m => ['send', m.name, '', m.plays, `${m.withContact} contacts`]),
    I.push.map(x => ['push', (x.tier === 1 || x.tier === 2 ? '★ ' : '') + x.station, x.country, x.plays, 'new this week']),
    I.find.map(x => ['find', x.station, x.country, x.plays, 'not on list']),
    I.outside.map(o => ['build', o.name, '', null, 'Shazam #' + o.peak]));
  const ACT = { send: 'Send', push: 'Push', find: 'Find contact', build: 'Build list' };
  const tbl = (head, rows) => rows.length ? `<div class="tw"><table class="fixed"><thead><tr>${head.map(h => `<th class="${h[1] || ''}">${h[0]}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="empty">—</div>';
  const moves = `<section class="moves">
    <div class="panel glass move"><div class="ph"><h2><span class="i">01</span>Expand</h2><span class="s">${expand.length}</span></div>
      ${tbl([['Action'], ['Where'], ['Plays', 'r']], expand.slice(0, 12).map(([a, n, c, p, note]) => `<tr><td><span class="act ${a}">${ACT[a]}</span></td><td><b>${esc(n)}</b><span class="sub">${esc([c, note].filter(Boolean).join(' · '))}</span></td><td class="r num">${p == null ? '—' : fmt(p)}</td></tr>`))}</div>
    <div class="panel glass move"><div class="ph"><h2><span class="i">02</span>Follow up</h2><span class="s">${I.follow.length}</span></div>
      ${tbl([['Station'], ['Type', 'r']], I.follow.slice(0, 12).map(f => `<tr><td><b>${esc(f.station)}</b><span class="sub">${esc(f.country)}</span></td><td class="r muted">${esc(f.type || '—')}</td></tr>`))}</div>
    <div class="panel glass move"><div class="ph"><h2><span class="i">03</span>Streaming</h2><span class="s">${esc(V.streaming.verdict)}</span></div>
      ${tbl([['Metric'], ['Now', 'r'], ['Change', 'r']], [
        `<tr><td>Spotify / day</td><td class="r num">${human(F.avg_day)}</td><td class="r">${delta(F.avg_day, P && P.avg_day, { pct: true })}</td></tr>`,
        `<tr><td>Playlists now</td><td class="r num">${fmt(F.playlists_cur)}</td><td class="r">${delta(F.playlists_cur, P && P.playlists_cur)}</td></tr>`,
        `<tr><td>Playlist reach</td><td class="r num">${human(F.reach)}</td><td class="r">${delta(F.reach, P && P.reach)}</td></tr>`,
        `<tr><td>Editorial</td><td class="r num">${fmt(F.editorial_cur || 0)}</td><td class="r"></td></tr>`,
        ...(F.dropped || []).slice(0, 4).map(p => `<tr><td><span class="act find">Re-pitch</span> ${esc(p.name)}</td><td class="r num">${human(p.followers)}</td><td class="r muted mono" style="font-size:11px">${esc(p.removed)}</td></tr>`)])}</div>
  </section>`;
  return kp + status + flagRow + charts + moves;
}

function tRadio(s, A, Ap, sn, week){
  const F = A.F;
  const nw = (F.new_major || []).concat(F.new_minor || []);
  const air = (A.airplay || []).filter(a => a.peak).sort((a, b) => (parseInt(a.peak) || 999) - (parseInt(b.peak) || 999));
  const now = (F.airplay || []).map(([c, p]) => [S.E.rmName(c), p]);
  return `<section class="cols">
    <div class="panel glass c5"><div class="ph"><h2>On air in</h2><span class="s">radio plays to date</span></div>${bars((F.markets || []).slice(0, 10))}</div>
    <div class="panel glass c7"><div class="ph"><h2>New on air this week</h2><span class="s">${nw.length} station${nw.length === 1 ? '' : 's'} · first play in the last 7 days</span></div>
      ${nw.length ? `<div class="tw"><table><thead><tr><th>Station</th><th>Market</th><th class="r">First play</th><th class="r">Plays</th></tr></thead><tbody>${nw.slice(0, 14).map(x => `<tr><td>${x.tier === 1 || x.tier === 2 ? '<span class="star">★</span> ' : ''}${esc(x.station)}</td><td class="muted">${esc(x.country)}</td><td class="r num muted">${esc(x.first || '')}</td><td class="r num">${fmt(x.plays)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No first plays this week.</div>'}</div>
    <div class="panel glass c12"><div class="ph"><h2>Airplay charts</h2><span class="s">Radiomonitor · this week and best positions</span></div>
      ${now.length ? `<div class="row" style="margin-bottom:12px">${now.map(([m, p]) => `<span class="chip"><b>#${p}</b> ${esc(m)}</span>`).join('')}</div>` : ''}
      ${air.length ? `<div class="tw"><table><thead><tr><th>Market</th><th class="r">Now</th><th class="r">Peak</th><th class="r">Weeks</th><th class="r">Chart</th></tr></thead><tbody>${air.map(a => `<tr><td>${esc(S.E.rmName(a.market))}</td><td class="r num">${esc(a.current)}</td><td class="r num"><b>#${esc(a.peak)}</b></td><td class="r num muted">${esc(a.weeks)}</td><td class="r num muted">Top ${esc(a.tier)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No airplay chart positions recorded.</div>'}</div>
    <div class="panel glass c12"><div class="ph"><h2>All stations</h2><input class="search" id="stq" placeholder="Filter stations or markets" aria-label="Filter stations"></div>
      <div class="tw"><table id="sttable"><thead><tr><th>Station</th><th>Where</th><th>Source</th><th class="r">First play</th><th class="r">Plays</th></tr></thead><tbody>
      ${A.stations.map(x => `<tr><td>${x.tier === 1 || x.tier === 2 ? '<span class="star">★</span> ' : ''}${esc(x.station)}${x.isNew ? ' <span class="tag hot">new</span>' : ''}</td><td class="muted">${esc(x.location || x.country)}</td><td>${x.source === 'home' ? '<span class="faint">home</span>' : SRC[x.source] ? `<i class="sw" style="background:${SRC[x.source][1]}"></i>${SRC[x.source][0]}` : '—'}</td><td class="r num muted">${esc(x.first || '')}</td><td class="r num">${fmt(x.plays)}</td></tr>`).join('')}
      </tbody></table></div><p class="note">★ priority station in its market</p></div></section>`;
}

const SRC = { us: ['Us', 'var(--up)'], shared: ['Us + partner', 'var(--accent)'], partner: ['Licensing partner', 'var(--info)'], organic: ['Organic', 'var(--faint)'] };
function tServicing(s, A){
  const SV = A.servicing, AT = A.attribution;
  if (!SV || !SV.contactsOk) return `<section class="panel glass"><div class="ph"><h2>Servicing</h2></div><div class="empty">No contact list loaded.</div></section>`;
  const r = rr(SV);
  const k = `<section class="kpis glass" style="grid-template-columns:repeat(4,1fr)">
    ${kpi('Territories sent', fmt(SV.sentCount), '', SV.planned.length ? `${SV.planned.length} planned` : '')}
    ${kpi('Stations mailed', fmt(SV.contacted), '', 'on our list')}
    ${kpi('Playing', fmt(SV.playing), SV.newPlaying ? `<span class="delta up">+${SV.newPlaying} new</span>` : '', `${fmt(SV.plays)} plays`)}
    ${kpi('Response rate', r == null ? '—' : r.toFixed(0) + '%', '', 'mailed → on air')}</section>`;
  const tot = AT.total || 0, pc = v => tot ? (v / tot * 100) : 0;
  const mk = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([m, p]) => `${esc(m)} ${human(p)}`).join(', ');
  const rowsA = [['us', ''], ['shared', mk(AT.sharedMarkets)], ['partner', mk(AT.partnerMarkets)], ['organic', '']];
  const attr = `<section class="panel glass"><div class="ph"><h2>Where the radio abroad comes from</h2><span class="s">${fmt(tot)} plays outside ${esc(S.E.HOME_MARKET)}</span></div>
    <div class="stack">${rowsA.map(([b]) => AT[b] ? `<span style="width:${pc(AT[b]).toFixed(2)}%;background:${SRC[b][1]}" title="${SRC[b][0]}"></span>` : '').join('')}</div>
    <div class="tw"><table class="fixed"><thead><tr><th>Source</th><th>Rule</th><th class="r">Plays</th><th class="r">Share</th><th>Markets</th></tr></thead><tbody>
      ${rowsA.map(([b, m]) => `<tr><td><i class="sw" style="background:${SRC[b][1]}"></i><b>${SRC[b][0]}</b></td><td class="muted">${{ us: 'Mailed by us', shared: 'Mailed by us · partner active in market', partner: 'Not mailed · partner active in market', organic: 'Not mailed · no partner' }[b]}</td><td class="r num">${fmt(AT[b])}</td><td class="r num">${pc(AT[b]).toFixed(0)}%</td><td class="muted" style="font-size:12px">${m || '—'}</td></tr>`).join('')}
    </tbody></table></div>
    ${AT.overlap.length ? `<div class="flags"><span class="flag warn">Sent + licensed: ${esc(AT.overlap.join(', '))} · not separable</span></div>` : ''}</section>`;
  const rows = SV.rows || [];
  const chan = t => t.licensed ? `<span class="act shared">Direct + ${esc(t.licensed)}</span>` : esc(t.channel);
  const table = `<section class="panel glass"><div class="ph"><h2>By territory</h2><span class="s">${rows.length} with contacts</span></div>
    ${rows.length ? `<div class="tw"><table><thead><tr><th>Territory</th><th>Wave</th><th>Channel</th><th class="r">Mailed</th><th class="r">Playing</th><th style="width:18%">Conversion</th><th class="r">Plays</th></tr></thead><tbody>
    ${rows.map(t => `<tr><td><b>${esc(t.name)}</b></td><td class="muted">${esc(t.wave)}</td><td>${chan(t)}</td><td class="r num">${t.contacted}</td><td class="r num">${t.playing}</td><td><div class="conv"><i style="width:${t.contacted ? (t.playing / t.contacted * 100).toFixed(0) : 0}%"></i></div></td><td class="r num">${fmt(t.plays)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No territory marked as sent. Set it in Setup.</div>'}
    ${SV.noContacts.length || SV.planned.length ? `<div class="flags">${SV.noContacts.length ? `<span class="flag bad">Sent, no contacts: ${esc(SV.noContacts.join(', '))}</span>` : ''}${SV.planned.length ? `<span class="flag">Planned: ${esc(SV.planned.join(', '))}</span>` : ''}</div>` : ''}</section>`;
  const leg = A.F.legacy ? `<div class="flags"><span class="flag">Imported week · top 60 stations · response rate undercounted</span></div>` : '';
  return k + leg + attr + table;
}

function tStreaming(s, A, Ap, sn, week, cmp){
  const F = A.F, P = A.prev, vs = vsLabel(cmp);
  const k = `<section class="kpis glass">
    ${kpi('Spotify / day', human(F.avg_day), delta(F.avg_day, P && P.avg_day, { pct: true }), vs)}
    ${kpi('Streams', human(F.combined), delta(F.combined, P && P.combined), 'Spotify + YouTube')}
    ${kpi('Playlists', `${fmt(F.playlists_cur)}<span class="faint" style="font-size:15px"> / ${fmt(F.playlists_total)}</span>`, delta(F.playlists_cur, P && P.playlists_cur), 'current / ever')}
    ${kpi('Shazam charts', fmt(F.shazam_rows || 0), delta(F.shazam_rows, P && P.shazam_rows), 'charting now')}
    ${kpi('TikTok views', human(F.tk_views), delta(F.tk_views, P && P.tk_views), F.tk_vids ? fmt(F.tk_vids) + ' videos' : '')}
    ${kpi('YouTube views', human(F.yt_views), delta(F.yt_views, P && P.yt_views), F.yt_sh_views ? human(F.yt_sh_views) + ' in Shorts' : '')}</section>`;
  const pl = (F.playlists || []), dr = (F.dropped || []);
  return k + `<section class="cols"><div class="panel glass c7"><div class="ph"><h2>Spotify streams per day</h2><span class="s">7-day average, Spotify for Artists</span></div>${areaChart(sn.map(r => ({ w: r.week, v: r.f.avg_day })), { cur: week, cmp })}</div>
    <div class="panel glass c5"><div class="ph"><h2>Shazam</h2><span class="s">chart · now · peak</span></div>${(F.shazam || []).length ? `<ul class="list">${F.shazam.map(z => `<li><span class="x"><b>${esc(z.name)}</b><span>${esc(z.type)} · ${esc(z.days)} days</span></span><span class="r">${z.now ? '#' + esc(z.now) + ' now · ' : ''}peak ${esc(z.peak)}</span></li>`).join('')}</ul>` : '<div class="empty">Not on Shazam charts.</div>'}</div>
    <div class="panel glass c7"><div class="ph"><h2>On playlists</h2><span class="s">by followers</span></div>${pl.length ? `<div class="tw"><table><thead><tr><th>Playlist</th><th>Curator</th><th class="r">Position</th><th class="r">Followers</th></tr></thead><tbody>${pl.map(p => `<tr><td>${/^spotify$/i.test(p.owner) ? '<span class="star">★</span> ' : ''}${esc(p.name)}</td><td class="muted">${esc(p.owner)}</td><td class="r num muted">${esc(p.pos)}</td><td class="r num">${human(p.followers)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No playlists with followers.</div>'}</div>
    <div class="panel glass c5"><div class="ph"><h2>Dropped from</h2><span class="s">worth a re-pitch</span></div>${dr.length ? `<ul class="list">${dr.map(p => `<li><span class="x"><b>${esc(p.name)}</b><span>${esc(p.owner)} · since ${esc(p.removed)}</span></span><span class="r">${human(p.followers)}</span></li>`).join('')}</ul>` : '<div class="empty">No drops.</div>'}</div>
    <div class="panel glass c12"><div class="ph"><h2>Social</h2><span class="s">views to date</span></div>${bars([['TikTok', F.tk_views || 0], ['Instagram', F.ig_views || 0], ['YouTube', F.yt_views || 0], ['YouTube Shorts', F.yt_sh_views || 0]])}</div></section>`;
}

/* ---- setup (territories, pluggers, licensing) ---- */
function setupPanel(s){
  const T = s.territories || [];
  const status = (opts, v) => opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('');
  return `<section class="panel glass" id="setup"><div class="ph"><h2>Territories</h2><span class="s">${T.filter(t => t.sent).length} sent of ${T.length} · sent territories drive the response rate</span></div>
    <div class="terr">${T.map((t, i) => `<div class="t"><span class="nm">${esc(t.name)}</span><span class="seg" role="group" aria-label="Wave">${[1, 2, 3].map(w => `<button data-wave="${i}:${w}" class="${(t.wave || 1) === w ? 'on' : ''}">${w === 3 ? 'X' : w}</button>`).join('')}</span><button class="toggle ${t.sent ? 'on' : ''}" data-sent="${i}">${t.sent ? 'sent' : 'not sent'}</button><button class="toggle" data-rm="${i}" aria-label="Remove ${esc(t.name)}">×</button></div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><select class="pill" id="addTerr" aria-label="Add territory"><option value="">Add territory…</option>${S.E.COUNTRIES.filter(c => !T.some(t => t.name === c)).map(c => `<option>${esc(c)}</option>`).join('')}</select></div></section>
  <section class="cols"><div class="panel glass c6"><div class="ph"><h2>Pluggers</h2></div>${(s.pluggers || []).length ? `<ul class="list">${s.pluggers.map((p, i) => `<li><span class="x"><b>${esc(p.name || '—')}</b><span>${esc(p.region || '')}</span></span><select class="pill" data-plug="${i}" aria-label="Status">${status(['shown', 'planning to show', 'active', 'ended'], p.status)}</select></li>`).join('')}</ul>` : '<div class="empty">No pluggers on this track.</div>'}</div>
    <div class="panel glass c6"><div class="ph"><h2>Licensing</h2></div>${(s.licensing || []).length ? `<ul class="list">${s.licensing.map((l, i) => `<li><span class="x"><b>${esc(l.company || '—')}</b><span>${esc(l.country || '')}</span></span><select class="pill" data-lic="${i}" aria-label="Status">${status(['shown', 'planning to show', 'sent', 'started', 'stopped'], l.status)}</select></li>`).join('')}</ul>` : '<div class="empty">No licensing deals.</div>'}</div></section>
  <section class="panel glass"><div class="ph"><h2>Track</h2></div><div class="row">
    <label class="note" for="ssid">Songstats ID</label><input id="ssid" class="search" style="max-width:160px" value="${esc(s.songstatsId || '')}" placeholder="e.g. 75j2lkun">
    <span style="flex:1"></span><button class="btn" id="btnArchive">${s.archived ? 'Bring back' : 'Archive'}</button><button class="btn primary" id="btnSave">Save changes</button></div>
</section>`;
}
function bindSetup(s){
  const T = s.territories = s.territories || [], re = () => viewTrack(s.id);
  document.querySelectorAll('[data-wave]').forEach(b => b.onclick = () => { const [i, w] = b.dataset.wave.split(':').map(Number); T[i].wave = w; re(); });
  document.querySelectorAll('[data-sent]').forEach(b => b.onclick = () => { const t = T[+b.dataset.sent]; t.sent = !t.sent; re(); });
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { T.splice(+b.dataset.rm, 1); re(); });
  const add = $('#addTerr'); if (add) add.onchange = () => { if (add.value){ T.push({ name: add.value, wave: 1, sent: false }); re(); } };
  document.querySelectorAll('[data-plug]').forEach(x => x.onchange = () => { s.pluggers[+x.dataset.plug].status = x.value; });
  document.querySelectorAll('[data-lic]').forEach(x => x.onchange = () => { s.licensing[+x.dataset.lic].status = x.value; });
  const ss = $('#ssid'); if (ss) ss.onchange = () => { s.songstatsId = ss.value.trim(); };
  const ar = $('#btnArchive'); if (ar) ar.onclick = async () => { s.archived = !s.archived; await saveSongs(`${s.archived ? 'Archive' : 'Restore'} ${s.name}`); re(); };
  const sv = $('#btnSave'); if (sv) sv.onclick = async () => { await saveSongs(`Update ${s.name} setup`); toast('Saved'); };
}
async function saveSongs(msg){
  try { await S.store.commit([{ path: DATA.songs, text: JSON.stringify(S.D.songs, null, 1) }], msg); engine(); }
  catch (e){ toast('Could not save: ' + e.message, 5000); throw e; }
}

/* ---- partner report sheet ---- */
const PERIOD_TABS = [['week', 'This week'], ['month', 'Last 30 days'], ['year', 'Last 12 months'], ['release', 'Since release'], ['custom', 'Custom']];
async function partnerSheet(s, week){
  const today = new Date().toISOString().slice(0, 10), b = S.E.weekBounds(week);
  const st = S.view.partner || (S.view.partner = { period: 'week', from: s.releaseDate || '', to: b ? b.end.toISOString().slice(0, 10) : today });
  const sc = document.createElement('div'); sc.className = 'scrim';
  sc.innerHTML = `<div class="sheet glass" role="dialog" aria-label="Partner report"><div class="sheet-h">
      <div class="seg period" role="tablist" aria-label="Period">${PERIOD_TABS.map(([k, l]) => `<button data-p="${k}">${l}</button>`).join('')}</div>
      <span class="custom-range" id="cr"><input type="date" id="pFrom" aria-label="From"><span class="faint">→</span><input type="date" id="pTo" aria-label="To"></span>
      <span class="grow"></span><button class="btn sm" id="cl">Close</button></div>
    <div class="sheet-h sub"><span class="grow mono" id="pFile"></span><span class="note" id="pdfState"></span><button class="btn primary sm" id="dl">Download PDF</button></div>
    <iframe title="Partner report preview"></iframe></div>`;
  document.body.appendChild(sc);
  const close = () => { clearInterval(sc._poll); sc.remove(); };
  $('#cl', sc).onclick = close; sc.onclick = e => { if (e.target === sc) close(); };
  const state = $('#pdfState', sc), dl = $('#dl', sc), fromI = $('#pFrom', sc), toI = $('#pTo', sc);
  fromI.value = st.from; toI.value = st.to; fromI.max = toI.max = today;
  const opt = () => ({ period: st.period, from: st.from, to: st.to });
  const fileOf = () => S.E.partnerFileName(s.name, week, opt());
  const draw = () => {
    sc.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === st.period));
    $('#cr', sc).hidden = st.period !== 'custom';
    if (st.period === 'custom' && (!st.from || !st.to || st.from > st.to)){ $('#pFile', sc).textContent = 'Pick a start and an end date'; dl.disabled = true; return; }
    const html = S.E.renderPartner(s.name, week, opt());
    $('#pFile', sc).textContent = fileOf() + '.pdf'; $('iframe', sc).srcdoc = html || '<p style="font:14px sans-serif;padding:20px">No report week in that period.</p>';
    dl.disabled = !html || S.store.mode === 'demo'; state.textContent = S.store.mode === 'demo' ? 'Download works once connected to GitHub' : '';
    clearInterval(sc._poll);
  };
  sc.querySelectorAll('[data-p]').forEach(x => x.onclick = () => { st.period = x.dataset.p; draw(); });
  fromI.onchange = () => { st.from = fromI.value; draw(); }; toI.onchange = () => { st.to = toI.value; draw(); };
  draw();
  const save = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.pdf'; a.click(); };
  dl.onclick = async () => {
    const file = fileOf(), path = `reports/${weekId(week)}/${file}.pdf`;
    dl.disabled = true; state.textContent = 'Fetching…';
    try {
      let blob = await S.store.readBlob(path);
      if (blob){ save(blob, file); state.textContent = ''; dl.disabled = false; return; }
      await S.store.dispatch('render-partner.yml', { week: weekId(week), song: s.id, period: st.period, from: st.period === 'custom' ? st.from : '', to: st.period === 'custom' ? st.to : '' });
      state.textContent = 'Rendering on GitHub, about a minute…'; let tries = 0;
      sc._poll = setInterval(async () => {
        if (++tries > 24){ clearInterval(sc._poll); state.textContent = 'Still rendering. Try Download again shortly.'; dl.disabled = false; return; }
        blob = await S.store.readBlob(path).catch(() => null);
        if (blob){ clearInterval(sc._poll); save(blob, file); state.textContent = 'Downloaded'; dl.disabled = false; }
      }, 8000);
    } catch (e){ state.textContent = e.message; dl.disabled = false; }
  };
}

/* ---------------- This week ---------------- */
async function viewWeek(){
  const week = S.E.weekLabelFor(new Date()), id = weekId(week);
  const active = S.D.songs.filter(s => !s.archived);
  app().innerHTML = `<section class="head"><div><div class="eyebrow">Weekly update</div><h1 class="h1">${esc(week)}</h1></div></section><div id="wk">Loading…</div>`;
  const meta = await S.store.readJSON(`songstats/${id}/_meta.json`).catch(() => null);
  const built = new Set(Object.entries(S.D.history).filter(([, l]) => l.some(r => r.week === week)).map(([k]) => k));
  const { bySong, unmatched } = matchTimelines(S.E, S.inbox.timelines);
  const ssApi = sid => meta && meta.tracks && meta.tracks[sid] && meta.tracks[sid].ok, ssOk = sid => ssApi(sid) || !!S.inbox.zips[sid];
  const ssCount = active.filter(s => ssOk(s.id)).length;
  const synced = meta && meta.syncedAt ? new Date(meta.syncedAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : null;
  const rmTracks = S.inbox.rm ? active.filter(s => S.E.norm(S.inbox.rm.text).includes(S.E.norm(s.name).slice(0, 12))).length : 0;
  const ready = active.filter(s => ssOk(s.id) || bySong[s.id]);
  $('#wk').outerHTML = `<section class="steps">
    <div class="step glass"><div class="sn"><b>STEP 1 · AUTOMATIC</b><i class="dot ${ssCount ? 'ok' : 'warn'}"></i></div><h3>Songstats</h3>
      <p class="mono" style="font-size:12px">${synced ? `${esc(synced)} · ${ssCount}/${active.length}` : 'Thursday 21:00 · auto'}</p>
      <ul class="checklist">${active.map(s => `<li><span class="tick ${ssOk(s.id) ? 'on' : ''}">✓</span><span class="nm">${esc(s.name)}</span>${S.inbox.zips[s.id] && !ssApi(s.id) ? '<span class="faint mono" style="font-size:11px">zip</span>' : ''}${built.has(s.id) ? '<span class="tag ok">built</span>' : ''}</li>`).join('')}</ul>
      <div class="row"><button class="btn sm" id="syncNow">Sync now</button><label class="btn sm" id="dropZip" style="cursor:pointer"><input type="file" accept=".zip" multiple hidden id="fileZip">Add ZIP exports</label></div>
      ${S.inbox.zipMiss && S.inbox.zipMiss.length ? `<p class="note">Not matched to a track: ${esc(S.inbox.zipMiss.join(', '))}</p>` : ''}</div>
    <div class="step glass"><div class="sn"><b>STEP 2 · YOU</b><i class="dot ${Object.keys(bySong).length ? 'ok' : 'warn'}"></i></div><h3>Spotify for Artists</h3>
      <p class="mono" style="font-size:12px">${Object.keys(bySong).length}/${active.length} · timeline CSV per track</p>
      <label class="drop" id="dropS4A"><input type="file" accept=".csv" multiple hidden id="fileS4A"><b>Drop the timeline CSVs</b><br>or click to choose</label>
      <ul class="checklist">${active.map(s => `<li><span class="tick ${bySong[s.id] ? 'on' : ''}">✓</span><span class="nm">${esc(s.name)}</span><span class="faint mono" style="font-size:11px">${bySong[s.id] ? 'ready' : 'to download'}</span></li>`).join('')}</ul>
      ${unmatched.length ? `<p class="note">Not matched to a track: ${esc(unmatched.join(', '))}</p>` : ''}</div>
    <div class="step glass"><div class="sn"><b>STEP 3 · YOU</b><i class="dot ${S.inbox.rm ? 'ok' : 'warn'}"></i></div><h3>Radiomonitor</h3>
      <p class="mono" style="font-size:12px">${S.inbox.rm ? '1 file' : '0 files'} · one file, all tracks</p>
      <label class="drop" id="dropRM"><input type="file" accept=".csv,.xlsx,.xls" hidden id="fileRM"><b>Drop the Radiomonitor file</b><br>CSV or Excel</label>
      ${S.inbox.rm ? `<p class="note"><b>${esc(S.inbox.rm.name)}</b> · ${rmTracks} of our tracks found in it.</p>` : '<p class="note">Optional · positions carry over</p>'}</div>
  </section>
  <section class="buildbar glass"><div class="grow"><b>Build ${esc(week)}</b><div class="note mono">${ready.length}/${active.length} ready${built.size ? ` · ${built.size} built (rebuild replaces)` : ''} · partner PDFs follow</div><div class="progress"><i id="prog"></i></div></div>
    <button class="btn primary" id="btnBuild" ${ready.length ? '' : 'disabled'}>Build week</button></section>`;
  bindDrop('dropS4A', 'fileS4A', async files => { for (const f of files) S.inbox.timelines.push({ name: f.name, text: await f.text() }); viewWeek(); });
  bindDrop('dropRM', 'fileRM', async files => { const f = files[0]; S.inbox.rm = { name: f.name, text: /\.xlsx?$/i.test(f.name) ? await xlsxToCsv(f) : await f.text() }; viewWeek(); });
  bindDrop('dropZip', 'fileZip', async files => {
    const JSZip = await jszip(); S.inbox.zipMiss = [];
    for (const f of files){ const z = await JSZip.loadAsync(await f.arrayBuffer()), list = [];
      for (const n of Object.keys(z.files)) if (!z.files[n].dir) list.push({ name: n, text: await z.files[n].async('string') });
      const song = S.E.songFor(zipTitle(f.name)), sec = zipSections(S.E, list);
      if (song && sec){ S.inbox.zips[song.id] = sec; (S.inbox.zipFiles = S.inbox.zipFiles || []).push(f); } else S.inbox.zipMiss.push(f.name); }
    viewWeek(); });
  $('#syncNow').onclick = async () => { await S.store.dispatch('songstats-sync.yml', { week: id }); toast(S.store.mode === 'demo' ? 'Preview: nothing to sync' : 'Songstats sync started. About 2 minutes.'); };
  $('#btnBuild').onclick = () => runBuild(week, ready);
}
function bindDrop(zoneId, inputId, cb){
  const z = $('#' + zoneId), inp = $('#' + inputId);
  inp.onchange = () => inp.files.length && cb([...inp.files]);
  z.ondragover = e => { e.preventDefault(); z.classList.add('over'); }; z.ondragleave = () => z.classList.remove('over');
  z.ondrop = e => { e.preventDefault(); z.classList.remove('over'); if (e.dataTransfer.files.length) cb([...e.dataTransfer.files]); };
}
let JSZipLib = null;
async function jszip(){ if (JSZipLib) return JSZipLib; await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); }); return (JSZipLib = window.JSZip); }
let XLSXlib = null;
async function sheetjs(){ if (XLSXlib) return XLSXlib; await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); }); return (XLSXlib = window.XLSX); }
async function xlsxToCsv(f){ const X = await sheetjs(), wb = X.read(await f.arrayBuffer()); return X.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]); }

async function runBuild(week, songs){
  if (S.busy) return; S.busy = true; const btn = $('#btnBuild'), prog = $('#prog'); btn.disabled = true;
  const step = (p, t) => { prog.style.width = p + '%'; btn.textContent = t; };
  try {
    const id = weekId(week), songstats = {};
    step(10, 'Reading Songstats…');
    await Promise.all(songs.map(async s => { const r = await S.store.readJSON(`songstats/${id}/${s.id}.json`).catch(() => null); if (r) songstats[s.id] = r; }));
    step(35, 'Running the rules…');
    const { bySong } = matchTimelines(S.E, S.inbox.timelines);
    const res = buildWeek({ engine: S.E, week, songs, songstats, zips: S.inbox.zips, timelines: bySong, radiomon: S.inbox.rm && S.inbox.rm.text });
    const DB = S.E.DB;
    S.D.history = DB.history; S.D.registry = DB.registry; S.D.airplay = { manual: DB.airplayManual, tracker: DB.airplayTracker }; S.D.tasks = { tasks: DB.tasks, cands: DB.cands };
    step(65, 'Saving to GitHub…');
    const files = [
      { path: DATA.history, text: JSON.stringify(S.D.history, null, 1) }, { path: DATA.airplay, text: JSON.stringify(S.D.airplay, null, 1) },
      { path: DATA.tasks, text: JSON.stringify(S.D.tasks, null, 1) }, { path: DATA.registry, text: JSON.stringify(S.D.registry, null, 1) },
      { path: DATA.songs, text: JSON.stringify(S.D.songs, null, 1) },
      ...S.inbox.timelines.map(f => ({ path: `inputs/${id}/s4a/${f.name}`, text: f.text })),
      ...(S.inbox.rm ? [{ path: `inputs/${id}/radiomonitor.csv`, text: S.inbox.rm.text }] : []),
      ...Object.entries(S.inbox.zips).map(([sid, sec]) => ({ path: `inputs/${id}/songstats-zip/${sid}.json`, text: JSON.stringify(sec) })),
      { path: `inputs/${id}/build.json`, text: JSON.stringify({ week, builtAt: new Date().toISOString(), built: res.built, skipped: res.skipped }, null, 1) },
    ];
    await S.store.commit(files, `Build ${week}: ${res.built.length} tracks`);
    engine(); S.inbox = { timelines: [], rm: null, zips: {} };
    step(100, 'Done');
    toast(`${week} built for ${res.built.length} tracks`);
    setTimeout(() => go('tracks'), 700);
  } catch (e){ toast('Build failed: ' + e.message, 6000); btn.disabled = false; btn.textContent = 'Build week'; }
  finally { S.busy = false; }
}

/* ---------------- Contacts ---------------- */
function viewContacts(){
  const T = S.D.tasks.tasks || [], lw = latestWeek(), wi = widx(lw);
  const open = T.filter(t => t.status === 'open'), st = open.filter(t => t.kind === 'station').sort((a, b) => b.plays - a.plays), mk = open.filter(t => t.kind === 'market');
  const newN = open.filter(t => t.firstWeek === lw).length, done = T.filter(t => t.status === 'done').sort((a, b) => widx(b.closedWeek) - widx(a.closedWeek)).slice(0, 12);
  const C = S.D.contacts, info = S.E.contactListInfo(), counts = S.E.contactListCounts();
  const age = t => { const n = wi - widx(t.firstWeek) + 1; return n <= 1 ? '<span class="tag hot">new</span>' : `<span class="tag">open ${n} wks</span>`; };
  app().innerHTML = `<section class="head"><div><div class="eyebrow">All tracks · ${esc(lw || '')}</div><h1 class="h1">New contacts to find</h1></div></section>
    <section class="kpis glass" style="grid-template-columns:repeat(4,1fr)">${kpi('Open', fmt(open.length), '', `${st.length} stations, ${mk.length} markets`)}${kpi('New this week', fmt(newN), '', '')}${kpi('Carried over', fmt(open.length - newN), '', 'still open')}${kpi('Done', fmt(done.length), '', 'contact now on the list')}</section>
    <section class="cols"><div class="panel glass c8"><div class="ph"><h2>Stations</h2><span class="s">ranked by plays across all our tracks</span></div>
      ${st.length ? `<div class="tw"><table><thead><tr><th>#</th><th>Station</th><th>Market</th><th>Tracks</th><th class="r">Plays</th><th class="r">Status</th></tr></thead><tbody>${st.slice(0, S.view.allTasks ? st.length : 25).map((t, i) => `<tr><td class="num faint">${String(i + 1).padStart(2, '0')}</td><td><b>${esc(t.station)}</b></td><td class="muted">${esc(t.country)}</td><td class="muted" style="font-size:12px">${esc(t.tracks)}</td><td class="r num">${fmt(t.plays)}</td><td class="r">${age(t)}</td></tr>`).join('')}</tbody></table></div>${st.length > 25 ? `<button class="btn sm" id="moreTasks" style="margin-top:12px">${S.view.allTasks ? 'Show top 25' : 'Show all ' + st.length}</button>` : ''}` : '<div class="empty">Every station playing our tracks abroad has a contact.</div>'}</div>
    <div class="c4" style="display:grid;gap:14px;align-content:start">
      <div class="panel glass"><div class="ph"><h2>Contact list</h2><i class="dot ${C ? 'ok' : 'bad'}"></i></div>
        ${C ? `<a class="src" href="https://docs.google.com/spreadsheets/d/${esc((C.source && C.source.id) || SHEET_ID)}/edit" target="_blank" rel="noopener"><b>${esc(C.name)}</b><span>Google Sheet ↗</span></a>
        <dl class="dl"><dt>Contacts</dt><dd>${fmt(info && info.stations)}</dd><dt>Countries</dt><dd>${C.stats ? C.stats.countries : Object.keys(counts).length}</dd><dt>Sheet edited</dt><dd>${esc(((C.source && C.source.modified) || C.updated || '').slice(0, 10))}</dd><dt>Counts</dt><dd>Corectă + Neverificată</dd></dl>` : '<div class="empty">No list yet.</div>'}
        <div class="row" style="margin-top:12px"><button class="btn sm" id="syncC">Sync from sheet</button><label class="btn sm" id="dropC" style="cursor:pointer"><input type="file" accept=".xlsx" hidden id="fileC">Upload .xlsx</label></div></div>
      <div class="panel glass"><div class="ph"><h2>Markets to build</h2><span class="s">traction, no contact</span></div>${mk.length ? `<ul class="list">${mk.map(t => `<li><span class="x"><b>${esc(t.station)}</b><span>${esc(t.signal || t.tracks)}</span></span><span class="r">${age(t)}</span></li>`).join('')}</ul>` : '<div class="empty">None this week.</div>'}</div>
      <div class="panel glass"><div class="ph"><h2>Done recently</h2></div>${done.length ? `<ul class="list">${done.map(t => `<li><span class="x"><b>${esc(t.station)}</b><span>${esc(t.country)}</span></span><span class="r">${wk(t.closedWeek)}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing closed yet.</div>'}</div></div></section>`;
  $('#syncC').onclick = async () => { try { await S.store.dispatch('contacts-sync.yml'); toast(S.store.mode === 'demo' ? 'Preview: sync runs in the live app' : 'Syncing the contact list. About a minute.'); } catch (e){ toast(e.message, 5000); } };
  const mt = $('#moreTasks'); if (mt) mt.onclick = () => { S.view.allTasks = !S.view.allTasks; viewContacts(); };
  bindDrop('dropC', 'fileC', async files => {
    try {
      const X = await sheetjs(), wb = X.read(await files[0].arrayBuffer());
      const sheets = wb.SheetNames.map(n => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) }));
      const cls = C ? classifier(S.E, [C.header].concat(C.rows)) : null;
      const next = importContactWorkbook(sheets, { classify: cls, name: files[0].name.replace(/\.xlsx$/i, '') });
      if (!next.rows.length) throw new Error('No stations with a Corectă or Neverificată address were found in that file.');
      await S.store.commit([{ path: DATA.contacts, text: JSON.stringify(next, null, 1) }], `Contact list: ${next.stats.contacts} contacts, ${next.stats.countries} countries`);
      S.D.contacts = next; engine(); toast(`Contact list updated: ${next.stats.contacts} contacts`); viewContacts();
    } catch (e){ toast(e.message, 6000); }
  });
}

/* ---------------- Settings / connect ---------------- */
function viewSettings(){
  const c = savedConnection() || {};
  app().innerHTML = `<section class="head"><div><div class="eyebrow">Settings</div><h1 class="h1">Connection</h1><p class="lede">The numbers live in a private GitHub repository. Each person connects once per device with their own access token.</p></div></section>
    <section class="cols"><form class="panel glass form c6" id="connForm"><label>Owner<input id="cOwner" value="${esc(c.owner || 'rotonappscript-droid')}" autocomplete="off"></label>
      <label>Data repository<input id="cRepo" value="${esc(c.repo || 'roton-stats-data')}" autocomplete="off"></label>
      <label>Access token<input id="cToken" type="password" value="${esc(c.token || '')}" placeholder="github_pat_…" autocomplete="off"></label>
      <div class="row"><button class="btn primary" type="submit">Connect</button>${c.token ? '<button class="btn" type="button" id="cOut">Disconnect this device</button>' : ''}</div></form>
    <div class="panel glass c6"><div class="ph"><h2>Making a token</h2></div><ol class="muted" style="margin:0;padding-left:18px;line-height:1.8">
      <li>GitHub › Settings › Developer settings › Fine-grained tokens › Generate new token.</li><li>Repository access: only <b>roton-stats-data</b>.</li>
      <li>Permissions: Contents <b>Read and write</b>, Actions <b>Read and write</b>.</li><li>Paste it here. It stays in this browser only.</li></ol></div></section>`;
  $('#connForm').onsubmit = async e => { e.preventDefault();
    const conn = { owner: $('#cOwner').value.trim(), repo: $('#cRepo').value.trim(), token: $('#cToken').value.trim() };
    try { const st = new GitHubStore(conn); await st.check(); saveConnection(conn); location.hash = 'tracks'; location.reload(); } catch (err){ toast(err.message, 6000); } };
  const out = $('#cOut'); if (out) out.onclick = () => { saveConnection(null); location.reload(); };
}

/* ---------------- boot ---------------- */
async function boot(){
  const conn = savedConnection();
  if (window.__DEMO__ && !conn) S.store = new DemoStore(window.__DEMO__);
  else if (conn) S.store = new GitHubStore(conn);
  else { S.store = new DemoStore({}); }
  try { await load(); } catch (e){ (document.getElementById('root') || document.body).innerHTML = `<main><section class="panel glass"><h2>Could not load the data</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="localStorage.clear();location.reload()">Reset connection</button></section></main>`; return; }
  shell();
  if (S.store.mode === 'demo' && !window.__DEMO__) location.hash = 'connect';
  window.addEventListener('hashchange', route); route();
}
boot();
