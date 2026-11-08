import {useId,useState} from 'react';
import {record,str,num,bounded,color} from './utils';
type Col = { key: string; label: string };
export function SpecTable({ props }: { props: Record<string, unknown> }) {
  const [sort,setSort]=useState<{key:string;ascending:boolean}|null>(null);
  const original = (Array.isArray(props.data) ? props.data : []).filter(record).slice(0, 200);
  const data=sort?[...original].sort((a,b)=>{const av=num(a[sort.key]),bv=num(b[sort.key]);return (av!==null&&bv!==null?av-bv:str(a[sort.key]).localeCompare(str(b[sort.key])))*(sort.ascending?1:-1);}):original;
  const cols: Col[] = Array.isArray(props.columns) && props.columns.length
    ? props.columns.filter(record).map(c => ({ key: str(c.key, 80), label: str(c.label, 80) || str(c.key, 80) })).filter(c => c.key).slice(0, 12)
    : Object.keys(data[0] ?? {}).slice(0, 12).map(k => ({ key: k, label: k }));
  if (!cols.length || !data.length) return <p role="status">{str(props.emptyMessage)||'No data available.'}</p>;
  return <div className="spec-table-wrap"><table className="spec-table"><thead><tr>{cols.map(c => <th key={c.key} aria-sort={sort?.key===c.key?(sort.ascending?'ascending':'descending'):'none'}><button type="button" onClick={()=>setSort({key:c.key,ascending:sort?.key===c.key?!sort.ascending:true})}>{c.label}</button></th>)}</tr></thead>
    <tbody>{data.map((r, i) => <tr key={i}>{cols.map(c => <td key={c.key} data-num={num(r[c.key]) !== null || undefined}>{str(r[c.key], 300)}</td>)}</tr>)}</tbody></table></div>;
}

/** One-series bar / line / area chart in plain SVG: thin marks, recessive grid, hover value, table view. */
export function XYChart({ kind, props }: { kind: string; props: Record<string, unknown> }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId='display-gradient-'+useId().replace(/[^A-Za-z0-9_-]/g,'');
  const xKey = str(props.xKey, 80), yKey = str(props.yKey, 80);
  const rows = (Array.isArray(props.data) ? props.data : []).filter(record).slice(0, 60)
    .map(r => ({ x: str(r[xKey], 40), y: num(r[yKey]) })).filter((r): r is { x: string; y: number } => r.y !== null);
  if (!xKey || !yKey || rows.length < 1) return <p role="status">No chart data available.</p>;
  if(rows.some(r=>Math.abs(r.y)>1e15))return <p role="status">Chart values exceed the supported numeric range.</p>;
  const title = str(props.title, 160);
  const W = 560, H = 220, L = 44, R = 12, T = 12, B = 30;
  const max = Math.max(0, ...rows.map(r => r.y)), min = Math.min(0, ...rows.map(r => r.y));
  const span = max - min || 1;
  const ticks = niceTicks(min, max);
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / span);
  const step = (W - L - R) / rows.length;
  const cx = (i: number) => L + step * i + step / 2;
  const fmt = (v: number) => Math.abs(v) >= 1000 ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : String(Math.round(v * 100) / 100);
  const every = Math.ceil(rows.length / 8);
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(r.y).toFixed(1)}`).join(' ');
  return <figure className="spec-chart">
    <figcaption><span>{title || yKey}</span>{props.interactive!==false&&<button type="button" className="link-button" onClick={() => setTable(v => !v)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>}</figcaption>
    {table ? <SpecTable props={{ data: rows.map(r => ({ [xKey]: r.x, [yKey]: r.y })), columns: [{ key: xKey, label: xKey }, { key: yKey, label: yKey }] }}/>
      : <svg viewBox={`0 0 ${W} ${H}`} className="spec-svg" style={{height:bounded(props.height,80,600,220),color:color(props.color)}} role="img" aria-label={`${title || yKey}: ${rows.map(r => `${r.x} ${r.y}`).join(', ')}`} onMouseLeave={() => setHover(null)}>
        {kind==='AreaChart'&&props.gradient!==false&&<defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity={.8}/><stop offset="100%" stopColor="currentColor" stopOpacity={0}/></linearGradient></defs>}
        {ticks.map(t => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'spec-axis' : 'spec-gridline'}/><text x={L - 6} y={y(t) + 3} className="spec-tick" textAnchor="end">{fmt(t)}</text></g>)}
        {rows.map((r, i) => i % every === 0 && <text key={i} x={cx(i)} y={H - 10} className="spec-tick" textAnchor="middle">{r.x.length > 10 ? `${r.x.slice(0, 9)}…` : r.x}</text>)}
        {kind === 'BarChart' && rows.map((r, i) => { const w = Math.max(2, Math.min(36, step - 2)); const top = y(Math.max(r.y, 0)), bot = y(Math.min(r.y, 0)); const h = Math.max(1, bot - top); const rad = Math.min(4, h / 2, w / 2);
          return <path key={i} className="spec-bar" data-hover={hover === i || undefined} d={r.y >= 0
            ? `M${cx(i) - w / 2},${bot} V${top + rad} Q${cx(i) - w / 2},${top} ${cx(i) - w / 2 + rad},${top} H${cx(i) + w / 2 - rad} Q${cx(i) + w / 2},${top} ${cx(i) + w / 2},${top + rad} V${bot} Z`
            : `M${cx(i) - w / 2},${top} V${bot - rad} Q${cx(i) - w / 2},${bot} ${cx(i) - w / 2 + rad},${bot} H${cx(i) + w / 2 - rad} Q${cx(i) + w / 2},${bot} ${cx(i) + w / 2},${bot - rad} V${top} Z`}/>; })}
        {kind === 'AreaChart' && <path className="spec-area" style={{fill:props.gradient!==false?`url(#${gradientId})`:color(props.color)}} d={`${line} L${cx(rows.length - 1)},${y(Math.max(min, 0))} L${cx(0)},${y(Math.max(min, 0))} Z`}/>}
        {kind !== 'BarChart' && <path className="spec-line" d={line}/>}
        {hover !== null && kind !== 'BarChart' && <><line className="spec-cross" x1={cx(hover)} x2={cx(hover)} y1={T} y2={H - B}/><circle className="spec-dot" cx={cx(hover)} cy={y(rows[hover].y)} r={4}/></>}
        {rows.map((_, i) => <rect key={i} x={L + step * i} y={T} width={step} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)}/>)}
        {hover !== null && <g className="spec-tip" transform={`translate(${Math.min(Math.max(cx(hover), L + 50), W - R - 50)},${T + 2})`}>
          <rect x={-50} y={0} width={100} height={34} rx={6}/><text y={14} textAnchor="middle" className="spec-tip-x">{rows[hover].x.slice(0, 16)}</text><text y={28} textAnchor="middle" className="spec-tip-y">{fmt(rows[hover].y)}</text></g>}
      </svg>}
  </figure>;
}

/** Up to eight slices in the fixed palette order; the rest fold into "Other". A legend names every slice. */
export function PieChart({ props }: { props: Record<string, unknown> }) {
  const [table, setTable] = useState(false);
  const nameKey = str(props.nameKey, 80), valueKey = str(props.valueKey, 80);
  let rows = (Array.isArray(props.data) ? props.data : []).filter(record).map(r => ({ name: str(r[nameKey], 60), value: num(r[valueKey]) }))
    .filter((r): r is { name: string; value: number } => r.value !== null && r.value > 0).slice(0, 60);
  if (!nameKey || !valueKey || !rows.length) return <p role="status">No chart data available.</p>;
  if(rows.some(r=>r.value>1e15))return <p role="status">Chart values exceed the supported numeric range.</p>;
  if (rows.length > 8) { const rest = rows.slice(7).reduce((s, r) => s + r.value, 0); rows = [...rows.slice(0, 7), { name: 'Other', value: rest }]; }
  const total = rows.reduce((s, r) => s + r.value, 0);
  const title = str(props.title, 160);
  let a = -Math.PI / 2;
  const arcs = rows.map((r, i) => {
    const sweep = (r.value / total) * Math.PI * 2; const a0 = a, a1 = a + sweep; a = a1;
    const R = 80, rIn = 46, c = 100;
    const p = (ang: number, rad: number) => `${(c + rad * Math.cos(ang)).toFixed(2)},${(c + rad * Math.sin(ang)).toFixed(2)}`;
    const large = sweep > Math.PI ? 1 : 0;
    const d = rows.length === 1 ? `M${c - R},${c} A${R},${R} 0 1 1 ${c + R},${c} A${R},${R} 0 1 1 ${c - R},${c} M${c - rIn},${c} A${rIn},${rIn} 0 1 0 ${c + rIn},${c} A${rIn},${rIn} 0 1 0 ${c - rIn},${c} Z`
      : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, rIn)} A${rIn},${rIn} 0 ${large} 0 ${p(a0, rIn)} Z`;
    return { ...r, d, slot: i + 1, pct: Math.round((r.value / total) * 100) };
  });
  return <figure className="spec-chart">
    <figcaption><span>{title || valueKey}</span>{props.interactive!==false&&<button type="button" className="link-button" onClick={() => setTable(v => !v)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>}</figcaption>
    {table ? <SpecTable props={{ data: rows.map(r => ({ [nameKey]: r.name, [valueKey]: r.value })), columns: [{ key: nameKey, label: nameKey }, { key: valueKey, label: valueKey }] }}/>
      : <div className="spec-pie"><svg viewBox="0 0 200 200" className="spec-svg spec-pie-svg" style={{height:bounded(props.height,80,600,200)}} role="img" aria-label={`${title || valueKey}: ${arcs.map(x => `${x.name}${props.showPercentages===false?'':' '+x.pct+'%'}`).join(', ')}`}>
        {arcs.map(x => <path key={x.slot} d={x.d} className="spec-slice" data-slot={x.slot}><title>{`${x.name}: ${x.value}${props.showPercentages===false?'':` (${x.pct}%)`}`}</title></path>)}</svg>
        <ul className="spec-legend">{arcs.map(x => <li key={x.slot}><i data-slot={x.slot} aria-hidden="true"/>{x.name}{props.showPercentages!==false&&<span className="spec-muted">{x.pct}%</span>}</li>)}</ul></div>}
  </figure>;
}

function niceTicks(min: number, max: number): number[] {
  const span = max - min || 1; const raw = span / 4; const mag = 10 ** Math.floor(Math.log10(raw));
  const stepv = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= 5) ?? mag * 10;
  const out: number[] = []; for (let v = Math.ceil(min / stepv) * stepv; v <= max + 1e-9 && out.length < 8; v += stepv) out.push(Math.round(v * 1e6) / 1e6);
  if (!out.includes(0) && min <= 0 && max >= 0) out.push(0);
  return out;
}
