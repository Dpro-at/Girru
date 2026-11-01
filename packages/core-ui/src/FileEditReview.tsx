import type { EditReview } from './edit-review';
import { UiIcon } from './ui-icons';

/** Read-only proposal. The existing approval action is the only apply control. */
export function FileEditReview({review}:{review:EditReview}) {
 return <section className="file-edit-review" aria-label="Proposed file changes"><header><UiIcon name="file" size={13}/><strong dir="ltr">{review.path}</strong><span>Before applying</span></header><div className="diff" role="table" aria-label={`Proposed changes to ${review.path}`} tabIndex={0}>{review.rows.map((row,i)=><div key={i} className="diff-line" role="row" data-kind={row.kind}><span className="diff-no">{row.old??''}</span><span className="diff-no">{row.next??''}</span><code>{row.kind==='del'?'-':row.kind==='add'?'+':' '} {row.text}</code></div>)}</div></section>;
}
