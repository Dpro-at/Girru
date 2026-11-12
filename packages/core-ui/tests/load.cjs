const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const { bindConsumerReact } = require('../scripts/react-runtime.cjs');
/* Pictures imported by the page: their bundled URL in the build, the file name in tests. */
require.extensions['.webp'] = (module, filename) => { module.exports = { __esModule: true, default: '/assets/' + path.basename(filename) }; };
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => {
    bindConsumerReact(module, path.resolve(__dirname, '..'));
    const source = fs.readFileSync(filename, 'utf8');
    const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
    module._compile(result.outputText, filename);
  };
}
