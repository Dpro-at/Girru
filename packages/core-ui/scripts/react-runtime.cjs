'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const packages = Object.freeze(['react', 'react-dom']);
const isReactImport = specifier => typeof specifier === 'string' && packages.some(name => specifier === name || specifier.startsWith(name + '/'));
/** Shared source consumes the application's locked React, including JSX subpaths. */
function reactResolve() { return { dedupe: [...packages] }; }
/** The source-test compiler has the same consumer boundary as the browser bundler. */
function bindConsumerReact(sourceModule, consumerRoot) {
  const consumerRequire = createRequire(path.join(consumerRoot, 'package.json'));
  const sourceRequire = sourceModule.require.bind(sourceModule);
  sourceModule.require = specifier => isReactImport(specifier) ? consumerRequire(specifier) : sourceRequire(specifier);
}
module.exports = { reactResolve, bindConsumerReact };
