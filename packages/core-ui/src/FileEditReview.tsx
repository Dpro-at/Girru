import type { EditReview } from './edit-review';
import { UiIcon } from './ui-icons';
import { OpenInCodeIcon } from './CodeOpen';
import { useState } from 'react';

type CodeRequester = Parameters<typeof OpenInCodeIcon>[0]['client'];
const absolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** Read-only proposal. The existing approval action is the only apply control.
 *  CODE-OPEN-01: with a client, the file opens in Code at the first changed line, read only until it is approved. */
export function FileEditReview({review,client}:{review:EditReview;client?:CodeRequester}) {
 const [said,say]=useState<string|null>(null);
 const line=review.rows.find(r=>r.kind!=='context')?.old??review.rows.find(r=>r.kind!=='context')?.next??null;
 return <section className="file-edit-review" aria-label="Proposed file changes"><header className="dk-file-row"><UiIcon name="file" size={13}/><strong dir="ltr">{review.path}</strong><span>Before applying</span>{client&&absolute(review.path)&&<OpenInCodeIcon client={client} path={review.path} line={line} say={say} readOnly/>}</header>{said&&<p className="fine-print" role="status">{said}</p>}<div className="diff" role="table" aria-label={`Proposed changes to ${review.path}`} tabIndex={0}>{review.rows.map((row,i)=><div key={i} className="diff-line" role="row" data-kind={row.kind}><span className="diff-no">{row.old??''}</span><span className="diff-no">{row.next??''}</span><code>{row.kind==='del'?'-':row.kind==='add'?'+':' '} {row.text}</code></div>)}</div></section>;
}
