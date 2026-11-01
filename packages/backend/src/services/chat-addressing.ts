/** Resolve conversational addresses against the current chat, never the whole workspace. */
export type ChatParticipant = { id: string; name: string; department: string | null; role?: string | null };
type Selection = { ids: string[] | null; ambiguous?: ChatParticipant[]; others?: boolean; followup?: boolean };

export function addressText(value: string): string {
  return value.replace(/```[\s\S]*?```/g, ' ').replace(/^>.*$/gm, ' ').replace(/"[^"]*"|«[^»]*»/g, ' ')
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[أإآٱ]/g, 'ا').replace(/ـ/g, '').toLowerCase();
}

/** Cross-script name matching is deliberately conservative and ambiguity is retained. */
function nameSound(value: string): string {
  const arabic: Record<string, string> = { ا:'a',ب:'b',پ:'p',ت:'t',ث:'th',ج:'j',چ:'tsh',ح:'h',خ:'kh',د:'d',ذ:'dh',ر:'r',ز:'z',ژ:'zh',س:'s',ش:'sh',ص:'s',ض:'d',ط:'t',ظ:'z',ع:'',غ:'gh',ف:'f',ڤ:'v',ق:'k',ك:'k',ک:'k',گ:'g',ل:'l',م:'m',ن:'n',ه:'h',ة:'h',و:'w',ي:'y',ى:'y',ئ:'y',ؤ:'w',ء:'' };
  return [...addressText(value).replace(/ch/g, 'tsh').replace(/ph/g, 'f').replace(/g(?=[ei])/g, 'j').replace(/c/g, 'k')]
    .map(letter => arabic[letter] ?? letter).join('').replace(/[aeiouyw\s]/g, '').replace(/[^a-z0-9]/g, '');
}

function words(value: string): string[] { return addressText(value).match(/[\p{L}\p{N}]+/gu) ?? []; }
export function asksRemaining(message: string): boolean {
  const text = words(message).join(' ');
  return /^(?:و ?)?(?:الباقين|الباقيين|البقية|بقيتهم|الاخرين|باقي الفريق|بقية الفريق)(?: (?:وينهم|شنو|جاهزين|مستعدين|يردون|يردوا|يجيبون))?$/.test(text)
    || /^(?:and |what about )?(?:the )?(?:others|rest|remaining participants)(?: then)?$/.test(text);
}
export function addressesGroup(message: string): boolean {
  const text = words(message).join(' ');
  return /^(?:(?:هل|انتم|كلكم|يا فريق|يا شباب|هلا|مرحبا) )?(?:مستعدين|جاهزين|جاهزون|متفقين|متفقون|كيفكم|شلونكم|شخباركم|شرايكم|رايكم)(?: |$)/.test(text)
    || /^(?:are you all|are all of you|is everyone|are we all|you all|team)[ ,]*(?:ready|available|prepared|there|in agreement)\b/.test(addressText(message));
}

export function conversationalSelection(message: string, participants: ChatParticipant[], selected?: string): Selection {
  if (asksRemaining(message)) return { ids: null, others: true };
  const tokens = words(message.slice(0, 4000));
  const sounds=new Map<string,string>();
  const soundOf=(value:string)=>{let sound=sounds.get(value);if(sound===undefined){sound=nameSound(value);sounds.set(value,sound);}return sound;};
  const hits: { person: ChatParticipant; at: number; size: number; score: number }[] = [];
  for (const person of participants) {
    const full = words(person.name); if (!full.length) continue;
    const aliases = [full, ...(full.length > 1 ? [full.slice(0, 1)] : [])];
    for (const alias of aliases) {
      const sound = soundOf(alias.join(' '));
      for (let at = 0; at < Math.min(tokens.length, 200); at++) {
        const span = tokens.slice(at, at + alias.length);
        if (span.length !== alias.length) continue;
        const raw = span.join(' '), named = alias.join(' ');
        const variations = [raw, ...(/^[وف]?ال/u.test(raw) ? [raw.replace(/^[وف]?ال/u, '')] : []), ...(raw.startsWith('و') ? [raw.slice(1)] : [])];
        const exact = variations.includes(named);
        const crossScript = /[\u0600-\u06ff]/.test(raw) !== /[\u0600-\u06ff]/.test(named);
        const phonetic = !exact && crossScript && sound.length >= 3 && variations.some(v => soundOf(v) === sound);
        if (!exact && !phonetic) continue;
        const before = tokens.slice(0, at).join(' '), after = tokens.slice(at + alias.length).join(' ');
        // A report about a colleague is different from addressing that colleague.
        if (/(?:قال|قصد|قصده|كتب|كلام|رسالة|ملف|لخص|ترجم|اشرح|قارن|معنى|said|wrote|summarize|explain|compare|message|meaning)(?: |$)/u.test(before)
          || /^(?:قال|كتب|ذكر|يقول|اجاب|said|wrote|says)(?: |$)/u.test(after)) continue;
        const direct = at === 0 || at + alias.length === tokens.length || /(?:كيفك|شلونك|رايك|عندك|تقدر|انت|انتي|مرحبا|هلا|how are you|can you|what do you think)/u.test(before + ' ' + after);
        if (direct) hits.push({ person, at, size: alias.length, score: (exact ? 100 : 50) + (alias.length === full.length ? 20 : 0) });
      }
    }
  }
  const selectedHits = hits.filter(hit => !hits.some(other => other.at === hit.at && (other.score > hit.score || other.score === hit.score && other.size > hit.size)));
  const candidates = [...new Map(selectedHits.map(hit => [hit.person.id, hit.person])).values()];
  if (selectedHits.some(hit => selectedHits.some(other => hit.person.id !== other.person.id && hit.at === other.at))) {
    if (selected && candidates.some(person => person.id === selected)) return { ids: [selected] };
    return { ids: null, ambiguous: candidates };
  }
  if (candidates.length) return { ids: candidates.map(person => person.id) };
  if (addressesGroup(message)) return { ids: participants.map(person => person.id) };
  const text = tokens.join(' ');
  return { ids: null, ...(/^(?:و?انت|كيفك|شلونك|جاهز|مستعد|وانتي|and you|are you ready|how about you)(?: |$)/u.test(text) ? { followup: true } : {}) };
}
