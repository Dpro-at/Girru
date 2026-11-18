/**
 * The server checks every tool argument (STORE-MAP-01 XP2, P2b).
 *
 * Models differ in how well they call tools, small local models most of all:
 * a number sent as text, one value where a list is wanted, a guessed extra
 * argument, a missing required one. Before a tool runs, its arguments are
 * checked against its own JSON schema:
 *
 *  - safe repairs only: "5" → 5 for numbers, "true" → true, a single value →
 *    a one-item list, a JSON text that holds the object or list, null → left out;
 *  - arguments the schema does not name are dropped (and reported), unless the
 *    schema allows more (additionalProperties); with additionalProperties false
 *    they are refused;
 *  - a missing required argument, a wrong type, a value outside an enum or a
 *    range, or text that is too long is refused with one plain sentence that
 *    says what to fix.
 *
 * Nothing is trusted because the model sent it: each tool still applies its
 * own rules (grants, scopes, approvals) afterwards.
 */

export type ArgCheck = { ok: true; args: Record<string, unknown>; dropped: string[] } | { ok: false; error: string };

const typeName = (t: string) => (t === 'integer' ? 'a whole number' : t === 'number' ? 'a number' : t === 'boolean' ? 'true or false' : t === 'array' ? 'a list' : t === 'object' ? 'an object' : 'text');

class Refusal extends Error {}

function check(path: string, schema: any, value: unknown): unknown {
  if (!schema || typeof schema !== 'object') return value;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return value; // several shapes: the tool decides
  let t: string | undefined = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
  if (!t && schema.properties) t = 'object';
  if (!t && Array.isArray(schema.enum)) t = typeof schema.enum[0] === 'number' ? 'number' : 'string';
  let v = value;
  if (t === 'integer' || t === 'number') {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v.trim());
    if (typeof v !== 'number' || !Number.isFinite(v) || (t === 'integer' && !Number.isInteger(v))) throw new Refusal(`${path} must be ${typeName(t)}`);
    if (typeof schema.minimum === 'number' && v < schema.minimum) throw new Refusal(`${path} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) throw new Refusal(`${path} must be at most ${schema.maximum}`);
  } else if (t === 'boolean') {
    if (v === 'true' || v === 'false') v = v === 'true';
    if (typeof v !== 'boolean') throw new Refusal(`${path} must be true or false`);
  } else if (t === 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    if (typeof v !== 'string') throw new Refusal(`${path} must be text`);
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) throw new Refusal(`${path} is longer than ${schema.maxLength} characters`);
  } else if (t === 'array') {
    if (typeof v === 'string' && /^\s*\[/.test(v)) { try { v = JSON.parse(v); } catch { /* keep */ } }
    if (!Array.isArray(v)) v = [v];
    const list = v as unknown[];
    if (typeof schema.maxItems === 'number' && list.length > schema.maxItems) throw new Refusal(`${path} has more than ${schema.maxItems} items`);
    v = list.map((x, i) => check(`${path}[${i}]`, schema.items, x));
  } else if (t === 'object') {
    if (typeof v === 'string' && /^\s*\{/.test(v)) { try { v = JSON.parse(v); } catch { /* keep */ } }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Refusal(`${path} must be an object`);
    v = checkObject(path, schema, v as Record<string, unknown>, []);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) throw new Refusal(`${path} must be one of: ${schema.enum.slice(0, 12).map(String).join(', ')}`);
  return v;
}

function checkObject(path: string, schema: any, raw: Record<string, unknown>, dropped: string[]): Record<string, unknown> {
  const props: Record<string, any> = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const declared = Object.keys(props).length > 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    const name = path ? `${path}.${k}` : k;
    if (!(k in props)) {
      if (schema.additionalProperties === false) throw new Refusal(`${name} is not an argument; use only: ${Object.keys(props).join(', ') || 'none'}`);
      if (declared && schema.additionalProperties === undefined) { dropped.push(name); continue; }
      out[k] = v;
      continue;
    }
    out[k] = check(name, props[k], v);
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  for (const k of required) if (out[k] === undefined || out[k] === '') throw new Refusal(`${path ? `${path}.${k}` : k} is required`);
  return out;
}

/** Check (and safely repair) one call's arguments against the tool's schema. */
export function checkToolArgs(schema: any, raw: unknown): ArgCheck {
  let args = raw;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* refused below */ } }
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'the arguments must be one JSON object' };
  if (!schema || typeof schema !== 'object' || (schema.type && schema.type !== 'object')) return { ok: true, args: args as Record<string, unknown>, dropped: [] };
  const dropped: string[] = [];
  try {
    return { ok: true, args: checkObject('', schema, args as Record<string, unknown>, dropped), dropped };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}
