(function(){
 'use strict';
 window.mccAnalysisMode=function(mode){
  const section=document.getElementById('mccTreeLogs');
  const panels={raid:'mccRaidPanel',history:'mccHistoryPanel'};
  for(const child of section.children){
   if(child.id==='mccRaidModeBar')continue;
   if(Object.values(panels).includes(child.id)){child.hidden=child.id!==panels[mode];continue;}
   if(mode!=='individual'){if(!child.hasAttribute('data-raid-display'))child.setAttribute('data-raid-display',child.style.display||'');child.style.display='none';}
   else if(child.hasAttribute('data-raid-display')){child.style.display=child.getAttribute('data-raid-display');child.removeAttribute('data-raid-display');}
  }
  for(const [id,value] of [['raidIndividual','individual'],['raidFull','raid'],['historyMode','history']])document.getElementById(id)?.setAttribute('aria-pressed',String(mode===value));
 };
})();
