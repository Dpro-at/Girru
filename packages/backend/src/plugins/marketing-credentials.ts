/** Narrow host capability: only Marketing's own OAuth connection, per active user. */
export function createMarketingCredentials(active: (userId:string)=>boolean, manager: {
  getByName(name:string,userId:string):Promise<{id:string}|null>;
  getValueByName(name:string,userId:string):Promise<string>;
  create(value:{name:string;type:any;value:string;userId:string;description:string}):Promise<unknown>;
  update(id:string,value:{value:string}):Promise<void>;
}) {
  const name='marketing-seo-agent';
  function guard(userId:string) { if(typeof userId!=='string'||!userId||!active(userId))throw Error('Marketing user access denied'); }
  return Object.freeze({
    async get(userId:string):Promise<string|null>{guard(userId);if(!await manager.getByName(name,userId))return null;return manager.getValueByName(name,userId);},
    async set(userId:string,value:string){
      guard(userId);if(typeof value!=='string'||Buffer.byteLength(value)>32768)throw Error('Invalid Marketing connection');
      const existing=await manager.getByName(name,userId);
      if(existing)await manager.update(existing.id,{value});
      else await manager.create({name,type:'oauth_token',value,userId,description:'Marketing: SEO Agent OAuth connection'});
    },
  });
}
