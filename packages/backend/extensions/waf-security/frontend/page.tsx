'use client';

/**
 * Server & Web Security Scanner — one window, seven places.
 *
 * Built to the approved structure (docs/designs/security-scanner/STRUCTURE.md) and the desktop-app
 * design rules: a sidebar of places (not tabs), a short quiet list in the middle, and the details
 * and actions of the selected item in an inspector on the right. One filled main action per screen,
 * no stat tiles, counts only as a "needs you" badge, a status footer. Advanced options live only in
 * Settings. Nothing here attacks anything; findings are informational with a fix hint.
 *
 * NOTE (D-DESIGN-FIRST): this is the design implementation of the structure. Final integration
 * should render inside the real Dpro window and import { UiIcon } from core-ui and portal the
 * sidebar, exactly like TradingWorkspace; the local `Icon` here maps 1:1 to the UiIcon names so it
 * is a drop-in swap. Must still pass the boards + Mohamed's review before shipping.
 */

import { useState, useEffect, useCallback } from 'react';
import { config } from '@/lib/config';

const API = `${config.backendUrl}/api/ext/waf-security`;

/* ------------------------------------------------------------------ icons */
// Names match packages/core-ui/src/ui-icons.tsx; swap this for the real <UiIcon/> on integration.
const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  bug: 'M8 7a4 4 0 018 0M6 11h12M5 15h14M12 7v12M4 11v4M20 11v4',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2M18 12h2M12 4v2M12 18v2',
  search: 'M11 4a7 7 0 105 12 7 7 0 00-5-12zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7z',
  refresh: 'M4 11a8 8 0 0114-5l2 2M20 13a8 8 0 01-14 5l-2-2',
  check: 'M5 13l4 4L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  wifi: 'M5 12a10 10 0 0114 0M8 15a6 6 0 018 0M12 18h.01',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 3',
  lock: 'M6 10V8a6 6 0 0112 0v2M5 10h14v10H5z',
};
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.shield} />
    </svg>
  );
}

/* ------------------------------------------------------------------ types */
type Place = 'overview' | 'servers' | 'sites' | 'findings' | 'campaigns' | 'this-girru' | 'settings';
interface Asset { id: string; kind: string; label: string; host: string; base_url: string | null; is_private: number; last_checked_at: string | null; coverage?: { total: number; ok: number; issue: number; notTested: number }; }
interface Finding { id: string; title: string; severity: string; status: string; where_url: string | null; category: string; summary?: string; fix_hint?: string; last_seen_at: string; evidence?: any[]; retests?: any[]; }
interface NeedRow { kind: string; id: string; severity: string; text: string; where?: string; }

const PLACES: { id: Place; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'servers', label: 'Servers', icon: 'server' },
  { id: 'sites', label: 'Sites', icon: 'globe' },
  { id: 'findings', label: 'Findings', icon: 'bug' },
  { id: 'campaigns', label: 'Campaigns', icon: 'calendar' },
  { id: 'this-girru', label: 'This Girru', icon: 'shield' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
function dot(sev: string) {
  const color = { critical: '#d1242f', high: '#e8590c', medium: '#d9a300', low: '#1f883d', info: '#6b7280' }[sev] || '#6b7280';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: color, flex: '0 0 auto' }} aria-label={sev} />;
}

async function get(path: string) { const r = await fetch(`${API}${path}`); return r.ok ? r.json() : null; }
async function post(path: string, body?: any) { const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({ error: 'failed' }))); }
async function del(path: string) { const r = await fetch(`${API}${path}`, { method: 'DELETE' }); return r.ok ? r.json() : null; }

/* ------------------------------------------------------------------ page */
export default function SecurityPage() {
  const [place, setPlace] = useState<Place>('overview');
  const [needs, setNeeds] = useState<NeedRow[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);

  const refreshBadge = useCallback(async () => {
    const o = await get('/overview'); setNeeds(o?.needsYou || []);
    const f = await get('/findings?status=open'); setFindings(f?.findings || []);
  }, []);
  useEffect(() => { refreshBadge(); }, [refreshBadge]);

  const needCount = needs.length;

  return (
    <div style={S.window}>
      <aside style={S.sidebar} aria-label="Security places">
        <p style={S.sectionLabel}>Security</p>
        {PLACES.map((p) => (
          <button key={p.id} style={{ ...S.navItem, ...(place === p.id ? S.navItemActive : {}) }}
            aria-current={place === p.id ? 'page' : undefined} onClick={() => setPlace(p.id)} title={p.label}>
            <Icon name={p.icon} />
            <span>{p.label}</span>
            {p.id === 'findings' && needCount > 0 && <span style={S.badge}>{needCount}</span>}
          </button>
        ))}
      </aside>

      <main style={S.main}>
        {place === 'overview' && <Overview needs={needs} onOpen={() => setPlace('findings')} />}
        {place === 'servers' && <Assets kind="server" onChanged={refreshBadge} />}
        {place === 'sites' && <Assets kind="site" onChanged={refreshBadge} />}
        {place === 'findings' && <Findings findings={findings} reload={refreshBadge} />}
        {place === 'campaigns' && <Campaigns />}
        {place === 'this-girru' && <ThisGirru />}
        {place === 'settings' && <Settings />}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ Overview (a to-do list; no main action) */
function Overview({ needs, onOpen }: { needs: NeedRow[]; onOpen: () => void }) {
  return (
    <>
      <header style={S.tools}><strong>Overview</strong><span style={S.quiet}>What needs you now</span></header>
      {needs.length === 0 ? (
        <Empty icon="check" line="You're clear. Nothing needs you right now." />
      ) : (
        <ul style={S.list}>
          {needs.map((n) => (
            <li key={`${n.kind}-${n.id}`} style={S.row} onClick={onOpen}>
              {dot(n.severity)}<span style={S.rowMain}>{n.text}</span>
              {n.where && <span style={S.quiet}>{n.where}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Servers / Sites (Add; select -> inspector) */
function Assets({ kind, onChanged }: { kind: 'server' | 'site'; onChanged: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sel, setSel] = useState<Asset | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { const d = await get(`/assets?kind=${kind}`); setAssets(d?.assets || []); }, [kind]);
  useEffect(() => { load(); setSel(null); }, [load]);

  const scan = async (a: Asset) => { setBusy(true); try { await post(`/assets/${a.id}/scan`); await load(); onChanged(); } catch (e: any) { alert(e.error || 'Scan failed'); } finally { setBusy(false); } };
  const forget = async (a: Asset) => { await del(`/assets/${a.id}`); setSel(null); await load(); };

  return (
    <div style={S.split}>
      <section style={S.listPane}>
        <header style={S.tools}>
          <strong>{kind === 'server' ? 'Servers' : 'Sites'}</strong>
          <button style={S.primary} onClick={() => setAdding(true)}><Icon name="plus" /> {kind === 'server' ? 'Add server' : 'Add site'}</button>
        </header>
        {assets.length === 0 ? (
          <Empty icon={kind === 'server' ? 'server' : 'globe'} line={kind === 'server' ? 'Add a server you own to watch its ports, services and certificate.' : 'Add a site you own to test its headers, certificate and firewall.'} />
        ) : (
          <ul style={S.list}>
            {assets.map((a) => (
              <li key={a.id} style={{ ...S.row, ...(sel?.id === a.id ? S.rowSel : {}) }} onClick={() => setSel(a)}>
                <Icon name={kind === 'server' ? 'server' : 'globe'} />
                <span style={S.rowMain}>{a.label}</span>
                <span style={S.quiet}>{a.coverage && a.coverage.total ? `${a.coverage.issue} issue(s) · ${a.coverage.ok} clean` : 'not checked yet'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside style={S.inspector}>
        {adding ? (
          <AddAsset kind={kind} onDone={async () => { setAdding(false); await load(); onChanged(); }} onCancel={() => setAdding(false)} />
        ) : sel ? (
          <div>
            <h3 style={S.inspTitle}>{sel.label}</h3>
            <p style={S.quiet}>{sel.base_url || sel.host}{sel.is_private ? ' · private address' : ''}</p>
            <dl style={S.dl}>
              <dt>Last checked</dt><dd>{sel.last_checked_at || 'never'}</dd>
              <dt>Coverage</dt><dd>{sel.coverage ? `${sel.coverage.total} checks · ${sel.coverage.ok} clean · ${sel.coverage.issue} issue(s) · ${sel.coverage.notTested} not tested` : '—'}</dd>
            </dl>
            <div style={S.inspActions}>
              <button style={S.primary} disabled={busy} onClick={() => scan(sel)}><Icon name="play" /> {busy ? 'Scanning…' : 'Scan now'}</button>
              <button style={S.ghost} onClick={() => forget(sel)} title="Forget">Forget</button>
            </div>
          </div>
        ) : <Empty icon="search" line="Select an item to see its details." />}
      </aside>
    </div>
  );
}

function AddAsset({ kind, onDone, onCancel }: { kind: 'server' | 'site'; onDone: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    try {
      const body: any = { kind, label, owner_confirmed: confirm };
      if (kind === 'site') body.base_url = host; else body.host = host;
      await post('/assets', body); onDone();
    } catch (e: any) { setErr(e.error || 'Could not add'); }
  };
  return (
    <div>
      <h3 style={S.inspTitle}>{kind === 'server' ? 'Add server' : 'Add site'}</h3>
      <label style={S.field}><span>Name</span><input style={S.input} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label style={S.field}><span>{kind === 'server' ? 'Host (name or IP)' : 'Address (https://…)'}</span><input style={S.input} value={host} onChange={(e) => setHost(e.target.value)} /></label>
      <label style={S.check}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I own this, or I am allowed to test it.</label>
      {err && <p style={S.err}>{err}</p>}
      <div style={S.inspActions}>
        <button style={S.primary} disabled={!label || !host || !confirm} onClick={submit}><Icon name="check" /> Add</button>
        <button style={S.ghost} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Findings (result list; select -> evidence + Retest) */
function Findings({ findings, reload }: { findings: Finding[]; reload: () => void }) {
  const [sel, setSel] = useState<Finding | null>(null);
  const [detail, setDetail] = useState<Finding | null>(null);
  const [explaining, setExplaining] = useState('');
  const sorted = [...findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));

  const open = async (f: Finding) => { setSel(f); setExplaining(''); const d = await get(`/findings/${f.id}`); setDetail(d); };
  const retest = async (verdict: string) => { if (!sel) return; await post(`/findings/${sel.id}/retest`, { verdict, oppositeCheck: 'Manual retest from the inspector.' }); await open(sel); reload(); };
  const explain = async () => { if (!sel) return; setExplaining('…'); try { const r = await post(`/findings/${sel.id}/explain`, {}); setExplaining(r.explanation || ''); } catch { setExplaining('Could not get an explanation.'); } };

  return (
    <div style={S.split}>
      <section style={S.listPane}>
        <header style={S.tools}><strong>Findings</strong><span style={S.quiet}>Newest first</span></header>
        {sorted.length === 0 ? <Empty icon="check" line="No open findings. Run a scan from Servers or Sites." /> : (
          <ul style={S.list}>
            {sorted.map((f) => (
              <li key={f.id} style={{ ...S.row, ...(sel?.id === f.id ? S.rowSel : {}) }} onClick={() => open(f)}>
                {dot(f.severity)}<span style={S.rowMain}>{f.title}</span><span style={S.quiet}>{f.where_url}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside style={S.inspector}>
        {detail ? (
          <div>
            <h3 style={S.inspTitle}>{detail.title}</h3>
            <p style={S.quiet}>{detail.severity} · {detail.category} · {detail.status}</p>
            {detail.summary && <p>{detail.summary}</p>}
            {detail.fix_hint && <p><strong>Fix:</strong> {detail.fix_hint}</p>}
            <h4 style={S.h4}>Evidence</h4>
            {(detail.evidence || []).map((e: any) => (
              <details key={e.id} style={S.evidence}>
                <summary>{e.role} · {e.kind} {e.integrity_ok ? '' : '⚠ hash mismatch'}</summary>
                <pre style={S.pre}>{String(e.body).slice(0, 2000)}</pre>
              </details>
            ))}
            <div style={S.inspActions}>
              <button style={S.primary} onClick={() => retest('reproduced')}><Icon name="refresh" /> Retest</button>
              <button style={S.ghost} onClick={() => retest('fixed')}>Mark fixed</button>
              <button style={S.ghost} onClick={explain}>Explain</button>
            </div>
            {explaining && <p style={S.explain}>{explaining}</p>}
          </div>
        ) : <Empty icon="search" line="Select a finding to see its evidence and retest it." />}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ Campaigns / This Girru / Settings */
function Campaigns() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { get('/campaigns').then((d) => setItems(d?.campaigns || [])); }, []);
  return (
    <>
      <header style={S.tools}><strong>Campaigns</strong><button style={S.primary}><Icon name="plus" /> New campaign</button></header>
      {items.length === 0 ? <Empty icon="calendar" line="Save a test to repeat it on a schedule and watch its score over time." />
        : <ul style={S.list}>{items.map((c) => <li key={c.id} style={S.row}><Icon name="calendar" /><span style={S.rowMain}>{c.name}</span><span style={S.quiet}>{c.target_domain}</span></li>)}</ul>}
    </>
  );
}

function ThisGirru() {
  const [audit, setAudit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setAudit(await post('/self', {})); } finally { setBusy(false); } };
  return (
    <>
      <header style={S.tools}><strong>This Girru</strong><button style={S.primary} disabled={busy} onClick={run}><Icon name="shield" /> {busy ? 'Checking…' : 'Run self-audit'}</button></header>
      {!audit ? <Empty icon="shield" line="Check this Girru's own security headers, CORS, sign-in and rate limits." />
        : <ul style={S.list}>{(audit.issues || []).map((i: any, n: number) => <li key={n} style={S.row}>{dot(i.severity)}<span style={S.rowMain}>{i.detail}</span><span style={S.quiet}>{i.recommendation}</span></li>)}</ul>}
    </>
  );
}

function Settings() {
  const [s, setS] = useState<any>({ allowPrivateTargets: false, noiseProfile: 'quiet' });
  useEffect(() => { get('/settings').then((d) => d && setS(d)); }, []);
  const save = async (patch: any) => { const next = await fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => r.json()); setS(next); };
  return (
    <>
      <header style={S.tools}><strong>Settings</strong><span style={S.quiet}>Advanced options</span></header>
      <div style={{ maxWidth: 560 }}>
        <label style={S.check}><input type="checkbox" checked={!!s.allowPrivateTargets} onChange={(e) => save({ allowPrivateTargets: e.target.checked })} /> Allow private / owned network addresses (logged)</label>
        <label style={S.field}><span>Scan pacing</span>
          <select style={S.input} value={s.noiseProfile} onChange={(e) => save({ noiseProfile: e.target.value })}>
            <option value="quiet">Quiet (gentlest)</option><option value="balanced">Balanced</option><option value="aggressive">Aggressive (fastest)</option>
          </select>
        </label>
        <p style={S.quiet}>Sensor pairing tokens, the payload library and the waf_scan agent permission also live here.</p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ shared bits */
function Empty({ icon, line }: { icon: string; line: string }) {
  return <div style={S.empty}><Icon name={icon} size={24} /><p>{line}</p></div>;
}

/* ------------------------------------------------------------------ styles (tokens; integration uses core-ui classes) */
const S: Record<string, React.CSSProperties> = {
  window: { display: 'flex', height: '100%', minHeight: 520, fontSize: 13, color: 'var(--text, #1b1b1f)' },
  sidebar: { width: 196, flex: '0 0 196px', borderRight: '1px solid var(--line, #e3e3e8)', padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
  sectionLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.6, margin: '2px 8px 8px' },
  navItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', border: 0, background: 'transparent', borderRadius: 7, cursor: 'pointer', color: 'inherit', textAlign: 'left', width: '100%' },
  navItemActive: { background: 'var(--sel, #eef1f6)', fontWeight: 600 },
  badge: { marginLeft: 'auto', background: '#d1242f', color: '#fff', borderRadius: 10, fontSize: 11, padding: '0 6px', minWidth: 18, textAlign: 'center' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  split: { display: 'flex', flex: 1, minHeight: 0 },
  listPane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line, #e3e3e8)' },
  tools: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line, #e3e3e8)', minHeight: 30 },
  quiet: { opacity: 0.6, fontSize: 12 },
  list: { listStyle: 'none', margin: 0, padding: 6, overflow: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 7, cursor: 'pointer' },
  rowSel: { background: 'var(--sel, #eef1f6)' },
  rowMain: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  inspector: { width: 320, flex: '0 0 320px', padding: 16, overflow: 'auto' },
  inspTitle: { margin: '0 0 2px', fontSize: 15 },
  inspActions: { display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' },
  dl: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, marginTop: 12 },
  primary: { display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', background: 'var(--accent, #2563eb)', color: '#fff', border: 0, borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontWeight: 600 },
  ghost: { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid var(--line, #d7d7de)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', color: 'inherit' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, margin: '10px 0', fontSize: 12 },
  input: { padding: '7px 9px', border: '1px solid var(--line, #d7d7de)', borderRadius: 7, background: 'var(--bg, #fff)', color: 'inherit' },
  check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, margin: '12px 0' },
  err: { color: '#d1242f', fontSize: 12 },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: 0.6, padding: '48px 16px', textAlign: 'center' },
  h4: { margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.6 },
  evidence: { border: '1px solid var(--line, #e3e3e8)', borderRadius: 7, padding: '6px 8px', margin: '6px 0', fontSize: 12 },
  pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: '6px 0 0', maxHeight: 220, overflow: 'auto' },
  explain: { marginTop: 12, fontSize: 12, background: 'var(--sel, #f3f5f9)', padding: 10, borderRadius: 7, whiteSpace: 'pre-wrap' },
};
