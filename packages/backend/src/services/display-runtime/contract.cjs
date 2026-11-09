"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISPLAY_LIMITS = exports.DISPLAY_SCHEMA_VERSION = exports.COMPONENT_TYPES = exports.COMPONENT_PROPS = void 0;
exports.normalizeDisplay = normalizeDisplay;
exports.displayTree = displayTree;
exports.safeDisplayUrl = safeDisplayUrl;
const catalogue_1 = require("./catalogue.cjs");
Object.defineProperty(exports, "COMPONENT_PROPS", { enumerable: true, get: function () { return catalogue_1.COMPONENT_PROPS; } });
Object.defineProperty(exports, "COMPONENT_TYPES", { enumerable: true, get: function () { return catalogue_1.COMPONENT_TYPES; } });
exports.DISPLAY_SCHEMA_VERSION = 1;
exports.DISPLAY_LIMITS = Object.freeze({ bytes: 128000, elements: 200, depth: 8, visits: 1000, children: 60, operations: 1000, array: 500, string: 8000 });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const forbidden = (k) => k === '__proto__' || k === 'prototype' || k === 'constructor';
function defineData(target, key, value) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        fail('display_key_invalid');
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) && !forbidden(v);
function fail(reason) { throw Error(reason); }
function safeValue(v, depth = 0) {
    if (depth > 12)
        fail('display_data_depth');
    if (v === null || typeof v === 'boolean')
        return;
    if (typeof v === 'string') {
        if (v.length > exports.DISPLAY_LIMITS.string)
            fail('display_string_limit');
        return;
    }
    if (typeof v === 'number') {
        if (!Number.isFinite(v))
            fail('display_number_invalid');
        return;
    }
    if (v && typeof v === 'object' && !own(v, 'toJSON') && 'toJSON' in v)
        fail('display_json_required');
    if (Array.isArray(v)) {
        if (v.length > exports.DISPLAY_LIMITS.array)
            fail('display_array_limit');
        for (const key of Reflect.ownKeys(v)) {
            if (key === 'length')
                continue;
            if (typeof key !== 'string' || forbidden(key) || !/^(0|[1-9][0-9]*)$/.test(key))
                fail('display_key_invalid');
            const descriptor = Object.getOwnPropertyDescriptor(v, key);
            if (!descriptor?.enumerable || !own(descriptor, 'value'))
                fail('display_json_required');
        }
        for (let i = 0; i < v.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
            if (!descriptor?.enumerable || !own(descriptor, 'value'))
                fail('display_json_required');
            safeValue(descriptor.value, depth + 1);
        }
        return;
    }
    if (!object(v))
        fail('display_json_required');
    const keys = Reflect.ownKeys(v);
    if (keys.length > 200)
        fail('display_object_limit');
    for (const key of keys) {
        if (typeof key !== 'string' || forbidden(key) || key.length > 100)
            fail('display_key_invalid');
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor?.enumerable || !own(descriptor, 'value'))
            fail('display_json_required');
        safeValue(descriptor.value, depth + 1);
    }
}
function clone(v) {
    safeValue(v);
    if (Array.isArray(v))
        return v.map(clone);
    if (!object(v))
        return v;
    const result = Object.create(null);
    for (const key of Object.keys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        defineData(result, key, clone(descriptor.value));
    }
    return result;
}
function pointer(path) {
    if (typeof path !== 'string' || path.length > 1000 || !path.startsWith('/'))
        fail('display_patch_path');
    const parts = path.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.some(forbidden) || !['root', 'elements', 'schemaVersion'].includes(parts[0]))
        fail('display_patch_path');
    return parts;
}
function readAt(root, parts) { let value = root; for (const key of parts) {
    if ((!object(value) && !Array.isArray(value)) || !own(value, key))
        fail('display_patch_missing');
    value = value[key];
} return value; }
function writeAt(root, parts, value, mode) {
    if (!parts.length || parts.some(forbidden))
        fail('display_patch_path');
    const key = parts.at(-1);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
        if ((!object(parent) && !Array.isArray(parent)) || !own(parent, part))
            fail('display_patch_missing');
        parent = parent[part];
    }
    if (Array.isArray(parent)) {
        if (key === '-' && mode === 'add') {
            parent.push(value);
            return;
        }
        if (!/^(0|[1-9][0-9]*)$/.test(key))
            fail('display_patch_index');
        const i = Number(key);
        if (i > parent.length || mode !== 'add' && i === parent.length)
            fail('display_patch_index');
        if (mode === 'add')
            parent.splice(i, 0, value);
        else if (mode === 'remove')
            parent.splice(i, 1);
        else
            parent.splice(i, 1, value);
        return;
    }
    if (!object(parent))
        fail('display_patch_parent');
    if (mode !== 'add' && !own(parent, key))
        fail('display_patch_missing');
    if (mode === 'remove')
        delete parent[key];
    else
        defineData(parent, key, value);
}
function dataBudget(value) { safeValue(value); if (new TextEncoder().encode(JSON.stringify(value)).length > exports.DISPLAY_LIMITS.bytes)
    fail('display_byte_limit'); }
function fromPatches(text) {
    const root = Object.create(null);
    defineData(root, 'elements', Object.create(null));
    let count = 0;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        if (++count > exports.DISPLAY_LIMITS.operations)
            fail('display_patch_limit');
        const op = JSON.parse(line);
        if (!object(op) || !['add', 'remove', 'replace', 'copy', 'move', 'test'].includes(String(op.op)) || Object.keys(op).some(k => !['op', 'path', 'from', 'value'].includes(k)))
            fail('display_patch_invalid');
        safeValue(op);
        const parts = pointer(op.path);
        if (op.op === 'test') {
            if (JSON.stringify(readAt(root, parts)) !== JSON.stringify(op.value))
                fail('display_patch_test');
            continue;
        }
        if (op.op === 'copy' || op.op === 'move') {
            const from = pointer(op.from);
            if (op.op === 'move' && parts.slice(0, from.length).join('/') === from.join('/'))
                fail('display_patch_move');
            const v = clone(readAt(root, from));
            if (op.op === 'move')
                writeAt(root, from, null, 'remove');
            writeAt(root, parts, v, 'add');
        }
        else {
            if (op.op !== 'remove' && !own(op, 'value'))
                fail('display_patch_value');
            writeAt(root, parts, clone(op.value ?? null), String(op.op));
        }
        dataBudget(root);
    }
    return root;
}
function normalizeDisplay(input) {
    try {
        if (typeof input === 'string' && new TextEncoder().encode(input).length > exports.DISPLAY_LIMITS.bytes)
            fail('display_byte_limit');
        let raw = input;
        if (typeof input === 'string') {
            try {
                const parsed = JSON.parse(input);
                raw = object(parsed) && own(parsed, 'root') ? parsed : fromPatches(input);
            }
            catch {
                raw = fromPatches(input);
            }
        }
        safeValue(raw);
        if (new TextEncoder().encode(JSON.stringify(raw)).length > exports.DISPLAY_LIMITS.bytes)
            fail('display_byte_limit');
        if (!object(raw) || Object.keys(raw).some(k => !['schemaVersion', 'root', 'elements'].includes(k)))
            fail('display_document_invalid');
        if (raw.schemaVersion !== undefined && raw.schemaVersion !== exports.DISPLAY_SCHEMA_VERSION)
            fail('display_version_unsupported');
        if (!id(raw.root) || !object(raw.elements))
            fail('display_document_invalid');
        const elements = Object.create(null), warnings = [];
        if (Object.keys(raw.elements).length > exports.DISPLAY_LIMITS.elements)
            fail('display_element_limit');
        for (const [key, value] of Object.entries(raw.elements)) {
            if (!id(key) || !object(value) || Object.keys(value).some(k => !['type', 'props', 'children'].includes(k)) || typeof value.type !== 'string' || value.type.length > 80)
                fail('display_element_invalid');
            const props = value.props ?? {}, children = value.children ?? [];
            if (!object(props) || !Array.isArray(children) || children.length > exports.DISPLAY_LIMITS.children || !children.every(id))
                fail('display_element_invalid');
            if (own(catalogue_1.COMPONENT_PROPS, value.type)) {
                const fields = catalogue_1.COMPONENT_PROPS[value.type];
                for (const [field, v] of Object.entries(props)) {
                    if (!own(fields, field))
                        fail('display_prop_unknown');
                    if (v === null)
                        continue;
                    const kind = fields[field];
                    if (kind === 'scalar' && !['string', 'number'].includes(typeof v) || kind === 'array' && !Array.isArray(v) || kind === 'object' && !object(v) || ['string', 'number', 'boolean'].includes(kind) && typeof v !== kind)
                        fail('display_prop_type');
                }
            }
            else
                warnings.push('Unsupported component: ' + value.type);
            defineData(elements, key, { type: value.type, props: clone(props), children: [...children] });
        }
        if (!own(elements, raw.root))
            fail('display_root_missing');
        let visits = 0;
        const visit = (key, seen, depth) => { if (!own(elements, key))
            fail('display_child_missing'); if (seen.has(key))
            fail('display_cycle'); if (depth > exports.DISPLAY_LIMITS.depth || ++visits > exports.DISPLAY_LIMITS.visits)
            fail('display_tree_limit'); const next = new Set(seen).add(key); for (const child of elements[key].children)
            visit(child, next, depth + 1); };
        visit(raw.root, new Set(), 0);
        return { ok: true, document: { schemaVersion: 1, root: raw.root, elements }, warnings: [...new Set(warnings)] };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error && error.message.startsWith('display_') ? error.message : 'display_invalid_json' };
    }
}
function displayTree(document) {
    const build = (id) => ({ ...document.elements[id], id, children: document.elements[id].children.map(build) });
    return build(document.root);
}
function safeDisplayUrl(value, media = false) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s"'<>\\]/.test(value))
        return null;
    try {
        const u = new URL(value);
        return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
    }
    catch {
        return null;
    }
}
