/**
 * The starting rows of the test library and the campaign stages. Store migrations can only make
 * tables, so the app adds these itself at startup, and only into an empty table: rows already
 * there (an earlier start, or data moved from an older Girru) are left as they are.
 */

import { PAYLOADS, STAGES } from './library.js';

export function seedLibrary(db) {
  const empty = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0;
  let added = 0;
  db.transaction(() => {
    if (empty('app_waf_security__waf_payload_library')) {
      const insert = db.prepare('INSERT INTO app_waf_security__waf_payload_library (id, category, payload, description, severity, evasion_technique) VALUES (?, ?, ?, ?, ?, ?)');
      for (const p of PAYLOADS) { insert.run(p.id, p.category, p.payload, p.description, p.severity, p.evasion_technique); added++; }
    }
    if (empty('app_waf_security__waf_campaign_stages')) {
      const insert = db.prepare('INSERT INTO app_waf_security__waf_campaign_stages (stage_number, stage_name, stage_description, default_mode, default_categories) VALUES (?, ?, ?, ?, ?)');
      for (const s of STAGES) { insert.run(s.stage_number, s.stage_name, s.stage_description, s.default_mode, s.default_categories); added++; }
    }
  })();
  return added;
}
