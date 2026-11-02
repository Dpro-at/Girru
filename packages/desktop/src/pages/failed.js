'use strict';
const params = new URLSearchParams(window.location.search);
const $ = id => document.getElementById(id);
const show = (id, text) => { const el = $(id); if (text !== undefined) el.textContent = text; el.hidden = false; };
const version = v => (v ? `Girru ${v}` : 'a newer Girru');
const kind = params.get('kind');
$('reason').textContent = params.get('reason') || 'Unknown problem.';
if (kind === 'migration_failed') {
  // STORE-MAP-01 P3 (FD4a): one plain sentence, the step, the error id.
  $('title').textContent = 'The update could not finish';
  show('lead', 'Nothing was lost. The step that failed was undone, and nothing after it ran.');
  $('reason').textContent = `The update to ${version(params.get('thisVersion'))} stopped at the step “${params.get('step') || 'unknown'}”.`;
  const id = params.get('errorId');
  if (id) {
    show('error-id', `Error id ${id} · copy it if you ask for help`);
    show('copy-id');
    $('copy-id').addEventListener('click', () => { void navigator.clipboard?.writeText(id).then(() => { $('copy-id').textContent = 'Copied'; }); });
  }
} else if (kind === 'layout_newer') {
  // STORE-MAP-01 P3 (FD4b): an older Girru never opens newer data.
  $('title').textContent = 'This workspace needs a newer Girru';
  show('lead', 'Update Girru to open it, or open another workspace.');
  $('reason').textContent = `This workspace was last opened by ${version(params.get('writtenBy'))}. This is ${version(params.get('thisVersion'))}, which does not know the newer layout. Nothing was opened or changed.`;
  $('retry').hidden = true;
  show('update');
  show('workspace');
  $('update').addEventListener('click', () => window.dproDesktop.updateFromFailed());
  $('workspace').addEventListener('click', () => window.dproDesktop.otherWorkspace());
}
if (params.get('remote') === '1') {
  $('title').textContent = 'Girru could not be reached';
  $('local').hidden = false;
}
$('retry').addEventListener('click', () => window.dproDesktop.retry());
$('logs').addEventListener('click', () => window.dproDesktop.showLogs());
$('connect').addEventListener('click', () => window.dproDesktop.openConnect());
$('local').addEventListener('click', () => window.dproDesktop.useLocal());
