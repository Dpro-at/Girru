import { useState } from 'react';
import type { OfficeDeck } from './office-content';
import { UiIcon } from './ui-icons';

/** A local, read-only slide canvas; no Office code, links or animation runs. */
export function PowerPointContent({ deck }: { deck: OfficeDeck }) {
  const [index, setIndex] = useState(0);
  const slide = deck.slides[index];
  if (!slide) return <p className="pane-empty">No visible slides can be previewed.</p>;
  const move = (n: number) => setIndex(v => Math.max(0, Math.min(deck.slides.length - 1, v + n)));
  return <section className="file-office file-presentation" aria-label="PowerPoint slides" tabIndex={0} onKeyDown={e => { if (e.target instanceof HTMLSelectElement) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1); } }}>
    <div className="file-content-tools"><button type="button" className="row-tool" title="Previous slide" aria-label="Previous slide" disabled={index === 0} onClick={() => move(-1)}><UiIcon name="chevron-left" size={16}/></button>
      <label>Slide <select aria-label="Slide" value={index} onChange={e => setIndex(Number(e.target.value))}>{deck.slides.map((s, i) => <option key={i} value={i}>{i + 1} · {s.title}</option>)}</select></label>
      <span className="muted">{index + 1} of {deck.slides.length}</span><button type="button" className="row-tool" title="Next slide" aria-label="Next slide" disabled={index === deck.slides.length - 1} onClick={() => move(1)}><UiIcon name="chevron" size={16}/></button>
    </div><p className="office-note">Read-only · slide layout may differ · animations are not played</p>
    <div className="office-slide-space"><article className={`office-slide${slide.flow ? ' office-slide-flow' : ''}`} dir="ltr" aria-label={`Slide ${index + 1}: ${slide.title}`} style={{ aspectRatio: slide.flow ? undefined : `${deck.width} / ${deck.height}` }}>
      {slide.items.map((item, i) => <div className="office-slide-item" key={i} style={{ insetInlineStart: `${item.x / deck.width * 100}%`, top: `${item.y / deck.height * 100}%`, width: `${item.width / deck.width * 100}%`, height: `${item.height / deck.height * 100}%`, fontSize: `${item.font}cqw`, color: item.color, background: item.fill }}>
        {item.image ? <img src={item.image.src} alt={item.image.alt}/> : item.paragraphs?.map((p, j) => <p key={j} dir={p.dir} style={{ textAlign: p.align }}>{p.runs.map((r, k) => <span key={k} style={{ fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined, textDecoration: r.underline ? 'underline' : undefined }}>{r.text}</span>)}</p>)}
      </div>)}
    </article></div>
    {deck.truncated && <p className="office-note">Some slides, shapes or images are omitted. Charts, grouped shapes, themes and animations are not reproduced.</p>}
  </section>;
}
