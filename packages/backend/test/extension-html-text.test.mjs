import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {htmlToText,HTML_TEXT_INPUT_BYTES,HTML_TEXT_OUTPUT_BYTES} from '../src/plugins/html-text.ts';

test('DOM text extraction decodes entities once, preserves whitespace and never evaluates markup',()=>{
  assert.equal(htmlToText('  A &amp; B <b>bold</b>\n'), '  A & B bold\n');
  assert.equal(htmlToText('&lt;img src=x onerror=alert(1)&gt;'), '<img src=x onerror=alert(1)>', 'result remains untrusted plain text, not safe HTML');
  assert.equal(htmlToText('<span title="a > b">visible</span><!-- hidden -->'), 'visible');
  assert.equal(htmlToText('<b><i>malformed</b> tail'), 'malformed tail');
  assert.equal(htmlToText('مرحبا 世界 😀'), 'مرحبا 世界 😀');
});
test('script, style, template and embedded content are excluded without network or script execution',()=>{
  const previous=globalThis.fetch;globalThis.fetch=()=>assert.fail('HTML extraction must not fetch');
  try{assert.equal(htmlToText('before<script>fetch("https://invalid.test")</script><style>body{}</style><template>hidden</template><iframe src="https://invalid.test">hidden</iframe><object>hidden</object>after'), 'beforeafter');}
  finally{globalThis.fetch=previous;}
});
test('input/output byte bounds and invalid values refuse rather than truncate or coerce',()=>{
  for(const value of [null,{},[],new String('text'),'\ud800','x'.repeat(HTML_TEXT_INPUT_BYTES+1),'😀'.repeat(HTML_TEXT_INPUT_BYTES/4+1)])assert.throws(()=>htmlToText(value),/input_invalid/);
  assert.equal(htmlToText('x'.repeat(HTML_TEXT_OUTPUT_BYTES)).length,HTML_TEXT_OUTPUT_BYTES);
  assert.throws(()=>htmlToText('x'.repeat(HTML_TEXT_OUTPUT_BYTES+1)),/output_too_large/);
  assert.throws(()=>htmlToText('😀'.repeat(HTML_TEXT_OUTPUT_BYTES/4+1)),/output_too_large/);
});
test('extension SDK exposes only the same bounded pure capability without storage or permission effects',async()=>{
  const root=mkdtempSync(join(tmpdir(),'extension-html-sdk-'));mkdirSync(join(root,'data'));
  process.env.NODE_ENV='test';process.env.AGENT_PLAYER_BACKGROUND='off';process.env.HOME=root;process.env.AGENT_PLAYER_DATA_DIR=join(root,'data');process.env.DATABASE_PATH=join(root,'data','test.db');
  const {createExtensionApi}=await import('../src/plugins/sdk.ts');
  const api=createExtensionApi('synthetic-html-test',{}, {prepare(){assert.fail('text conversion must not query the database');}},null,root);
  assert.equal(api.htmlToText,htmlToText);assert.equal(api.htmlToText('<b>plain</b> &amp; text'),'plain & text');
});
