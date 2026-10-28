/* Browser-local archival storage. IndexedDB handles real raid sizes; existing localStorage archives stay readable. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MCCRaidStorage=api.createStorage({indexedDB:root.indexedDB,localStorage:root.localStorage,crypto:root.crypto});})(globalThis,function(){
 'use strict';
 const keys={raid:'mcc_full_raid_archive_v1',history:'mcc_historical_datasets_v1'};
 function createStorage(env){let connection=null,counter=0;
  const legacy=kind=>{if(!keys[kind])throw new Error('Unknown archive type.');const value=JSON.parse(env.localStorage.getItem(keys[kind])||'[]');if(!Array.isArray(value))throw new Error('Existing local archive format is invalid.');return value;};
  const label=(kind,data)=>kind==='raid'?(data.report.title||data.report.id):(data.name||'Historical dataset');
  const date=(kind,data)=>kind==='raid'?data.retrievedAt:data.createdAt;
  const meta=(kind,data,id)=>({id,kind,label:label(kind,data),createdAt:date(kind,data)});
  function open(){if(!connection)connection=new Promise((resolve,reject)=>{const request=env.indexedDB.open('mcc_tree_logs_archives_v1',1);request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('objects',{keyPath:'id'});const catalog=db.createObjectStore('catalog',{keyPath:'id'});catalog.createIndex('kind','kind',{unique:false});};request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};request.onerror=()=>{connection=null;reject(request.error||new Error('Local archive could not be opened.'));};request.onblocked=()=>{connection=null;reject(new Error('Local archive upgrade blocked by another tab. Close older development tabs.'));};});return connection;}
  async function transaction(stores,mode,work){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(stores,mode);let value,requestError;tx.oncomplete=()=>resolve(value);tx.onerror=e=>{requestError=e.target?.error;};tx.onabort=()=>reject(tx.error||requestError||new Error('Local archive transaction failed.'));try{work(tx,v=>value=v);}catch(e){tx.abort();reject(e);}});}
  async function list(kind){const old=legacy(kind);if(!env.indexedDB)return old.map((data,index)=>meta(kind,data,String(index)));const recent=await transaction(['catalog'],'readonly',(tx,set)=>{const q=tx.objectStore('catalog').index('kind').getAll(kind);q.onsuccess=()=>set(q.result);});return [...old.map((data,index)=>meta(kind,data,'legacy:'+index)),...recent].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id));}
  async function get(kind,id){if(!env.indexedDB||String(id).startsWith('legacy:')){const n=Number(String(id).replace(/^legacy:/,''));if(!Number.isInteger(n)||n<0)throw new Error('Invalid archive selection.');const data=legacy(kind)[n];if(!data)throw new Error('Saved entry not found.');return data;}return transaction(['objects'],'readonly',(tx,set)=>{const q=tx.objectStore('objects').get(id);q.onsuccess=()=>{if(!q.result||q.result.kind!==kind){tx.abort();return;}set(q.result.data);};});}
  async function save(kind,data){if(!keys[kind])throw new Error('Unknown archive type.');if(!env.indexedDB){const a=legacy(kind);if(kind==='raid'&&a.some(s=>s.snapshotId===data.snapshotId))return{duplicate:true};a.push(data);env.localStorage.setItem(keys[kind],JSON.stringify(a));return{duplicate:false,id:String(a.length-1),backend:'localStorage fallback'};}
   const id=kind==='raid'?'raid:'+data.snapshotId:'history:'+(env.crypto?.randomUUID?.()||Date.now()+'-'+(++counter));
   if(kind==='raid'&&legacy(kind).some(s=>s.snapshotId===data.snapshotId))return{duplicate:true};
   try{await transaction(['objects','catalog'],'readwrite',tx=>{tx.objectStore('objects').add({id,kind,data});tx.objectStore('catalog').add(meta(kind,data,id));});return{duplicate:false,id,backend:'IndexedDB'};}catch(e){if(kind==='raid'&&e.name==='ConstraintError')return{duplicate:true};throw e;}
  }
  return Object.freeze({list,get,save,backend:env.indexedDB?'IndexedDB':'localStorage fallback'});
 }
 return Object.freeze({createStorage});
});
