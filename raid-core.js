/* Shared single-report ingestion and snapshot contract. No DOM, storage, or authentication writes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MCCRaidCore=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const VERSION='1.0.0', CALC='combat-roster-v1';
 const HISTORY=['4yPZV3Q6bBFg9Rkn','VzjmAHKDkn2QXxR6','9F8rWzbZ6xkHwpPv','1NwBdtbVJy8chLCj','h8rcaM6pDJ9mNYdZ','LAr6FGhpPBav9K3z','9WyrGCXVZgt1dJjk','4mFdQVtfWKXh2gH8'];
 const META=`query MCCRaidMetadata($code:String!){reportData{report(code:$code){code title startTime endTime revision zone{id name} masterData{actors{id name type subType server petOwner gameID}} fights{id name encounterID startTime endTime kill difficulty inProgress friendlyPlayers friendlySpecs}}}}`;
 const EVENTS=`query MCCRaidEvents($code:String!,$dt:EventDataType!,$fights:[Int]!,$start:Float!,$end:Float!){reportData{report(code:$code){events(dataType:$dt,fightIDs:$fights,startTime:$start,endTime:$end,includeResources:false,limit:10000){data nextPageTimestamp}}}}`;
 const RANKINGS=`query MCCRaidRankings($code:String!,$fights:[Int]!,$metric:ReportRankingMetricType!){reportData{report(code:$code){rankings(fightIDs:$fights,playerMetric:$metric)}}}`;
 const TYPES={DamageDone:'damage',Healing:'heal',Deaths:'death'};
 const fail=m=>{throw new Error(m);};
 const number=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
 const id=n=>Number.isInteger(n)&&n>0;
 const metric=(value,source,reason=null)=>({value,status:value===null?'unavailable':'available',source,reason:value===null?(reason||'Not provided by the source'):null});
 const missing=(source,reason)=>metric(null,source,reason);
 const ms=f=>f.endTime-f.startTime;
 function reportCode(input){
  const s=String(input||'').trim();if(/^[a-zA-Z0-9]{16}$/.test(s))return s;
  let u;try{u=new URL(s);}catch(_){fail('Enter one Warcraft Logs report URL or 16-character report ID.');}
  if(u.protocol!=='https:'||!/(^|\.)warcraftlogs\.com$/i.test(u.hostname))fail('Use an HTTPS Warcraft Logs report URL.');
  const m=u.pathname.match(/^\/reports\/([a-zA-Z0-9]{16})\/?$/);if(!m)fail('The report URL must identify one report.');return m[1];
 }
 function prepare(report){
  if(!report||!Array.isArray(report.fights)||!Array.isArray(report.masterData?.actors))fail('Incomplete report metadata.');
  reportCode(report.code);
  if(!number(report.startTime)||!number(report.endTime)||report.endTime<report.startTime||!Number.isInteger(report.revision))fail('Invalid report timestamps or revision.');
  const actors=new Map();for(const a of report.masterData.actors){if(!Number.isInteger(a.id)||(a.type==='Player'&&!id(a.id))||actors.has(a.id))fail('Invalid or duplicate actor ID.');actors.set(a.id,a);}
  const fights=report.fights.map(f=>({...f})).sort((a,b)=>a.startTime-b.startTime||a.id-b.id),seen=new Set();
  if(!fights.length)fail('No combat fights returned.');
  for(let i=0;i<fights.length;i++){
   const f=fights[i];if(!id(f.id)||seen.has(f.id)||!Number.isInteger(f.encounterID)||f.encounterID<0||!number(f.startTime)||!number(f.endTime)||(ms(f)<0||(ms(f)===0&&(f.encounterID??f.encounterId)>0))||f.endTime>report.endTime-report.startTime+1)fail('Invalid or duplicate combat interval.');
   if(f.inProgress!==false)fail('Report contains unfinished or unverified combat. Retry after the report is finalized.');
   if(f.encounterID>0&&typeof f.kill!=='boolean')fail('Boss attempt outcome is missing.');
   if(i&&f.startTime<fights[i-1].endTime)fail('Overlapping combat intervals require review; totals were not generated.');
   if(f.friendlyPlayers!==null&&f.friendlyPlayers!==undefined&&!Array.isArray(f.friendlyPlayers))fail('Invalid participation roster.');
   if(Array.isArray(f.friendlyPlayers)){if(new Set(f.friendlyPlayers).size!==f.friendlyPlayers.length)fail('Duplicate roster actor.');for(const p of f.friendlyPlayers)if(!id(p)||actors.get(p)?.type!=='Player')fail('Roster contains an unresolved player.');}
   seen.add(f.id);
  }
  return{report,actors,fights};
 }
 function createAccumulator(ctx){
  const rows=new Map(),diagnostics={unownedPetDamage:0,unownedPetHealing:0,unknownSourceDamage:0,unknownSourceHealing:0,ignoredNonPlayerEvents:0,unknownDamageTargets:0,unclassifiedEvents:0};
  const streams={};const warnings=[];const {actors,fights,report}=ctx;
  function owner(actorID){const seen=new Set();let a=actors.get(actorID);while(a&&a.type!=='Player'&&id(a.petOwner)){if(seen.has(a.id))fail('Cyclic pet ownership.');seen.add(a.id);a=actors.get(a.petOwner);}return a?.type==='Player'?a:null;}
  function row(actorID,f){
   let p=rows.get(actorID);if(!p){const a=actors.get(actorID);p={actor:a,byFight:new Map()};rows.set(actorID,p);}
   let r=p.byFight.get(f.id);if(!r){r={fightId:f.id,rostered:Array.isArray(f.friendlyPlayers)?f.friendlyPlayers.includes(actorID):null,observed:false,damage:0,directDamage:0,petDamage:0,bossTargetDamage:0,unknownTargetDamage:0,healing:0,petHealing:0,overheal:0,overhealKnown:true,deaths:0,deathTimestamps:[]};p.byFight.set(f.id,r);}return r;
  }
  for(const f of fights)for(const a of f.friendlyPlayers||[])row(a,f);
  function findFight(e){
   const explicit=e.fight??e.fightID;
   if(explicit!==undefined){const f=fights.find(f=>f.id===explicit);if(!f||e.timestamp<f.startTime||e.timestamp>f.endTime)fail('Event fight ID conflicts with its timestamp.');return f;}
   // Adjacent fight boundaries belong to the later interval; report final endpoint is included.
   return fights.find(f=>ms(f)===0&&e.timestamp===f.startTime)||fights.find(f=>e.timestamp>=f.startTime&&e.timestamp<f.endTime)||fights.find(f=>e.timestamp===f.endTime&&!fights.some(g=>g.startTime===e.timestamp));
  }
  function consume(dt,events){
   for(const e of events){
    if(!e||!number(e.timestamp)||typeof e.type!=='string')fail('Malformed combat event.');
    if(e.type.toLowerCase()!==TYPES[dt])continue;
    const f=findFight(e);if(!f){diagnostics.unclassifiedEvents++;fail('Combat events outside known fight intervals; coverage cannot be verified.');}
    const src=owner(e.sourceID),target=owner(e.targetID);
    if(src){const r=row(src.id,f);r.observed=true;}
    if(target){const r=row(target.id,f);r.observed=true;}
    if(dt==='Deaths'){
     // Deaths belong to targets, never to the damage source or a dead pet's owner.
     if(actors.get(e.targetID)?.type==='Player'){const r=row(e.targetID,f);r.deaths++;r.deathTimestamps.push(e.timestamp);}continue;
    }
    if(!number(e.amount))fail('Missing or invalid '+dt+' event amount.');
    const sourceActor=actors.get(e.sourceID);
    if(!src){if(sourceActor?.type==='Pet')diagnostics[dt==='DamageDone'?'unownedPetDamage':'unownedPetHealing']+=e.amount;else if(!sourceActor)diagnostics[dt==='DamageDone'?'unknownSourceDamage':'unknownSourceHealing']+=e.amount;else diagnostics.ignoredNonPlayerEvents++;continue;}
    const r=row(src.id,f),pet=e.sourceID!==src.id;
    if(dt==='DamageDone'){
     // Friendly fire is excluded. Unknown targets remain explicit coverage uncertainty.
     if(target)continue;
     r.damage+=e.amount;r[pet?'petDamage':'directDamage']+=e.amount;
     const ta=actors.get(e.targetID);
     if(!ta){r.unknownTargetDamage+=e.amount;diagnostics.unknownDamageTargets+=e.amount;}
     else if(ta.id>0&&f.encounterID>0&&String(ta.subType).toLowerCase()==='boss')r.bossTargetDamage+=e.amount;
    }else{
     r.healing+=e.amount;if(pet)r.petHealing+=e.amount;
     if(number(e.overheal))r.overheal+=e.overheal;else r.overhealKnown=false;
    }
   }
  }
  function finish(rankings,retrievedAt){
   const duration=fights.reduce((n,f)=>n+ms(f),0),unknownParticipation=fights.some(f=>!Array.isArray(f.friendlyPlayers)),bossIdentityKnown=[...actors.values()].some(a=>a.id>0&&String(a.subType).toLowerCase()==='boss');
   if(unknownParticipation)warnings.push('Some fight rosters are unavailable. Participation-adjusted metrics may be unavailable.');
   if(diagnostics.unownedPetDamage||diagnostics.unownedPetHealing)warnings.push('Unowned pet output is retained in diagnostics and excluded from player totals.');
   if(diagnostics.unknownSourceDamage||diagnostics.unknownSourceHealing)warnings.push('Unresolved source output is retained in diagnostics and cannot be assigned to a player.');
   if(diagnostics.unknownDamageTargets)warnings.push('Some damage targets are unresolved; boss-target damage is unavailable for affected players.');
   const value=(v,dt,reason)=>streams[dt]?.complete?metric(v,'WCL '+dt+' events'):missing('WCL '+dt+' events',reason||streams[dt]?.error||'Stream incomplete');
   const players=[];
   for(const [actorID,p] of rows){
    const a=p.actor;
    const participantFights=fights.filter(f=>p.byFight.has(f.id));
    const denomKnown=!unknownParticipation&&participantFights.every(f=>p.byFight.get(f.id).rostered===true);
    const participationMs=denomKnown?participantFights.reduce((n,f)=>n+ms(f),0):null;
    const perFight=participantFights.map(f=>{
     const r=p.byFight.get(f.id),i=f.friendlyPlayers?.indexOf(actorID),spec=Number.isInteger(i)&&i>=0?f.friendlySpecs?.[i]||null:null;
     return{fightId:f.id,encounterId:f.encounterID,kind:f.encounterID>0?'boss':'trash',outcome:f.encounterID===0?'trash':f.kill?'kill':'wipe',participation:{rostered:r.rostered,observed:r.observed,combatDurationMs:r.rostered?ms(f):null,spec,role:null,roleReason:'Not provided; class/spec alone is not treated as role evidence'},metrics:{damage:value(r.damage,'DamageDone'),directDamage:value(r.directDamage,'DamageDone'),petDamage:value(r.petDamage,'DamageDone'),bossTargetDamage:f.encounterID===0?missing('WCL actor subtype','Not a boss encounter'):!bossIdentityKnown?missing('WCL actor subtype','No verified boss actor subtype returned'):r.unknownTargetDamage?missing('WCL actor subtype','Unresolved damage targets'):value(r.bossTargetDamage,'DamageDone'),healing:value(r.healing,'Healing'),petHealing:value(r.petHealing,'Healing'),overheal:r.overhealKnown?value(r.overheal,'Healing'):missing('WCL Healing events','Some heal events lack overheal'),deaths:value(r.deaths,'Deaths')},deathTimestamps:streams.Deaths?.complete?r.deathTimestamps:null};
    });
    const sum=(k,kind)=>{const rs=perFight.filter(r=>!kind||r.kind===kind);if(rs.some(r=>r.metrics[k].value===null))return null;return rs.reduce((n,r)=>n+r.metrics[k].value,0);};
    const total=sum('damage'),heal=sum('healing'),deaths=sum('deaths');
    const rate=(n,d,source,reason)=>n===null||d===null||!d?missing(source,reason||'Numerator unavailable or duration is zero'):metric(n/(d/1000),source);
    const specs=[...new Set(perFight.map(r=>r.participation.spec).filter(Boolean))];
    const parseRows=[];
    for(const item of rankings){
     const payload=item.payload,rs=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:[];
     for(const rf of rs){const fightId=rf.fightID??rf.fightId;if(!participantFights.some(f=>f.id===fightId&&f.encounterID>0))continue;
      for(const [role,group] of Object.entries(rf.roles||{}))for(const c of group?.characters||[]){
       const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/\s/g,'');const candidates=participantFights.find(f=>f.id===fightId)?.friendlyPlayers?.map(i=>actors.get(i)).filter(p=>norm(p.name)===norm(c.name)&&norm(p.server)===norm(c.server?.name)&&norm(p.subType)===norm(c.class))||[];const match=candidates.length===1&&candidates[0].id===actorID;if(!match||!number(c.rankPercent)||c.rankPercent>100)continue;
       parseRows.push({fightId,metric:item.metric,rankPercent:c.rankPercent,role,spec:c.spec||null,comparison:'WCL default at retrieval; no historical percentile assertion',source:'report.rankings',identityMatch:'Unique fight-roster name + normalized server + class; WCL character ID is not a report actor ID',raw:c});
      }
     }
    }
    const roles=[...new Set(parseRows.map(r=>r.role))];
    for(const f of perFight){const fightRoles=[...new Set(parseRows.filter(r=>r.fightId===f.fightId).map(r=>r.role))];if(fightRoles.length===1){f.participation.role=fightRoles[0];f.participation.roleReason='Actor/fight-matched WCL rankings role';}}
    players.push({identity:{reportActorId:actorID,reportKey:report.code+':'+actorID,name:a.name||'Unknown',server:a.server||null,gameId:a.gameID??null,class:a.subType||null,role:roles.length===1?roles[0]:null,roleSource:roles.length===1?'WCL rankings':null,specs,crossReportIdentity:{status:'unresolved',candidate:a.server?String(a.name).toLowerCase()+'@'+String(a.server).toLowerCase():null,reason:'Report actor IDs are local; name/server candidates require region and identity review before merging.'}},participation:{fightIds:perFight.map(r=>r.fightId),combatDurationMs:metric(participationMs,'WCL friendlyPlayers fight rosters','Missing rosters or observed actor absent from a roster'),fraction:duration&&participationMs!==null?metric(participationMs/duration,'Participating fight duration / raid combat duration'):missing('WCL fight rosters','Participation duration unavailable')},metrics:{damage:value(total,'DamageDone'),bossEncounterDamage:value(sum('damage','boss'),'DamageDone'),trashDamage:value(sum('damage','trash'),'DamageDone'),directDamage:value(sum('directDamage'),'DamageDone'),petDamage:value(sum('petDamage'),'DamageDone'),overallDps:rate(total,duration,'Damage / all recorded raid combat seconds'),participationAdjustedDps:rate(total,participationMs,'Damage / rostered combat seconds','Participation or damage unavailable'),healing:value(heal,'Healing'),overallHps:rate(heal,duration,'Healing / all recorded raid combat seconds'),participationAdjustedHps:rate(heal,participationMs,'Healing / rostered combat seconds'),overheal:sum('overheal')===null?missing('WCL Healing events','Overheal incomplete'):value(sum('overheal'),'Healing'),deaths:value(deaths,'Deaths')},parses:{status:parseRows.length?'available':'unavailable',reason:parseRows.length?null:'No recognized actor-matched boss percentiles returned; see raw ranking provenance.',entries:parseRows},fights:perFight});
   }
   players.sort((a,b)=>a.identity.reportActorId-b.identity.reportActorId);
   if(players.some(p=>p.participation.combatDurationMs.value===null))warnings.push('Participation is unresolved for some players; their adjusted rates are unavailable.');
   const completeness=Object.values(streams).every(s=>s.complete)&&!unknownParticipation&&players.every(p=>p.participation.combatDurationMs.value!==null)&&!diagnostics.unownedPetDamage&&!diagnostics.unownedPetHealing&&!diagnostics.unknownSourceDamage&&!diagnostics.unknownSourceHealing&&!diagnostics.unknownDamageTargets?'complete':'partial';
   const snapshot={schema:'mcc.raid-snapshot',schemaVersion:VERSION,calculationVersion:CALC,snapshotId:report.code+':'+report.revision+':'+retrievedAt,report:{id:report.code,url:'https://www.warcraftlogs.com/reports/'+report.code,title:report.title||'',startTime:report.startTime,endTime:report.endTime,revision:report.revision,zone:report.zone??null},retrievedAt,coverage:{status:completeness,scope:'All API-returned combat fights; bosses, wipes and WCL-classified trash',streams,diagnostics,warnings,identityRoster:'Players in fight rosters or observed as sources/targets of damage, healing, deaths'},durationDefinitions:{raidCombatMs:duration,reportElapsedMs:report.endTime-report.startTime,overallDps:'Sum of hostile/unresolved-target damage including owned pets / summed nonoverlapping fight seconds; downtime excluded',participationAdjustedDps:'Same damage / full duration of fights whose friendlyPlayers roster includes this player; death/inactivity is not subtracted; unavailable when rosters are incomplete or conflicting',bossEncounterDamage:'All damage during encounterID > 0, including adds and wipes',trashDamage:'All damage during encounterID = 0, including any short pulls WCL classifies as trash',healing:'Sum of API heal event amount; absorbs not inferred; overheal separate',deaths:'Player-target death events during selected combat; not pet deaths; no preventability judgment',parse:'Raw WCL percentile context retained; percentiles must not be summed'},encounters:fights.map(f=>({id:f.id,encounterId:f.encounterID,name:f.name||'',startTime:f.startTime,endTime:f.endTime,absoluteStartTime:report.startTime+f.startTime,absoluteEndTime:report.startTime+f.endTime,combatDurationMs:ms(f),kind:f.encounterID>0?'boss':'trash',outcome:f.encounterID===0?'trash':f.kill?'kill':'wipe',difficulty:f.difficulty??null,roster:f.friendlyPlayers??null,specs:f.friendlySpecs??null})),players,provenance:{provider:'Warcraft Logs v2 user GraphQL',metadataQuery:META,eventsQuery:EVENTS,rankingsQuery:RANKINGS,rankings,actorMetadata:[...actors.values()],overlap:{reportRevisionKey:report.code+':'+report.revision,absoluteCombatIntervals:fights.map(f=>[report.startTime+f.startTime,report.startTime+f.endTime]),policy:'Duplicate report revisions and overlapping absolute intervals require review before future aggregation; no aggregation performed'},liveReconciliation:'Not performed automatically; compare against WCL before production acceptance'}};
   return snapshot;
  }
  return{consume,finish,streams,diagnostics};
 }
 async function sha(text){if(!globalThis.crypto?.subtle)fail('SHA-256 is unavailable; use localhost or HTTPS.');return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
 async function reconcileTables(snapshot,gql,{signal,onProgress=()=>{}}={}){
  const s=JSON.parse(JSON.stringify(snapshot)),code=s.report.id,proof=[],tables=new Map();
  for(let offset=0;offset<s.encounters.length;offset+=6){
   if(signal?.aborted)fail('Analysis cancelled.');onProgress('Retrieving credited damage/healing tables '+(offset+1)+'�'+Math.min(offset+6,s.encounters.length)+'/'+s.encounters.length+'�');
   const batch=s.encounters.slice(offset,offset+6),fields=batch.flatMap(f=>['DamageDone','Healing'].map(dt=>(dt==='DamageDone'?'d':'h')+f.id+':table(dataType:'+dt+',fightIDs:['+f.id+'],startTime:'+f.startTime+',endTime:'+f.endTime+',viewBy:Source)')).join(' '),query='query MCCCreditedFightTables($code:String!){reportData{report(code:$code){'+fields+'}}}',data=await gql(query,{code},signal);
   if(signal?.aborted)fail('Analysis cancelled.');
   for(const f of batch)for(const prefix of ['d','h']){
    const body=data?.[prefix+f.id]?.data;if(!body||!Array.isArray(body.entries))fail('Incomplete credited '+prefix+' table for fight '+f.id+'.');
    if(!number(body.totalTime)||Math.abs(body.totalTime-f.combatDurationMs)>1)fail('WCL table combat duration disagrees for fight '+f.id+'.');
    const excludedEntries=body.entries.filter(e=>{const a=s.provenance.actorMetadata.find(a=>a.id===e.id);return a&&a.type!=='Player';}).map(e=>({id:e.id,name:e.name,total:e.total,reason:'Known non-player actor; excluded from player leaderboards',actorType:s.provenance.actorMetadata.find(a=>a.id===e.id).type}));const seen=new Set(),entries=body.entries.filter(e=>!excludedEntries.some(x=>x.id===e.id)).map(e=>{if(!id(e.id)||seen.has(e.id)||!number(e.total)||!s.players.some(p=>p.identity.reportActorId===e.id&&p.identity.name===e.name))fail('Credited table player mismatch: fight '+f.id+' '+prefix+' actor '+e.id+' '+e.name+'; metadata '+JSON.stringify(s.provenance.actorMetadata.find(a=>a.id===e.id)||null)+'; participant '+JSON.stringify(s.players.find(p=>p.identity.reportActorId===e.id)?.identity||null));seen.add(e.id);const pets=(e.pets||[]).map(p=>({id:p.id,total:p.total}));if(pets.some(p=>!number(p.total))||pets.reduce((n,p)=>n+p.total,0)>e.total)fail('Invalid credited pet totals.');return{id:e.id,name:e.name,total:e.total,pets,overheal:number(e.overheal)?e.overheal:null};});
    tables.set(prefix+f.id,entries);proof.push({fightId:f.id,dataType:prefix==='d'?'DamageDone':'Healing',combatDurationMs:body.totalTime,query,sha256:await sha(JSON.stringify(data[prefix+f.id])),entries,excludedEntries});
   }
  }
  for(const p of s.players){
   for(const e of s.encounters){if(p.fights.some(f=>f.fightId===e.id))continue;if(!['d','h'].some(prefix=>tables.get(prefix+e.id).some(row=>row.id===p.identity.reportActorId&&row.total>0)))continue;const rostered=Array.isArray(e.roster)?e.roster.includes(p.identity.reportActorId):null,metrics={};for(const k of ['damage','directDamage','petDamage','healing','petHealing','overheal','deaths']){const stream=k==='deaths'?'Deaths':['healing','petHealing','overheal'].includes(k)?'Healing':'DamageDone';metrics[k]=s.coverage.streams[stream].complete?metric(0,'No matching raw events in this fight'):missing('Raw events','Stream incomplete');}metrics.bossTargetDamage=missing('Raw events','No matching raw source events');p.fights.push({fightId:e.id,encounterId:e.encounterId,kind:e.kind,outcome:e.outcome,participation:{rostered,observed:true,combatDurationMs:rostered?e.combatDurationMs:null,spec:null,role:null,roleReason:'Participation observed through WCL credited table'},metrics,deathTimestamps:s.coverage.streams.Deaths.complete?[]:null});}
   p.fights.sort((a,b)=>s.encounters.findIndex(e=>e.id===a.fightId)-s.encounters.findIndex(e=>e.id===b.fightId));p.participation.fightIds=p.fights.map(f=>f.fightId);const duration=s.encounters.every(e=>Array.isArray(e.roster))&&p.fights.every(f=>f.participation.rostered===true)?p.fights.reduce((n,f)=>n+f.participation.combatDurationMs,0):null;p.participation.combatDurationMs=metric(duration,'WCL fight rosters','Credited output or observed events outside a fight roster');p.participation.fraction=duration===null?missing('WCL fight rosters','Participation unresolved'):metric(duration/s.durationDefinitions.raidCombatMs,'Rostered duration / raid combat duration');
   for(const f of p.fights){f.rawEventMetrics=JSON.parse(JSON.stringify(f.metrics));for(const prefix of ['d','h']){const entries=tables.get(prefix+f.fightId),e=entries.find(e=>e.id===p.identity.reportActorId),total=e?.total??0,pet=(e?.pets||[]).reduce((n,p)=>n+p.total,0),source='WCL per-fight '+(prefix==='d'?'DamageDone':'Healing')+' table; provider crediting rules';
     if(prefix==='d'){f.metrics.damage=metric(total,source);f.metrics.petDamage=metric(pet,source);f.metrics.directDamage=metric(total-pet,source);f.metrics.bossTargetDamage=missing(source,'Canonical target allocation not requested; raw event target damage retained separately');}
     else if(s.coverage.streams.Healing.complete){f.metrics.healing=metric(total,source);f.metrics.petHealing=metric(pet,source);f.metrics.overheal=e&&e.overheal===null?missing(source,'Table did not provide overheal'):metric(e?.overheal??0,source);}
    }
   }
   p.rawEventMetrics=JSON.parse(JSON.stringify(p.metrics));const sum=(k,kind)=>{const fs=p.fights.filter(f=>!kind||f.kind===kind);return fs.some(f=>f.metrics[k].value===null)?null:fs.reduce((n,f)=>n+f.metrics[k].value,0);};
   for(const k of ['damage','directDamage','petDamage','healing','overheal'])p.metrics[k]=metric(sum(k),'Sum of WCL credited per-fight tables');
   p.metrics.bossEncounterDamage=metric(sum('damage','boss'),'WCL credited damage during all boss attempts, including wipes');p.metrics.trashDamage=metric(sum('damage','trash'),'WCL credited damage during trash');
   for(const [k,n,d] of [['overallDps','damage',s.durationDefinitions.raidCombatMs],['participationAdjustedDps','damage',p.participation.combatDurationMs.value],['overallHps','healing',s.durationDefinitions.raidCombatMs],['participationAdjustedHps','healing',p.participation.combatDurationMs.value]])p.metrics[k]=p.metrics[n].value===null||d===null||!d?missing('WCL credited output / combat seconds','Output or participation denominator unavailable'):metric(p.metrics[n].value/(d/1000),'WCL credited output / combat seconds');
  }
  if(s.players.some(p=>p.participation.combatDurationMs.value===null)){s.coverage.status='partial';if(!s.coverage.warnings.some(w=>w.includes('Participation is unresolved')))s.coverage.warnings.push('Participation is unresolved for some players; their adjusted rates are unavailable.');}
  s.calculationVersion='wcl-tables-combat-v2';s.provenance.creditedTables=proof;s.provenance.liveReconciliation='Primary output uses per-fight WCL aggregate tables; independent report totals still require acceptance comparison';
  s.durationDefinitions.overallDps='WCL credited damage / summed nonoverlapping combat seconds; encounter-specific provider exclusions and attribution apply; rawEventMetrics retains unfiltered event output';s.durationDefinitions.bossEncounterDamage='Sum of WCL credited damage for all encounterID > 0 attempts, kills and wipes; provider may exclude specific adds';s.durationDefinitions.healing='WCL per-fight Healing table totals, including provider-supported absorption credit; raw healing event totals retained separately';
  validateSnapshot(s);return s;
 }
 async function analyze(input,gql,{signal,onProgress=()=>{},maxPages=500,maxEvents=2000000}={}){
  const code=reportCode(input),check=()=>{if(signal?.aborted)throw new Error('Analysis cancelled.');};
  const get=async(q,v)=>{check();const r=await gql(q,v,signal);check();if(!r)fail('No GraphQL report returned.');return r;};
  onProgress('Loading report and all fight rosters…');const report=await get(META,{code});if(report.code!==code)fail('Report ID mismatch.');
  const ctx=prepare(report),acc=createAccumulator(ctx),start=ctx.fights[0].startTime,end=Math.max(...ctx.fights.map(f=>f.endTime)),fights=ctx.fights.map(f=>f.id);
  for(const dt of Object.keys(TYPES)){
   let next=start,pages=0,count=0;const pageHashes=[];
   try{
    while(true){
     check();if(pages>=maxPages)fail('Pagination safety limit reached.');onProgress(dt+': retrieving page '+(pages+1)+'…');
     const r=await get(EVENTS,{code,dt,fights,start:next,end}),ev=r.events;
     if(!ev||!Array.isArray(ev.data)||!Object.hasOwn(ev,'nextPageTimestamp'))fail('Incomplete '+dt+' paginator.');
     const cursor=ev.nextPageTimestamp;if(cursor!==null&&cursor!==0&&(!number(cursor)||cursor<=next||cursor>end))fail('Invalid pagination cursor.');
     for(const e of ev.data)if(!number(e?.timestamp)||e.timestamp<next||e.timestamp>end||(cursor&&e.timestamp>=cursor))fail('Event timestamps overlap a page boundary or exceed the query range.');
     count+=ev.data.length;if(count>maxEvents)fail('Event safety limit reached.');
     const hash=await sha(JSON.stringify(ev.data));acc.consume(dt,ev.data);pages++;pageHashes.push({start:next,next:cursor,count:ev.data.length,sha256:hash});
     if(cursor===null||cursor===0)break;next=cursor;
    }
    acc.streams[dt]={complete:true,pages,eventCount:count,pageHashes};
   }catch(e){check();acc.streams[dt]={complete:false,pages,eventCount:count,pageHashes,error:String(e.message||e)};if(dt==='DamageDone')throw new Error('Damage coverage incomplete: '+e.message);}
  }
  const bossIds=ctx.fights.filter(f=>f.encounterID>0&&f.kill).map(f=>f.id),rankings=[];
  if(bossIds.length)for(const metric of ['dps','hps']){
   onProgress('Retrieving optional '+metric+' boss rankings…');try{const r=await get(RANKINGS,{code,fights:bossIds,metric});rankings.push({metric,parameters:{fightIDs:bossIds,playerMetric:metric},status:r.rankings===null||r.rankings===undefined?'unavailable':'retrieved',payload:r.rankings??null});}catch(e){check();rankings.push({metric,status:'unavailable',error:String(e.message||e),payload:null});}
  }
  check();onProgress('Confirming report revision…');const final=await get(META,{code});if(JSON.stringify(final)!==JSON.stringify(report))fail('Report metadata changed during analysis. Retry the finalized report.');
  const snapshot=acc.finish(rankings,new Date().toISOString());validateSnapshot(snapshot);if(gql.canonicalTables){const corrected=await reconcileTables(snapshot,gql,{signal,onProgress});const confirmed=await get(META,{code});if(JSON.stringify(confirmed)!==JSON.stringify(report))fail('Report metadata changed during table analysis.');return corrected;}return snapshot;
 }
 function validateSnapshot(s){
  if(!s||s.schema!=='mcc.raid-snapshot'||s.schemaVersion!==VERSION||![CALC,'wcl-tables-combat-v2'].includes(s.calculationVersion))fail('Unsupported raid snapshot version.');
  reportCode(s.report?.id);if(!number(s.report.startTime)||!number(s.report.endTime)||!Number.isFinite(new Date(s.report.startTime).getTime())||!Number.isFinite(new Date(s.report.endTime).getTime())||s.report.endTime<s.report.startTime||!Number.isInteger(s.report.revision)||!Number.isFinite(Date.parse(s.retrievedAt)))fail('Invalid snapshot report metadata.');
  if(!Array.isArray(s.encounters)||!s.encounters.length||s.encounters.length>10000||!Array.isArray(s.players)||s.players.length>1000||!s.coverage?.streams?.DamageDone?.complete)fail('Invalid or incomplete damage snapshot.');
  const allIds=new Set(),sorted=[...s.encounters].sort((a,b)=>a.startTime-b.startTime);let totalMs=0;
  for(let i=0;i<sorted.length;i++){const f=sorted[i];if(!id(f.id)||allIds.has(f.id)||!number(f.startTime)||!number(f.endTime)||(ms(f)<0||(ms(f)===0&&(f.encounterID??f.encounterId)>0))||f.combatDurationMs!==ms(f)||!['boss','trash'].includes(f.kind)||!['kill','wipe','trash'].includes(f.outcome)||f.absoluteStartTime!==s.report.startTime+f.startTime||f.absoluteEndTime!==s.report.startTime+f.endTime||f.absoluteEndTime>s.report.endTime+1||(i&&f.startTime<sorted[i-1].endTime))fail('Invalid snapshot combat intervals.');allIds.add(f.id);totalMs+=ms(f);}
  if(s.durationDefinitions?.raidCombatMs!==totalMs||!s.provenance?.overlap||!Array.isArray(s.provenance?.rankings)||!Array.isArray(s.coverage.warnings)||!['complete','partial'].includes(s.coverage.status)||s.snapshotId!==s.report.id+':'+s.report.revision+':'+s.retrievedAt)fail('Missing snapshot definitions or provenance.');
  if(s.calculationVersion==='wcl-tables-combat-v2'){
   const proofs=s.provenance.creditedTables;if(!Array.isArray(proofs)||proofs.length!==sorted.length*2)fail('Missing credited table provenance.');const keys=new Set();
   for(const proof of proofs){const key=proof.dataType+':'+proof.fightId,f=sorted.find(f=>f.id===proof.fightId);if(!f||keys.has(key)||!['DamageDone','Healing'].includes(proof.dataType)||!Array.isArray(proof.entries)||!Number.isFinite(proof.combatDurationMs)||Math.abs(proof.combatDurationMs-f.combatDurationMs)>1||typeof proof.query!=='string'||!/^[a-f0-9]{64}$/.test(proof.sha256))fail('Invalid credited table provenance.');keys.add(key);const seen=new Set();for(const e of proof.entries){const p=s.players.find(p=>p.identity.reportActorId===e.id);if(!p||p.identity.name!==e.name||seen.has(e.id)||!number(e.total)||!Array.isArray(e.pets)||e.pets.some(p=>!number(p.total))||(e.overheal!==null&&!number(e.overheal)))fail('Invalid credited table entry.');seen.add(e.id);}for(const p of s.players){const pf=p.fights.find(f=>f.fightId===proof.fightId),entry=proof.entries.find(e=>e.id===p.identity.reportActorId);if(!pf){if(entry?.total)fail('Credited player fight missing.');continue;}const k=proof.dataType==='DamageDone'?'damage':'healing';if((k==='damage'||s.coverage.streams.Healing.complete)&&pf.metrics[k].value!==(entry?.total??0))fail('Credited table totals disagree with player metrics.');}}
  }
  const eq=(a,b)=>a===b||(number(a)&&number(b)&&Math.abs(a-b)<1e-8*Math.max(1,a,b));
  const unknownRosters=sorted.some(f=>!Array.isArray(f.roster));
  for(const name of Object.keys(TYPES)){const stream=s.coverage.streams[name];if(!stream||typeof stream.complete!=='boolean'||!Number.isInteger(stream.pages)||stream.pages<0||!Array.isArray(stream.pageHashes)||stream.pageHashes.length!==stream.pages)fail('Missing stream provenance.');for(const page of stream.pageHashes)if(!/^[a-f0-9]{64}$/.test(page.sha256)||!Number.isInteger(page.count)||page.count<0||!number(page.start))fail('Invalid page provenance.');}
  const checkMetric=m=>{if(!m||!['available','unavailable'].includes(m.status)||typeof m.source!=='string'||(m.status==='available'?!number(m.value):m.value!==null||typeof m.reason!=='string'))fail('Invalid metric: missing and zero must remain distinct.');};
  const pids=new Set();for(const p of s.players){const pid=p.identity?.reportActorId;if(!id(pid)||pids.has(pid)||typeof p.identity.name!=='string'||['class','server','role'].some(k=>p.identity[k]!==null&&typeof p.identity[k]!=='string')||!Array.isArray(p.identity.specs)||p.identity.specs.some(x=>typeof x!=='string')||!Array.isArray(p.fights)||!Array.isArray(p.parses?.entries))fail('Invalid snapshot player.');pids.add(pid);const fids=new Set();for(const f of p.fights){if(!allIds.has(f.fightId)||fids.has(f.fightId))fail('Invalid player fight references.');fids.add(f.fightId);const encounter=sorted.find(e=>e.id===f.fightId);if(f.kind!==encounter.kind||f.encounterId!==encounter.encounterId||f.outcome!==encounter.outcome||!f.participation||f.participation.rostered!==(Array.isArray(encounter.roster)?encounter.roster.includes(pid):null)||f.participation.combatDurationMs!==(f.participation.rostered?ms(encounter):null))fail('Conflicting player participation or encounter classification.');for(const m of Object.values(f.metrics||{}))checkMetric(m);for(const k of ['damage','directDamage','petDamage','healing','overheal','deaths'])if(!f.metrics?.[k])fail('Missing fight metric.');for(const k of ['damage','directDamage','petDamage'])if(f.metrics[k].value===null)fail('Complete damage retrieval requires available fight damage values.');if(f.metrics.damage.value!==f.metrics.directDamage.value+f.metrics.petDamage.value)fail('Fight pet attribution totals disagree.');for(const [k,stream] of [['healing','Healing'],['overheal','Healing'],['deaths','Deaths']])if(!s.coverage.streams[stream].complete&&f.metrics[k].value!==null)fail('Incomplete stream cannot yield complete metrics.');}
   for(const m of Object.values(p.metrics||{}))checkMetric(m);checkMetric(p.participation?.combatDurationMs);checkMetric(p.participation?.fraction);
   for(const k of ['damage','directDamage','petDamage','healing','overheal','deaths','overallDps','participationAdjustedDps','bossEncounterDamage','trashDamage'])if(!p.metrics?.[k])fail('Missing player metric.');
   for(const k of ['damage','directDamage','petDamage','healing','overheal','deaths']){const v=p.fights.some(f=>f.metrics[k].value===null)?null:p.fights.reduce((n,f)=>n+f.metrics[k].value,0);if(p.metrics[k].value!==v)fail('Snapshot totals disagree with encounter data.');}
   if(p.metrics.damage.value!==null&&p.metrics.damage.value!==p.metrics.directDamage.value+p.metrics.petDamage.value)fail('Pet attribution totals disagree.');
   for(const [name,kind] of [['bossEncounterDamage','boss'],['trashDamage','trash']]){const v=p.fights.filter(f=>f.kind===kind).reduce((n,f)=>n+f.metrics.damage.value,0);if(!eq(p.metrics[name].value,v))fail('Boss/trash totals disagree.');}
   if(sorted.some(f=>f.roster?.includes(pid)&&!fids.has(f.id)))fail('Snapshot omits a rostered player fight.');
   const denom=!unknownRosters&&p.fights.every(f=>f.participation.rostered===true)?p.fights.reduce((n,f)=>n+sorted.find(e=>e.id===f.fightId).combatDurationMs,0):null;
   if(!eq(p.participation.combatDurationMs.value,denom)||!eq(p.participation.fraction.value,denom===null?null:denom/totalMs)||JSON.stringify(p.participation.fightIds)!==JSON.stringify(p.fights.map(f=>f.fightId)))fail('Participation denominator disagrees with rosters.');
   for(const [key,numerator,denominator] of [['overallDps','damage',totalMs],['participationAdjustedDps','damage',denom],['overallHps','healing',totalMs],['participationAdjustedHps','healing',denom]]){if(!p.metrics[key])fail('Missing rate metric.');const n=p.metrics[numerator].value,expected=n===null||denominator===null||denominator===0?null:n/(denominator/1000);if(!eq(p.metrics[key].value,expected))fail('Rate disagrees with duration definition.');}
   for(const r of p.parses.entries)if(!fids.has(r.fightId)||!['dps','hps'].includes(r.metric)||!number(r.rankPercent)||r.rankPercent>100||typeof r.role!=='string'||typeof r.comparison!=='string')fail('Invalid parse entry.');
  }
  for(const f of sorted)for(const actor of f.roster||[])if(!pids.has(actor))fail('Snapshot omits a rostered player.');
  return s;
 }
 const csvCell=v=>{let t=v===null||v===undefined?'':String(v);if(/^[=+@\-\t\r]/.test(t))t="'"+t;return '"'+t.replace(/"/g,'""')+'"';};
 function csv(s){validateSnapshot(s);const metrics=['damage','overallDps','participationAdjustedDps','bossEncounterDamage','trashDamage','healing','overallHps','overheal','deaths'];const header=['report_id','report_revision','raid_start_ms','raid_end_ms','snapshot_id','actor_id','name','server','class','role','participating_combat_ms',...metrics.flatMap(k=>[k,k+'_status',k+'_reason']),'parses_json'];const rows=s.players.map(p=>[s.report.id,s.report.revision,s.report.startTime,s.report.endTime,s.snapshotId,p.identity.reportActorId,p.identity.name,p.identity.server,p.identity.class,p.identity.role,p.participation.combatDurationMs.value,...metrics.flatMap(k=>[p.metrics[k].value,p.metrics[k].status,p.metrics[k].reason]),JSON.stringify(p.parses.entries)]);return[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');}
 function readable(s){validateSnapshot(s);const fmt=m=>m.value===null?'Unavailable ('+m.reason+')':m.value.toLocaleString('en-US',{maximumFractionDigits:2});const lines=['# Full Raid Analysis',s.report.title+' — '+s.report.id,new Date(s.report.startTime).toISOString(),'Coverage: '+s.coverage.status+'; '+s.durationDefinitions.raidCombatMs/1000+' combat seconds',...s.coverage.warnings.map(w=>'Warning: '+w),'',...Object.entries(s.durationDefinitions).map(([k,v])=>k+': '+v)];for(const p of s.players){lines.push('','## '+p.identity.name+' — '+(p.identity.class||'Unknown class')+' / '+(p.identity.role||'Unknown role'),...Object.entries(p.metrics).map(([k,m])=>k+': '+fmt(m)),...p.fights.map(f=>'Fight #'+f.fightId+' '+f.kind+' '+f.outcome+': damage '+fmt(f.metrics.damage)+', healing '+fmt(f.metrics.healing)+', deaths '+fmt(f.metrics.deaths)), 'Parses: '+(p.parses.entries.length?p.parses.entries.map(r=>'fight '+r.fightId+' '+r.metric+' '+r.rankPercent+'% ('+r.comparison+')').join('; '):p.parses.reason));}return lines.join('\n');}
 return Object.freeze({VERSION,CALC,HISTORY,META,EVENTS,RANKINGS,reportCode,prepare,createAccumulator,reconcileTables,analyze,validateSnapshot,csv,readable,sha});
});
