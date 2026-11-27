const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const version=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v);
export function validLegalAcceptance(value){return object(value)&&Object.keys(value).sort().join(',')==='accepted,contentSha256,version'&&value.accepted===true&&version(value.version)&&typeof value.contentSha256==='string'&&/^[a-f0-9]{64}$/.test(value.contentSha256);}
export function parseLegalPolicy(value){
 if(!object(value)||!version(value.version)||typeof value.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.contentSha256)||value.locale!=='en'||typeof value.effectiveAt!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.effectiveAt)||value.termsUrl!=='https://girru.dev/terms/'||value.privacyUrl!=='https://girru.dev/privacy/'||!object(value.documents))throw Error('Invalid legal policy');
 const documents={};for(const key of ['terms','privacy']){
  const doc=value.documents[key];if(!object(doc)||typeof doc.title!=='string'||!doc.title.trim()||doc.title.length>200||!Array.isArray(doc.sections)||!doc.sections.length||doc.sections.length>200)throw Error('Invalid legal text');
  documents[key]={title:doc.title,sections:doc.sections.map(section=>{if(!object(section)||typeof section.title!=='string'||!section.title.trim()||!Array.isArray(section.paragraphs)||!section.paragraphs.length||section.paragraphs.length>100||section.paragraphs.some(p=>typeof p!=='string'||!p.trim()||p.length>20000))throw Error('Invalid legal section');return {title:section.title,paragraphs:[...section.paragraphs]};})};
 }
 return {version:value.version,contentSha256:value.contentSha256,effectiveAt:value.effectiveAt,locale:'en',termsUrl:value.termsUrl,privacyUrl:value.privacyUrl,documents};
}
export function canAgreeToPolicy(readToEnd,checked,busy=false){return readToEnd===true&&checked===true&&busy===false;}
