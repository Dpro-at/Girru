require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {orientedViewport,validViewport}=require('../src/browser-devices.ts');
const {allowedBrowserApp,browserAppResponse,BROWSER_APP_PATH}=require('../src/browser-app-contract.js');
test('portrait and landscape preserve mobile/touch layout for phones, foldables and tablets',()=>{
 for(const size of [{width:390,height:844,mobile:true},{width:984,height:1092,mobile:true},{width:834,height:1194,mobile:true},{width:3840,height:2160,mobile:false}]){
  const landscape=orientedViewport(size,false),portrait=orientedViewport(landscape,true);assert.equal(landscape.mobile,size.mobile);assert.equal(portrait.mobile,size.mobile);assert.ok(landscape.width>=landscape.height);assert.ok(portrait.height>=portrait.width);assert.deepEqual(orientedViewport(portrait,false),landscape);
 }
 for(const [w,h]of [[239,800],[390,8193],[NaN,800],[390.5,844]])assert.equal(validViewport(w,h),false);assert.equal(validViewport(7680,4320),true);
});
test('device presets use the owner-only fixed command and closed bounded projection',()=>{
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'devices'}),true);assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'devices',path:'/private'}),false);
 const p={id:'phone',name:'Phone',group:'Phones',kind:'phone',width:390,height:844,mobile:true};assert.deepEqual(browserAppResponse(200,{presets:[{...p,token:'private'}]}),{presets:[p]});
 for(const bad of [{...p,width:9000},{...p,height:0},{...p,kind:'script'},{...p,mobile:'true'}])assert.deepEqual(browserAppResponse(200,{presets:[bad]}),{presets:[]});
});
