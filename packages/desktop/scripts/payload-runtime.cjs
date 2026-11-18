'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const BUILD_TOOLS = new Set(['typescript', 'tsx', 'esbuild']);
const buildOnly = name => BUILD_TOOLS.has(name) || name.startsWith('@esbuild/');
const supported = (values, actual) => !Array.isArray(values) || (!values.includes(`!${actual}`) && (values.every(v => v.startsWith('!')) || values.includes(actual)));

/** Use the lockfile rather than everything left in a developer's installed folder. */
function productionModules(lock, platform = process.platform, arch = process.arch) {
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Payload requires a version 3 backend lockfile');
  return new Set(Object.entries(lock.packages).filter(([key, value]) => {
    const name = key.split('node_modules/').at(-1);
    return key.startsWith('node_modules/') && !value.dev && !value.link && !buildOnly(name) && supported(value.os, platform) && supported(value.cpu, arch);
  }).map(([key]) => key));
}

function moduleFilter(root, allowed, noSecrets, platform = process.platform, arch = process.arch) {
  return source => {
    if (!noSecrets(source)) return false;
    const rel = path.relative(root, source).split(path.sep).join('/');
    if (!rel) return true;
    const parts = rel.split('/');
    if (parts.some(p => ['.bin', '.cache', '.vite'].includes(p))) return false;
    const prebuild = parts.indexOf('prebuilds');
    if (prebuild !== -1 && parts[prebuild + 1]) {
      const folder = parts[prebuild + 1], arches = folder.startsWith(`${platform}-`) ? folder.slice(platform.length + 1).split('+') : [];
      if (!arches.some(a => a === arch || a.startsWith(`${arch}-`))) return false;
    }
    const key = `node_modules/${rel}`;
    // Check the innermost package too: a production package may contain dev modules.
    const segments = key.split('/');
    let packageKey = '';
    for (let i = 0; i < segments.length; i++) if (segments[i] === 'node_modules' && segments[i + 1]) {
      const end = i + (segments[i + 1].startsWith('@') ? 3 : 2);
      if (segments.length >= end) packageKey = segments.slice(0, end).join('/');
    }
    if (allowed.has(packageKey)) return true;
    // Keep scope and nested node_modules directories needed to reach an allowed package.
    return [...allowed].some(p => p.startsWith(`${key}/`));
  };
}

function assertRelativeImports(text, file, ts) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = node => {
    const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith('.') && !/\.(?:[cm]?js|json)$/.test(spec.text)) throw new Error(`Backend ESM import needs a runtime extension: ${spec.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Reject drift before replacing the previous payload; missing optional packages may be absent. */
function validateModules(lock, allowed, roots) {
  for (const key of allowed) {
    const files = roots.map(root => path.join(root, key.slice('node_modules/'.length), 'package.json'));
    const file = files.find(file => fs.existsSync(file));
    if (!file && lock.packages[key].optional) continue;
    let installed;
    try { installed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* report a bounded package identifier */ }
    if (!installed || installed.version !== lock.packages[key].version) throw new Error(`Locked runtime dependency missing or different: ${key}. Provide clean npm-ci dependency folders before staging.`);
  }
}

function compilerOptions(backend, ts) {
  const config = ts.readConfigFile(path.join(backend, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('Cannot read backend TypeScript configuration');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backend);
  if (parsed.errors.length) throw new Error('Invalid backend TypeScript configuration');
  if (parsed.options.paths) throw new Error('Backend path aliases need explicit runtime resolution');
  if (parsed.options.importHelpers) throw new Error('Backend payload must emit inline helpers');
  return { ...parsed.options, module: ts.ModuleKind.ESNext, declaration: false, declarationMap: false, sourceMap: false, inlineSourceMap: false, rewriteRelativeImportExtensions: true };
}

/** Reviewed non-execution literals: launcher validation, a language label, and the source-only bridge branch. */
const SOURCE_ONLY_LITERALS = {
  'config/isolated-env-check.js': ['tsx'],
  'services/memory-enrichment.js': ['typescript'],
  'memory/bridge/clients.js': ['.ts', 'tsx', 'tsx/esm'],
};
function assertCompiledRuntime(root, ts) {
  for (const name of fs.readdirSync(root, { recursive: true }).filter(name => /\.[cm]?js$/.test(name))) {
    const source = ts.createSourceFile(name, fs.readFileSync(path.join(root, name), 'utf8'), ts.ScriptTarget.Latest, true), found = [];
    const visit = node => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && (/\.[cm]?tsx?$/.test(node.text) || /^(?:tsx|typescript|esbuild)(?:\/|$)/.test(node.text))) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const allowed = SOURCE_ONLY_LITERALS[name.split(path.sep).join('/')] ?? [];
    if (found.length && JSON.stringify(found.sort()) !== JSON.stringify([...allowed].sort())) throw new Error(`Compiled runtime contains an unreviewed TypeScript loader or path: ${name}`);
  }
}

/** Extension frontend sources are build inputs, never Node entry points. */
function assertExtensionRuntime(root, ts) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.name === 'frontend') continue;
    if (entry.isSymbolicLink()) throw new Error('Extension runtime must not contain symbolic links');
    if (entry.isDirectory()) assertExtensionRuntime(file, ts);
    else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) throw new Error('Extension runtime TypeScript must be compiled before staging');
    else if (/^agent-?player\.plugin\.json$/.test(entry.name)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.main && !/\.[cm]?js$/.test(manifest.main)) throw new Error('Extension entry must be JavaScript');
    } else if (ts && /\.[cm]?js$/.test(entry.name)) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isStringLiteral(node) && (/\.[cm]?tsx?$/.test(node.text) || /^(?:tsx|typescript|esbuild)(?:\/|$)/.test(node.text))) throw new Error('Extension runtime cannot load TypeScript or build tools');
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
}

/** The staged UI bridge is deliberately standalone: its only bare imports are Node built-ins. */
function assertBridgeImports(root, ts) {
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) assertBridgeImports(file, ts);
    else if (/\.(?:c|m)?js$/.test(entry.name)) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') ? node.arguments[0] : null;
        if (spec && ts.isStringLiteral(spec) && !spec.text.startsWith('.') && !path.isAbsolute(spec.text) && !builtins.has(spec.text)) throw new Error(`UI bridge needs an undeclared runtime module: ${spec.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
}

/** Preserve src-relative assets/import.meta paths, replacing only TypeScript source. */
function compileBackend(from, to, ts, options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true }) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (['__tests__', '.data'].includes(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name) || /\.test\.[cm]?tsx?$/.test(entry.name)) continue;
    const input = path.join(from, entry.name), output = path.join(to, entry.name.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.tsx?$/, '.js'));
    if (entry.isSymbolicLink()) throw new Error('Backend source must not contain symbolic links');
    if (entry.isDirectory()) compileBackend(input, output, ts, options);
    else if (/\.[cm]?tsx?$/.test(entry.name)) {
      if (entry.name.endsWith('.tsx') && (!options.jsx || options.jsx === ts.JsxEmit.Preserve)) throw new Error('Backend TSX requires JavaScript JSX emit in tsconfig');
      const result = ts.transpileModule(fs.readFileSync(input, 'utf8'), { fileName: input, reportDiagnostics: true, compilerOptions: options });
      if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot compile backend file: ${entry.name}`);
      assertRelativeImports(result.outputText, output, ts);
      fs.writeFileSync(output, result.outputText);
    } else fs.copyFileSync(input, output);
  }
}

module.exports = { BUILD_TOOLS, productionModules, moduleFilter, compileBackend, validateModules, compilerOptions, assertBridgeImports, assertExtensionRuntime, assertCompiledRuntime };
