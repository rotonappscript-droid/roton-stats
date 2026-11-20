// Minimal stand-ins for the Apps Script services the legacy rules use.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function pad(n){ return (n < 10 ? '0' : '') + n; }

export function parseCsv(text){
  const rows = []; let row = [], cell = '', q = false, i = 0;
  text = String(text || '').replace(/^﻿/, '');
  while (i < text.length){
    const c = text[i];
    if (q){
      if (c === '"'){ if (text[i+1] === '"'){ cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"'){ q = true; i++; continue; }
    if (c === ','){ row.push(cell); cell = ''; i++; continue; }
    if (c === '\r'){ i++; continue; }
    if (c === '\n'){ row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length){ row.push(cell); rows.push(row); }
  return rows;
}

// Only the patterns the rules use: yyyy-MM-dd, dd MMM, d MMM yyyy. Always UTC (the rules pass 'GMT').
export function formatDate(d, tz, fmt){
  d = new Date(d);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate();
  return String(fmt)
    .replace('yyyy', Y).replace('MMM', MONTHS[M]).replace('MM', pad(M + 1))
    .replace('dd', pad(D)).replace(/\bd\b/, D);
}

const SHIM = {
  Utilities: { parseCsv, formatDate },
  Logger: { log(){ if (typeof process !== 'undefined' && process.env && process.env.DEBUG) console.log.apply(console, arguments); } },
};

// Roton Stats rules engine.
// Ported verbatim from the Apps Script app (Reports.gs, Render.gs, Templates.gs, Assets.gs, Code.gs), Nov 2026, so every
// rule built there (station tiers, new adds, response rate, Expand / Follow up, New contacts to find, partner report)
// behaves exactly as before. The part at the end ("overrides") replaces Sheets/Drive with the JSON database.
// Runs unchanged in the browser and in Node. This file is now the source of truth: edit it here.
export function createEngine(DB){
"use strict";
var Utilities = SHIM.Utilities, Logger = SHIM.Logger;
const FRESH_MIN_DAYS = 7;   // a track needs 7 full days of data before it can be auto-updated
const COUNTRIES = [
 'Afghanistan','Albania','Algeria','Angola','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahrain','Bangladesh','Belarus','Belgium','Bolivia','Bosnia and Herzegovina','Brazil','Bulgaria','Cambodia','Cameroon','Canada','Chile','China','Colombia','Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Dominican Republic','Ecuador','Egypt','El Salvador','Estonia','Ethiopia','Finland','France','Georgia','Germany','Ghana','Greece','Guatemala','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kuwait','Latvia','Lebanon','Libya','Lithuania','Luxembourg','Malaysia','Malta','Mexico','Moldova','Mongolia','Montenegro','Morocco','Netherlands','New Zealand','Nigeria','North Macedonia','Norway','Oman','Pakistan','Panama','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Saudi Arabia','Senegal','Serbia','Singapore','Slovakia','Slovenia','South Africa','South Korea','Spain','Sri Lanka','Sweden','Switzerland','Syria','Taiwan','Tanzania','Thailand','Tunisia','Turkey','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];
const DJPOOLS_SEED = ['Trackstacks','Good to Stand Out','Relish','Music Worx','Nordics DJ Pool','Germany DDP DJ Pool','France BUZZ Chart + Les Hits Des Clubs'];
function isoWeek_(d){ var date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); var day=(date.getUTCDay()+6)%7; date.setUTCDate(date.getUTCDate()-day+3); var f=new Date(Date.UTC(date.getUTCFullYear(),0,4)); var fd=(f.getUTCDay()+6)%7; f.setUTCDate(f.getUTCDate()-fd+3); return {week:1+Math.round((date-f)/(7*864e5)),year:date.getUTCFullYear()}; }
function currentWeekLabel_(){ var w=isoWeek_(new Date()); return 'Week '+w.week+' '+w.year; }
function weekIndex_(l){ if(!l)return -1; var m=String(l).match(/Week\s+(\d+)\s+(\d+)/i); return m?parseInt(m[2],10)*53+parseInt(m[1],10):-1; }

/* ---------- release dates ----------
 * A track is "upcoming" until its go-live date. Reporting weeks run Mon-Fri, so a
 * Saturday/Sunday release is treated as landing the following Monday — that way a
 * track never shows up before it is out, and its first report week is a full one.
 */
function parseYMD_(v){
  if(v===''||v==null) return null;
  if(Object.prototype.toString.call(v)==='[object Date]') return isNaN(v)?null:new Date(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate()));
  var m=String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if(!m) return null;
  return new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
}
function ymd_(d){ return d?Utilities.formatDate(d,'GMT','yyyy-MM-dd'):''; }
function goLiveDate_(rel){ if(!rel) return null; var d=new Date(rel.getTime()), dow=d.getUTCDay();
  if(dow===6) d.setUTCDate(d.getUTCDate()+2);        // Saturday -> Monday
  else if(dow===0) d.setUTCDate(d.getUTCDate()+1);   // Sunday   -> Monday
  return d; }
function weekLabelFor_(d){ var w=isoWeek_(d); return 'Week '+w.week+' '+w.year; }
function releaseInfo_(s){
  var rel=parseYMD_(s.releaseDate);
  if(!rel) return {upcoming:false,releaseDate:'',goLive:'',daysToRelease:null,releaseWeek:'',daysSinceRelease:null,tooFresh:false};
  var live=goLiveDate_(rel), t=todayUTC_();
  var up = live.getTime()>t.getTime();
  var since = Math.floor((t.getTime()-live.getTime())/864e5);   // full days since it went live
  return { upcoming: up, releaseDate:ymd_(rel), goLive:ymd_(live),
           daysToRelease: Math.round((rel.getTime()-t.getTime())/864e5), releaseWeek: weekLabelFor_(live),
           daysSinceRelease: up?null:since,
           tooFresh: (!up && since < FRESH_MIN_DAYS) };
}

/* ---------- focus territories: waves + sent ----------
 * focusTerritories stays a plain array of names (the report renderer reads it),
 * terrMeta holds {name:{wave:1|2|3, sent:true/false}} alongside it. wave 3 = "Extra".
 */
var WAVES=[1,2,3];
function waveOf_(m){ var w=m&&m.wave?parseInt(m.wave,10):1; return (w===2||w===3)?w:1; }
// accepts ['Romania',...] or [{name,wave,sent},...] and returns both shapes
function normTerritories_(list, prevMeta){
  var names=[], meta={};
  (list||[]).forEach(function(x){
    var nm = (typeof x==='string') ? x : (x&&x.name)||'';
    nm=String(nm).trim(); if(!nm||names.indexOf(nm)>=0) return;
    var prev=(prevMeta||{})[nm]||{};
    var wave = (typeof x==='object'&&x&&x.wave!=null) ? waveOf_(x) : waveOf_(prev);
    var sent = (typeof x==='object'&&x&&x.sent!=null) ? !!x.sent : !!prev.sent;
    names.push(nm); meta[nm]={wave:wave,sent:sent};
  });
  names.sort(function(a,b){ var d=meta[a].wave-meta[b].wave; return d!==0?d:(a<b?-1:1); });
  return {names:names, meta:meta};
}
function territoryList_(s){ var m=s.terrMeta||{}; return (s.focusTerritories||[]).map(function(n){ var x=m[n]||{}; return {name:n, wave:waveOf_(x), sent:!!x.sent}; }); }
// one-off: everything already in the app becomes Wave 1 and counts as already sent
function pj_(v,f){ if(v===''||v==null)return f; try{return JSON.parse(v);}catch(e){return f;} }
function norm_(s){ return String(s||'').replace(/[’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase(); }
function num_(s){
  if (s === null || s === undefined) return null;
  s = String(s).trim().replace(/,/g,'');
  if (s === '' || s === '-' || s === 'N/A') return null;
  s = s.replace(/^#/,'').replace(/\+$/,'');
  var m = s.match(/^([0-9.]+)\s*([KMB%]?)$/);
  if (!m) return null;
  var v = parseFloat(m[1]), u = m[2];
  return u==='K'?v*1e3 : u==='M'?v*1e6 : u==='B'?v*1e9 : v;
}
function human_(n){
  if (n === null || n === undefined) return '—';
  n = Number(n);
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2).replace(/\.00$/,'')+'M';
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return String(Math.round(n));
}
function isum_(rows, colIdx){ var s=0; for (var i=1;i<rows.length;i++){ var v=num_(rows[i][colIdx]); if(v!=null) s+=v; } return s; }
function colIndex_(header, name){ for (var i=0;i<header.length;i++){ if (String(header[i]).trim().toLowerCase()===name.toLowerCase()) return i; } return -1; }

/* ---------- find the latest week folder ---------- */
function streamStats_(text){
  if (!text) return {};
  var rows = Utilities.parseCsv(text);
  var data = [];
  for (var i=1;i<rows.length;i++){
    var d = String(rows[i][0]||'').trim();
    var v = parseInt(String(rows[i][1]||'').trim(),10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(v)) data.push([d, v]);
  }
  if (!data.length) return {};
  data.sort(function(a,b){ return a[0]<b[0]?-1:1; });
  var last = data[data.length-1][0];
  var lastMs = new Date(last).getTime();
  function windowSum(a,b){ var s=0; for (var i=0;i<data.length;i++){ var diff=Math.round((lastMs-new Date(data[i][0]).getTime())/86400000); if (diff>=a && diff<=b) s+=data[i][1]; } return s; }
  var total=0; for (var j=0;j<data.length;j++) total+=data[j][1];
  var last7=windowSum(0,6), prev7=windowSum(7,13);
  return { total: total, last7: last7, avg_day: last7/7, avg_day_prev: prev7/7, as_of: last };
}

/* ---------- radiomonitor airplay for a track ---------- */
function radioMonitor_(text, trackDisplay){
  if (!text) return [];
  var rows = Utilities.parseCsv(text);
  var header = rows[0]; var want = norm_(trackDisplay);
  for (var i=1;i<rows.length;i++){
    if (norm_(rows[i][1]) === want || norm_(rows[i][1]).indexOf(want)>=0 || want.indexOf(norm_(rows[i][1]))>=0){
      var out=[];
      for (var c=2;c<header.length;c++){
        var val = String(rows[i][c]||'').trim();
        if (val && val !== '-'){ var p=parseInt(val,10); if(!isNaN(p)) out.push([String(header[c]).trim(), p]); }
      }
      out.sort(function(a,b){ return a[1]-b[1]; });   // best (lowest) first
      return out;
    }
  }
  return [];
}

/* ---------- compute facts for one track ---------- */
function computeFacts_(display, tl, sections, radiomonText){
  var F = { title: display, has_radio: false };
  var st = streamStats_(tl);
  F.total_streams = st.total || null; F.last7 = st.last7 || null;
  F.avg_day = st.avg_day || null; F.avg_day_prev = st.avg_day_prev || null;

  function rows(sec){ return sections && sections[sec] ? sections[sec] : null; }

  // radio
  var rr = rows('Radiostats Radio');
  if (rr && rr.length > 1){
    F.has_radio = true;
    var h = rr[0], ip=colIndex_(h,'Plays'), ic=colIndex_(h,'Country'), ist=colIndex_(h,'Station'), ifp=colIndex_(h,'First Play'), icity=colIndex_(h,'City');
    var plays=0, mk={}, stations=0, newAdds=0, cut=todayUTC_();  // FIX: anchor "new adds" to today, not the (lagging) streams as_of
    for (var i=1;i<rr.length;i++){
      var p = parseInt(String(rr[i][ip]||'').replace(/,/g,''),10) || 0;
      plays += p; stations++;
      var ctry = String(rr[i][ic]||'').trim() || 'Unknown'; mk[ctry]=(mk[ctry]||0)+p;
      var fp = parseDate_(rr[i][ifp]); if (fp && (cut-fp)/86400000 <= 7 && (cut-fp)>=0) newAdds++;
    }
    F.radio_plays = plays; F.radio_stations = stations; F.new_adds = newAdds;
    F.markets = Object.keys(mk).map(function(k){return [k,mk[k]];}).filter(function(x){return x[1]>0 && x[0]!=='Unknown';}).sort(function(a,b){return b[1]-a[1];}).slice(0,10);
    F.countries_on_air = Object.keys(mk).filter(function(k){return k!=='Unknown';}).length;
  } else { F.radio_plays=null; F.radio_stations=null; F.markets=[]; }

  // playlists (Spotify)
  var pl = rows('Spotify Playlists');
  if (pl && pl.length>1){
    var ph=pl[0], ifol=colIndex_(ph,'Followers'), irem=colIndex_(ph,'Removed');
    var reach=0, cur=0, tot=0;
    for (var k=1;k<pl.length;k++){ var fo=num_(pl[k][ifol]); if(fo){reach+=fo;} tot++; var rv=String(pl[k][irem<0?0:irem]||'').replace(/^'+/,'').trim(); if (irem<0 || rv===''||rv==='-') cur++; }   // FIX: Songstats writes "'-" for still-current
    F.reach=reach; F.playlists_cur=cur; F.playlists_total=tot;
  } else { F.reach=null; F.playlists_cur=0; F.playlists_total=0; }

  // shazam
  var sh = rows('Shazam Charts'); F.shazam_rows = 0;   // FIX: count only charts with a current position ("'-" = not charting now)
  if (sh && sh.length>1){ var isc=colIndex_(sh[0],'Current'); for (var z=1;z<sh.length;z++){ var cv=String(isc>=0?sh[z][isc]:'').replace(/^'+/,'').trim(); if (cv && cv!=='-') F.shazam_rows++; } }

  // social
  F.tk_views = sumCol_(rows('TikTok Top Videos'), 'Views');
  F.ig_views = sumCol_(rows('Instagram Top Reels'), 'Views');
  F.yt_views = sumCol_(rows('YouTube Videos'), 'Views');
  F.combined = (F.total_streams||0) + (F.yt_views||0);

  // airplay
  F.airplay = radioMonitor_(radiomonText, display);
  return F;
}
function sumCol_(rows, name){ if(!rows||rows.length<2) return null; var idx=colIndex_(rows[0],name); if(idx<0) return null; return isum_(rows, idx); }
function parseDate_(s){
  s=String(s||'').trim(); if(!s) return null;
  var m=s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/); if(!m) return null;
  var mo={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11}[m[2].toLowerCase()];
  if(mo===undefined) return null;
  // FIX: build at UTC midnight so it matches Utilities.formatDate(..,'GMT',..) and the
  // (cut-fp) day math. Previously new Date(y,mo,d) used the script tz (Europe/Bucharest,
  // UTC+3), which rendered every First Play one day earlier than Songstats.
  return new Date(Date.UTC(parseInt(m[3]),mo,parseInt(m[1])));
}
// Report run date at UTC midnight — anchor for the "last 7 days" radio window.
function todayUTC_(){ var n=new Date(); return new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate())); }

/* ---------- STAGE-1 TEST: print facts for every track ---------- */
var T_STREAM = 5, T_REACH = 10, T_RADIO = 12, T_SHAZAM = 10, COOLING = 15;
var GREEN_BADGE_MIN = 5;   // radio row shows green badge at 5+ plays

// Optional: pin the streaming baseline to the week ENDING this date. Leave '' for
// normal comparison (previous folder → stored snapshot → the timeline's own prior 7 days).
var BASELINE_END_DATE = '';
var BASELINE_LABEL = '';
function baselineAvg_(tl, endStr){
  if(!tl||!endStr) return null;
  var rows=Utilities.parseCsv(tl), end=new Date(endStr).getTime(), s=0, n=0;
  for(var i=1;i<rows.length;i++){ var d=String(rows[i][0]||'').trim(), v=parseInt(rows[i][1],10);
    if(/^\d{4}-\d{2}-\d{2}$/.test(d)&&!isNaN(v)){ var diff=(end-new Date(d).getTime())/86400000; if(diff>=0&&diff<=6){s+=v;n++;} } }
  return n?s/7:null;
}
// the "appscript" folder = parent of the DATA folder. Reports go into appscript/<folder name>.
function weekNum_(name){ var m=String(name||'').match(/W\s*0*(\d+)|Week\s+0*(\d+)/i); return m?parseInt(m[1]||m[2],10):null; }
// proper report label from a folder: "W27"->"Week 27 2026", "W28 - 6 Jul"->"Week 28 2026 (6 Jul)", "DATA 2 July"->ISO week of its date
function reportWeekLabel_(folder){
  var name=folder.getName(), yr=folder.getDateCreated().getFullYear();
  var m=name.match(/(?:W\s*|Week\s+)0*(\d+)/i);
  if(m){ var rest=name.slice(m.index+m[0].length).replace(/^[\s\-–—]+/,'').trim(); return 'Week '+parseInt(m[1],10)+' '+yr+(rest?(' ('+rest+')'):''); }
  return weekLabelFromDate_(folder.getDateCreated());
}
function esc_(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function weekLabelFromDate_(d){
  var date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  var day=(date.getUTCDay()+6)%7; date.setUTCDate(date.getUTCDate()-day+3);
  var f=new Date(Date.UTC(date.getUTCFullYear(),0,4)); var fd=(f.getUTCDay()+6)%7; f.setUTCDate(f.getUTCDate()-fd+3);
  return 'Week '+(1+Math.round((date-f)/(7*864e5)))+' '+date.getUTCFullYear();
}
function shortW_(w){ var m=String(w||'').match(/Week\s+(\d+)/i); return m?('W'+m[1]):String(w||''); }

/* ---------- important radios (editable Sheet) + station relevance ---------- */
var IMPORTANT_SEED = [
 ["Romania","Kiss FM",1],["Romania","Radio România Actualități",1],["Romania","Virgin Radio",1],["Romania","Radio ZU",1],["Romania","Pro FM",2],["Romania","Digi FM",2],["Romania","Europa FM",2],["Romania","Magic FM",2],["Romania","Dance FM",2],
 ["France","NRJ",1],["France","Fun Radio",1],["France","Skyrock",1],["France","Europe 2",1],["France","RTL2",1],["France","Nostalgie",1],["France","Chérie FM",2],["France","RFM",2],["France","Radio FG",2],["France","Mouv'",2],["France","Voltage",2],["France","Générations",2],["France","Ado FM",2],["France","Latina",2],
 ["Germany","1LIVE",1],["Germany","SWR3",1],["Germany","Bayern 3",1],["Germany","NDR 2",1],["Germany","WDR 2",1],["Germany","hr3",1],["Germany","Antenne Bayern",1],["Germany","MDR Jump",2],["Germany","bigFM",2],["Germany","ENERGY",2],["Germany","RPR1",2],["Germany","planet radio",2],["Germany","Hit Radio FFH",2],["Germany","Radio NRW",2],["Germany","SWR1",2],
 ["Italy","RTL 102.5",1],["Italy","Radio Deejay",1],["Italy","Radio 105",1],["Italy","RDS",1],["Italy","Radio Italia",1],["Italy","Radio Kiss Kiss",2],["Italy","Radio 101",2],["Italy","Radio Zeta",2],["Italy","m2o",2],["Italy","Radio Capital",2],["Italy","Radio Subasio",2],["Italy","Virgin Radio",2],
 ["United Kingdom","BBC Radio 1",1],["United Kingdom","Capital",1],["United Kingdom","Heart",1],["United Kingdom","BBC Radio 2",1],["United Kingdom","Kiss",1],["United Kingdom","Hits Radio",2],["United Kingdom","Capital Dance",2],["United Kingdom","BBC Radio 1Xtra",2],["United Kingdom","Kisstory",2],["United Kingdom","Magic Radio",2],["United Kingdom","Virgin Radio UK",2],["United Kingdom","Absolute Radio",2],
 ["Spain","Los 40",1],["Spain","Cadena 100",1],["Spain","Europa FM",1],["Spain","Cadena Dial",1],["Spain","Los 40 Dance",2],["Spain","Los 40 Urban",2],["Spain","Máxima FM",2],["Spain","Flaix FM",2],["Spain","Kiss FM",2],["Spain","M80 Radio",2],["Spain","Rock FM",2],
 ["Netherlands","Qmusic",1],["Netherlands","Radio 538",1],["Netherlands","NPO 3FM",1],["Netherlands","NPO Radio 2",1],["Netherlands","Sky Radio",2],["Netherlands","Radio Veronica",2],["Netherlands","SLAM!",2],["Netherlands","100% NL",2],["Netherlands","Radio 10",2],
 ["Belgium","Qmusic",1],["Belgium","MNM",1],["Belgium","Radio Contact",1],["Belgium","NRJ",1],["Belgium","Studio Brussel",2],["Belgium","Nostalgie",2],["Belgium","Joe",2],["Belgium","Fun Radio",2],
 ["Poland","RMF FM",1],["Poland","Radio Zet",1],["Poland","Eska",1],["Poland","RMF Maxxx",2],["Poland","Radio Zet Chilli",2],["Poland","Antyradio",2],["Poland","Vox FM",2],["Poland","PR Trójka",2],
 ["Greece","Sfera",1],["Greece","Rythmos 94.9",1],["Greece","Dromos FM",1],["Greece","En Lefko 87.7",2],["Greece","Best 92.6",2],["Greece","Kiss FM",2],
 ["Sweden","Rix FM",1],["Sweden","Mix Megapol",1],["Sweden","NRJ",1],["Sweden","Sveriges Radio P3",1],["Sweden","Lugna Favoriter",2],["Sweden","Bandit Rock",2],["Sweden","Star FM",2],["Sweden","The Voice",2],
 ["Norway","NRK P3",1],["Norway","P4",1],["Norway","Radio Norge",1],["Norway","NRJ",1],["Norway","P5 Hits",2],["Norway","The Beat",2],["Norway","NRK mP3",2],
 ["Denmark","The Voice",1],["Denmark","NOVA",1],["Denmark","DR P3",1],["Denmark","Radio 100",2],["Denmark","Pop FM",2],["Denmark","Radio ABC",2],
 ["Finland","Radio Suomipop",1],["Finland","NRJ",1],["Finland","YleX",1],["Finland","Radio Nova",1],["Finland","Loop",2],["Finland","Kiss FM",2],["Finland","Groove FM",2],
 ["Austria","Ö3",1],["Austria","Kronehit",1],["Austria","Energy Wien",1],["Austria","Radio 88.6",2],["Austria","Radio Arabella",2],["Austria","Antenne Steiermark",2],
 ["Switzerland","SRF 3",1],["Switzerland","Energy Zürich",1],["Switzerland","Radio 24",1],["Switzerland","Planet 105",2],["Switzerland","Rouge FM",2],["Switzerland","One FM",2],["Switzerland","Couleur 3",2],
 ["Portugal","RFM",1],["Portugal","Rádio Comercial",1],["Portugal","Cidade FM",1],["Portugal","Mega Hits",1],["Portugal","M80",2],["Portugal","Nova Era",2],
 ["Ireland","RTÉ 2FM",1],["Ireland","Today FM",1],["Ireland","SPIN 1038",1],["Ireland","FM104",2],["Ireland","iRadio",2],["Ireland","Beat 102-103",2],["Ireland","Cork's Red FM",2],
 ["Czech Republic","Evropa 2",1],["Czech Republic","Rádio Kiss",1],["Czech Republic","Fajn Rádio",1],["Czech Republic","Rádio Blaník",2],["Czech Republic","Rádio Impuls",2],["Czech Republic","Frekvence 1",2],["Czech Republic","Hitrádio",2],
 ["Slovakia","Fun Rádio",1],["Slovakia","Rádio Expres",1],["Slovakia","Europa 2",1],["Slovakia","Rádio Vlna",2],["Slovakia","Rádio Melody",2],["Slovakia","Rádio Jemné",2],
 ["Hungary","Rádió 1",1],["Hungary","Petőfi Rádió",1],["Hungary","Retró Rádió",1],["Hungary","Best FM",2],["Hungary","Sláger FM",2],["Hungary","Music FM",2],["Hungary","Danubius Rádió",2],
 ["Bulgaria","N-JOY",1],["Bulgaria","The Voice",1],["Bulgaria","Radio City",1],["Bulgaria","BG Radio",1],["Bulgaria","Radio Energy",2],["Bulgaria","Radio Fresh",2],["Bulgaria","Radio Nova",2],["Bulgaria","Z-Rock",2],
 ["Serbia","Naxi Radio",1],["Serbia","Radio S",1],["Serbia","Hit FM",1],["Serbia","Play Radio",1],["Serbia","TDI Radio",2],["Serbia","Radio Roadstar",2],["Serbia","Radio Fokus",2],["Serbia","Radio AS FM",2],
 ["Croatia","Otvoreni Radio",1],["Croatia","Antena Zagreb",1],["Croatia","Narodni Radio",1],["Croatia","HR Top 40",1],["Croatia","Radio Dalmacija",2],["Croatia","Enter Zagreb",2],["Croatia","Extra FM",2],
 ["Ukraine","Hit FM",1],["Ukraine","Lux FM",1],["Ukraine","Kiss FM",1],["Ukraine","Radio ROKS",1],["Ukraine","Radio ENERGY",2],["Ukraine","Radio Maximum",2],["Ukraine","Bayraktar FM",2],["Ukraine","Nashe Radio",2],
 ["Russia","Europa Plus",1],["Russia","Russkoe Radio",1],["Russia","Love Radio",1],["Russia","DFM",1],["Russia","Novoe Radio",1],["Russia","Radio ENERGY",2],["Russia","Hit FM",2],["Russia","Retro FM",2],["Russia","Avtoradio",2],["Russia","Radio Record",2],
 ["Moldova","Kiss FM",1],["Moldova","Hit FM",1],["Moldova","Radio Noroc",1],["Moldova","Love Radio",2],["Moldova","Radio ZUM",2],["Moldova","Muz FM",2],
 ["Turkey","Power FM",1],["Turkey","Kral FM",1],["Turkey","Metro FM",1],["Turkey","Number1 FM",1],["Turkey","Virgin Radio",2],["Turkey","Kral Pop",2],["Turkey","Radyo Fenomen",2],["Turkey","Slow Türk",2],["Turkey","Joy FM",2]
];
var REG_HEADERS = ['Country','Station','Tier (1=top, 2=relevant, 3=minor/local, blank=unrated)','Aliases (; separated)','Note'];
var HOME_MARKET = 'Romania';
var REGISTRY_SEED_V2 = [
 ['Romania','Radio România București',3,'Radio Bukuresti; SRR Bucuresti; Radio Romania Bucuresti FM; Bucuresti FM','regional public'],
 ['Romania','Radio România Regional',3,'Radio Cluj; Radio Iasi; Radio Craiova; Radio Timisoara; Radio Constanta; Radio Targu Mures; Radio Resita; Radio Vacanta; Radio Antena Brasovului; Radio Antena Satelor','regional public network'],
 ['Romania','Radio România Muzical',3,'','public'],
 ['Romania','Radio România Cultural',3,'','public'],
 ['Romania','Radio România Internațional',3,'','public'],
 ['France','Europe 2',1,'Virgin Radio; Virgin Radio France','ex-Virgin Radio France — rebranded'],
 ['France','Radio Scoop',3,'','regional network — change tier if needed'],
 ['France','Alouette',2,'','regional network'],
 ['France','Virage Radio',3,'','regional network — change tier if needed'],
 ['France','Hit West',3,'','regional network — change tier if needed'],
 ['France','Radio Espace',3,'','regional network — change tier if needed'],
 ['France','Tendance Ouest',3,'','regional network — change tier if needed'],
 ['France','Contact FM',3,'','regional network — change tier if needed'],
 ['France','Swigg',3,'','regional network — change tier if needed']
];
var RENAMED = [{country:'France', from:'Virgin Radio', to:'Europe 2', alias:'Virgin Radio; Virgin Radio France', note:'ex-Virgin Radio France — rebranded'}];
function fold_(s){ return String(s||'').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]','g'),'').toLowerCase().replace(/\s+/g,' ').trim(); }   // fold diacritics: "Petofi"
function nk_(s){ return fold_(s).replace(/[^a-z0-9]/g,''); }   // strip spaces/punct too so "ProFM" == "Pro FM"
function wordBounded_(hay, needle){ if(!needle) return false; var i=hay.indexOf(needle); while(i>=0){ var b=i===0?' ':hay.charAt(i-1), a=(i+needle.length>=hay.length)?' ':hay.charAt(i+needle.length); if(/[^a-z0-9]/.test(b)&&/[^a-z0-9]/.test(a)) return true; i=hay.indexOf(needle,i+1); } return false; }
var CTRY_ALIAS = {'czechia':'czech republic','uk':'united kingdom','great britain':'united kingdom','russian federation':'russia','moldova, republic of':'moldova','republic of moldova':'moldova','turkiye':'turkey','the netherlands':'netherlands'};
function ctryKey_(c){ var f=fold_(c); return CTRY_ALIAS[f]||f; }
// registry entry for a raw station name: exact (after stripping) wins, else the LONGEST whole-word name/alias match
function registryMatch_(station, country, map){ var arr=map[ctryKey_(country)]; if(!arr) return null; var sn=fold_(station), sk=nk_(station); if(sk.length<2) return null;
  var best=null, bestLen=0;
  for(var i=0;i<arr.length;i++){ var e=arr[i]; for(var j=0;j<e.needles.length;j++){ var nd=e.needles[j];
    if(sk===nd.k) return e;
    if(nd.f.length>bestLen && wordBounded_(sn,nd.f)){ best=e; bestLen=nd.f.length; } } }
  return best; }
function stationImportance_(station, country, map){ var e=registryMatch_(station,country,map); return (e&&(e.tier===1||e.tier===2))?e.tier:0; }
// fallback identity for stations not in the registry: drop frequencies, "fm"/"radio", and the city, so feeds of one station collapse
function autoKey_(station, city){ var f=' '+fold_(station)+' '; f=f.replace(/\b\d{2,3}([.,]\d{1,2})?\b/g,' ').replace(/\b(fm|am|mhz|radio|radyo|radiou)\b/g,' ');
  var c=fold_(city); if(c.length>=3) f=f.split(c).join(' '); var k=f.replace(/[^a-z0-9]/g,''); return k.length>=2?k:nk_(station); }
function firstStreamDate_(tl){ if(!tl) return null; var rows=Utilities.parseCsv(tl); for(var i=1;i<rows.length;i++){ var d=String(rows[i][0]||'').trim(), v=parseInt(rows[i][1],10); if(/^\d{4}-\d{2}-\d{2}$/.test(d) && v>0) return new Date(d); } return null; }
var TIER_W = {1:1.6, 2:1.25, 0:1.0, 3:0.5};   // weight of a play by station class
function stScore_(s){ return (s.plays||0)*(TIER_W[s.tier]||1) + (s.tier===1?30:0); }
function cityOf_(loc, country){ var l=String(loc||''), i=l.lastIndexOf(' · '); return i>=0?l.slice(0,i):(fold_(l)===fold_(country)?'':l); }

// Merge raw Radiostats rows into real stations (registry match → auto key), then classify.
// Produces F.stations_c (canonical, sorted by plays), F.new_major / F.new_minor (new STATIONS this week, not new feeds),
// and F.by_market (key stations per market: home capped, international surfaced).
function rankStations_(F, focusTerr){
  var map=importantMap_();
  if (F.all_stations && F.all_stations.length){
    var g={}, winStart=(F.radio_cut||todayUTC_().getTime())-7*864e5;
    F.all_stations.forEach(function(s){ var e=registryMatch_(s.station,s.country,map), city=cityOf_(s.location,s.country);
      var key=ctryKey_(s.country)+'|'+(e?('R:'+nk_(e.n)):('A:'+autoKey_(s.station,city)));
      var c=g[key]; if(!c){ c=g[key]={station:e?e.n:s.station, country:s.country, tier:e?e.tier:0, rated:!!e, plays:0, feeds:0, cities:{}, fp:null, top:-1, rawNames:{}}; }
      c.plays+=(s.plays||0); c.feeds++; if(city) c.cities[city]=1; c.rawNames[s.station]=1;
      if(!e && (s.plays||0)>c.top){ c.top=s.plays||0; c.station=s.station; }
      if(s.fp!=null && (c.fp==null || s.fp<c.fp)) c.fp=s.fp;
      if(e && e.tier>0){ s.tier=(e.tier===1||e.tier===2)?e.tier:0; } else s.tier=0; });
    F.stations_c=Object.keys(g).map(function(k){ var c=g[k], cs=Object.keys(c.cities);
      var loc=(c.feeds>1 ? (c.feeds+' feeds · ') : (cs[0]?cs[0]+' · ':''))+c.country;
      return {station:c.station, names:Object.keys(c.rawNames).slice(0,8), country:c.country, location:loc, plays:c.plays, feeds:c.feeds, tier:c.tier, rated:c.rated,
              isNew:(c.fp!=null && c.fp>=winStart), first:(c.fp!=null?Utilities.formatDate(new Date(c.fp),'GMT','dd MMM'):'')}; })
      .sort(function(a,b){return b.plays-a.plays;});
  }
  var S=F.stations_c||[];
  // NEW this week = the station itself is new (a new feed of a station already on air doesn't count)
  var newAll=S.filter(function(s){return s.isNew;});
  function major(s){ return s.tier===1 || s.tier===2 || (s.tier===0 && s.plays>=GREEN_BADGE_MIN); }
  F.new_major=newAll.filter(major).sort(function(a,b){return stScore_(b)-stScore_(a);}).slice(0,6);
  F.new_minor=newAll.filter(function(s){return !major(s);}).sort(function(a,b){return b.plays-a.plays;});
  F.new_adds=newAll.length; F.new_major_n=newAll.filter(major).length;
  // key stations by market: home capped at 3, each other market top 2 (+ a top-tier station on test spins), max 6 markets / 14 rows
  var mk={}; S.forEach(function(s){ var k=ctryKey_(s.country); (mk[k]=mk[k]||{name:s.country,plays:0,list:[]}); mk[k].plays+=s.plays; mk[k].list.push(s); });
  var home=ctryKey_(HOME_MARKET), order=Object.keys(mk).filter(function(k){return mk[k].name && fold_(mk[k].name)!=='unknown' && mk[k].plays>0;}).sort(function(a,b){return mk[b].plays-mk[a].plays;});
  var rows=[], abroad=0, CAP=14;
  function pick(k, n){ var L=mk[k].list.slice().sort(function(a,b){return stScore_(b)-stScore_(a);}), out=L.slice(0,n);
    var t1=L.filter(function(s){return s.tier===1 && out.indexOf(s)<0;})[0]; if(t1 && k!==home) out.push(t1); return out; }
  if (mk[home]) pick(home,3).forEach(function(s,i){ rows.push({market:i===0?mk[home].name:'', mplays:i===0?mk[home].plays:null, s:s}); });
  order.forEach(function(k){ if(k===home || abroad>=6 || rows.length>=CAP || mk[k].plays<10) return; abroad++;
    pick(k,2).forEach(function(s,i){ if(rows.length<CAP) rows.push({market:i===0?mk[k].name:'', mplays:i===0?mk[k].plays:null, s:s}); }); });
  F.by_market=rows;
  // biggest driver outside the home market, for the one-read
  var ab=order.filter(function(k){return k!==home;})[0];
  F.intl_driver = ab ? {market:mk[ab].name, plays:mk[ab].plays, lead:(mk[ab].list.slice().sort(function(a,b){return stScore_(b)-stScore_(a);})[0]||{}).station||''} : null;
  // unrated stations that matter → queued for the registry (blank tier) so they get classified
  S.forEach(function(s){ if(s.rated) return; var lead=rows.some(function(r){return r.s===s;});
    if(s.plays>=15 || lead) queueToClassify_(s, F.title); });
}
var AIRPLAY_MANUAL_SEED = [
 ['Sugar Daddy','Hungary','17','3','42','200'],
 ['Sugar Daddy','Bulgaria','N/A','128','6','200'],
 ['Sugar Daddy','Russia','N/A','104','7','200'],
 ['Queen In Puerto Rico','Romania','24','7','17','200'],
 ["Don't Leave (Kylie)",'Romania','N/A','2','49','200'],
 ["Don't Leave (Kylie)",'Russia','84','1','47','100'],
 ["Don't Leave (Kylie)",'Hungary','15','3','56','100'],
 ["Don't Leave (Kylie)",'Finland','N/A','3','35','100'],
 ["Don't Leave (Kylie)",'Belarus','4','3','42','100'],
 ["Don't Leave (Kylie)",'Bulgaria','N/A','27','','100'],
 ["Don't Leave (Kylie)",'Netherlands','N/A','17','20','100'],
 ["Don't Leave (Kylie)",'Poland','N/A','8','16','200'],
 ["Don't Leave (Kylie)",'Estonia','N/A','54','14','200'],
 ["Don't Leave (Kylie)",'Latvia','N/A','66','11','200'],
 ["Don't Leave (Kylie)",'France','N/A','154','1','200']
];
function airplayChartsFor_(track){ var byM={}; airplayManual_(track).forEach(function(e){byM[norm_(e.market)]=e;}); airplayTracked_(track).forEach(function(e){byM[norm_(e.market)]=e;}); return Object.keys(byM).map(function(k){return byM[k];}); }

/* ---------- detail lists on top of computeFacts_ ---------- */
function buildFullFacts_(display, tl, sections, radiomon){
  var F = computeFacts_(display, tl, sections, radiomon);
  F.has_songstats = !!sections;
  function sec(n){ return sections && sections[n] ? sections[n] : null; }
  F.new_r = []; F.top_stations = []; F.all_stations = [];
  // release date (first day streams appear) + weeks since release, for recency weighting
  var _rel = firstStreamDate_(tl); F.release_date = _rel ? Utilities.formatDate(_rel,'GMT','yyyy-MM-dd') : null;
  var rr = sec('Radiostats Radio');
  if (rr && rr.length>1){
    var h=rr[0], ip=colIndex_(h,'Plays'), ist=colIndex_(h,'Station'), ic=colIndex_(h,'Country'), icity=colIndex_(h,'City'), ifp=colIndex_(h,'First Play');
    var cut=todayUTC_(), arr=[]; F.radio_cut=cut.getTime();  // FIX: "new radios this week" = last 7 days from today, not from the lagging streams as_of
    F.weeks_since_release = _rel ? Math.max(0,(cut-_rel)/(7*864e5)) : null;
    for (var i=1;i<rr.length;i++){
      var p=parseInt(String(rr[i][ip]||'').replace(/,/g,''),10)||0;
      var ctry=String(rr[i][ic]||'').trim();
      var loc=((rr[i][icity]?String(rr[i][icity]).trim()+' · ':'')+ctry).replace(/^ · | · $/,'');
      var rec={plays:p, station:String(rr[i][ist]||''), location:loc, country:ctry};
      var fp=parseDate_(rr[i][ifp]); rec.fp=fp?fp.getTime():null;
      if (fp && (cut-fp)/86400000<=7 && (cut-fp)>=0){ rec.first=Utilities.formatDate(fp,'GMT','dd MMM'); F.new_r.push({plays:p,station:rec.station,location:loc,country:ctry,first:rec.first}); }
      arr.push(rec);
    }
    arr.sort(function(a,b){return b.plays-a.plays;}); F.all_stations=arr; F.top_stations=arr.slice(0,14);
    F.new_r.sort(function(a,b){return b.plays-a.plays;});
  } else { F.weeks_since_release = _rel ? Math.max(0,(new Date()-_rel)/(7*864e5)) : null; }
  F.playlists = []; F.dropped = [];
  var pl = sec('Spotify Playlists');
  if (pl && pl.length>1){
    var ph=pl[0], inm=colIndex_(ph,'Name'), iow=colIndex_(ph,'Owner'), ipo=colIndex_(ph,'Position'), ifo=colIndex_(ph,'Followers'), irem=colIndex_(ph,'Removed');
    var lst=[];
    for (var k=1;k<pl.length;k++){
      var fo=num_(pl[k][ifo]); if(!fo) continue;
      var rem = (irem>=0)? String(pl[k][irem]||'-').replace(/^'+/,'').trim() : '-';   // FIX: "'-" means still on the playlist
      var o={name:String(pl[k][inm]||'').substring(0,40), owner:String(pl[k][iow]||'').substring(0,18), pos:String(pl[k][ipo]||'-'), followers:fo, removed:(rem&&rem!=='-')?rem:null};
      if (o.removed) F.dropped.push(o); else lst.push(o);
    }
    lst.sort(function(a,b){return b.followers-a.followers;}); F.playlists=lst.slice(0,8);
    F.dropped.sort(function(a,b){return b.followers-a.followers;}); F.dropped=F.dropped.slice(0,5);
  }
  F.shazam = [];
  var sh = sec('Shazam Charts');
  if (sh && sh.length>1){
    var s0=sh[0], sn=colIndex_(s0,'Name'), sty=colIndex_(s0,'Type'), sc=colIndex_(s0,'Current'), sp=colIndex_(s0,'Peak'), sd=colIndex_(s0,'Days In');
    for (var q=1;q<sh.length && F.shazam.length<6;q++) F.shazam.push({name:String(sh[q][sn]||''),type:String(sh[q][sty]||''),now:String(sh[q][sc]||'').replace(/^'+/,'').replace(/^-$/,''),peak:String(sh[q][sp]||'').replace(/^'+/,''),days:String(sh[q][sd]||'').replace(/^'+/,'')});
  }
  F.tk_likes=sumCol_(sec('TikTok Top Videos'),'Likes'); F.tk_vids=(sec('TikTok Top Videos')||[]).length-1;
  F.ig_likes=sumCol_(sec('Instagram Top Reels'),'Likes'); F.ig_vids=(sec('Instagram Top Reels')||[]).length-1;
  F.yt_likes=sumCol_(sec('YouTube Videos'),'Likes'); F.yt_sh_views=sumCol_(sec('YouTube Shorts'),'Views'); F.yt_sh_likes=sumCol_(sec('YouTube Shorts'),'Likes');
  return F;
}

/* ---------- snapshots (full, for carry-forward + deltas) ---------- */
var SNAP_FIELDS = ['has_radio','has_songstats','radio_plays','radio_stations','markets','top_stations','new_r','stations_c',
  'reach','playlists_cur','playlists_total','playlists','shazam_rows','shazam','total_streams','combined','avg_day',
  'tk_views','tk_likes','tk_vids','ig_views','ig_likes','ig_vids','yt_views','yt_likes','yt_sh_views','yt_sh_likes','airplay'];
function snapOf_(F){ var o={}; SNAP_FIELDS.forEach(function(k){ o[k]=F[k]; }); if(o.stations_c) o.stations_c=o.stations_c.slice(0,60).map(function(s){return {station:s.station,country:s.country,location:s.location,plays:s.plays,feeds:s.feeds,tier:s.tier,rated:s.rated,isNew:false,first:s.first};}); return o; }
function repWeekIdx_(l){ var m=String(l).match(/(?:Week\s+|W\s*)0*(\d+)(?:\s+(\d+))?/i); return m?((m[2]?parseInt(m[2])*53:0)+parseInt(m[1])):-1; }
function carryForward_(F, prevRec){
  F.old = {};
  if (!prevRec) return F;
  var p = prevRec.f, pw = prevRec.week;
  // whole radio section missing this week -> use last week's radio, mark old
  if (!F.has_radio && p.has_radio){
    ['radio_plays','radio_stations','markets','top_stations','stations_c'].forEach(function(k){ F[k]=p[k]; }); F.new_r=[];
    F.radio_old = pw;
  }
  // whole Songstats missing this week -> carry playlists/shazam/social/reach, mark old
  if (!F.has_songstats && p.has_songstats){
    ['reach','playlists_cur','playlists_total','playlists','shazam_rows','shazam','tk_views','tk_likes','tk_vids','ig_views','ig_likes','ig_vids','yt_views','yt_likes','yt_sh_views','yt_sh_likes'].forEach(function(k){ F[k]=p[k]; });
    F.songstats_old = pw;
    F.combined = (F.total_streams||0) + (F.yt_views||0);
  }
  return F;
}
function buildRead_(F, prevF, ctx){
  var pct = (F.avg_day!=null && F.avg_day_prev) ? (F.avg_day-F.avg_day_prev)/F.avg_day_prev*100 : null;
  var mt = (F.markets||[]).slice(0,3).map(function(x){return x[0];});
  var V={};
  var radioOld = F.radio_old ? (' (data from '+shortW_(F.radio_old)+')') : '';
  if (F.radio_plays==null){
    var air0=(F.airplay&&F.airplay.length)?(F.airplay[0][0]+' #'+F.airplay[0][1]):'no active positions';
    V.radio={badge:'watch',verdict:'Not updated this week',body:'No radio in this export and no earlier week to fall back on; Radiomonitor shows '+air0+'.'};
  } else {
    V.radio={badge:(F.radio_plays>0)?'ok':'watch', verdict:(F.radio_old?'Radio (last available)':(F.new_adds>0?'Building on air':'Live on air')),
      body: human_(F.radio_plays)+' plays / '+F.radio_stations+' stations'+radioOld+'; top markets '+(mt.join(', ')||'—')+'.'};
  }
  var sv = pct==null?'Holding steady' : (pct>=T_STREAM?'Growing' : (pct<=-COOLING?'Cooling off' : (pct<=-T_STREAM?'Easing off':'Holding steady')));
  V.streaming={badge:(pct==null||pct>=-T_STREAM)?'ok':'watch', verdict:sv, body: human_(F.avg_day)+'/day on Spotify'+(pct!=null?(' ('+(pct>=0?'+':'')+pct.toFixed(1)+'% vs '+(F.baseline_label||'prev')+')'):'')+'. '+(F.playlists_total||0)+' playlists, '+human_(F.reach)+' reach.'};
  var charting=(F.shazam_rows>0);
  V.shazam={badge:charting?'ok':'watch', verdict:charting?('Charting'+(F.shazam&&F.shazam[0]?(' — '+F.shazam[0].name):'')):'Quiet on Shazam', body:(F.shazam_rows||0)+' active Shazam chart(s).'};
  var soc=[['TikTok',F.tk_views||0],['YouTube',F.yt_views||0],['Instagram',F.ig_views||0]].sort(function(a,b){return b[1]-a[1];});
  V.social={badge:'ok', verdict:soc[0][0]+'-led', body: human_(F.tk_views)+' TikTok · '+human_(F.ig_views)+' IG · '+human_(F.yt_views)+' YT.'};

  var down=(pct!=null&&pct<=-T_STREAM), up=(pct!=null&&pct>=T_STREAM);
  var phase = up?'Building momentum.' : (down ? ((F.radio_plays>0)?'Radio still building while streaming settles.':'Streaming easing this week.') : 'Steady week.');
  var support = ((F.radio_plays!=null)?(human_(F.radio_plays)+' radio plays across '+F.radio_stations+' stations'+(F.radio_old?' (last available)':'')+'; '):'')
    + (charting?('charting on Shazam'+(F.airplay&&F.airplay.length?(' and airplay ('+F.airplay[0][0]+' #'+F.airplay[0][1]+')'):'')+'; '):'')
    + human_(soc[0][1])+' '+soc[0][0]+' views carrying reach.'
    + ((F.intl_driver && F.intl_driver.plays>=20)?(' Biggest radio market outside '+HOME_MARKET+': '+F.intl_driver.market+' ('+human_(F.intl_driver.plays)+' plays'+(F.intl_driver.lead?(', led by '+F.intl_driver.lead):'')+').'):'');
  var A=[];
  if (F.radio_plays!=null && mt.length) A.push({tag:'t-hold',label:'Hold',text:'Defend '+mt[0]+(mt[1]?(' / '+mt[1]):'')+' — the plays base; keep servicing.'});
  if (F.airplay && F.airplay.length && F.airplay[0][1]<=300) A.push({tag:'t-push',label:'Angle',text:'Use '+F.airplay[0][0]+' #'+F.airplay[0][1]+' as the pitch angle for rotation upgrades.'});
  if (F.has_radio && F.new_major_n>0) A.push({tag:'t-push',label:'Push',text:'Push this week’s '+F.new_major_n+' major add'+(F.new_major_n>1?'s':'')+' ('+(F.new_major||[]).slice(0,3).map(function(s){return s.station;}).join(', ')+') past single spins before they lapse.'});
  if (F.dropped && F.dropped.length) A.push({tag:'t-cut',label:'Playlist',text:'Dropped from '+F.dropped.length+' playlist(s) this period — worth a re-pitch.'});
  if (!F.has_radio && !F.radio_old) A.push({tag:'t-fix',label:'Radio',text:'Re-export with the Radiostats section so radio play-counts come through.'});
  A.push({tag:'t-fix',label:'Check', text: prevF? 'Deltas vs last week are live above.' : 'Deltas activate next week once a second snapshot is stored.'});
  var action=A.length?A[0].text:'Keep servicing the base and feeding playlist + creator momentum.';
  var narrative=phase+' '+support+' <b>Action: '+action+'</b>';

  var checks=[];
  if (prevF){
    [['Radio plays','radio_plays'],['Radio stations','radio_stations'],['Combined streams','combined'],['Total streams','total_streams']].forEach(function(mm){
      if (F.radio_old && (mm[1]==='radio_plays'||mm[1]==='radio_stations')) return; // carried, don't check
      var c=F[mm[1]], pp=prevF[mm[1]]; if (c!=null && pp!=null && c<pp) checks.push(mm[0]+' fell vs last week ('+human_(pp)+' → '+human_(c)+') — a running total can’t drop. Check the export/scope.');
    });
  }
  return {narrative:narrative, verdicts:V, actions:A.slice(0,5), checks:checks, pct:pct};
}
function deltaHtml_(cur, prev, oldWeek){
  if (oldWeek) return ['<div class="num-delta flat">old · '+shortW_(oldWeek)+'</div>','not updated'];
  if (cur==null) return ['<div class="num-delta flat">—</div>',''];
  if (prev==null) return ['<div class="num-delta flat">first snapshot</div>','baseline next week'];
  var d=cur-prev, ar=d>0?'&nearr;':(d<0?'&searr;':'&rarr;'), cls=d>0?'up':(d<0?'down':'flat');
  return ['<div class="num-delta '+cls+'">'+ar+' '+(d>=0?'+':'')+human_(d)+'</div>','vs prev week'];
}
function partnerMilestones_(F, prevF){
  var out=[];
  if (F.total_streams!=null){ var curM=Math.floor(F.total_streams/1e6), prevM=(prevF&&prevF.total_streams!=null)?Math.floor(prevF.total_streams/1e6):null;
    if (curM>=1) out.push((prevM!=null&&curM>prevM)?('Crossed '+curM+'M streams'):(curM+'M+ streams')); }
  if (F.airplay && F.airplay.length && F.airplay[0][1]<=100) out.push('Top 100 airplay — '+F.airplay[0][0]+' #'+F.airplay[0][1]);
  if (F.shazam && F.shazam.length){ var best=1e9; F.shazam.forEach(function(r){ var n=parseInt(String(r.now).replace('#',''),10); if(!isNaN(n)&&n<best)best=n; }); if(best<=100) out.push('Top 100 Shazam (#'+best+')'); }
  if (F.playlists && F.playlists.length){ var big=F.playlists.filter(function(p){return p.followers>=500000;}); if(big.length) out.push('On '+big[0].name+' ('+human_(big[0].followers)+' followers)'); }
  if (F.radio_stations!=null && F.radio_stations>=50) out.push(F.radio_stations+' radio stations spinning it');
  return out.slice(0,4);
}
function posDelta_(cur, prev){ if(cur==null||prev==null) return '<div class="num-sub">&nbsp;</div>'; var d=cur-prev; return d>0?('<div class="num-delta up">&nearr; +'+human_(d)+' this period</div>'):'<div class="num-sub">&nbsp;</div>'; }
function renderPartner_(F, prevF, week){
  var m=F, T=esc_(F.title), L='Roton Music', artist=esc_(F.artist||'');
  var topsoc=[['TikTok',m.tk_views||0],['YouTube',m.yt_views||0],['Instagram',m.ig_views||0]].sort(function(a,b){return b[1]-a[1];})[0];
  // summary
  var wins=[];
  if (m.radio_plays!=null) wins.push(human_(m.radio_plays)+' radio plays across '+m.radio_stations+' stations'+((m.countries_on_air)?(' in '+m.countries_on_air+' countries'):''));
  else if (m.airplay&&m.airplay.length) wins.push('on air in '+m.airplay[0][0]+' (#'+m.airplay[0][1]+' Radiomonitor)');
  wins.push(human_(m.total_streams)+' streams ('+human_(m.avg_day)+'/day)');
  if (m.reach) wins.push(human_(m.reach)+' playlist reach');
  wins.push(human_(topsoc[1])+' '+topsoc[0]+' views');
  var summary = T+' is building momentum — '+wins.slice(0,3).join(', ')+', and more below.';
  // milestone chips
  var mls=partnerMilestones_(F,prevF);
  var mlHtml = mls.length ? ('<div style="margin:0 0 4mm">'+mls.map(function(x){return '<span style="display:inline-block;background:#fdf3dc;border:1px solid #efe2c4;color:#8a6a12;font-weight:800;font-size:9pt;padding:3px 11px;border-radius:14px;margin:2px 7px 2px 0">★ '+esc_(x)+'</span>';}).join('')+'</div>') : '';
  // headline cards
  var radioCard = (m.radio_plays!=null)
      ? '<div class="num"><div class="num-label">Radio plays</div><div class="num-val">'+human_(m.radio_plays)+'</div>'+posDelta_(m.radio_plays, prevF&&prevF.radio_plays)+'</div>'
      : (m.airplay&&m.airplay.length ? '<div class="num"><div class="num-label">Best airplay</div><div class="num-val">#'+m.airplay[0][1]+'</div><div class="num-sub">'+esc_(m.airplay[0][0])+' · Radiomonitor</div></div>'
      : '<div class="num"><div class="num-label">Radio</div><div class="num-val">—</div><div class="num-sub">not tracked</div></div>');
  var reachCard='<div class="num"><div class="num-label">Playlist reach</div><div class="num-val">'+human_(m.reach)+'</div>'+posDelta_(m.reach, prevF&&prevF.reach)+'</div>';
  var nums = '<div class="numbers">'
    +'<div class="num"><div class="num-label">Total streams</div><div class="num-val">'+human_(m.total_streams)+'</div>'+posDelta_(m.combined, prevF&&prevF.combined)+'</div>'
    +'<div class="num"><div class="num-label">Streams / day</div><div class="num-val">'+human_(m.avg_day)+'</div><div class="num-sub">Spotify</div></div>'
    +radioCard
    +'<div class="num"><div class="num-label">'+(m.airplay?'Airplay markets':'Countries on air')+'</div><div class="num-val">'+((m.airplay&&m.airplay.length)?m.airplay.length:(m.countries_on_air||0))+'</div><div class="num-sub">&nbsp;</div></div>'
    +reachCard
    +'<div class="num"><div class="num-label">'+esc_(topsoc[0])+' views</div><div class="num-val">'+human_(topsoc[1])+'</div><div class="num-sub">top social</div></div>'
    +'</div>';
  // radio detail
  var topList=(m.stations_c&&m.stations_c.length)? m.stations_c.slice(0,10) : (m.top_stations||[]).slice(0,10);
  var tops=topList.length? topList.map(function(r){return '<tr><td><b>'+r.plays+'</b></td><td>'+(r.tier===1||r.tier===2?'<span style="color:#c79a12">★</span> ':'')+esc_(r.station)+'</td><td class="muted">'+esc_(r.location)+'</td></tr>';}).join('') : '<tr><td colspan="3" class="muted small">Radio play-counts not tracked for this track — see airplay positions.</td></tr>';
  // airplay: current = top 200 now; historical = was top 200 last period, no longer top 200
  var curAir=(m.airplay||[]).filter(function(a){return a[1]<=200;});
  var air=curAir.length? curAir.slice(0,8).map(function(a){return '<tr><td><b>'+esc_(a[0])+'</b></td><td><b>#'+a[1]+'</b></td></tr>';}).join('') : '<tr><td colspan="2" class="muted small">No airplay in the top 200 this period.</td></tr>';
  var curAirSet={}; curAir.forEach(function(a){curAirSet[norm_(a[0])]=1;});
  var prevAir=(prevF&&prevF.airplay)||[];
  var histAir=prevAir.filter(function(a){return a[1]<=200 && !curAirSet[norm_(a[0])];}).sort(function(a,b){return a[1]-b[1];});
  var airHistSection=histAir.length? '<div class="sec-head" style="margin-top:5mm"><h2 style="font-size:12pt">Airplay — historical</h2><span class="sec-note">was top 200, dropped off</span></div><table class="tbl"><thead><tr><th>Market</th><th>Was</th></tr></thead><tbody>'+histAir.slice(0,12).map(function(a){return '<tr><td><b>'+esc_(a[0])+'</b></td><td class="muted">#'+a[1]+'</td></tr>';}).join('')+'</tbody></table>' : '';
  // radio charts: peak + longevity (cumulative weeks in top 100 / 200, from manual history + auto tracker)
  var charts=airplayChartsFor_(m.title);
  var chartRows=charts.length? charts.map(function(c){ var now=(c.current&&c.current!=='N/A'&&c.current!=='')?('#'+esc_(c.current)):'<span class="muted">N/A</span>';
    return '<tr><td><b>'+esc_(c.market)+'</b></td><td>'+now+'</td><td class="muted">'+(c.peak?('#'+esc_(c.peak)):'—')+'</td><td class="muted">'+(c.weeks?(esc_(c.weeks)+(c.weeks==='1'?' wk':' wks')):'—')+' in top '+esc_(c.tier)+'</td></tr>'; }).join('') : '';
  var chartsSection=charts.length? '<div class="sec-head" style="margin-top:6mm"><h2 style="font-size:12pt">Radio charts</h2><span class="sec-note">peak &amp; longevity (top 100 / 200)</span></div><table class="tbl"><thead><tr><th>Market</th><th>Now</th><th>Peak</th><th>Longevity</th></tr></thead><tbody>'+chartRows+'</tbody></table>' : '';
  // key radio support: the priority (starred) stations backing the track
  var _homeN=0, keySupport=(m.stations_c||[]).filter(function(s){return s.tier===1||s.tier===2;}).sort(function(a,b){return stScore_(b)-stScore_(a);}).filter(function(s){ if(ctryKey_(s.country)!==ctryKey_(HOME_MARKET)) return true; return (++_homeN)<=4; });
  var keySupRows=keySupport.length? keySupport.slice(0,12).map(function(s){return '<tr><td><span style="color:#c79a12">★</span> '+esc_(s.station)+'</td><td class="muted">'+esc_(s.location)+'</td><td class="r muted">'+((s.plays||0)?(human_(s.plays)+' plays'):'')+'</td></tr>';}).join('') : '';
  var keySupSection=keySupport.length? '<div class="sec-head" style="margin-top:6mm"><h2 style="font-size:12pt">Key radio support</h2><span class="sec-note">priority stations on the track</span></div><table class="tbl"><thead><tr><th>Station</th><th>Location</th><th class="r">Plays</th></tr></thead><tbody>'+keySupRows+'</tbody></table>' : '';
  var radioInsightsEmpty = !airHistSection && !chartsSection && !keySupSection;
  // playlists (current, highlight big)
  var plr=(m.playlists||[]).map(function(p){var big=p.followers>=500000; return '<tr><td>'+(big?'★ ':'')+esc_(p.name)+'</td><td class="muted">'+esc_(p.owner)+'</td><td class="r">'+human_(p.followers)+'</td></tr>';}).join('') || '<tr><td colspan="3" class="muted small">—</td></tr>';
  // key playlists to date: merge current + dropped, dedup by name, biggest first, flag current vs no longer
  var plAll={}; (m.playlists||[]).forEach(function(p){plAll[norm_(p.name)]={name:p.name,owner:p.owner,followers:p.followers||0,status:'current'};});
  (m.dropped||[]).forEach(function(p){var k=norm_(p.name); if(!plAll[k]||(p.followers||0)>plAll[k].followers) plAll[k]={name:p.name,owner:p.owner,followers:p.followers||0,status:'no longer'};});
  var plToDate=Object.keys(plAll).map(function(k){return plAll[k];}).sort(function(a,b){return b.followers-a.followers;}).slice(0,10);
  var plToDateRows=plToDate.length? plToDate.map(function(p){return '<tr><td>'+esc_(p.name)+'</td><td class="muted">'+esc_(p.owner)+'</td><td class="r">'+human_(p.followers)+'</td><td class="muted">'+p.status+'</td></tr>';}).join('') : '';
  var plToDateSection=plToDate.length? '<div class="sec-head" style="margin-top:7mm"><h2 style="font-size:12.5pt">Key playlists to date</h2><span class="sec-note">biggest placements · current &amp; past</span></div><table class="tbl"><thead><tr><th>Playlist</th><th>Owner</th><th class="r">Followers</th><th>Status</th></tr></thead><tbody>'+plToDateRows+'</tbody></table>' : '';
  // shazam current + no-longer-charting note
  var shr=(m.shazam&&m.shazam.length)? m.shazam.map(function(r){return '<tr><td><b>'+esc_(r.name)+'</b></td><td class="muted">'+esc_(r.type)+'</td><td><b>'+esc_(r.now)+'</b></td></tr>';}).join('') : '<tr><td colspan="3" class="muted small">—</td></tr>';
  var prevShz=(prevF&&prevF.shazam)||[], curShzSet={}; (m.shazam||[]).forEach(function(r){curShzSet[norm_(r.name)]=1;});
  var histShz=prevShz.filter(function(r){return r&&r.name&&!curShzSet[norm_(r.name)];});
  var shazamHist=histShz.length? '<div class="cap" style="margin-top:3mm"><b>No longer charting on Shazam:</b> '+histShz.slice(0,8).map(function(r){return esc_(r.name)+(r.now?(' (was '+esc_(r.now)+')'):'');}).join(', ')+'.</div>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+esc_(reportFileName_(F.title, week, true).replace(/\.html$/,''))+'</title><style>'+REPORT_CSS+'</style></head><body>'
  +'<section class="page"><div class="hdr hdr-pad"><div class="hdr-top"><img class="logo" src="data:image/png;base64,'+LOGO_B64+'"><span class="report-label">Performance Snapshot</span></div>'
  +'<div class="artist">'+artist+'</div><h1 class="title">'+T+'</h1><div class="subtitle">'+esc_(week)+' &nbsp;•&nbsp; '+L+'</div>'
  +'<div class="callout"><div class="callout-label">Highlights</div><div class="callout-body">'+esc_(summary)+'</div></div></div>'
  +'<div class="body">'+mlHtml
  +'<div class="sec-head"><h2>The numbers</h2><span class="sec-note">This period · growth flagged</span></div>'+nums
  +'<div class="two" style="margin-top:6mm"><div><div class="sec-head"><h2 style="font-size:12.5pt">Top stations</h2><span class="sec-note">by plays</span></div>'
  +'<table class="tbl dense"><thead><tr><th style="width:12mm">Plays</th><th>Station</th><th>Location</th></tr></thead><tbody>'+tops+'</tbody></table></div>'
  +'<div><div class="sec-head"><h2 style="font-size:12.5pt">Airplay — current</h2><span class="sec-note">top 200 · Radiomonitor</span></div>'
  +'<table class="tbl"><thead><tr><th>Market</th><th>Position</th></tr></thead><tbody>'+air+'</tbody></table></div></div>'
  +'</div><div class="foot"><span>'+T+' — '+L+'</span><span>01 / 04</span></div></section>'
  +'<section class="page"><div class="hdr hdr-thin"><img class="logo-thin" src="data:image/png;base64,'+LOGO_B64+'"><span class="sect-label">Radio — history &amp; longevity</span></div><div class="body">'
  +(radioInsightsEmpty ? '<div class="note">No airplay history or chart longevity recorded yet for this track.</div>' : (keySupSection+chartsSection+airHistSection))
  +'</div><div class="foot"><span>'+T+' — '+L+'</span><span>02 / 04</span></div></section>'
  +'<section class="page"><div class="hdr hdr-thin"><img class="logo-thin" src="data:image/png;base64,'+LOGO_B64+'"><span class="sect-label">Streaming · Playlists</span></div><div class="body">'
  +'<div class="sec-head"><h2>Spotify</h2><span class="sec-note">'+(m.playlists_total||0)+' playlists · '+human_(m.reach)+' reach</span></div>'
  +'<div class="statcards"><div class="statcard"><div class="num-label">Total streams</div><div class="v">'+human_(m.total_streams)+'</div></div>'
  +'<div class="statcard"><div class="num-label">Last 7 days</div><div class="v">'+human_(m.last7)+'</div></div>'
  +'<div class="statcard"><div class="num-label">Playlists</div><div class="v">'+(m.playlists_total||0)+'</div></div>'
  +'<div class="statcard"><div class="num-label">Streams / day</div><div class="v">'+human_(m.avg_day)+'</div></div></div>'
  +'<div class="sec-head" style="margin-top:6mm"><h2 style="font-size:12.5pt">Current playlists</h2><span class="sec-note">active placements</span></div>'
  +'<table class="tbl"><thead><tr><th>Playlist</th><th>Owner</th><th class="r">Followers</th></tr></thead><tbody>'+plr+'</tbody></table>'
  +plToDateSection
  +'</div><div class="foot"><span>'+T+' — '+L+'</span><span>03 / 04</span></div></section>'
  +'<section class="page"><div class="hdr hdr-thin"><img class="logo-thin" src="data:image/png;base64,'+LOGO_B64+'"><span class="sect-label">Social · Shazam</span></div><div class="body">'
  +'<div class="two"><div><div class="sec-head"><h2 style="font-size:12.5pt">Social</h2></div><div class="soc-grid">'
  +'<div class="soc"><div class="soc-t">TikTok</div><div class="soc-v">'+human_(m.tk_views)+' views</div><div class="soc-s">'+human_(m.tk_likes)+' likes / '+(m.tk_vids||0)+' videos</div></div>'
  +'<div class="soc"><div class="soc-t">YouTube</div><div class="soc-v">'+human_(m.yt_views)+' views</div><div class="soc-s">'+human_(m.yt_likes)+' likes</div></div>'
  +'<div class="soc"><div class="soc-t">YouTube Shorts</div><div class="soc-v">'+human_(m.yt_sh_views)+' views</div><div class="soc-s">'+human_(m.yt_sh_likes)+' likes</div></div>'
  +'<div class="soc"><div class="soc-t">Instagram</div><div class="soc-v">'+human_(m.ig_views)+' views</div><div class="soc-s">'+human_(m.ig_likes)+' likes / '+(m.ig_vids||0)+' reels</div></div>'
  +'</div></div><div><div class="sec-head"><h2 style="font-size:12.5pt">Shazam</h2></div>'
  +'<table class="tbl"><thead><tr><th>Chart</th><th>Type</th><th>Now</th></tr></thead><tbody>'+shr+'</tbody></table>'+shazamHist+'</div></div>'
  +'</div><div class="foot"><span>'+T+' — '+L+'</span><span>04 / 04</span></div></section>'
  +'</body></html>';
}

// available data folders, newest first: {folder: raw name, label: report week label}
var _repIdx=null;
function reportFileName_(display, week, partner){
  var m=String(week||'').match(/Week\s+(\d+)\s+(\d+)/i);
  var tag = m ? ('W'+m[1]+' '+m[2]) : String(week||'').replace(/^Week\s+/i,'W');
  return display+'_'+tag+(partner?' — PARTNER':'')+'.html';
}
var CONTACTS_SHEET_NAME = 'Roton Radio Stations';
var CONTACTS_TYPES = ['Major CHR','National other','Regional','Local','Not radio'];
var SV_CATS = [
  {key:'major',    label:'Major national CHR / Top 40', hint:'hit stations',                       color:'#1f6b3a'},
  {key:'natother', label:'National, other formats',      hint:'AC, dance, urban, public',           color:'#2f6f8f'},
  {key:'regional', label:'Regional & networks',          hint:'regional majors, city networks',     color:'#b88a1e'},
  {key:'local',    label:'Local, web & niche',           hint:'local, online, college, specialist', color:'#9a9aa0'}
];
function svTypeKey_(t){ var f=fold_(t);
  if(!f) return 'local';
  if(/not radio|exclude|^tv/.test(f)) return 'x';
  if(/major|chr|top ?40/.test(f)) return 'major';
  if(/national|other/.test(f)) return 'natother';
  if(/regional|network/.test(f)) return 'regional';
  return 'local'; }
var SV_GENERIC = {radio:1,radyo:1,radiou:1,fm:1,am:1,tv:1,the:1,station:1,music:1,online:1,hd:1,web:1,stream:1};
function stationCore_(name, country){
  var f=' '+fold_(name).replace(/[^a-z0-9]+/g,' ')+' ';
  f=f.replace(/ \d{2,3} \d{1,2}(?= )/g,' ');                          // decimal frequencies: 98.3, 104,6
  var cf=fold_(country), ck=ctryKey_(country);
  var toks=f.split(' ').filter(function(t){ return t && !SV_GENERIC[t] && t!==cf && t!==ck; });
  var out=toks.join(' ');
  return out || nk_(name);
}
function svMatchScore_(s, sCores, sReg, c){
  var best=0;
  sCores.forEach(function(k){
    if(k===c.core){ best=Math.max(best,3); return; }
    var a=k, b=c.core, sh=a.length<=b.length?a:b, lg=a.length<=b.length?b:a;
    // one-word cores only match when the contact is the brand and the station a feed of it ("Radio Scoop" → "Radio Scoop Lyon"), never the reverse
    var city=fold_(String(s.location||'').split(' · ')[0]);
    var ok = /[a-z]/.test(sh) && (sh.indexOf(' ')>0 || (sh===c.core && sh.length>=4 && sh!==city));
    if(ok && wordBounded_(lg,sh)) best=Math.max(best,1+sh.length/100);
  });
  if(best<2 && sReg && c.reg && sReg===c.reg) best=Math.max(best,2);
  return best;
}
function buildServicing_(F, ctx){
  var home=ctryKey_(HOME_MARKET), map=importantMap_(), base=radioContacts_();
  var contacts=base? base.map(function(c){ return {country:c.country, ck:c.ck, station:c.station, core:c.core, type:c.type, reg:c.reg, genre:c.genre, relevance:c.relevance, rotonPlays:c.rotonPlays}; }) : null;
  var S={mode:'normal', contactsOk:!!contacts, hasStations:!!(F.stations_c&&F.stations_c.length)};
  var stations=(F.stations_c||[]).filter(function(s){ return ctryKey_(s.country)!==home && (s.plays||0)>0; });
  S.intlPlays=stations.reduce(function(a,s){return a+(s.plays||0);},0); S.intlStations=stations.length;
  // match every international station to at most one contacted station (same country, best score)
  var byC={}; (contacts||[]).forEach(function(c){ (byC[c.ck]=byC[c.ck]||[]).push(c); });
  stations.forEach(function(s){
    var cands=byC[ctryKey_(s.country)]; if(!cands) return;
    var names=[s.station].concat(s.names||[]), cores={}; names.forEach(function(n){ cores[stationCore_(n,s.country)]=1; });
    var sReg=registryMatch_(s.station,s.country,map), bestC=null, best=0;
    cands.forEach(function(c){ var sc=svMatchScore_(s,Object.keys(cores),sReg,c); if(sc>best){best=sc;bestC=c;} });
    if(bestC && best>=1){ s._contact=bestC; bestC._plays=(bestC._plays||0)+(s.plays||0); if(s.isNew && !bestC._wasOn) bestC._new=true; if(!s.isNew) bestC._wasOn=true; }
  });
  (contacts||[]).forEach(function(c){ if(c._new && c._wasOn) c._new=false; });
  S.contactsAll=contacts||[];
  // territories recorded on the song (home market left out: serviced separately)
  var terr=((ctx&&ctx.territories)||[]).filter(function(t){ return ctryKey_(t.name)!==home; });
  var sent=terr.filter(function(t){return t.sent;}), planned=terr.filter(function(t){return !t.sent;});
  S.planned=planned.map(function(t){return t.name;});
  if(!sent.length){
    S.mode='none';
    // still useful: which territories have stations from our list playing it
    var by={}; (contacts||[]).forEach(function(c){ if(c._plays>0){ var b=by[c.ck]||(by[c.ck]={name:c.country,stations:0,plays:0}); b.stations++; b.plays+=c._plays; } });
    S.onList=Object.keys(by).map(function(k){return by[k];}).sort(function(a,b){return b.plays-a.plays;});
    S.onListPlays=S.onList.reduce(function(a,x){return a+x.plays;},0); S.onListStations=S.onList.reduce(function(a,x){return a+x.stations;},0);
    return S;
  }
  function channelFor(t){ var act=((ctx&&ctx.pluggers)||[]).some(function(p){ return p.status==='active' && ctryKey_(p.region)===ctryKey_(t); }); return act?'Plugger + direct':'Direct'; }
  var cats={}; SV_CATS.forEach(function(c){ cats[c.key]={contacted:0,playing:0,plays:0}; });
  var rows=[], tc=0, tp=0, tpl=0, tnew=0, noContacts=[];
  sent.forEach(function(t){
    var list=byC[ctryKey_(t.name)]||[];
    if(!list.length){ noContacts.push(t.name); return; }
    var r={name:t.name, wave:(t.wave===3?'Extra':'Wave '+t.wave), channel:channelFor(t.name), contacted:list.length, playing:0, plays:0};
    list.forEach(function(c){ var k=cats[c.type]?c.type:'local'; cats[k].contacted++; if(c._plays>0){ r.playing++; r.plays+=c._plays; cats[k].playing++; cats[k].plays+=c._plays; if(c._new) tnew++; } });
    tc+=r.contacted; tp+=r.playing; tpl+=r.plays; rows.push(r);
  });
  rows.sort(function(a,b){ return (b.plays-a.plays)||(b.contacted-a.contacted); });
  S.allRows=rows; S.rows=rows.slice(0,14); S.moreRows=rows.slice(14).map(function(r){return r.name;});
  S.noContacts=noContacts; S.sentCount=sent.length;
  S.contacted=tc; S.playing=tp; S.plays=tpl; S.newPlaying=tnew; S.cats=cats;
  S.organic=Math.max(0,S.intlPlays-tpl);
  S.organicStations=stations.filter(function(s){ return !(s._contact && sent.some(function(t){return ctryKey_(t.name)===s._contact.ck;})); }).length;
  // one read
  function pct(a,b){ return b?Math.round(a/b*100):0; }
  var conv=rows.filter(function(r){return r.contacted>=5;}).map(function(r){ r.conv=r.playing/r.contacted; return r; });
  var bestT=conv.slice().sort(function(a,b){return (b.conv-a.conv)||(b.plays-a.plays);})[0];
  var gapT=conv.filter(function(r){return r.contacted>=10;}).sort(function(a,b){return (a.conv-b.conv)||(b.contacted-a.contacted);})[0];
  var txt='Sent to <b>'+sent.length+' '+(sent.length===1?'territory':'territories')+'</b>'+(noContacts.length?(' ('+noContacts.length+' without contacts on our list)'):'')+', <b>'+tc+' stations</b> on our list. ';
  if(!S.hasStations) txt+='No station-level radio data this week, so plays can&rsquo;t be matched yet.';
  else if(tp===0) txt+='None of them is playing it yet'+(S.intlPlays?('; all '+human_(S.intlPlays)+' plays outside '+esc_(HOME_MARKET)+' come from stations we didn&rsquo;t contact.'):'.');
  else {
    txt+='<b>'+tp+' are playing it ('+pct(tp,tc)+'%)</b>, bringing <b>'+human_(tpl)+' plays</b>, '+pct(tpl,S.intlPlays)+'% of everything outside '+esc_(HOME_MARKET)+'.';
    if(bestT && bestT.playing>0) txt+=' '+esc_(bestT.name)+' converts best ('+bestT.playing+' of '+bestT.contacted+').';
    if(gapT && bestT && gapT.name!==bestT.name && gapT.conv<bestT.conv/2) txt+=' '+esc_(gapT.name)+' is the gap: '+gapT.playing+' of '+gapT.contacted+' contacted.';
  }
  S.read=txt;
  return S;
}
var RPT_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@50..150,100..900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
var RPT_CSS = ':root{--ink:#212224;--green:#1F5639;--amber:#F6B501;--pink:#F4B2CE;--off:#EDEDED;--grey:#6f6f75;--grey-l:#a0a0a6;--line:#dcdcdf;--down:#b4413a}'
 + '*{box-sizing:border-box;margin:0;padding:0}@page{size:A4;margin:0}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}'
 + 'body{background:#54545a;font-family:Inter,Helvetica,Arial,sans-serif;font-weight:400;color:var(--ink);font-size:10pt}'
 + '.page{position:relative;width:210mm;height:297mm;background:#fff;margin:0 auto 10mm;overflow:hidden}'
 + '@media print{body{background:#fff}.page{margin:0;page-break-after:always}.page:last-child{page-break-after:auto}}'
 + '.H{font-family:Anybody,Inter,Helvetica,Arial,sans-serif;font-stretch:108%}'
 + '.hdr{background:var(--ink);color:#fff;padding:12mm 14mm 11mm}.hdr-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10mm}'
 + '.logo{height:12mm;display:block}.lab{font-size:8pt;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--amber)}.conf{color:var(--pink);margin-left:5mm}'
 + '.artist{font-size:9pt;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--pink);margin-bottom:2.5mm}'
 + '.title{font-size:34pt;font-weight:800;line-height:1.02}.sub{color:#9b9ba1;font-size:9pt;margin-top:3mm}'
 + '.lead{margin-top:8mm;font-size:12.5pt;line-height:1.5;color:#c4c4c9;max-width:175mm}.lead b{color:#fff;font-weight:600}'
 + '.thin{background:var(--ink);padding:5mm 14mm;display:flex;align-items:center;justify-content:space-between}.thin img{height:7.5mm}'
 + '.body{padding:9mm 14mm 0}'
 + '.sh{display:flex;align-items:baseline;justify-content:space-between;gap:6mm;border-top:1.5px solid var(--ink);padding-top:2.6mm;margin:0 0 4.5mm}'
 + '.sh h2{font-size:13pt;font-weight:750;white-space:nowrap}.sh span{color:var(--grey);font-size:8.6pt;text-align:right}'
 + '.sub2{font-size:10.5pt;font-weight:650;margin:7mm 0 2.5mm}.sub2 span{color:var(--grey);font-weight:400;font-size:8.6pt;margin-left:2mm}'
 + '.gap{height:10mm}.nums{display:flex;gap:6mm}.n{flex:1;min-width:0}'
 + '.n .l{color:var(--grey);font-size:8.6pt;margin-bottom:1.8mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
 + '.n .v{font-size:25pt;font-weight:750;line-height:1}.n .d{font-size:9pt;font-weight:600;margin-top:2mm;color:var(--grey)}.n .d.up{color:var(--green)}.n .d.dn{color:var(--down)}'
 + '.bar{display:flex;align-items:center;gap:3mm;margin-bottom:3.2mm;font-size:10pt}.bar .k{width:24mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
 + '.bar .t{flex:1;height:2.6mm;background:var(--off)}.bar .f{display:block;height:100%;background:var(--green)}.bar .x{width:12mm;text-align:right;font-weight:600}'
 + 'table{width:100%;border-collapse:collapse}th{text-align:left;color:var(--grey);font-size:8.4pt;font-weight:500;padding:0 2mm 2mm;border-bottom:1px solid var(--ink)}'
 + 'td{font-size:9.8pt;padding:2.4mm 2mm;border-bottom:1px solid var(--line);vertical-align:top}td.r,th.r{text-align:right}.m{color:var(--grey)}td b{font-weight:650}'
 + '.tight td{padding:1.85mm 2mm}.star{color:var(--amber)}.two{display:flex;gap:10mm;align-items:flex-start}.two>div{flex:1;min-width:0}'
 + '.note{color:var(--grey);font-size:8.6pt;line-height:1.5;margin-top:3mm}.note b{color:var(--ink);font-weight:600}'
 + '.foot{position:absolute;bottom:8mm;left:14mm;right:14mm;display:flex;justify-content:space-between;color:var(--grey-l);font-size:7.8pt}.foot b{color:var(--down);font-weight:600}'
 + '.stack{display:flex;height:10mm;margin:1mm 0 3mm}.stack span{display:flex;align-items:flex-end;padding:0 0 1.6mm 2.4mm;color:#fff;font-size:9pt;font-weight:700;overflow:hidden;white-space:nowrap}'
 + '.leg{display:flex;flex-wrap:wrap;gap:2mm 7mm;font-size:9pt;color:var(--grey)}.leg b{color:var(--ink);font-weight:650}.sq{display:inline-block;width:2.6mm;height:2.6mm;margin-right:1.8mm;vertical-align:-.2mm}'
 + '.mv{display:flex;gap:4mm;padding:3.2mm 0;border-bottom:1px solid var(--line);font-size:10.5pt;line-height:1.45}.mv .i{font-weight:800;color:var(--green);width:8mm;flex:none}.mv b{font-weight:650}'
 + '.tag{font-size:8pt;font-weight:750;letter-spacing:.05em;text-transform:uppercase;margin-bottom:1.8mm}.t1{color:var(--green)}.t2{color:#2f6f8f}.t3{color:var(--down)}'
 + '.txt{font-size:10pt;line-height:1.5}.txt b{font-weight:650}.pill{font-size:8pt;font-weight:600;color:var(--grey)}.pill.new{color:var(--green)}.pill.old{color:#b07f00}'
 + '.facts div{display:flex;gap:4mm;padding:3mm 0;border-bottom:1px solid var(--line);font-size:10.5pt;line-height:1.45}.facts div span:first-child{color:var(--amber);font-weight:800;flex:none}'
 + '.chart{display:flex;align-items:flex-end;gap:4mm;height:46mm;border-bottom:1px solid var(--ink);padding:0 1mm}'
 + '.chart .c{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}.chart .c .bv{font-size:9.5pt;font-weight:700;margin-bottom:1.5mm}'
 + '.chart .c .bb{width:100%;background:var(--green)}.chart .c.last .bb{background:var(--amber)}'
 + '.xl{display:flex;gap:4mm;padding:2mm 1mm 0}.xl span{flex:1;text-align:center;font-size:8.6pt;color:var(--grey)}.xl span b{display:block;color:var(--ink);font-weight:600;font-size:9pt}';

/* ---------------- small building blocks ---------------- */
function T_doc_(title, pages){ return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+esc_(title)+'</title>'+RPT_FONTS+'<style>'+RPT_CSS+'</style></head><body>'+pages.join('')+'</body></html>'; }
function T_page_(inner){ return '<section class="page">'+inner+'</section>'; }
function T_hero_(o){ // {label, conf, artist, title, sub, lead}
  return '<div class="hdr"><div class="hdr-top"><img class="logo" src="data:image/png;base64,'+LOGO_B64+'"><span class="lab">'+esc_(o.label)+(o.conf?'<span class="conf">Confidential</span>':'')+'</span></div>'
    +(o.artist?'<div class="artist">'+esc_(o.artist)+'</div>':'')+'<div class="title H">'+esc_(o.title)+'</div><div class="sub">'+esc_(o.sub||'')+'</div>'
    +(o.lead?'<div class="lead">'+o.lead+'</div>':'')+'</div>'; }
function T_thin_(label, conf){ return '<div class="thin"><img src="data:image/png;base64,'+LOGO_B64+'"><span class="lab" style="color:#cfcfd3">'+esc_(label)+(conf?'<span class="conf">Confidential</span>':'')+'</span></div>'; }
function T_foot_(left, conf){ return '<div class="foot"><span>'+esc_(left)+(conf?' · <b>Confidential</b>, internal use only':'')+'</span><span>__PN__</span></div>'; }
function T_number_(html){ var n=0, total=(html.match(/__PN__/g)||[]).length; return html.replace(/__PN__/g, function(){ n++; return n+' / '+total; }); }
function T_sh_(t, note){ return '<div class="sh"><h2 class="H">'+esc_(t)+'</h2><span>'+(note||'')+'</span></div>'; }
function T_n_(l, v, d, cls){ return '<div class="n"><div class="l">'+esc_(l)+'</div><div class="v H">'+v+'</div><div class="d '+(cls||'')+'">'+(d||'&nbsp;')+'</div></div>'; }
function T_nums_(items){ while(items.length<4) items.push(['','','','']); return '<div class="nums">'+items.slice(0,4).map(function(x){ return x[0]===''?'<div class="n"></div>':T_n_(x[0],x[1],x[2],x[3]); }).join('')+'</div>'; }
function T_bars_(rows){ if(!rows.length) return '<div class="note">No data this week.</div>'; var mx=Math.max.apply(null,rows.map(function(r){return r[1];}).concat([1]));
  return rows.map(function(r){ return '<div class="bar"><span class="k">'+esc_(r[0])+'</span><span class="t"><span class="f" style="width:'+Math.max(2,Math.round(r[1]/mx*100))+'%"></span></span><span class="x">'+fmtInt_(r[1])+'</span></div>'; }).join(''); }
function T_table_(cols, rows, right, cls){ right=right||[];
  var h=cols.map(function(c,i){ return '<th'+(right.indexOf(i)>=0?' class="r"':'')+'>'+c+'</th>'; }).join('');
  var b=rows.map(function(r){ return '<tr>'+r.map(function(v,i){ return '<td'+(right.indexOf(i)>=0?' class="r"':'')+'>'+v+'</td>'; }).join('')+'</tr>'; }).join('');
  return (cls?'<div class="'+cls+'">':'')+'<table><tr>'+h+'</tr>'+b+'</table>'+(cls?'</div>':''); }
function T_resp_(p, c, mx){ var r=c?p/c:0; return '<div class="bar" style="margin:0"><span class="t"><span class="f" style="width:'+Math.max(2,Math.round(r/(mx||1)*100))+'%"></span></span><span class="x">'+Math.round(r*100)+'%</span></div>'; }
function T_g_(s){ return '<span class="m">'+esc_(s)+'</span>'; }
function T_b_(s){ return '<b>'+esc_(s)+'</b>'; }
function fmtInt_(n){ n=Math.round(Number(n)||0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function signed_(d){ return (d>0?'+':(d<0?'−':''))+human_(Math.abs(d)); }
function T_star_(s){ return (s&&(s.tier===1||s.tier===2))?'<span class="star">★</span> ':''; }
function cleanCell_(v){ return String(v==null?'':v).replace(/^'+/,'').trim(); }
function joinAnd_(a){ return a.length<=1?(a[0]||''):(a.slice(0,-1).join(', ')+' and '+a[a.length-1]); }
function weekLbl_(w){ return shortW_(w)||String(w||''); }
var RM_CODES={EUR:'Europe',EXUK:'Europe ex-UK',AR:'Argentina',AT:'Austria',AU:'Australia',BE:'Belgium',BG:'Bulgaria',BR:'Brazil',BY:'Belarus',CA:'Canada',CH:'Switzerland',CZ:'Czechia',DE:'Germany',DK:'Denmark',EE:'Estonia',ES:'Spain',FI:'Finland',FR:'France',GB:'United Kingdom',GH:'Ghana',GR:'Greece',HU:'Hungary',IE:'Ireland',IL:'Israel',IN:'India',IS:'Iceland',IT:'Italy',KE:'Kenya',LT:'Lithuania',LV:'Latvia',MK:'North Macedonia',MT:'Malta',MX:'Mexico',NG:'Nigeria',NL:'Netherlands',NO:'Norway',NZ:'New Zealand',PL:'Poland',PT:'Portugal',PY:'Paraguay',RO:'Romania',RS:'Serbia',RU:'Russia',SE:'Sweden',SI:'Slovenia',SK:'Slovakia',TR:'Turkey',UY:'Uruguay',UA:'Ukraine',MD:'Moldova',HR:'Croatia',AL:'Albania'};
// Radiomonitor columns are country codes ("LV", "DE-IFPI"): show the country name
function rmName_(code){ var c=String(code||'').trim(), m=c.toUpperCase().match(/^([A-Z]+)(-IFPI)?$/); if(!m) return c; var n=RM_CODES[m[1]]; return n?(n+(m[2]?' (IFPI)':'')):c; }
/* ---------------- data helpers ---------------- */
// every stored snapshot of a track, oldest first: [{week, f}]
var CIS_ = ['Russia','Belarus','Kazakhstan','Kyrgyzstan','Tajikistan','Uzbekistan','Armenia','Azerbaijan','Moldova','Ukraine','Turkmenistan','Georgia'];
// territories handled by an active licensing partner (status "started"), minus territories we sent ourselves
function licensedSet_(ctx){
  var set={}, sent={}; ((ctx&&ctx.territories)||[]).forEach(function(t){ if(t.sent) sent[ctryKey_(t.name)]=1; });
  ((ctx&&ctx.licensing)||[]).forEach(function(l){ if(String(l.status||'')!=='started') return;
    String(l.country||'').split(/\s*(?:\+|,|\/|&|\band\b)\s*/i).forEach(function(p){ p=p.trim(); if(!p) return;
      (/^cis$/i.test(p)?CIS_:[p]).forEach(function(c){ var k=ctryKey_(c); if(!sent[k]) set[k]=c; }); }); });
  return set;
}
// Shazam chart name → country it belongs to (charts are named "Spain - Dance", "Bucharest Romania", "Romania")
function shazamCountry_(name, markets){
  var f=fold_(String(name).split(/\s+-\s+/)[0]);
  var all=(markets||[]).concat([HOME_MARKET]).concat((typeof COUNTRIES!=='undefined'&&COUNTRIES)?COUNTRIES:[]);
  for (var i=0;i<all.length;i++){ var m=fold_(all[i]); if(m && (f===m || f.slice(-m.length-1)===' '+m)) return all[i]; }
  return '';
}
function shazamPeak_(r){ var p=parseInt(cleanCell_(r.peak).replace('#',''),10); return isNaN(p)?null:p; }
function shazamNow_(r){ var p=parseInt(cleanCell_(r.now).replace('#',''),10); return isNaN(p)?null:p; }
// count of stations on the contact list per country (all rows, with or without a contact)
function stationHasContact_(station, country){
  var list=radioContacts_()||[], ck=ctryKey_(country), cands=list.filter(function(c){return c.ck===ck;}); if(!cands.length) return false;
  var s={station:station, location:''}, cores=[stationCore_(station,country)], sReg=registryMatch_(station,country,importantMap_());
  return cands.some(function(c){ return svMatchScore_(s,cores,sReg,c)>=1; });
}
var SV_TYPE_LABEL = {major:'Major CHR', natother:'National', regional:'Regional', local:'Local'};
var SV_TYPE_RANK = {major:0, natother:1, regional:2, local:3};

/* ---------------- insights: one place that turns facts into the actions shown in the internal report ---------------- */
function buildInsights_(F, ctx, SV){
  var I={}, home=ctryKey_(HOME_MARKET), lic=licensedSet_(ctx), stations=(F.stations_c||[]).filter(function(s){return (s.plays||0)>0;});
  var sentSet={}; ((ctx&&ctx.territories)||[]).forEach(function(t){ if(t.sent) sentSet[ctryKey_(t.name)]=1; });
  var abroad=stations.filter(function(s){ return ctryKey_(s.country)!==home; });
  I.intlPlays=abroad.reduce(function(a,s){return a+s.plays;},0);
  // where the radio abroad comes from
  var contacted=(SV&&SV.contactsOk&&SV.mode!=='none')?(SV.plays||0):0;
  var licPlays=abroad.filter(function(s){ return lic[ctryKey_(s.country)] && !(s._contact && sentSet[s._contact.ck]); }).reduce(function(a,s){return a+s.plays;},0);
  I.split={contacted:contacted, licensed:licPlays, other:Math.max(0,I.intlPlays-contacted-licPlays), licLabel:((ctx&&ctx.licensing)||[]).filter(function(l){return String(l.status||'')==='started';}).map(function(l){return l.country;}).join(', ')};
  // markets abroad, by plays
  var byM={}; abroad.forEach(function(s){ var k=ctryKey_(s.country); var m=byM[k]||(byM[k]={name:s.country, k:k, plays:0, stations:0, list:[]}); m.plays+=s.plays; m.stations++; m.list.push(s); });
  var markets=Object.keys(byM).map(function(k){return byM[k];}).sort(function(a,b){return b.plays-a.plays;});
  markets.forEach(function(m,i){ m.rank=i+1; });
  // shazam peaks per country
  var names=markets.map(function(m){return m.name;}).concat(((ctx&&ctx.territories)||[]).map(function(t){return t.name;}));
  var shz={}; (F.shazam||[]).forEach(function(r){ var c=shazamCountry_(r.name,names), p=shazamPeak_(r); if(!c||p==null) return; var k=ctryKey_(c); if(!shz[k]||p<shz[k].peak) shz[k]={peak:p, chart:r.name, country:c}; });
  I.shazam=shz;
  var counts=contactListCounts_(), withC={}; (radioContacts_()||[]).forEach(function(c){ withC[c.ck]=(withC[c.ck]||0)+1; });
  // 01a send these markets: traction (≥50 plays or a Shazam peak), not sent, not licensed, not home
  var cand={}; markets.forEach(function(m){ if(m.plays>=50) cand[m.k]={name:m.name, plays:m.plays, rank:m.rank}; });
  Object.keys(shz).forEach(function(k){ if(!cand[k] && k!==home) cand[k]={name:shz[k].country, plays:(byM[k]||{}).plays||0, rank:(byM[k]||{}).rank||null}; });
  I.send=Object.keys(cand).filter(function(k){ return !sentSet[k] && !lic[k] && k!==home && !(cand[k].plays<50 && !(withC[k]>0)); }).map(function(k){ var c=cand[k];
      return {name:c.name, k:k, plays:c.plays, rank:c.rank, shazam:shz[k]||null, onList:counts[k]||0, withContact:withC[k]||0}; })
    .sort(function(a,b){ return (b.plays-a.plays)||((a.shazam?a.shazam.peak:999)-(b.shazam?b.shazam.peak:999)); }).slice(0,4);
  // 01b push to rotation: stations new this week, still on 1-4 plays
  I.push=stations.filter(function(s){ return s.isNew && s.plays<=4 && ctryKey_(s.country)!==home; })
    .sort(function(a,b){ return ((a.tier===1||a.tier===2)?0:1)-((b.tier===1||b.tier===2)?0:1) || b.plays-a.plays; }).slice(0,5);
  // 01c find contacts: playing it abroad, no contact on our list
  I.find=abroad.filter(function(s){ return !s._contact && s.plays>=5; }).sort(function(a,b){return b.plays-a.plays;}).slice(0,6);
  I.outside=Object.keys(shz).filter(function(k){ return k!==home && !(withC[k]>0) && !sentSet[k]; }).map(function(k){ return {name:shz[k].country, peak:shz[k].peak, onList:counts[k]||0}; });
  // 02 follow up: contacted (sent territories), not playing, best types first
  var proof={}; stations.forEach(function(s){ var k=ctryKey_(s.country); if(!proof[k]||s.plays>proof[k].plays) proof[k]=s; });
  I.follow=[];
  if (SV && SV.contactsAll){
    I.follow=SV.contactsAll.filter(function(c){ return sentSet[c.ck] && !(c._plays>0) && c.type!=='local'; })
      .sort(function(a,b){ return (relRank_(a)-relRank_(b)) || (typeRank_(a)-typeRank_(b)) || ((b.rotonPlays||0)-(a.rotonPlays||0)); })
      .slice(0,8).map(function(c){ var p=proof[c.ck], z=shz[c.ck], angle;
        if (p && p.plays>=20) angle=p.station+' ('+fmtInt_(p.plays)+' plays) as proof';
        else if (z) angle='Shazam '+z.chart.replace(/\s*-\s*/,' ')+' peak (#'+z.peak+')';
        else if (c.rotonPlays>0) angle='Played Roton tracks before';
        else angle='Second mail with the radio numbers';
        return {station:c.station, country:c.country, type:((c.genre&&!/^(chr|mixed|pop)$/i.test(c.genre))?(SV_TYPE_LABEL[c.type]||'')+' · '+c.genre:(SV_TYPE_LABEL[c.type]||'')), angle:angle}; });
  }
  // 03 streaming
  var pct=(F.avg_day!=null&&F.avg_day_prev)?(F.avg_day-F.avg_day_prev)/F.avg_day_prev*100:null;
  var dropped=(F.dropped||[]).filter(function(p){ return p.removed; }).slice(0,3), keep=(F.playlists||[])[0];
  var st=[]; if (pct!=null) st.push(human_(F.avg_day)+'/day, '+(pct>=0?'up ':'down ')+Math.abs(pct).toFixed(0)+'% on '+weekLbl_(F.baseline_label||'last week')+'.');
  if (dropped.length) st.push('Left '+joinAnd_(dropped.map(function(p){return p.name;}))+(dropped[0].removed?(' (since '+dropped[0].removed+')'):'')+'.');
  if (keep) st.push('Still on '+keep.name+' ('+human_(keep.followers)+').');
  var angle=[]; if (F.radio_stations) angle.push(F.radio_stations+' radio stations'); var bz=Object.keys(shz).map(function(k){return shz[k];}).sort(function(a,b){return a.peak-b.peak;})[0]; if(bz) angle.push('the '+bz.chart.replace(/\s*-\s*/,' ')+' Shazam run');
  I.streaming={pct:pct, text:st.join(' ')+(angle.length?(' New angle for the pitch: <b>'+esc_(joinAnd_(angle))+'</b>.'):''), title:(pct!=null&&pct<=-T_STREAM)?'Re-pitch Spotify editorial':'Keep pitching Spotify editorial'};
  I.markets=markets; I.sentSet=sentSet;
  return I;
}
function typeRank_(c){ return (c.type in SV_TYPE_RANK)?SV_TYPE_RANK[c.type]:3; }
function relRank_(c){ var r=String(c.relevance||'').toLowerCase(); if(!r) return 1; if(/^1$|high|top|a$/.test(r)) return 0; if(/^3$|low|c$/.test(r)) return 2; return 1; }

/* =====================================================================================================
 * INTERNAL REPORT
 * ===================================================================================================== */
function renderInternalV2_(F, read, ctx, week){
  var SV=null; try{ SV=buildServicing_(F, ctx); }catch(e){ Logger.log('servicing: '+e); }
  var I=buildInsights_(F, ctx, SV), P=read.prevSnap||null, C=true, T=F.title, L=T+' · Roton Music';
  var pct=read.pct, rd=(P&&P.radio_plays!=null&&F.radio_plays!=null&&!F.radio_old)?F.radio_plays-P.radio_plays:null, sd=(P&&P.radio_stations!=null&&F.radio_stations!=null&&!F.radio_old)?F.radio_stations-P.radio_stations:null;
  // ---- lead
  var lead=[];
  if (F.radio_plays==null) lead.push('No station-level radio data this week.');
  else if (rd!=null) lead.push((rd>0?'Radio is growing (<b>':'Radio is flat (<b>')+signed_(rd)+' plays, '+signed_(sd||0)+' stations</b>)');
  else lead.push('Radio: <b>'+human_(F.radio_plays)+' plays on '+F.radio_stations+' stations</b>');
  if (pct!=null) lead[lead.length-1]+=(pct<=-T_STREAM?' while Spotify cools (<b>':(pct>=T_STREAM?' and Spotify is up (<b>':' and Spotify holds (<b>'))+human_(F.avg_day)+'/day, '+(pct>=0?'up ':'down ')+Math.abs(pct).toFixed(0)+'%</b>).';
  else lead[lead.length-1]+='.';
  if (SV && SV.contactsOk && SV.mode!=='none' && I.intlPlays>0) lead.push('<b>'+Math.round(I.split.contacted/I.intlPlays*100)+'%</b> of the radio abroad comes from contacted stations on our list.');
  if (I.send.length){ var top=I.send.filter(function(m){return m.rank&&m.rank<=10;}); if(top.length) lead.push('<b>'+esc_(joinAnd_(top.slice(0,2).map(function(m){return m.name;})))+' '+(top.length>1?'were':'was')+' never sent</b> and '+(top.length>1?'are':'is')+' already top 10 abroad.'); }
  // ---- scoreboard
  var respRate=(SV&&SV.contactsOk&&SV.mode!=='none'&&SV.contacted)?Math.round(SV.playing/SV.contacted*100)+'%':'—';
  var score=[
    ['Radio plays', F.radio_plays!=null?human_(F.radio_plays):'n/a', F.radio_old?('old · '+weekLbl_(F.radio_old)):(rd!=null?signed_(rd):''), rd>0?'up':(rd<0?'dn':'')],
    ['Radio stations', F.radio_stations!=null?String(F.radio_stations):'n/a', sd!=null?signed_(sd):'', sd>0?'up':(sd<0?'dn':'')],
    ['Spotify / day', human_(F.avg_day), pct!=null?((pct>=0?'+':'−')+Math.abs(pct).toFixed(0)+'%'):'', pct==null?'':(pct>=0?'up':'dn')],
    ['Response rate', respRate, (SV&&SV.contacted)?(SV.playing+' of '+SV.contacted+' contacted'):'no territory sent', '']];
  var split='', S2=I.split, tot=I.intlPlays||0;
  if (tot>0){ var w=function(x){return Math.round(x/tot*100);};
    split=T_sh_('Where the radio abroad comes from', fmtInt_(tot)+' plays outside '+esc_(HOME_MARKET))
      +'<div class="stack">'+(S2.contacted?'<span style="width:'+w(S2.contacted)+'%;background:var(--green)">'+w(S2.contacted)+'%</span>':'')
      +(S2.licensed?'<span style="width:'+w(S2.licensed)+'%;background:var(--amber);color:var(--ink)">'+w(S2.licensed)+'%</span>':'')
      +'<span style="width:'+Math.max(0,100-w(S2.contacted)-w(S2.licensed))+'%;background:#b9b9be">'+w(S2.other)+'%</span></div>'
      +'<div class="leg"><span><i class="sq" style="background:var(--green)"></i><b>'+fmtInt_(S2.contacted)+'</b> contacted, from our list</span>'
      +(S2.licensed?'<span><i class="sq" style="background:var(--amber)"></i><b>'+fmtInt_(S2.licensed)+'</b> licensing ('+esc_(S2.licLabel)+')</span>':'')
      +'<span><i class="sq" style="background:#b9b9be"></i><b>'+fmtInt_(S2.other)+'</b> not contacted</span></div><div class="gap"></div>'; }
  var mv=[];
  var ex=[]; if(I.send.length) ex.push('send '+joinAnd_(I.send.slice(0,2).map(function(m){return m.name;}))); if(I.push.length) ex.push('push '+I.push.length+' new station'+(I.push.length>1?'s':'')); if(I.find.length) ex.push('find '+I.find.length+' contact'+(I.find.length>1?'s':''));
  mv.push(['01','Expand', ex.length?(ex.join(', ').replace(/^./,function(c){return c.toUpperCase();})+'.'):'Nothing new to expand this week.']);
  var fuC=[]; I.follow.forEach(function(f){ if(fuC.indexOf(f.country)<0) fuC.push(f.country); });
  mv.push(['02','Follow up', I.follow.length?(I.follow.length+' priority station'+(I.follow.length>1?'s':'')+' in '+joinAnd_(fuC.slice(0,4))+'.'):'No priority station waiting for a follow-up.']);
  mv.push(['03','Streaming', I.streaming.title+'.']);
  var checks=(read.checks||[]).slice(); var unr=(F.stations_c||[]).filter(function(s){return !s.rated && s.plays>=100;}).slice(0,2);
  unr.forEach(function(s){ checks.push(s.station+' ('+fmtInt_(s.plays)+' plays) has no tier yet.'); });
  var p1=T_hero_({label:'Weekly report', conf:C, artist:F.artist||'', title:T, sub:week+(F.baseline_label?(' · compared to '+F.baseline_label):' · first week tracked'), lead:lead.join(' ')})
    +'<div class="body">'+T_sh_('Scoreboard', F.baseline_label?('vs '+esc_(F.baseline_label)):'')+T_nums_(score)+'<div class="gap"></div>'+split
    +T_sh_('Next moves','details on the next pages')+mv.map(function(m){ return '<div class="mv"><span class="i H">'+m[0]+'</span><span><b>'+m[1]+'.</b> '+esc_(m[2])+'</span></div>'; }).join('')
    +(checks.length?'<div class="note" style="margin-top:4mm"><b>Data check:</b> '+checks.map(esc_).join(' ')+'</div>':'')
    +'</div>'+T_foot_(L,C);

  // ---- servicing
  var li=contactListInfo_(), p2;
  var src='<div class="note">Source: '+(li?('<b>'+esc_(li.name)+'</b>, read fresh at this run ('+li.stations+' stations with a contact, last edited '+esc_(li.edited)+')'):'contact list')+'. '+esc_(HOME_MARKET)+' is serviced separately.</div>';
  if (!SV || !SV.contactsOk) p2=T_thin_('Servicing',C)+'<div class="body">'+T_sh_('Response rate')+'<div class="txt">The contact list could not be opened, so servicing is not measured this week.</div></div>'+T_foot_(L,C);
  else if (SV.mode==='none') p2=T_thin_('Servicing',C)+'<div class="body">'+T_sh_('Response rate','no territory marked as sent')
      +'<div class="txt">No territory is ticked as sent for this track. Tick the territories in the app and this page measures them in the next report.</div><div class="gap"></div>'
      +T_sh_('Stations from our list already playing it')+T_table_(['Territory','Stations on air','Plays'],(SV.onList||[]).slice(0,10).map(function(r){return [T_b_(r.name),String(r.stations),T_b_(fmtInt_(r.plays))];}),[1,2])+src+'</div>'+T_foot_(L,C);
  else {
    var on=(SV.rows||[]).filter(function(r){return r.playing>0;}), off=(SV.allRows||SV.rows||[]).filter(function(r){return r.playing===0;});
    var mx=Math.max.apply(null,on.map(function(r){return r.playing/r.contacted;}).concat([0.0001]));
    var cats=SV_CATS.map(function(c){ var r=SV.cats[c.key]; return [c.label,r.contacted,r.playing,r.plays]; }), mx2=Math.max.apply(null,cats.map(function(c){return c[1]?c[2]/c[1]:0;}).concat([0.0001]));
    p2=T_thin_('Servicing',C)+'<div class="body">'+T_sh_('Response rate','contacted stations from the contact list')
      +T_nums_([['Contacted',String(SV.contacted),SV.sentCount+' territories',''],['On air',String(SV.playing),SV.newPlaying?('+'+SV.newPlaying+' this week'):'no new adds',SV.newPlaying?'up':''],
                ['Response rate',Math.round(SV.playing/Math.max(1,SV.contacted)*100)+'%','contacted → on air',''],['Plays from them',human_(SV.plays),(I.intlPlays?Math.round(SV.plays/I.intlPlays*100):0)+'% of plays abroad','']])
      +'<div class="gap"></div>'+T_sh_('By territory','territories with a station on air')
      +(on.length?T_table_(['Territory','Contacted','On air','Response','Plays'],on.map(function(r){return [T_b_(r.name),T_g_(String(r.contacted)),String(r.playing),T_resp_(r.playing,r.contacted,mx),T_b_(fmtInt_(r.plays))];}),[1,2,4]):'<div class="txt">No contacted station plays it yet.</div>')
      +(off.length?'<div class="note"><b>No station on air yet:</b> '+off.map(function(r){return esc_(r.name)+' ('+r.contacted+')';}).join(', ')+(SV.noContacts&&SV.noContacts.length?('. No contacts on our list: '+esc_(SV.noContacts.join(', '))):'')+'.</div>':'')
      +'<div class="gap"></div>'+T_sh_('By station type','type as set in the list')
      +T_table_(['Station type','Contacted','On air','Response','Plays'],cats.map(function(c){return [esc_(c[0]),T_g_(String(c[1])),String(c[2]),T_resp_(c[2],c[1],mx2),T_b_(fmtInt_(c[3]))];}),[1,2,4])
      +src+'</div>'+T_foot_(L,C);
  }

  // ---- 01 expand
  var p3=T_thin_('What we could do next',C)+'<div class="body"><div class="tag t1 H">01 · Expand</div>'+T_sh_('Grow the footprint','markets, new stations, new contacts')
    +'<div class="sub2">Send these markets<span>traction, not sent yet</span></div>'
    +(I.send.length?T_table_(['Market','Radio plays','Shazam peak','On our list','With a contact'],I.send.map(function(m){ return [T_b_(m.name),T_b_(fmtInt_(m.plays)),m.shazam?('#'+m.shazam.peak+' '+esc_(String(m.shazam.chart).split(/\s+-\s+/)[1]||'')):T_g_('—'),String(m.onList),T_b_(String(m.withContact))]; }),[1,2,3,4]):'<div class="txt">No unsent market with traction this week.</div>')
    +'<div class="sub2">Push to rotation<span>new this week, still on a few plays</span></div>'
    +(I.push.length?T_table_(['Station','Market','First play','Plays'],I.push.map(function(s){return [T_star_(s)+T_b_(s.station),T_g_(s.country),esc_(s.first||''),String(s.plays)];}),[2,3]):'<div class="txt">No new station on test spins this week.</div>')
    +'<div class="sub2">Find contacts<span>playing it, no contact on our list · also in the weekly contacts list</span></div>'
    +(I.find.length?T_table_(['Station','Market','Station class','Plays'],I.find.map(function(s){return [T_star_(s)+T_b_(s.station),T_g_(s.country),T_g_(s.tier===1?'top station':(s.tier===2?'relevant':(s.rated?'minor':'unrated'))),T_b_(fmtInt_(s.plays))];}),[3]):'<div class="txt">Every station playing it abroad has a contact on our list.</div>')
    +(I.outside.length?'<div class="note"><b>Outside our list:</b> '+I.outside.map(function(o){return esc_(o.name)+' is on the Shazam chart (#'+o.peak+') with no station with a contact on our list';}).join('; ')+'. Add 3 to 5 CHR and dance stations.</div>':'')
    +'</div>'+T_foot_(L,C);
  // ---- 02 follow up + 03 streaming
  var p4=T_thin_('What we could do next',C)+'<div class="body"><div class="tag t2 H">02 · Follow up</div>'+T_sh_('Priority stations not playing it yet','contacted, no plays')
    +(I.follow.length?T_table_(['Station','Market','Type','Angle'],I.follow.map(function(f){return [T_b_(f.station),T_g_(f.country),T_g_(f.type),esc_(f.angle)];})):'<div class="txt">'+((SV&&SV.mode==='none')?'No territory is ticked as sent, so there is nobody to follow up yet.':'No priority station waiting for a follow-up.')+'</div>')
    +'<div class="gap"></div><div class="tag t3 H">03 · Streaming</div>'+T_sh_(I.streaming.title, human_(F.avg_day)+'/day')
    +'<div class="txt">'+(I.streaming.text||'No streaming change worth acting on.')+'</div>'
    +'</div>'+T_foot_(L,C);

  // ---- detail: radio
  var nr=(F.new_major||[]).concat(F.new_minor||[]).slice(0,10);
  var p5=T_thin_('Radio detail',C)+'<div class="body">'
    +(F.radio_old?'<div class="note" style="margin:0 0 5mm">Radio not updated this week: figures are the last available ('+esc_(weekLbl_(F.radio_old))+').</div>':'')
    +T_sh_('New stations this week', (F.new_major_n||0)+' major · '+((F.new_minor||[]).length)+' minor')
    +(nr.length?T_table_(['Station','Market','First play','Plays'],nr.map(function(s){return [T_star_(s)+T_b_(s.station),T_g_(s.country),esc_(s.first||''),String(s.plays)];}),[2,3],'tight'):'<div class="txt">No new stations this week.</div>')
    +'<div class="gap"></div>'+T_sh_('Key stations by market', esc_(HOME_MARKET)+' capped at 3 · ★ top / relevant station')
    +((F.by_market||[]).length?T_table_(['Market','Station','Location','Plays'],(F.by_market||[]).map(function(r){ var s=r.s; return [r.market?T_b_(r.market):'',T_star_(s)+esc_(s.station)+(s.isNew?' <span class="pill new">new</span>':''),T_g_(s.location),T_b_(fmtInt_(s.plays))]; }),[3],'tight'):'<div class="txt">No station data this week.</div>')
    +'</div>'+T_foot_(L,C);
  // ---- detail: markets & airplay
  var curAir=(F.airplay||[]).filter(function(a){return a[1]<=200;}), charts=airplayChartsFor_(F.title);
  var p6=T_thin_('Markets & airplay',C)+'<div class="body"><div class="two"><div>'+T_sh_('Top markets','radio plays')+T_bars_((F.markets||[]).slice(0,10))+'</div>'
    +'<div>'+T_sh_('Airplay now','top 200 · Radiomonitor')+(curAir.length?T_table_(['Market','Position'],curAir.slice(0,10).map(function(a){return [T_b_(rmName_(a[0])),T_b_('#'+a[1])];}),[1]):'<div class="txt">No airplay position in the top 200.</div>')+'</div></div>'
    +(charts.length?'<div class="gap"></div>'+T_sh_('Radio charts','standings & longevity')+T_table_(['Market','Now','Peak','Weeks'],charts.map(function(c){ var now=(c.current&&c.current!=='N/A')?('#'+esc_(c.current)):T_g_('—'); return [T_b_(rmName_(c.market)),now,c.peak?('#'+esc_(c.peak)):T_g_('—'),T_g_((c.weeks||'—')+' in top '+c.tier)]; }),[1,2,3]):'')
    +'</div>'+T_foot_(L,C);
  // ---- detail: streaming, shazam, social
  var shRows=(F.shazam||[]).map(function(r){ var now=shazamNow_(r); return [T_b_(r.name),T_g_(r.type),now!=null?T_b_('#'+now):T_g_('—'),'#'+esc_(cleanCell_(r.peak).replace('#','')),T_g_(cleanCell_(r.days)+'d')]; });
  var p7=T_thin_('Streaming · Shazam · Social',C)+'<div class="body">'+T_sh_('Spotify', F.songstats_old?('last available '+esc_(weekLbl_(F.songstats_old))):'playlists & streams')
    +T_nums_([['Total streams',human_(F.total_streams),'',''],['Last 7 days',human_(F.last7),'',''],['Streams / day',human_(F.avg_day),pct!=null?((pct>=0?'+':'−')+Math.abs(pct).toFixed(0)+'%'):'',pct==null?'':(pct>=0?'up':'dn')],['Playlists',(F.playlists_cur||0)+' / '+(F.playlists_total||0),'current / total','']])
    +'<div class="gap"></div><div class="two"><div>'+T_sh_('Current playlists','biggest')+((F.playlists||[]).length?T_table_(['Playlist','Followers'],(F.playlists||[]).slice(0,6).map(function(p){return [esc_(p.name)+'<div class="m" style="font-size:8pt">'+esc_(p.owner)+'</div>',T_b_(human_(p.followers))];}),[1],'tight'):'<div class="txt">No current playlists.</div>')+'</div>'
    +'<div>'+T_sh_('Left playlists','biggest')+((F.dropped||[]).length?T_table_(['Playlist','Left'],(F.dropped||[]).slice(0,6).map(function(p){return [esc_(p.name)+'<div class="m" style="font-size:8pt">'+human_(p.followers)+' followers</div>',T_g_(p.removed||'')];}),[1],'tight'):'<div class="txt">None.</div>')+'</div></div>'
    +'<div class="gap"></div>'+T_sh_('Shazam','now / peak')+(shRows.length?T_table_(['Chart','Type','Now','Peak','Days'],shRows,[2,3,4],'tight'):'<div class="txt">No Shazam chart.</div>')
    +'<div class="gap"></div>'+T_sh_('Social','views to date')+T_nums_([['TikTok',human_(F.tk_views),(F.tk_vids||0)+' videos',''],['Instagram',human_(F.ig_views),(F.ig_vids||0)+' reels',''],['YouTube',human_(F.yt_views),human_(F.yt_likes)+' likes',''],['YouTube Shorts',human_(F.yt_sh_views),human_(F.yt_sh_likes)+' likes','']])
    +'</div>'+T_foot_(L,C);

  F._svForTasks=SV; F._insights=I;
  return T_number_(T_doc_(reportFileName_(F.title, week, false).replace(/\.html$/,''), [p1,p2,p3,p4,p5,p6,p7].map(T_page_)));
}

/* =====================================================================================================
 * PARTNER REPORT (growth and peaks only)
 * ===================================================================================================== */
function renderPartnerV2_(F, prevF, week){
  var T=F.title, L=T+' · Roton Music', pos=function(c,p){ return (c!=null&&p!=null&&c-p>0)?('+'+human_(c-p)):''; };
  var snaps=[]; try{ snaps=trackSnaps_(T).filter(function(s){ return repWeekIdx_(s.week)<repWeekIdx_(week); }); }catch(e){}
  var soc=[['TikTok',F.tk_views||0,(F.tk_vids||0)+' creator videos'],['YouTube',F.yt_views||0,human_(F.yt_likes)+' likes'],['Instagram',F.ig_views||0,(F.ig_vids||0)+' reels']].sort(function(a,b){return b[1]-a[1];})[0];
  // streams shown next to the social highlight: when that highlight is YouTube, count Spotify only, so YouTube is not counted twice
  var ytHi=soc[0]==='YouTube'&&soc[1]>0, STR=ytHi?(F.total_streams||0):(F.combined||0), STRp=prevF?(ytHi?prevF.total_streams:prevF.combined):null, STRL=ytHi?'Spotify streams':'Streams', STRl=ytHi?'Spotify streams':'streams';
  var lead=[];
  if (F.radio_plays!=null){ var d=prevF&&prevF.radio_plays!=null?F.radio_plays-prevF.radio_plays:0, ds=prevF&&prevF.radio_stations!=null?F.radio_stations-prevF.radio_stations:0;
    lead.push(esc_(T)+' '+(d>0?'keeps growing on radio':'is on air')+': <b>'+human_(F.radio_plays)+' plays on '+F.radio_stations+' stations</b>'+((d>0||ds>0)?(', '+(d>0?(fmtInt_(d)+' more plays'):'')+(d>0&&ds>0?' and ':'')+(ds>0?(ds+' more stations'):'')+' than last week'):'')+'.'); }
  var tail=[]; if (STR) tail.push('<b>'+human_(STR)+' '+STRl+'</b>'); if (soc[1]) tail.push('<b>'+human_(soc[1])+' '+soc[0]+' views</b>');
  if (tail.length) lead.push('It has passed '+tail.join(' and ')+'.');
  var stations=(F.stations_c&&F.stations_c.length)?F.stations_c:(F.top_stations||[]);
  var top=stations.slice().sort(function(a,b){return b.plays-a.plays;}).slice(0,8);
  var p1=T_hero_({label:'Performance snapshot', artist:F.artist||'', title:T, sub:week+' · Roton Music', lead:lead.join(' ')})
    +'<div class="body">'+T_sh_('This week','growth vs last week')
    +T_nums_([['Radio plays',F.radio_plays!=null?human_(F.radio_plays):'—',pos(F.radio_plays,prevF&&prevF.radio_plays),'up'],['Radio stations',F.radio_stations!=null?String(F.radio_stations):'—',pos(F.radio_stations,prevF&&prevF.radio_stations),'up'],
              [STRL,human_(STR),pos(STR,STRp),'up'],[soc[0]+' views',human_(soc[1]),soc[2],'']])
    +'<div class="gap"></div><div class="two"><div>'+T_sh_('On air in','radio plays')+T_bars_((F.markets||[]).slice(0,8))+'</div>'
    +'<div>'+T_sh_('Top stations','radio plays')+(top.length?T_table_(['Station','Market','Plays'],top.map(function(s){return [T_star_(s)+esc_(s.station),T_g_(s.country),T_b_(fmtInt_(s.plays))];}),[2]):'<div class="txt">Station detail not tracked for this track.</div>')
    +'<div class="note">★ priority station in its market</div></div></div></div>'+T_foot_(L,false);

  // radio growth page
  var series=snaps.filter(function(s){return s.f&&s.f.radio_plays!=null;}).map(function(s){return {w:weekLbl_(s.week), p:s.f.radio_plays, st:s.f.radio_stations};}).slice(-6);
  if (F.radio_plays!=null) series.push({w:weekLbl_(week), p:F.radio_plays, st:F.radio_stations});
  var p2=null;
  if (series.length>=2){
    var mx=Math.max.apply(null,series.map(function(x){return x.p;}).concat([1]));
    var chart='<div class="chart">'+series.map(function(x,i){ return '<div class="c'+(i===series.length-1?' last':'')+'"><div class="bv">'+human_(x.p)+'</div><div class="bb" style="height:'+Math.round(x.p/mx*82)+'%"></div></div>'; }).join('')+'</div>'
      +'<div class="xl">'+series.map(function(x){return '<span><b>'+esc_(x.w)+'</b>'+(x.st||0)+' stations</span>';}).join('')+'</div>';
    var base=series.length>=5?snaps[snaps.length-4]:snaps[0]; // ~4 weeks back
    var bm={}; ((base&&base.f&&base.f.markets)||[]).forEach(function(m){ bm[norm_(m[0])]=m[1]; });
    var grow=(F.markets||[]).filter(function(m){ var b=bm[norm_(m[0])]; return b && m[1]>b; }).map(function(m){ return [m[0],bm[norm_(m[0])],m[1]]; }).slice(0,7);
    var facts=[], first=series[0];
    if (F.radio_plays!=null) facts.push('On <b>'+F.radio_stations+' radio stations</b> with <b>'+human_(F.radio_plays)+' plays</b>'+(first.st&&first.st<F.radio_stations?(', up from '+first.st+' stations in '+esc_(first.w)):'')+'.');
    if (grow.length){ var g0=grow.slice().sort(function(a,b){return (b[2]/b[1])-(a[2]/a[1]);})[0]; facts.push('Plays are up <b>×'+(g0[2]/g0[1]).toFixed(1)+' in '+esc_(g0[0])+'</b> since '+esc_(weekLbl_(base.week))+(grow.length>1?(' and growing in '+esc_(joinAnd_(grow.filter(function(x){return x!==g0;}).slice(0,3).map(function(x){return x[0];})))):'')+'.'); }
    var pk=(F.shazam||[]).map(function(r){return {n:r.name,p:shazamPeak_(r)};}).filter(function(x){return x.p!=null&&x.p<=200;}).sort(function(a,b){return a.p-b.p;}).slice(0,2);
    var air=(F.airplay||[]).filter(function(a){return a[1]<=200;})[0];
    if (pk.length||air) facts.push((pk.length?('On the <b>Shazam charts</b> in '+esc_(joinAnd_(pk.map(function(x){return x.n.replace(/\s*-\s*/,' ')+' (#'+x.p+')';})))):'')+(pk.length&&air?', ':'')+(air?('top 200 airplay in '+esc_(rmName_(air[0]))+' (#'+air[1]+')'):'')+'.');
    var ed=(F.playlists||[]).concat(F.dropped||[]).some(function(p){return /^spotify$/i.test(p.owner);});
    facts.push('<b>'+human_(STR)+' '+STRl+'</b>'+(ed?', Spotify editorial support':'')+(soc[1]?(' and <b>'+human_(soc[1])+' '+soc[0]+' views</b>'):'')+'.');
    p2=T_thin_('Radio growth',false)+'<div class="body">'+T_sh_('Radio plays to date','by report week')+chart
      +(grow.length?'<div class="gap"></div>'+T_sh_('Growth by market','radio plays, '+esc_(weekLbl_(base.week))+' vs now')+T_table_(['Market',esc_(weekLbl_(base.week)),esc_(weekLbl_(week)),'Growth'],grow.map(function(g){return [T_b_(g[0]),T_g_(fmtInt_(g[1])),T_b_(fmtInt_(g[2])),'<span style="color:var(--green);font-weight:650">×'+(g[2]/g[1]).toFixed(1)+'</span>'];}),[1,2,3]):'')
      +'<div class="gap"></div>'+T_sh_('Pitch facts','ready to paste into a mail')+'<div class="facts">'+facts.map(function(f,i){return '<div><span>0'+(i+1)+'</span><span>'+f+'</span></div>';}).join('')+'</div>'
      +'</div>'+T_foot_(L,false);
  }
  // charts, playlists, social, new
  var peaks=[]; (F.shazam||[]).forEach(function(r){ var p=shazamPeak_(r); if(p!=null) peaks.push([esc_(String(r.name).replace(/\s*-\s*/,' · ')),T_g_('Shazam'),T_g_(cleanCell_(r.days)+' days'),T_b_('#'+p),p]); });
  airplayChartsFor_(T).forEach(function(c){ var p=parseInt(c.peak,10); if(!isNaN(p)&&p<=200) peaks.push([esc_(rmName_(c.market)),T_g_('Airplay (Radiomonitor)'),T_g_((c.weeks||'1')+' weeks'),T_b_('#'+p),p]); });
  peaks.sort(function(a,b){return a[4]-b[4];});
  var pl={}; (F.playlists||[]).concat(F.dropped||[]).forEach(function(p){ var k=norm_(p.name); if(!pl[k]||p.followers>pl[k].followers) pl[k]=p; });
  var feat=Object.keys(pl).map(function(k){return pl[k];}).sort(function(a,b){return b.followers-a.followers;}).slice(0,5);
  var nw=(F.new_major||[]).concat(F.new_minor||[]).filter(function(s){return ctryKey_(s.country)!==ctryKey_(HOME_MARKET)||s.tier;}).slice(0,6);
  var p3=T_thin_('Charts · playlists · social',false)+'<div class="body">'
    +(peaks.length?T_sh_('Best chart positions','peak reached')+T_table_(['Chart','Source','Time on chart','Peak'],peaks.slice(0,5).map(function(r){return r.slice(0,4);}),[3])+'<div class="gap"></div>':'')
    +(feat.length?T_sh_('Featured on','★ Spotify editorial')+T_table_(['Playlist','Curator','Followers'],feat.map(function(p){ var ed=/^spotify$/i.test(p.owner); return [(ed?'<span class="star">★</span> ':'')+esc_(p.name),T_g_(p.owner),T_b_(human_(p.followers))]; }),[2])+'<div class="gap"></div>':'')
    +T_sh_('Social','views to date')+T_nums_([['TikTok',human_(F.tk_views),human_(F.tk_likes)+' likes',''],['Instagram',human_(F.ig_views),human_(F.ig_likes)+' likes',''],['YouTube',human_(F.yt_views),human_(F.yt_likes)+' likes',''],['YouTube Shorts',human_(F.yt_sh_views),human_(F.yt_sh_likes)+' likes','']])
    +(nw.length?'<div class="gap"></div>'+T_sh_('New on air this week','first play')+T_table_(['Station','Market','First play'],nw.map(function(s){return [T_star_(s)+esc_(s.station),T_g_(s.country),esc_(s.first||'')];}),[2]):'')
    +'</div>'+T_foot_(L,false);
  return T_number_(T_doc_(reportFileName_(T, week, true).replace(/\.html$/,''), [p1,p2,p3].filter(Boolean).map(T_page_)));
}

/* =====================================================================================================
 * WEEKLY "NEW CONTACTS TO FIND" (all tracks of a week)
 *   ContactCand sheet: candidates per week+track (re-running a track replaces its rows)
 *   ContactTasks sheet: one row per station task, carried across weeks
 * ===================================================================================================== */
var CAND_H=['week','track','key','station','country','plays','kind','signal'];
var TASK_H=['key','station','country','kind','firstWeek','lastSeenWeek','status','closedWeek','plays','tracks','signal'];
var LOGO_B64 = "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";
/* ===================== overrides: JSON database instead of Sheets/Drive ===================== */
DB = DB || {};
DB.registry = DB.registry || [];            // [[country, station, tier, aliases, note]]
DB.contacts = DB.contacts || null;          // {name, updated, header:[], rows:[[]]}
DB.airplayManual = DB.airplayManual || [];  // [[track, market, current, peak, weeks, tier]]
DB.airplayTracker = DB.airplayTracker || [];// [[track, market, current, peak, weeks100, weeks200, lastWeek]]
DB.songs = DB.songs || [];
DB.history = DB.history || {};              // {songKey: [{week, f}]}
DB.tasks = DB.tasks || [];
DB.cands = DB.cands || {};                  // {week: [{track,key,station,country,plays,kind,signal}]}
DB.registryAdds = DB.registryAdds || [];

function songFor_(display){
  var d = norm_(display), hit = null;
  DB.songs.forEach(function(s){ if (!hit && [s.name].concat(s.aliases || []).some(function(n){ return norm_(n) === d; })) hit = s; });
  if (!hit) DB.songs.forEach(function(s){ if (hit) return; [s.name].concat(s.aliases || []).forEach(function(n){ n = norm_(n); if (!hit && n && (n.indexOf(d) >= 0 || d.indexOf(n) >= 0)) hit = s; }); });
  return hit;
}
function songKey_(display){ var s = songFor_(display); return s ? s.id : ('t:' + norm_(display)); }

var _impMap = null, _toClassify = {}, _contacts = null, _listCounts = null;
function importantMap_(){
  if (_impMap) return _impMap; var m = {};
  DB.registry.forEach(function(r){ var c = ctryKey_(r[0]), n = String(r[1] || '').trim(); if (!c || !n) return;
    var t = String(r[2] == null ? '' : r[2]).trim(), tier = (t === '' ? 0 : (parseInt(t, 10) || 0));
    var names = [n].concat(String(r[3] || '').split(/[;\n]/).map(function(a){ return a.trim(); }).filter(String));
    (m[c] = m[c] || []).push({ n: n, tier: tier, needles: names.map(function(x){ return { f: fold_(x), k: nk_(x) }; }).filter(function(x){ return x.k.length >= 2; }) }); });
  _impMap = m; return m;
}
function queueToClassify_(s, track){ var k = ctryKey_(s.country) + '|' + autoKey_(s.station, ''); var q = _toClassify[k];
  if (!q) _toClassify[k] = { country: s.country, station: s.station, plays: s.plays, tracks: [track] };
  else { q.plays += s.plays; if (q.tracks.indexOf(track) < 0) q.tracks.push(track); } }
function flushToClassify_(week){
  var have = {}; DB.registry.forEach(function(r){ have[ctryKey_(r[0]) + '|' + autoKey_(r[1], '')] = 1; });
  Object.keys(_toClassify).filter(function(k){ return !have[k]; }).forEach(function(k){ var q = _toClassify[k];
    var row = [q.country, q.station, '', '', 'auto-added ' + (week || '') + ' · ' + q.plays + ' plays · ' + q.tracks.slice(0, 3).join(', ') + ' — set a tier'];
    DB.registry.push(row); DB.registryAdds.push(row); });
  _toClassify = {}; _impMap = null;
}

function airplayManual_(track){ var out = [], want = norm_(track);
  DB.airplayManual.forEach(function(r){ if (!r[1]) return; var tn = norm_(r[0]);
    if (tn === want || tn.indexOf(want) >= 0 || want.indexOf(tn) >= 0) out.push({ market: String(r[1]), current: String(r[2] || 'N/A').trim(), peak: String(r[3] || '').trim(), weeks: String(r[4] || '').trim(), tier: String(r[5] || '200').trim() }); });
  return out; }
function updateAirplayTracker_(track, airplay, week){
  var rows = DB.airplayTracker, idx = {};
  for (var i = 0; i < rows.length; i++){ if (norm_(rows[i][0]) === norm_(track)) idx[norm_(rows[i][1])] = i; }
  var seen = {};
  (airplay || []).forEach(function(a){ var mkt = a[0], pos = a[1]; if (pos > 200) return; seen[norm_(mkt)] = 1; var i = idx[norm_(mkt)];
    if (i === undefined){ rows.push([track, mkt, String(pos), String(pos), (pos <= 100 ? 1 : 0), 1, week]); }
    else { var r = rows[i], w100 = parseInt(r[4], 10) || 0, w200 = parseInt(r[5], 10) || 0, peak = parseInt(r[3], 10); if (isNaN(peak)) peak = pos; peak = Math.min(peak, pos);
      if (String(r[6] || '') !== week){ if (pos <= 100) w100++; w200++; }
      rows[i] = [r[0], r[1], String(pos), String(peak), w100, w200, week]; } });
  for (var m in idx){ if (!seen[m]){ var j = idx[m]; if (String(rows[j][6] || '') !== week){ rows[j][2] = 'N/A'; rows[j][6] = week; } } }
}
function airplayTracked_(track){ var out = [], want = norm_(track);
  DB.airplayTracker.forEach(function(r){ var tn = norm_(r[0]); if (!(tn === want || tn.indexOf(want) >= 0 || want.indexOf(tn) >= 0)) return;
    var posNum = parseInt(r[2], 10), w100 = parseInt(r[4], 10) || 0, w200 = parseInt(r[5], 10) || 0, tier, weeks;
    if (!isNaN(posNum) && posNum <= 100){ tier = '100'; weeks = w100; } else if (!isNaN(posNum) && posNum <= 200){ tier = '200'; weeks = w200; } else { if (w100 > 0){ tier = '100'; weeks = w100; } else { tier = '200'; weeks = w200; } }
    out.push({ market: String(r[1]), current: String(r[2] || 'N/A'), peak: String(r[3] || ''), weeks: String(weeks || ''), tier: tier }); });
  return out; }

function trackSnaps_(track){ var a = (DB.history[songKey_(track)] || []).slice(); a.sort(function(x, y){ return repWeekIdx_(x.week) - repWeekIdx_(y.week); }); return a; }
function loadPrevSnap_(track, week){ var wi = repWeekIdx_(week), best = null;
  trackSnaps_(track).forEach(function(r){ var i = repWeekIdx_(r.week); if (i < wi && (!best || i > repWeekIdx_(best.week))) best = r; });
  return best ? { week: best.week, f: best.f } : null; }
function snapFor_(track, week){ var hit = null; trackSnaps_(track).forEach(function(r){ if (r.week === week) hit = r; }); return hit; }

function contextFor_(display){ var s = songFor_(display); if (!s) return null;
  var terr = (s.territories || []).map(function(t){ return { name: t.name, wave: waveOf_(t), sent: !!t.sent }; });
  return { focus_territories: terr.map(function(t){ return t.name; }), pluggers: s.pluggers || [], licensing: s.licensing || [], territories: terr }; }

function contactsGrid_(){ var c = DB.contacts; if (!c || !c.header || !c.rows) return null; return [c.header].concat(c.rows); }
function radioContacts_(){
  if (_contacts) return _contacts.list; var list = null, v = contactsGrid_();
  if (v){
    var h = v[0].map(function(x){ return fold_(x); });
    function col(re){ for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; }
    var ic = col(/^countr|^territor|^tara/), is = col(/^station|^radio|^nume/), it = col(/^type|^tip/), ip = col(/^contact pers|^person/), ie = col(/mail|^contact$/), ig = col(/^genre|^gen$|^format/), irl = col(/relevan|priorit|^tier/), irp = col(/roton plays/), ist = col(/^status/);
    var seen = {}; list = [];
    for (var r = 1; r < v.length; r++){
      var c = String(v[r][ic] || '').trim(), st = String(v[r][is] || '').trim(); if (!c || !st) continue;
      var tk = svTypeKey_(it >= 0 ? v[r][it] : ''); if (tk === 'x') continue;
      var status = fold_(ist >= 0 ? v[r][ist] : ''); if (/gresit|wrong|fara adresa|no address/.test(status)) continue;   // new master list: only Corecta / Neverificata count
      var person = String(ip >= 0 ? v[r][ip] : '').replace(/\([^)]*\)/g, '').replace(/[\s;\-]+/g, ' ').trim();
      var email = String(ie >= 0 ? v[r][ie] : '');
      var has = /@/.test(email) || (person.length > 2 && !/^(na|n\/a)$/i.test(person)); if (!has) continue;
      var core = stationCore_(st, c), key = ctryKey_(c) + '|' + core; if (seen[key]) continue; seen[key] = 1;
      list.push({ country: c, ck: ctryKey_(c), station: st, core: core, type: tk, reg: registryMatch_(st, c, importantMap_()), genre: String(ig >= 0 ? v[r][ig] : '').trim(), relevance: String(irl >= 0 ? v[r][irl] : '').trim(), rotonPlays: parseInt(String(irp >= 0 ? v[r][irp] : '').replace(/[^0-9]/g, ''), 10) || 0 });
    }
  }
  _contacts = { list: list }; return list;
}
function contactListCounts_(){ if (_listCounts) return _listCounts; _listCounts = {}; var v = contactsGrid_(); if (!v) return _listCounts;
  var h = v[0].map(function(x){ return fold_(x); }), ic = -1; for (var i = 0; i < h.length; i++) if (/^countr|^territor|^tara/.test(h[i])){ ic = i; break; }
  for (var r = 1; r < v.length; r++){ var c = String(v[r][ic] || '').trim(); if (c){ var k = ctryKey_(c); _listCounts[k] = (_listCounts[k] || 0) + 1; } }
  return _listCounts; }
function contactListInfo_(){ var c = DB.contacts; if (!c) return null; return { name: c.name || 'Contact list', url: '', edited: c.updated || '', stations: (radioContacts_() || []).length }; }

/* ---- weekly "new contacts to find": candidates per track, tasks carried across weeks ---- */
function saveContactCandidates_(week, F){
  var I = F._insights; if (!I) return; var home = ctryKey_(HOME_MARKET), rows = [];
  (F.stations_c || []).forEach(function(s){ if ((s.plays || 0) < 5 || s._contact || ctryKey_(s.country) === home) return;
    rows.push({ track: F.title, key: 'S|' + ctryKey_(s.country) + '|' + stationCore_(s.station, s.country), station: s.station, country: s.country, plays: s.plays, kind: 'station', signal: '' }); });
  (I.outside || []).forEach(function(o){ rows.push({ track: F.title, key: 'M|' + ctryKey_(o.name), station: o.name, country: o.name, plays: 0, kind: 'market', signal: 'Shazam #' + o.peak }); });
  (I.send || []).forEach(function(m){ if (m.withContact === 0 && m.plays >= 100) rows.push({ track: F.title, key: 'M|' + m.k, station: m.name, country: m.name, plays: m.plays, kind: 'market', signal: fmtInt_(m.plays) + ' plays' }); });
  var list = (DB.cands[week] || []).filter(function(r){ return norm_(r.track) !== norm_(F.title); });
  DB.cands[week] = list.concat(rows);
}
function buildWeeklyContacts_(week){
  var cur = {};
  (DB.cands[week] || []).forEach(function(r){ var k = r.key, c = cur[k] || (cur[k] = { key: k, station: r.station, country: r.country, kind: r.kind, plays: 0, tracks: [], signal: [] });
    c.plays += Number(r.plays) || 0; if (c.tracks.indexOf(r.track) < 0) c.tracks.push(r.track); if (r.signal) c.signal.push(r.track + ': ' + r.signal); });
  var tasks = {}, order = []; DB.tasks.forEach(function(t){ tasks[t.key] = t; order.push(t.key); });
  var wi = repWeekIdx_(week), done = [], dropped = [];
  Object.keys(cur).forEach(function(k){ var c = cur[k], t = tasks[k];
    if (!t || t.status !== 'open'){ t = tasks[k] = { key: k, station: c.station, country: c.country, kind: c.kind, firstWeek: week, status: 'open', closedWeek: '' }; if (order.indexOf(k) < 0) order.push(k); }
    t.lastSeenWeek = week; t.plays = c.plays; t.tracks = c.tracks.join(', '); t.signal = c.signal.join(' · '); });
  order.forEach(function(k){ var t = tasks[k]; if (t.status !== 'open' || cur[k]) return;
    var has = t.kind === 'station' ? stationHasContact_(t.station, t.country) : ((radioContacts_() || []).some(function(c){ return c.ck === ctryKey_(t.country); }));
    if (has){ t.status = 'done'; t.closedWeek = week; done.push(t); }
    else if (wi - repWeekIdx_(t.lastSeenWeek) >= 2){ t.status = 'dropped'; t.closedWeek = week; dropped.push(t); } });
  DB.tasks = order.map(function(k){ return tasks[k]; });
  return { week: week, done: done.length, dropped: dropped.length, open: DB.tasks.filter(function(t){ return t.status === 'open'; }).length };
}

/* ---- where the radio abroad comes from, without guessing ----
   A market can be both mailed by us and worked by a licensing partner (e.g. Russia sent + licensed). Plays from a station we
   mailed in such a market cannot be credited to either side, so they sit in their own "shared" bucket instead of being forced
   into "contacted" or "licensing". Buckets:
     us       station on our list, in a territory we sent, no active licensing deal there
     shared   station on our list, in a territory we sent, and a licensing partner is active in that market
     partner  station not mailed by us, in a market with an active licensing partner
     organic  everything else abroad                                                                                    */
function licAllSet_(ctx){
  var set = {};
  ((ctx && ctx.licensing) || []).forEach(function(l){ if (String(l.status || '') !== 'started') return;
    String(l.country || '').split(/\s*(?:\+|,|\/|&|\band\b)\s*/i).forEach(function(p){ p = p.trim(); if (!p) return;
      if (/^(ww|worldwide|world)$/i.test(p)){ set['*'] = { name: 'Worldwide', company: l.company || '' }; return; }
      (/^cis$/i.test(p) ? CIS_ : [p]).forEach(function(c){ set[ctryKey_(c)] = { name: c, company: l.company || '' }; }); }); });
  return set;
}
function licFor_(set, k){ return set[k] || (set['*'] && k !== ctryKey_(HOME_MARKET) ? { name: set['*'].name, company: set['*'].company } : null); }
function attribution_(F, ctx, SV){
  var home = ctryKey_(HOME_MARKET), lic = licAllSet_(ctx), sent = {};
  ((ctx && ctx.territories) || []).forEach(function(t){ if (t.sent) sent[ctryKey_(t.name)] = 1; });
  var A = { us: 0, shared: 0, partner: 0, organic: 0, total: 0, sharedMarkets: {}, partnerMarkets: {} };
  (F.stations_c || []).forEach(function(s){
    var k = ctryKey_(s.country); if (!s.plays || !k || k === home) return;
    var mailed = !!(s._contact && SV && SV.contactsOk && sent[s._contact.ck]);
    var L = licFor_(lic, k), src = mailed ? (L ? 'shared' : 'us') : (L ? 'partner' : 'organic');
    s._source = src; A[src] += s.plays; A.total += s.plays;
    if (src === 'shared') A.sharedMarkets[s.country] = (A.sharedMarkets[s.country] || 0) + s.plays;
    if (src === 'partner') A.partnerMarkets[s.country] = (A.partnerMarkets[s.country] || 0) + s.plays;
  });
  A.licensed = Object.keys(lic).map(function(k){ return { name: lic[k].name, company: lic[k].company, sent: !!sent[k] }; });
  A.overlap = A.licensed.filter(function(l){ return l.sent; }).map(function(l){ return l.name; });
  if (lic['*']) A.overlap = Object.keys(sent).filter(function(k){ return k !== home; }).map(function(k){ var t = ((ctx && ctx.territories) || []).filter(function(x){ return ctryKey_(x.name) === k; })[0]; return t ? t.name : k; });
  return A;
}

/* ===================== public API ===================== */
function strip_(F){ return JSON.parse(JSON.stringify(F, function(k, v){ return (k && k.charAt(0) === '_') ? undefined : v; })); }
function clone_(x){ return x == null ? x : JSON.parse(JSON.stringify(x)); }

// One track, one week: exactly the per-track body of the legacy runWeekly_, minus rendering.
function buildTrackWeek(o){
  var display = o.display, week = o.week;
  var F = buildFullFacts_(display, o.timeline || null, o.sections || null, o.radiomon || null);
  var song = songFor_(display); if (song){ F.artist = song.artist || ''; F.song_id = song.id; F.title = song.name || F.title; }
  var X = o.extra || {};
  ['tk_vids','ig_vids','cover','editorial_cur','shazams_total'].forEach(function(k){ if (X[k] != null) F[k] = X[k]; });
  if (!o.timeline && X.ss_streams_total){ F.total_streams = X.ss_streams_total; F.streams_source = 'songstats'; }
  F.combined = (F.total_streams || 0) + (F.yt_views || 0);
  F.inputs = { songstats: !!o.sections, s4a: !!o.timeline, radiomonitor: !!(F.airplay && F.airplay.length) };
  var prev = loadPrevSnap_(display, week), prevF = prev ? prev.f : null;
  if (prevF && prevF.avg_day != null){ F.avg_day_prev = prevF.avg_day; F.baseline_label = prev.week; }
  if (prev && weekNum_(week) != null && weekNum_(prev.week) != null && weekNum_(week) - weekNum_(prev.week) > 1) F.baseline_stale = weekNum_(week) - weekNum_(prev.week);
  F = carryForward_(F, prev);
  var ctx = contextFor_(display);
  rankStations_(F, ctx ? ctx.focus_territories : []);
  if (F.airplay && F.airplay.length) updateAirplayTracker_(display, F.airplay, week);
  // insights (needed for the contact candidates), on the live object like the legacy run
  var SV = null; try { SV = buildServicing_(F, ctx); } catch (e) { Logger.log('servicing: ' + e); }
  F._insights = buildInsights_(F, ctx, SV);
  saveContactCandidates_(week, F);
  var clean = strip_(F); clean.week = week; clean.built_at = new Date().toISOString();
  var key = songKey_(display), list = (DB.history[key] = (DB.history[key] || []).filter(function(r){ return r.week !== week; }));
  list.push({ week: week, f: clean });
  return clean;
}

// Everything the app shows for one track in one week, compared with any other stored week.
function analyze(display, week, cmpWeek){
  var cur = snapFor_(display, week); if (!cur) return null;
  var F = clone_(cur.f), cmp = cmpWeek ? snapFor_(display, cmpWeek) : null;
  if (!cmp && cmpWeek !== null) cmp = loadPrevSnap_(display, week);
  var prevF = cmp ? clone_(cmp.f) : null;
  if (prevF && prevF.avg_day != null){ F.avg_day_prev = prevF.avg_day; F.baseline_label = cmp.week; }
  var ctx = contextFor_(display);
  if (!F.stations_c) F.stations_c = (F.top_stations || []).map(function(s){ return { station: s.station, country: s.country, location: s.location, plays: s.plays, tier: 0, isNew: false }; });
  rankStations_(F, ctx ? ctx.focus_territories : []);
  var read = buildRead_(F, prevF, ctx);
  var SV = null; try { SV = buildServicing_(F, ctx); } catch (e) { SV = null; }
  var I = buildInsights_(F, ctx, SV);
  var AT = attribution_(F, ctx, SV), licK = licAllSet_(ctx);
  var svOut = SV ? { mode: SV.mode, contactsOk: SV.contactsOk, read: SV.read, contacted: SV.contacted || 0, playing: SV.playing || 0, plays: SV.plays || 0,
    newPlaying: SV.newPlaying || 0, rows: SV.allRows || [], noContacts: SV.noContacts || [], planned: SV.planned || [], cats: SV.cats || null, organic: SV.organic || 0,
    intlPlays: SV.intlPlays || 0, intlStations: SV.intlStations || 0, onList: SV.onList || [], sentCount: SV.sentCount || 0 } : null;
  if (svOut) svOut.rows = svOut.rows.map(function(r){ var l = licFor_(licK, ctryKey_(r.name)); r.licensed = l ? l.company || 'licensing partner' : ''; return r; });
  var stations = (F.stations_c || []).map(function(s){ var o = strip_(s); o.contacted = !!s._contact; o.source = s._source || (ctryKey_(s.country) === ctryKey_(HOME_MARKET) ? 'home' : 'organic'); return o; });
  return { F: strip_(F), prev: prevF ? strip_(prevF) : null, cmpWeek: cmp ? cmp.week : null, read: read, servicing: svOut, attribution: AT,
    insights: { split: I.split, send: I.send.filter(function(m){ return m.name; }), push: I.push.map(strip_), find: I.find.map(strip_), outside: I.outside, follow: I.follow, streaming: I.streaming, intlPlays: I.intlPlays,
      markets: I.markets.filter(function(m){ return m.name; }).map(function(m){ return { name: m.name, plays: m.plays, stations: m.stations, rank: m.rank }; }) },
    stations: stations, airplay: airplayChartsFor_(display), ctx: ctx };
}

function renderPartner(display, week){
  var cur = snapFor_(display, week); if (!cur) return null; var prev = loadPrevSnap_(display, week);
  var F = clone_(cur.f); var song = songFor_(display); if (song){ F.artist = song.artist; F.title = song.name || F.title; }
  var ctx = contextFor_(display); rankStations_(F, ctx ? ctx.focus_territories : []);
  return renderPartnerV2_(F, prev ? clone_(prev.f) : null, week);
}
function partnerFileName(display, week){ var s = songFor_(display); return reportFileName_(s ? s.name : display, week, false).replace(/\.html$/, ''); }

return {
  DB: DB, buildTrackWeek: buildTrackWeek, analyze: analyze, renderPartner: renderPartner, partnerFileName: partnerFileName,
  flushToClassify: flushToClassify_, weeklyContacts: buildWeeklyContacts_, songFor: songFor_, songKey: songKey_,
  trackSnaps: trackSnaps_, radioContacts: radioContacts_, contactListInfo: contactListInfo_, contactListCounts: contactListCounts_,
  human: human_, fmtInt: fmtInt_, rmName: rmName_, weekLabelFor: weekLabelFor_, repWeekIdx: repWeekIdx_, norm: norm_, ctryKey: ctryKey_,
  releaseInfo: releaseInfo_, stationCore: stationCore_, parseCsv: Utilities.parseCsv, HOME_MARKET: HOME_MARKET, LOGO_B64: LOGO_B64, COUNTRIES: COUNTRIES
};

}
