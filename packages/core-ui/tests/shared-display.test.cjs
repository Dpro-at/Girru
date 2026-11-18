require('./load.cjs');const{test}=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {normalizeDisplay,COMPONENT_TYPES,safeDisplayUrl}=require('../../display-renderer/src/contract.ts');const {DisplayDocumentView,ReportSpecView,AvatarSpecView}=require('../../display-renderer/src/renderer.tsx');const fixtures=require('../../display-renderer/test/fixtures.json');
const doc=(type,props={},children=[])=>({schemaVersion:1,root:'root',elements:{root:{type,props,children}}});
const render=(type,props=fixtures[type])=>renderToStaticMarkup(React.createElement(DisplayDocumentView,{input:doc(type,props)}));
test('all61 audited types have validated, explicit render paths rather than unknown placeholders',()=>{assert.equal(COMPONENT_TYPES.length,61);assert.deepEqual([...COMPONENT_TYPES].sort(),Object.keys(fixtures).sort());for(const type of COMPONENT_TYPES){const result=normalizeDisplay(doc(type,fixtures[type]));assert.equal(result.ok,true,type+JSON.stringify(result));const html=render(type);assert.doesNotMatch(html,/Unsupported component:|Unable to display/,type);}});
test('versioned contract bounds cycles, props, operations, prototype paths and unknown nodes',()=>{
 for(const input of [{...doc('Card'),schemaVersion:2},doc('Text',{content:()=>{}}),doc('ProgressBar',{value:'not numeric'}),doc('Text',{onClick:'delete'}),doc('Card',{},['root']),doc('Card',{},['missing']),JSON.parse('{"root":"x","elements":{},"__proto__":{}}'),'{"op":"add","path":"/elements/__proto__","value":{}}'])assert.equal(normalizeDisplay(input).ok,false);
 const unknown=normalizeDisplay(doc('NewComponent'));assert.equal(unknown.ok,true);assert.equal(unknown.warnings.length,1);assert.match(renderToStaticMarkup(React.createElement(DisplayDocumentView,{input:doc('NewComponent')})),/Unsupported component: NewComponent/);
 const ops=[{op:'add',path:'/root',value:'r'},{op:'add',path:'/elements/r',value:{type:'Text',props:{content:'before'},children:[]}},{op:'replace',path:'/elements/r/props/content',value:'after'},{op:'test',path:'/elements/r/props/content',value:'after'}].map(JSON.stringify).join('\n');assert.equal(normalizeDisplay(ops).document.elements.r.props.content,'after');assert.equal(normalizeDisplay(ops+'\n'+JSON.stringify({op:'test',path:'/root',value:'wrong'})).ok,false);
});
test('chat/report/avatar share the same rendered components, corrected progress and real pie arcs',()=>{
 const input=doc('ProgressBar',{value:25,max:50,label:'Half'});for(const Component of [DisplayDocumentView,AvatarSpecView]){const html=renderToStaticMarkup(React.createElement(Component,{input,document:input}));assert.match(html,/aria-valuenow="50"/);}assert.match(renderToStaticMarkup(React.createElement(ReportSpecView,{document:input,title:'Saved',capturedAt:'2026-01-01',sourceLabel:'Synthetic'})),/aria-valuenow="50"/);
 assert.match(render('Heading',{text:'Heading',level:'h1'}),/<h1/);assert.match(render('PieChart'),/class="spec-slice"/);assert.doesNotMatch(render('CalendarView',{selectedDates:['2024-02-15']}),/>30<|>31</);
});
test('display JSON grants no actions, unsafe links/media/HTML cannot execute',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','http://example.invalid','https://user:pass@example.invalid'])assert.equal(safeDisplayUrl(url),null);
 assert.match(render('Button',{label:'Danger'}),/disabled/);assert.match(render('AlertDialogCard'),/button/);assert.doesNotMatch(render('MarkdownBlock',{content:'<script>alert(1)</script> **Safe** [x](javascript:alert)'}),/<script|href="javascript:/);
 const state={};const host={onAction:()=>{state.called=true;}};renderToStaticMarkup(React.createElement(DisplayDocumentView,{input:doc('Button',{label:'Action'}),host,surface:'report'}));assert.equal(state.called,undefined);
});

test('copy patches cannot expand intermediate state past display budgets',()=>{
 const ops=[{op:'add',path:'/root',value:'r'},{op:'add',path:'/elements/r',value:{type:'JsonViewer',props:{data:{seed:'x'.repeat(500)}},children:[]}}];
 for(let i=0;i<18;i++)ops.push({op:'copy',from:'/elements/r/props/data',path:'/elements/r/props/data/copy'+i});
 const start=Date.now(),result=normalizeDisplay(ops.map(JSON.stringify).join('\n'));assert.equal(result.ok,false);assert.ok(Date.now()-start<1000);
});

test('finite but extreme chart data never produces NaN or Infinity geometry',()=>{
 for(const [type,p] of [['LineChart',{xKey:'x',yKey:'y',data:[{x:'a',y:1e308},{x:'b',y:-1e308}]}],['PieChart',{nameKey:'n',valueKey:'v',data:[{n:'a',v:1e308},{n:'b',v:1e308}]}],['StockCandlestickChart',{data:[{open:1e308,high:1e308,low:-1e308,close:0}]}],['PortfolioPerformanceChart',{data:[{date:'a',portfolioValue:1e-300},{date:'b',portfolioValue:1e308}]}]]){const html=render(type,p);assert.doesNotMatch(html,/(?:NaN|Infinity)/,type);assert.match(html,/supported numeric range/,type);}
 const html=render('AreaChart',{data:[{x:'a',y:2},{x:'b',y:3}],xKey:'x',yKey:'y',gradient:true});assert.match(html,/linearGradient/);
 assert.doesNotMatch(render('AssetAllocationPie',{holdings:[{symbol:'A',value:10,percentage:100}],showPercentages:false,interactive:false}),/>Table<|100%[)<]/);
});
