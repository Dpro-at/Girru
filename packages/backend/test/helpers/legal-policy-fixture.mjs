import {createHash} from 'node:crypto';
export function legalFixture(){
 const documents={terms:{status:'approved',title:'Terms of Use',sections:[{title:'Test terms',paragraphs:['Disposable terms fixture.']}]},privacy:{status:'approved',title:'Privacy Policy',sections:[{title:'Test privacy',paragraphs:['Disposable privacy fixture.']}]}};
 const hash=createHash('sha256').update(JSON.stringify(documents)).digest('hex');
 const manifest={schema:1,product:'Girru',locale:'en',status:'approved',version:'test.1',effectiveAt:'2020-01-01',termsUrl:'https://girru.dev/terms/',privacyUrl:'https://girru.dev/privacy/',imprintUrl:'https://girru.dev/imprint/',accessibilityUrl:'https://girru.dev/accessibility/',contentUrl:'https://girru.dev/legal/content.json',approval:{contentSha256:hash}};
 const content={schema:1,product:'Girru',locale:'en',status:'approved',version:manifest.version,documents};
 const policy={version:manifest.version,contentSha256:hash,effectiveAt:manifest.effectiveAt,locale:'en',termsUrl:manifest.termsUrl,privacyUrl:manifest.privacyUrl,documents};
 return {manifest,content,policy,acceptance:{accepted:true,version:manifest.version,contentSha256:hash},fetcher:async url=>new Response(JSON.stringify(url.endsWith('/policy.json')?manifest:content),{headers:{'Content-Type':'application/json'}})};
}
