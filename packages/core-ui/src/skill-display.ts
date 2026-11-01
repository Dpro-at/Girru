// How a skill looks on screen (boards SK1–SK3): a readable title instead of the package
// name, where it came from as a group with an icon, and its own icon and colour.
import type {UiIconName} from './ui-icons';

/** "content-studio" → "Content studio"; names that already read like words stay as they are. */
export function skillTitle(name:string){
 const clean=name.trim();if(!clean)return 'Untitled skill';
 if(/[A-Z ]/.test(clean)&&!/[-_]/.test(clean))return clean;
 const words=clean.replace(/\.md$/i,'').replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
 return properWords((words.charAt(0).toUpperCase()+words.slice(1)));
}
/** Names that have their own spelling ("Github" → "GitHub", "Json" → "JSON"). */
const PROPER:Record<string,string>=Object.fromEntries(['AI','API','CLI','LSP','PHP','SVG','PNG','MD','CSS','CSV','HTML','JSON','MCP','PDF','PR','QA','SDK','SEO','SQL','SSH','UI','UX','URL','GenVR','GitHub','GitLab','iOS','macOS','OpenAI','YouTube','LinkedIn','TikTok','WhatsApp','PostgreSQL','SQLite','TypeScript','JavaScript','Girru'].map(w=>[w.toLowerCase(),w]));
export function properWords(text:string){return text.replace(/[A-Za-z]+/g,w=>PROPER[w.toLowerCase()]??w);}

/** A SKILL.md as the owner reads it: the description from its front matter, and the text after it. */
export function skillFileSummary(text:string){
 const m=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
 if(!m)return {description:'',body:text};
 const lines=m[1].split(/\r?\n/),at=lines.findIndex(l=>/^description\s*:/.test(l));
 let description='';
 if(at>=0){const first=lines[at].replace(/^description\s*:\s*/,'').trim();
  const rest:string[]=[];for(const l of lines.slice(at+1)){if(/^\S/.test(l))break;rest.push(l.trim());}
  description=(/^[>|][+-]?$/.test(first)?rest:[first,...rest]).join(' ').replace(/^["']|["']$/g,'').replace(/\s+/g,' ').trim();}
 return {description,body:text.slice(m[0].length)};
}

/** Why a found item cannot be added, in plain words (codes never reach the screen). */
export function blockedReason(code:string){
 const say:Record<string,string>={
  metadata_only:'SSH identity found. Its path and public fingerprint are shown for reference; the private key stays on this computer and is not imported.',
  skill_name_taken:'Girru already has another skill with this name. It is not replaced from here; compare them in Skills.',
  unsupported_configuration:'Its settings use a form Girru cannot run yet, so it cannot be added.',
 };
 return say[code]??`It cannot be added here (${code.replace(/_/g,' ')}).`;
}

export type SkillSource={key:string;group:string;line:string;icon:UiIconName;app?:string};
const SOURCES:Record<string,SkillSource>={
 workspace:{key:'workspace',group:'Made in this workspace',line:'Made in this workspace',icon:'pencil'},
 bundled:{key:'bundled',group:'Comes with Girru',line:'Comes with Girru',icon:'box'},
 genvr:{key:'genvr',group:'From GenVR',line:'From GenVR',icon:'dice'},
 catalogue:{key:'catalogue',group:'From Girru’s catalogue',line:'From Girru’s catalogue',icon:'download'},
 claude:{key:'claude',group:'From Claude Code',line:'From Claude Code',icon:'code',app:'Claude Code'},
 codex:{key:'codex',group:'From Codex',line:'From Codex',icon:'code',app:'Codex'},
 shared:{key:'shared',group:'From shared agent skills',line:'From shared agent skills',icon:'code',app:'Shared agent skills'},
 project:{key:'project',group:'From a project folder',line:'From a project folder',icon:'folder',app:'A project folder'},
 other:{key:'other',group:'Other places',line:'From another place',icon:'folder'},
};
/** The place a skill came from, in plain words (raw origin codes never reach the screen). */
export function skillSource(origin:string):SkillSource{
 const o=origin.toLowerCase();
 if(['workspace','managed','existing','local'].includes(o))return SOURCES.workspace;
 if(o==='bundled')return SOURCES.bundled;
 if(o.startsWith('genvr'))return SOURCES.genvr;
 if(o==='reviewed-marketplace')return SOURCES.catalogue;
 if(o==='codex')return SOURCES.codex;
 if(o==='shared')return SOURCES.shared;
 if(o==='project')return SOURCES.project;
 if(o.startsWith('claude'))return SOURCES.claude;
 return SOURCES.other;
}
/** The order source groups appear in the list. */
export const SOURCE_ORDER=['workspace','bundled','genvr','catalogue','claude','codex','shared','project','other'];

const LOOKS:[RegExp,UiIconName][]=[[/content|write|writer|post|copy|blog|newsletter|brand|story/,'pencil'],[/analytic|data|chart|metric|report|sql|dashboard/,'chart'],[/course|teach|learn|lesson|tutor|study/,'cap'],[/audio|podcast|voice|speech|music|sound/,'mic'],[/calc|math|unit|number/,'calc'],[/computer|discover|desktop|system/,'laptop'],[/world|genvr|game|scene|3d/,'dice'],[/code|review|debug|test|program|dev/,'code'],[/design|logo|colour|color|image|graphic|thumbnail|visual/,'palette'],[/pdf|doc|word|sheet|xlsx|pptx|slide|file/,'file'],[/trade|money|finance|invoice|tax/,'coin'],[/mail|email|message|chat/,'message'],[/search|research|seo|keyword/,'search'],[/security|safe|guard|permission/,'shield'],[/plan|task|project|board/,'board']];
const COLOURS=['#C4A5FF','#6FD3C7','#F0B86E','#F29BC0','#8FD6B0','#9DBBFF','#E8A27C','#B9C46B'];
/** A skill's own icon and colour, chosen from its name so it stays the same everywhere. */
export function skillLook(name:string):{icon:UiIconName;colour:string}{
 const n=name.toLowerCase(),icon=LOOKS.find(([pattern])=>pattern.test(n))?.[1]??'book';
 let hash=0;for(const ch of n)hash=(hash*31+ch.charCodeAt(0))>>>0;
 return {icon,colour:COLOURS[hash%COLOURS.length]};
}

/** A package file in plain words: SKILL.md is the main guide, "references/claims-and-voice.md" → "Claims and voice". */
export function fileTitle(path:string){
 if(path==='SKILL.md')return 'Main guide';
 const base=path.split('/').pop()??path;return skillTitle(base.replace(/\.md$/i,''));
}
export function folderTitle(path:string){const parts=path.split('/');return parts.length>1?skillTitle(parts.slice(0,-1).join(' › ')):'';}

/** A marketplace or plugin id as words: "claude-plugins-official" → "Official Claude Code plugins". */
export function publisherName(id:string){
 const known:Record<string,string>={'claude-plugins-official':'Official Claude Code plugins'};
 return known[id]??skillTitle(id);
}
/** "name@marketplace" (a coding-app plugin) as its own name, without the marketplace id. */
export function addonName(id:string){const at=id.lastIndexOf('@');return skillTitle(at>0?id.slice(0,at):id);}
