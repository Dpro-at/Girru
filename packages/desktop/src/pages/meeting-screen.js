'use strict';
let sources = [], offset = 0;
const list = document.getElementById('sources'), search = document.getElementById('search'), status = document.getElementById('status');
function draw() { const matches = sources.filter(s => s.name.toLowerCase().includes(search.value.toLowerCase())); list.replaceChildren(); for (const source of matches.slice(offset, offset + 24)) { const button = document.createElement('button'), text = document.createElement('span'); button.type = 'button'; text.textContent = source.name; if (source.thumbnail.startsWith('data:image/png')) { const image = document.createElement('img'); image.alt = ''; image.src = source.thumbnail; button.append(image); } button.append(text); button.onclick = () => { button.disabled = true; void window.meetingShare.choose(source.id).then(ok => { if (!ok) { button.disabled = false; status.textContent = 'That source is no longer available. Choose another one.'; } }); }; list.append(button); } status.textContent = matches.length ? `${offset + 1}–${Math.min(offset + 24, matches.length)} of ${matches.length}` : 'No matching screens or windows'; document.getElementById('previous').disabled = offset === 0; document.getElementById('next').disabled = offset + 24 >= matches.length; }
search.oninput = () => { offset = 0; draw(); };
document.getElementById('previous').onclick = () => { offset = Math.max(0, offset - 24); draw(); };
document.getElementById('next').onclick = () => { offset += 24; draw(); };
document.getElementById('cancel').onclick = () => window.meetingShare.cancel();
window.addEventListener('keydown', event => { if (event.key === 'Escape') void window.meetingShare.cancel(); });
void window.meetingShare.list().then(value => { sources = Array.isArray(value) ? value.filter(s => typeof s.id === 'string' && typeof s.name === 'string' && typeof s.thumbnail === 'string') : []; draw(); }).catch(() => { status.textContent = 'Screens could not be listed. Cancel and try again.'; });
