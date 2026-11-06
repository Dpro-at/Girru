'use strict';
// Reproduce the optional Store renderer using the existing locked UI build dependencies.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
function buildStoreTrading(storeDir){
 if(!storeDir||!path.isAbsolute(storeDir))throw Error('Provide an absolute --store-dir for the Girru Store checkout.');
 const ui=path.resolve(__dirname,'..'),load=createRequire(path.join(ui,'package.json')),esbuild=load('esbuild'),folder=path.join(storeDir,'apps','trading','package');
 if(!fs.statSync(folder).isDirectory())throw Error('Trading package is missing.');
 esbuild.buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {TradingWorkspace} from './TradingWorkspace';import './trading-workspace.css';export function mount(node,props){const root=createRoot(node);root.render(React.createElement(TradingWorkspace,props));return {update(next){root.render(React.createElement(TradingWorkspace,next));},unmount(){root.unmount();}};}`,resolveDir:path.join(ui,'src'),loader:'tsx',sourcefile:'trading-renderer.tsx'},bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true,define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof',outfile:path.join(folder,'client.js')});
 fs.copyFileSync(path.join(path.dirname(load.resolve('react/package.json')),'LICENSE'),path.join(folder,'react-LICENSE.txt'));
 return folder;
}
if(require.main===module){try{if(process.argv.length!==4||process.argv[2]!=='--store-dir')throw Error('Usage: node build-store-trading.cjs --store-dir /absolute/girru-store');console.log('Trading renderer rebuilt: '+buildStoreTrading(process.argv[3]));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={buildStoreTrading};
