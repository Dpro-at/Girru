import { useEffect, useMemo, useState } from 'react';
import type { SpaceRow } from './GenVRHome';

/**
 * GV1c (approved by Mohamed, 2026-11-12): the GenVR market as a place in the GenVR sidebar. Items
 * from GenVR creators, a search and three filters, the selected item's details on the right, and
 * Add to a place…, which opens that place in the Studio where the item waits in the Items tab.
 * Paid items show with Add turned off: they are bought on GenVR.
 */
export interface MarketItem {manifest: {id: string; name: string; type?: string; category?: string; subcategory?: string; styles?: string[]; author?: {name?: string}; price: {type: string; coins?: number}; license?: string}; caption: string | null; tags: string[]}

const KINDS: Record<string, {name: string; icon: string}> = {
  nature: {name: 'Nature', icon: 'M12 3l6 9h-4l4 6H6l4-6H6z'},
  building: {name: 'Buildings', icon: 'M4 21V9l8-5 8 5v12zM10 21v-6h4v6'},
  furniture: {name: 'Furniture', icon: 'M5 11h14v4H5zM7 15v4M17 15v4M7 11V7h10v4'},
  props: {name: 'Props and decor', icon: 'M5 8h14l-1 12H6zM9 8V5h6v3'},
  vehicle: {name: 'Vehicles', icon: 'M3 16h18l-2-6H5zM7 19a1.5 1.5 0 1 0 0-3M17 19a1.5 1.5 0 1 0 0-3'},
  character: {name: 'Characters', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0'},
  gameplay: {name: 'Game pieces', icon: 'M12 3l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L3 10l6-1z'},
};
const BOX = 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10';
const kindOf = (item: MarketItem) => KINDS[item.manifest.category ?? ''] ?? {name: item.manifest.category ? item.manifest.category.replace(/[-_]/g, ' ') : 'Other', icon: BOX};
export const priceLine = (price: MarketItem['manifest']['price']) => price.type === 'free' ? 'Free' : price.type === 'paid' ? `${price.coins ?? '?'} coins` : 'With a subscription';
const Glyph = ({d, size = 14}: {d: string; size?: number}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;

export function GenVRMarket({load, spaces, onAdd}: {load: () => Promise<MarketItem[]>; spaces: SpaceRow[]; onAdd: (spaceId: string) => void}) {
  const [items, setItems] = useState<MarketItem[] | null>(null), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [price, setPrice] = useState(''), [style, setStyle] = useState('');
  const [selected, setSelected] = useState(''), [choosing, setChoosing] = useState(false);
  useEffect(() => { let gone = false; setFailed(false); setItems(null); void load().then(rows => { if (!gone) setItems(rows); }).catch(() => { if (!gone) setFailed(true); }); return () => { gone = true; }; }, [load, retry]);
  const kinds = useMemo(() => [...new Set((items ?? []).map(i => i.manifest.category ?? '').filter(Boolean))].sort(), [items]);
  const styles = useMemo(() => [...new Set((items ?? []).flatMap(i => i.manifest.styles ?? []))].sort(), [items]);
  const shown = (items ?? []).filter(i => {
    const q = query.trim().toLowerCase();
    return (!q || [i.manifest.name, i.caption ?? '', ...i.tags].some(t => t.toLowerCase().includes(q)))
      && (!kind || i.manifest.category === kind) && (!price || (price === 'free') === (i.manifest.price.type === 'free')) && (!style || (i.manifest.styles ?? []).includes(style));
  });
  const item = shown.find(i => i.manifest.id === selected) ?? null;
  const add = (spaceId: string) => { setChoosing(false); onAdd(spaceId); };
  const move = (step: number) => { if (!shown.length) return; const at = shown.findIndex(i => i.manifest.id === selected); setSelected(shown[Math.max(0, Math.min(shown.length - 1, at + step))].manifest.id); };

  if (failed) return <div role="alert" className="dk-empty"><p>The market could not be reached. Check the connection.</p><button type="button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>;
  if (!items) return <p role="status" className="fine-print">Loading the market…</p>;
  return <div className="genvr-market">
    <div className="genvr-market-main">
      <div className="genvr-market-bar">
        <input type="search" placeholder="Search the market" aria-label="Search the market" value={query} onChange={e => setQuery(e.target.value)}/>
        <select aria-label="Kind" value={kind} onChange={e => setKind(e.target.value)}><option value="">Any kind</option>{kinds.map(k => <option key={k} value={k}>{KINDS[k]?.name ?? k}</option>)}</select>
        <select aria-label="Price" value={price} onChange={e => setPrice(e.target.value)}><option value="">Any price</option><option value="free">Free</option><option value="paid">Paid</option></select>
        <select aria-label="Style" value={style} onChange={e => setStyle(e.target.value)}><option value="">Any style</option>{styles.map(s => <option key={s} value={s}>{s}</option>)}</select>
      </div>
      {shown.length ? <div className="genvr-items" role="listbox" aria-label="Market items" tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); } if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); } if (e.key === 'Enter' && item && item.manifest.price.type === 'free' && spaces.length) setChoosing(true); }}>
        {shown.map(i => <button key={i.manifest.id} type="button" role="option" aria-selected={i.manifest.id === selected} className="genvr-item" onClick={() => { setSelected(i.manifest.id); setChoosing(false); }} onDoubleClick={() => { setSelected(i.manifest.id); if (i.manifest.price.type === 'free' && spaces.length) setChoosing(true); }}>
          <span className="genvr-item-art"><Glyph d={kindOf(i).icon} size={34}/></span>
          <b>{i.manifest.name}</b><small>{priceLine(i.manifest.price)}{i.manifest.author?.name ? ` · ${i.manifest.author.name}` : ''}</small>
        </button>)}
      </div> : <div className="dk-empty"><p>{items.length ? 'Nothing matches. Clear the search or a filter.' : 'The market has no items yet.'}</p></div>}
      <p className="fine-print">Items from GenVR creators · double-click an item to add it to a place</p>
    </div>
    <aside className="genvr-inspector" aria-label="Item details">{item ? <>
      <span className="genvr-item-art big"><Glyph d={kindOf(item).icon} size={56}/></span>
      <h3>{item.manifest.name}</h3>
      <dl>
        <dt>Kind</dt><dd>{kindOf(item).name}</dd>
        <dt>Price</dt><dd>{priceLine(item.manifest.price)}</dd>
        {item.manifest.author?.name && <><dt>Made by</dt><dd>{item.manifest.author.name}</dd></>}
        {item.manifest.styles?.length ? <><dt>Styles</dt><dd>{item.manifest.styles.join(', ')}</dd></> : null}
        {item.manifest.license && <><dt>Licence</dt><dd>{item.manifest.license}</dd></>}
      </dl>
      {item.caption && <p>{item.caption}</p>}
      {item.tags.length > 0 && <p className="fine-print">{item.tags.slice(0, 8).join(' · ')}</p>}
      {item.manifest.price.type !== 'free' ? <><button type="button" className="primary" disabled>Add to a place…</button><p className="fine-print">Paid items are bought on GenVR.</p></>
        : !spaces.length ? <><button type="button" className="primary" disabled>Add to a place…</button><p className="fine-print">Make a space first, in My spaces.</p></>
        : <><button type="button" className="primary" aria-expanded={choosing} onClick={() => setChoosing(c => !c)}>Add to a place…</button>
          {choosing && <div className="genvr-menu" role="menu" aria-label="Add to a place">{spaces.map(s => <button key={s.id} type="button" role="menuitem" onClick={() => add(s.id)}>{s.title}</button>)}</div>}
          <p className="fine-print">The place opens in the Studio; the item is in its Items tab.</p></>}
    </> : <p className="fine-print">Select an item to see it here.</p>}</aside>
  </div>;
}
