require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { parseSpec, SpecView } = require('../src/spec.tsx');
const { Markdown } = require('../src/markdown.tsx');

const lines = (...xs) => xs.map(x => JSON.stringify(x)).join('\n');
const el = (id, type, props = {}, children = []) => ({ op: 'add', path: `/elements/${id}`, value: { type, props, children } });
const https = ['https:', '', 'example.com/a'].join('/');

test('spec: shared contract rejects cycles and keeps local form controls without action authority', () => {
 assert.equal(parseSpec(lines({op:'add',path:'/root',value:'g'},el('g','Grid',{},['g']))),null);
 const t=parseSpec(lines({op:'add',path:'/root',value:'g'},el('g','Grid',{},['m','x']),el('m','Metric',{label:'Users',value:'1,204'}),el('x','InputField',{label:'Email'})));
 assert.deepEqual(t.children.map(c=>c.type),['Metric','InputField']);
 assert.equal(parseSpec('{"op":"add",'),null);assert.equal(parseSpec(lines(el('a','Card'))),null);
});

test('spec: cards, tables, timeline, progress, safe links and charts with a table view', () => {
  const spec = lines({ op: 'add', path: '/root', value: 's' }, el('s', 'Stack', {}, ['c', 't', 'tl', 'p', 'l1', 'l2', 'b', 'pie']),
    el('c', 'Card', { title: 'Summary', description: 'Fictional numbers' }, ['m']), el('m', 'Metric', { label: 'Open cards', value: 12 }),
    el('t', 'Table', { data: [{ name: 'A', n: 3 }, { name: 'B', n: 5 }], columns: [{ key: 'name', label: 'Name' }, { key: 'n', label: 'Count' }] }),
    el('tl', 'Timeline', { items: [{ title: 'Plan', status: 'completed' }, { title: 'Build', status: 'current' }] }),
    el('p', 'ProgressBar', { label: 'Done', value: 140 }),
    el('l1', 'Link', { text: 'Docs', href: https }), el('l2', 'Link', { text: 'Bad', href: 'javascript:alert(1)' }),
    el('b', 'BarChart', { title: 'Per day', data: [{ d: 'Mon', v: 3 }, { d: 'Tue', v: -1 }, { d: 'Wed', v: 'x' }], xKey: 'd', yKey: 'v' }),
    el('pie', 'PieChart', { title: 'Share', data: Array.from({ length: 10 }, (_, i) => ({ k: `s${i}`, v: i + 1 })), nameKey: 'k', valueKey: 'v' }));
  const html = renderToStaticMarkup(React.createElement(SpecView, { text: spec }));
  assert.match(html, /Summary/); assert.match(html, />12</); assert.match(html, /<table/); assert.match(html, /Count/);
  assert.match(html, /data-status="current"/); assert.match(html, /aria-valuenow="100"/, 'progress is clamped');
  assert.match(html, /href="https:\/\/example\.com\/a"/); assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /aria-label="Per day: Mon 3, Tue -1"/, 'non-numbers are dropped');
  assert.match(html, />Other</, 'pie folds past eight slices');
  assert.equal((html.match(/class="spec-slice"/g) || []).length, 8);
  assert.match(html, />Table</);
});

test('spec blocks in a reply: drawn when complete, "preparing" while streaming, code when broken', () => {
  const good = '```spec\n' + lines({ op: 'add', path: '/root', value: 'm' }, el('m', 'Metric', { label: 'Total', value: '7' })) + '\n```';
  assert.match(renderToStaticMarkup(React.createElement(Markdown, { text: `Here.\n\n${good}` })), /spec-metric/);
  assert.match(renderToStaticMarkup(React.createElement(Markdown, { text: '```spec\n{"op":"add"' })), /Preparing a view/);
  assert.match(renderToStaticMarkup(React.createElement(Markdown, { text: '```spec\nnot json\n```' })), /md-code/);
});
