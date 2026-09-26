const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path'),crypto=require('crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const html=fs.readFileSync(process.argv[2]||path.join(__dirname,'../MCC_Tree_of_Logs.html'),'utf8');
const original=html; // Review-order function is exercised from the actual application.
const script=(h,id)=>h.match(new RegExp('<script id="'+id+'">([\\s\\S]*?)</script>'))[1];
const P='Performance & rotation',A='Miss / dodge / glancing',I='Actionable improvements';
const fights=[{id:1,name:'First Boss',encounterID:1,startTime:0,endTime:10000,kill:true},{id:2,name:'Second Boss',encounterID:2,startTime:20000,endTime:40000,kill:false},{id:3,name:'Trash',encounterID:0,startTime:50000,endTime:60000,kill:true}];
function events(start){return [
 {type:'damage',timestamp:start+10,sourceID:7,abilityGameID:1,ability:{name:'Melee'},amount:100,hitType:6},
 {type:'damage',timestamp:start+20,sourceID:7,abilityGameID:5221,ability:{name:'Shred'},amount:300},
 {type:'miss',timestamp:start+30,sourceID:7,abilityGameID:1,missType:'DODGE'},
 {type:'cast',timestamp:start+40,sourceID:7,abilityGameID:5221,ability:{name:'Shred'}}];}
function setup(options={}){
 const nodes={},handlers={},calls=[],copies=[];
 for(const id of ['tolUrl','tolCharacter','tolRole','tolScope','tolBoss','tolNotes','tolOrder','tolStatus','tolWclReportStatus','tolWclReportResult','tolWclStatus','tolWclClientId','mccTreeLogs'])nodes[id]={id,value:'',textContent:'',dataset:{},style:{},addEventListener:(event,fn)=>handlers[event]=fn};
 Object.assign(nodes.tolUrl,{value:'https://vanilla.warcraftlogs.com/reports/TestReport'});nodes.tolCharacter.value='Twig';nodes.tolScope.value=options.scope||'Full Raid Report';
 let requested=options.requested||[P,A,I];
 const storage=new Map([['mcc_tol_wcl_token','test-token'],['mcc_tol_wcl_exp',String(Date.now()+3600000)]]);
 const ctx={console,URLSearchParams,Map,Set,Date,Promise,document:{getElementById:id=>nodes[id],querySelectorAll:()=>requested.map(value=>({value})),addEventListener(){}},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},localStorage:{getItem:()=>null},navigator:{clipboard:{writeText:async t=>copies.push(t)}},location:{search:'',origin:'https://test.invalid',pathname:'/MCC.html'},fetch:async(url,init)=>{
  assert.equal(url,'https://www.warcraftlogs.com/api/v2/user');assert.equal(init.headers.Authorization,'Bearer test-token');
  const body=JSON.parse(init.body);calls.push(body);
  if(options.hook)await options.hook(body,nodes);
  if(options.fail)throw Error('Network failed');
  if(options.graphqlError)return{ok:true,json:async()=>({errors:[{message:'API denied'}]})};
  let report;
  if(body.query.includes('masterData'))report={code:'TestReport',title:'Fixture Raid',masterData:{actors:[{id:7,name:'Twig',type:'Player',subType:'Druid'}]},fights:options.noFights?[]:fights};
  else{
   const v=body.variables;assert.match(body.query,/dataType:All/);assert.equal(v.source,7);assert.ok(v.fights.length===1);
   const f=fights.find(f=>f.id===v.fights[0]);let data=events(f.startTime),nextPageTimestamp=null;
   if(options.empty)data=[];
   if(options.noCasts)data=data.filter(e=>e.type!=='cast');
   if(options.badAmount)data[0].amount='100';
   if(options.paginate){if(v.start===f.startTime){data=data.slice(0,2);nextPageTimestamp=f.startTime+25;}else data=data.slice(2);}
   if(options.stuck)nextPageTimestamp=v.start;
   if(options.stuck&&v.start===0)nextPageTimestamp=-1;
   if(options.cap)nextPageTimestamp=v.start+1;
   if(options.lastPageFails&&v.start!==f.startTime)throw Error('Page two failed');
   report={events:{data,nextPageTimestamp}};
   if(options.missingCursor)delete report.events.nextPageTimestamp;
   if(options.missingData)delete report.events.data;
  }
  return{ok:true,json:async()=>({data:{reportData:{report}}})};
 }};
 ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(original.match(/function tolBuildOrder\(\)\{[^\n]+/)[0],ctx);
 ctx.tolClear=()=>{};
 for(const id of ['mcc-tree-of-logs-wcl-pkce','tree-of-logs-full-raid-fix','tol-final-handoff-race-fix','tol-performance-handoff-repair'])vm.runInContext(script(html,id),ctx,{filename:id});
 return{ctx,nodes,calls,copies,storage,setRequested(v,emit=true){requested=v;if(emit)handlers.change({target:{id:'',matches:()=>true}});},change(id,value){nodes[id].value=value;handlers.input({target:{id,matches:()=>false}});}};
}
const results=[];
async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
const blocked=s=>{assert.notEqual(s.nodes.tolWclReportResult.dataset.finalHandoff,'1');assert.doesNotMatch(s.nodes.tolWclReportResult.textContent,/STATUS: ANALYSIS HANDOFF READY/);};
(async()=>{
 await test('All inline classic scripts parse',()=>{for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!/type="module"/.test(m[1]))new vm.Script(m[2]);});
 await test('Original PKCE and authentication block hash preserved',()=>assert.equal(hash(script(html,'mcc-tree-of-logs-wcl-pkce')),'3e2966e9d1ef9a4327d57c3fa5c1abb4f6be60489caa945cefe9731b6b0e1d0e'));
 await test('Full Raid: first fight starts at zero; kills and wipes; no trash; Performance reaches final packet',async()=>{
  const s=setup({paginate:true}),packet=await s.ctx.tolWclFinalHandoff();assert.equal(s.nodes.tolWclReportResult.dataset.finalHandoff,'1');
  for(const text of ['PERFORMANCE & ROTATION — RETRIEVED EVIDENCE','RAID-WIDE CAST COUNTS','Shred [5221] — 2 casts','Observed source damage: 800','26.7 DPS','White glancing: 2/4','COMPLETE — '+P,'COMPLETE — '+I])assert.ok(packet.includes(text),text);
  assert.equal(s.calls.length,5);assert.ok(!packet.includes('Trash'));assert.ok(!packet.includes('\\n'));
 });
 await test('All Boss Kills excludes wipes and trash',async()=>{const s=setup({scope:'All Boss Kills'});const p=await s.ctx.tolWclFinalHandoff();assert.ok(p.includes('Boss fights analyzed: 1'));assert.ok(!p.includes('Second Boss'));});
 await test('Actionable Review contains Performance before handoff',async()=>{const s=setup();await s.ctx.tolWclActionableReview();assert.match(s.nodes.tolWclReportResult.textContent,/PERFORMANCE & ROTATION/);assert.equal(s.nodes.tolWclReportResult.dataset.tolEvidenceComplete,'1');assert.equal(s.nodes.tolWclReportResult.dataset.finalHandoff,undefined);});
 await test('Performance-only selection is complete',async()=>{const s=setup({requested:[P]});assert.ok(await s.ctx.tolWclFinalHandoff());});
 await test('Exact six requested categories retain Performance and block on Deaths, Buffs, and Gear',async()=>{
  const missing=['Deaths & survivability','Buffs / consumables / cooldowns','Gear / talents / enchants'];
  const s=setup({requested:[P,A,...missing,I]});assert.equal(await s.ctx.tolWclFinalHandoff(),null);blocked(s);
  const text=s.nodes.tolWclReportResult.textContent;assert.ok(text.includes('PERFORMANCE & ROTATION — RETRIEVED EVIDENCE'));
  assert.ok(text.includes('COMPLETE — '+P));assert.ok(text.includes('COMPLETE — '+A));
  for(const name of missing)assert.ok(text.includes('INCOMPLETE — '+name));
 });
 await test('Accuracy calculations match the preserved classifier',async()=>{
  const s=setup({requested:[A,I]});const p=await s.ctx.tolWclFinalHandoff();assert.ok(p.includes('White dodge: 2/4 (50.0%)'));assert.ok(!p.includes('PERFORMANCE & ROTATION'));
  const expected={"abilityName":"ec2cf207e72633ac744ef526c28c397e4f66d618c8bf4ad0adec238bf2e37dd4","abilityId":"123ff949d61d37ab30753eb80460efd9720f0935302a98dd5951a681415b730a","isWhite":"e4578f8aaad2b8df1ca5ab7f8fbae2c4757c6684f22b3d5e78081338bc2eb760","outcome":"7913354d1605a0f105eb5a45b4cab5775d277492152f0295bdc8fa34492aaacd","pct":"b6f87515b8060ed04e3d6b4f21ebc8c43f6ec77ca9f230e302308230d97750e6"};for(const [name,digest] of Object.entries(expected))assert.equal(hash(script(html,'tree-of-logs-full-raid-fix').split('\n').find(l=>l.trim().startsWith('const '+name+'='))),digest);
  assert.equal(hash(script(html,'tree-of-logs-full-raid-fix').split('\n').find(l=>l.includes('function stats('))),'2f0b7ac3e5de4be557942e5575eef8fd34eff5a2e0c54051f44c3a146032205d');
 });
 for(const [name,options] of [
  ['Unsupported selected category',{requested:[P,I,'Healing & overheal']}],['No selected category',{requested:[]}],['Actionable without evidence',{requested:[I]}],
  ['Empty event payload',{empty:true}],['Missing cast evidence',{noCasts:true}],['Missing data array',{missingData:true}],['Missing pagination cursor',{missingCursor:true}],['Stalled pagination',{stuck:true}],['Pagination safety cap',{cap:true}],['Failed second page',{paginate:true,lastPageFails:true}],['Network failure',{fail:true}],['GraphQL error',{graphqlError:true}],['Invalid amount',{badAmount:true}],['No matching fights',{noFights:true}],['Unverified single-boss final scope',{scope:'Single Boss'}]
 ])await test(name+' blocks READY',async()=>{const s=setup(options);assert.equal(await s.ctx.tolWclFinalHandoff(),null);blocked(s);});
 await test('Expired authentication blocks without making a request',async()=>{const s=setup();s.storage.set('mcc_tol_wcl_exp','1');await s.ctx.tolWclFinalHandoff();blocked(s);assert.equal(s.calls.length,0);});
 await test('Selection change invalidates a previously ready packet',async()=>{const s=setup();await s.ctx.tolWclFinalHandoff();s.setRequested([P,'Healing & overheal']);blocked(s);await s.ctx.tolWclCopyFinalHandoff();blocked(s);assert.equal(s.copies.length,0);});
 await test('Programmatic change is detected even without an input event',async()=>{const s=setup();await s.ctx.tolWclFinalHandoff();s.setRequested(['Healing & overheal'],false);await s.ctx.tolWclCopyFinalHandoff();blocked(s);assert.equal(s.copies.length,0);});
 await test('Mid-fetch request edit blocks mixed-request evidence',async()=>{let s;s=setup({hook:async body=>{if(body.query.includes('events('))s.change('tolCharacter','Other');}});await s.ctx.tolWclFinalHandoff();blocked(s);});
 await test('Build + double Build + Copy share one final retrieval',async()=>{const s=setup();await Promise.all([s.ctx.tolWclFinalHandoff(),s.ctx.tolWclFinalHandoff(),s.ctx.tolWclCopyFinalHandoff()]);assert.equal(s.calls.length,3);assert.equal(s.copies.length,1);assert.match(s.copies[0],/STATUS: ANALYSIS HANDOFF READY/);assert.match(s.copies[0],/PERFORMANCE & ROTATION/);});
 await test('Review followed immediately by Copy waits for a verified final',async()=>{const s=setup();await Promise.all([s.ctx.tolWclActionableReview(),s.ctx.tolWclCopyFinalHandoff()]);assert.equal(s.copies.length,1);assert.match(s.copies[0],/STATUS: ANALYSIS HANDOFF READY/);});
 await test('Other result-panel actions clear final readiness',async()=>{const s=setup();await s.ctx.tolWclFinalHandoff();await s.ctx.tolWclAnalyzeHitTable();blocked(s);assert.match(s.nodes.tolWclReportResult.textContent,/VALIDATED HIT TABLE/);});
 await test('Another panel action cannot overwrite an active final',async()=>{const s=setup();await Promise.all([s.ctx.tolWclFinalHandoff(),s.ctx.tolWclAnalyzeHitTable()]);assert.equal(s.nodes.tolWclReportResult.dataset.finalHandoff,'1');assert.match(s.nodes.tolWclReportResult.textContent,/PERFORMANCE & ROTATION/);});
 await test('Disconnect removes credentials and invalidates final',async()=>{const s=setup();await s.ctx.tolWclFinalHandoff();s.ctx.tolWclDisconnect();blocked(s);assert.equal(s.storage.get('mcc_tol_wcl_token'),undefined);});
 await test('Single boss Actionable Review delegates to original handler',async()=>{const s=setup({scope:'Single Boss'});s.storage.delete('mcc_tol_wcl_token');await s.ctx.tolWclActionableReview();assert.match(s.nodes.tolWclReportStatus.textContent,/Connect to Warcraft Logs first/);blocked(s);});
 console.log(results.length+' tests passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
