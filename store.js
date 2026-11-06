// Where the data lives. GitHubStore talks to the private data repo through the GitHub API with the
// viewer's own token; DemoStore serves an embedded snapshot and keeps edits in memory (preview only).

const b64 = str => { const bytes = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

export class GitHubStore {
  constructor({ owner, repo, token, branch = 'main' }){ Object.assign(this, { owner, repo, token, branch }); this.mode = 'github'; }
  async api(path, opts = {}){
    const r = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', ...(opts.headers || {}) } });
    if (r.status === 404) return null;
    if (!r.ok){ const t = await r.text(); throw new Error(`GitHub ${r.status}: ${t.slice(0, 200)}`); }
    return r;
  }
  async check(){ const r = await this.api(''); if (!r) throw new Error('Repository not found, or the token cannot see it.'); return r.json(); }
  async readText(path){ const r = await this.api(`/contents/${encodeURI(path)}?ref=${this.branch}`, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store' }); return r ? r.text() : null; }
  async readJSON(path){ const t = await this.readText(path); return t == null ? null : JSON.parse(t); }
  async readBlob(path){ const r = await this.api(`/contents/${encodeURI(path)}?ref=${this.branch}`, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store' }); return r ? r.blob() : null; }
  async list(path){ const r = await this.api(`/contents/${encodeURI(path)}?ref=${this.branch}`, { cache: 'no-store' }); return r ? r.json() : []; }
  // files: [{path, text}] or [{path, base64}] — one commit, all or nothing
  async commit(files, message){
    const ref = await (await this.api(`/git/ref/heads/${this.branch}`)).json();
    const base = await (await this.api(`/git/commits/${ref.object.sha}`)).json();
    const tree = [];
    for (const f of files){
      const blob = await (await this.api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.base64 || b64(f.text), encoding: 'base64' }) })).json();
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await (await this.api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) })).json();
    const c = await (await this.api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [ref.object.sha] }) })).json();
    await this.api(`/git/refs/heads/${this.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
    return c.sha;
  }
  async dispatch(workflow, inputs = {}){ await this.api(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: this.branch, inputs }) }); }
  async lastRun(workflow){ const r = await this.api(`/actions/workflows/${workflow}/runs?per_page=1`, { cache: 'no-store' }); if (!r) return null; const j = await r.json(); return (j.workflow_runs || [])[0] || null; }
}

export class DemoStore {
  constructor(bundle){ this.files = bundle; this.mode = 'demo'; }
  async check(){ return { full_name: 'demo' }; }
  async readText(p){ const v = this.files[p]; return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); }
  async readJSON(p){ const v = this.files[p]; return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : JSON.parse(JSON.stringify(v))); }
  async readBlob(){ return null; }
  async list(p){ const pre = p.replace(/\/?$/, '/'); return Object.keys(this.files).filter(k => k.startsWith(pre)).map(k => ({ name: k.slice(pre.length), path: k, type: 'file' })); }
  async commit(files){ for (const f of files) this.files[f.path] = f.text != null ? f.text : '(binary)'; await new Promise(r => setTimeout(r, 450)); return 'demo'; }
  async dispatch(){ await new Promise(r => setTimeout(r, 300)); }
  async lastRun(){ return { status: 'completed', conclusion: 'success', updated_at: new Date().toISOString(), demo: true }; }
}

const KEY = 'roton-stats-connection';
export function savedConnection(){ try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
export function saveConnection(c){ try { c ? localStorage.setItem(KEY, JSON.stringify(c)) : localStorage.removeItem(KEY); } catch {} }
