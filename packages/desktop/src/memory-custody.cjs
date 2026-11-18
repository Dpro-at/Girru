'use strict';
/** Explicit main-process assembly. Existing directories only; no original-data paths, enrollment or key creation. */
const path=require('node:path');
const {createMemoryMasterKeyStore}=require('./memory-key-store.cjs');
const {createMemoryTrustStore}=require('./memory-trust-store.cjs');
const {createMemoryWitnessStore}=require('./memory-witness-store.cjs');
const {createMemoryTrustAdapters}=require('./memory-trust-adapters.cjs');
function createMemoryCustody({masterDirectory,trustDirectory,witnessDirectory,profileRoots,backupRoots,protector,platform,beginTrustPersistence}){
 if(!Array.isArray(profileRoots)||!profileRoots.length||!Array.isArray(backupRoots)||!backupRoots.length)throw Error('memory_custody_unavailable');
 const roots=[...profileRoots,...backupRoots];
 const inside=(root,target)=>{const rel=path.relative(root,target);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
 for(const value of [masterDirectory,trustDirectory,witnessDirectory,...roots])if(typeof value!=='string'||!path.isAbsolute(value))throw Error('memory_custody_unavailable');
 for(const excluded of [...roots,trustDirectory,witnessDirectory])if(inside(path.resolve(excluded),path.resolve(masterDirectory))||inside(path.resolve(masterDirectory),path.resolve(excluded)))throw Error('memory_custody_unavailable');
 const witness=createMemoryWitnessStore({directory:witnessDirectory,excludedRoots:[...roots,trustDirectory,masterDirectory],protector,platform});
 const trust=createMemoryTrustStore({directory:trustDirectory,excludedRoots:[...roots,witnessDirectory,masterDirectory],protector,platform,witness,beginPersistence:beginTrustPersistence});
 const master=createMemoryMasterKeyStore({directory:masterDirectory,protector,platform});const adapters=createMemoryTrustAdapters(trust);let closed=false;
 return{
  ...adapters,
  async readProtectedMaster(){if(closed)throw Error('memory_custody_unavailable');return master.read();},
  /** New custody enrollment requires a separate trusted-main approval callback, never an unlock fallback. */
  enrollTrust:(record,authorize)=>trust.enroll(record,authorize),
  close(){closed=true;trust.close();witness.close();},
 };
}
module.exports={createMemoryCustody};
