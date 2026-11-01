'use strict';
const path = require('node:path');
const { buildSync } = require(require.resolve('esbuild', { paths: [path.resolve(__dirname, '../../core-ui/node_modules')] }));
buildSync({ entryPoints: [path.resolve(__dirname, '../src/pages/permission-orb.ts')], outfile: path.resolve(__dirname, '../src/pages/permission-orb.js'), bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'inline', banner: { js: '/* AI-Orb renderer, MIT Copyright (c) 2026 Nick Vyhouski. See AI-ORB-LICENSE.txt. Built from permission-orb.ts. */' } });
