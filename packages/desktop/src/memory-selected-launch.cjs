'use strict';
/** Trusted-main selected-copy lifecycle. No renderer IPC, profile discovery, enrollment or application activation. */
const path=require('node:path');
const {createMemoryProfileCoordinator}=require('./memory-profile-coordinator.cjs');
const {createMemoryCustody}=require('./memory-custody.cjs');
const failure=()=>Error('selected_memory_unavailable');
function createSelectedMemoryLaunch(options){
 const {createSelectedHost,buildSelectedServer,buildDocumentAdmissionServer,runner,journalRunner,ownerId,memberId,token,launchToken,authorizeExclusive,authorizeJournal,authorizeEmptyTarget,authorizeRotation,protector,platform}=options;
 if(typeof createSelectedHost!=='function'||typeof buildSelectedServer!=='function'||typeof authorizeJournal!=='function'||(!options.targets&&typeof authorizeEmptyTarget!=='function')||runner===journalRunner)throw failure();
 const profile={...options.profile,exportFiles:[...options.profile.exportFiles]},backupRoots=[...options.backupRoots];
 const targets=options.targets?options.targets.map(target=>({...target})):undefined;
 const authorizeImportFile=options.authorizeImportFile;
 const captureGraphRoot=options.captureGraphRoot,graphMutationJournal=options.graphMutationJournal,authorizeGraphReview=options.authorizeGraphReview;
 if(authorizeGraphReview!==undefined&&typeof authorizeGraphReview!=='function')throw failure();
 if(captureGraphRoot!==undefined&&typeof captureGraphRoot!=='function'||graphMutationJournal!==undefined&&typeof graphMutationJournal!=='function')throw failure();
 const authorizeDocumentFile=options.authorizeDocumentFile,mode=options.mode??'memory';
 if(!['memory','document-admission'].includes(mode)||mode==='document-admission'&&(typeof authorizeDocumentFile!=='function'||typeof buildDocumentAdmissionServer!=='function'))throw failure();
 const embeddings=options.embeddings?{...options.embeddings}:undefined,bridge=options.bridge?{...options.bridge}:undefined;
 const custodyPaths={masterDirectory:options.masterDirectory,trustDirectory:options.trustDirectory,witnessDirectory:options.witnessDirectory};
 const coordinator=createMemoryProfileCoordinator({profileId:options.profileId,profileRoot:profile.profileRoot,memoryRoot:profile.memoryRoot,authorizeExclusive});
 let state='new',custody,host,server,active,closing;
 const close=()=>{if(closing)return closing;if(state==='closed')return Promise.resolve();state='closing';closing=(async()=>{try{if(server)await server.close();else if(host)await host.runtime.close();}finally{try{custody?.close();}finally{coordinator.close();state='closed';}}})();return closing;};
 return Object.freeze({
  start(port=0){
   if(state!=='new')return Promise.reject(failure());state='starting';
   active=(async()=>{try{
    const lease=await coordinator.acquire();if(state!=='starting'||!lease.isCurrent())throw failure();
    custody=createMemoryCustody({...custodyPaths,profileRoots:[profile.profileRoot],backupRoots,protector,platform,beginTrustPersistence:options.beginTrustPersistence});
    host=await createSelectedHost({runner,journalRunner,ownerId,memberId,token,custody,profile,authorizeJournal,authorizeEmptyTarget,targets,authorizeRotation,embeddings,authorizeDocumentFile,captureGraphRoot,graphMutationJournal,authorizeGraphReview,
     async authorizeProfile(candidate,requested){
      if(state!=='starting'||candidate!==runner||path.resolve(requested.profileRoot)!==path.resolve(profile.profileRoot)||path.resolve(requested.memoryRoot)!==path.resolve(profile.memoryRoot)||!lease.isCurrent())throw failure();
      return lease;
     },
    });
    if(state!=='starting'||!lease.isCurrent())throw failure();server=mode==='document-admission'?await buildDocumentAdmissionServer({host,review:await host.openDocumentAdmissionReview(),launchToken,runOperation:options.runOperation}):await buildSelectedServer({host,launchToken,bridge,runOperation:options.runOperation});
    if(state!=='starting'||!lease.isCurrent())throw failure();const address=await server.listen(port);
    if(state!=='starting'||!lease.isCurrent())throw failure();state='ready';return Object.freeze({address,profileId:lease.profileId,activationReady:false});
   }catch{await close();throw failure();}})();return active;
  },
  async stop(){if(state==='new'){await close();return;}if(state==='starting'){state='closing';try{await active;}catch{}await close();return;}await close();},
  async importOwnerFile(request){
   if(state!=='ready'||!host||typeof authorizeImportFile!=='function'||!request||Object.keys(request).some(key=>!['fileId','drawer','format'].includes(key)))throw failure();
   // The trusted main host resolves opaque file IDs; renderer paths never become authority.
   return host.importOwnerFile({fileId:request.fileId,format:request.format,drawer:{...request.drawer}},authorizeImportFile);
  },
  status:()=>state,
 });
}
module.exports={createSelectedMemoryLaunch};
