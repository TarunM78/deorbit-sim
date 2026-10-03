// app.js — UI glue and render loop.
(function(){
'use strict';
const M=SIM.mission, P=SIM.phys, DAY=P.DAY, d2r=Math.PI/180, $=id=>document.getElementById(id);
const sel={regime:'LEO', scenario:'leo-sso', tech:'ibs'};
let running=true, autoWarp=true, manualWarp=3, camMode='earth', labelsOn=true, lastPhase='', lastEvents=0;

// ---------- setup panel ----------
function renderSetup(){
  for(const r of ['LEO','GEO']) $('rg_'+r).setAttribute('aria-pressed',sel.regime===r);
  const cl=$('clusters'); cl.innerHTML='';
  const scs=SIM.scenarios.filter(s=>s.regime===sel.regime); if(!scs.find(s=>s.id===sel.scenario)) sel.scenario=scs[0].id;
  for(const s of scs){ const b=document.createElement('button'); b.setAttribute('aria-pressed',sel.scenario===s.id); b.innerHTML=`${s.name}<small>${s.blurb}</small>`; b.onclick=()=>{sel.scenario=s.id; renderSetup();}; cl.appendChild(b); }
  const sc=SIM.scenarios.find(s=>s.id===sel.scenario); if(!sc.techs.includes(sel.tech)) sel.tech=sc.techs[0];
  const th=$('techs'); th.innerHTML='';
  for(const k of ['ibs','kit']){ const t=SIM.techs[k]; const b=document.createElement('button'); b.disabled=!sc.techs.includes(k); b.setAttribute('aria-pressed',sel.tech===k);
    b.innerHTML=`${t.name}<small>${b.disabled?'Not applicable in GEO: nothing reenters, the graveyard push is contactless.':t.blurb}</small>`; b.onclick=()=>{sel.tech=k; renderSetup();}; th.appendChild(b); }
  $('kitsCap').parentElement.querySelectorAll('#kitsCap, [for=kitsCap]').forEach(e=>e.disabled=sel.tech!=='kit');
}
$('rg_LEO').onclick=()=>{sel.regime='LEO'; renderSetup();}; $('rg_GEO').onclick=()=>{sel.regime='GEO'; renderSetup();};
renderSetup();

// ---------- sliders ----------
function bind(id,fmt){ const el=$(id),out=$('o_'+id); const f=()=>{ M.cfg[id]=parseFloat(el.value)*(id==='beamN'?1e-3:1); out.textContent=fmt(parseFloat(el.value)); }; el.addEventListener('input',f); f(); }
bind('beamN',v=>v+' mN'); bind('etaB',v=>v.toFixed(2)); bind('beamHalf',v=>v+'°'); bind('standoff',v=>v+' m'); bind('propCap',v=>v+' kg'); bind('kitsCap',v=>v); bind('targetPerigee',v=>v+' km'); bind('solar',v=>v.toFixed(1));
function fmtWarp(w){ if(w<60) return w.toFixed(0)+' s / s'; if(w<3600) return (w/60).toFixed(0)+' min / s'; if(w<DAY) return (w/3600).toFixed(1)+' h / s'; return (w/DAY).toFixed(w<10*DAY?1:0)+' day / s'; }
$('rate').addEventListener('input',()=>{ manualWarp=parseFloat($('rate').value); autoWarp=false; $('rateAuto').setAttribute('aria-pressed','false'); $('warpAuto').textContent=''; });
$('rateAuto').onclick=()=>{ autoWarp=!autoWarp; $('rateAuto').setAttribute('aria-pressed',autoWarp); $('warpAuto').textContent=autoWarp?'(auto)':''; };
$('play').onclick=()=>{ running=!running; $('play').textContent=running?'Pause':'Play'; };
$('skip').onclick=()=>M.skipPhase();
$('newmission').onclick=()=>{ if(SIM.demo&&SIM.demo.active){ SIM.demo.stop(); $('view').classList.remove('demoOn'); } $('running').classList.add('hidden'); $('setup').classList.remove('hidden'); started=false; $('callout_t').textContent='Pick a regime, a cluster and a technology, then launch.'; };
$('launch').onclick=()=>start();
// HOOK for a first-person view module (SIM.fpv): add 'fpv' to CAM_MODES; frame() shows #fpvBox when camMode==='fpv' and !state.prox.active.
const CAM_MODES=['fpv','earth','follow','cluster'];
function setCam(c){ camMode=c; for(const k of CAM_MODES) { const b=$('cam_'+k); if(b) b.setAttribute('aria-pressed',k===c); } if(c!=='fpv') SIM.scene.setCameraMode(c); }
for(const k of CAM_MODES) $('cam_'+k).onclick=()=>setCam(k);
const journey=p=>!!(SIM.fpv&&SIM.fpv.isJourneyPhase(p));
$('labels').onclick=()=>{ labelsOn=!labelsOn; $('labels').setAttribute('aria-pressed',labelsOn); SIM.scene.setLabels(labelsOn); };

// ---------- views ----------
SIM.scene.init($('orbitBox')); SIM.prox.init($('proxBox')); SIM.scene.setUserOrbit(true); SIM.prox.setUserOrbit(true);
if(SIM.fpv) SIM.fpv.init($('fpvBox')); if(SIM.demo) SIM.demo.init($('view'));
let started=false;
function start(){
  M.setup(sel.scenario,sel.tech); started=true; running=true; $('play').textContent='Pause';
  $('setup').classList.add('hidden'); $('running').classList.remove('hidden'); lastPhase=''; lastEvents=0; $('log').innerHTML='';
  setCam(SIM.fpv?'fpv':'follow'); if(SIM.fpv) SIM.scene.setCameraMode('follow');   // ride along from the pad; the orbit view keeps 'follow' ready behind it
  renderPhases();
}
// ---------- 60-second demo ----------
let demoCam='';
function startDemo(){
  if(!SIM.demo) return; sel.regime='LEO'; sel.scenario='leo-sso'; sel.tech='ibs'; renderSetup(); start(); autoWarp=true; demoCam='';
  $('view').classList.add('demoOn');
  SIM.demo.start({ onReplay:startDemo, onExplore:()=>{ $('view').classList.remove('demoOn'); setCam(journey(M.state.phase)&&SIM.fpv?'fpv':'earth'); } });
}
$('demo').onclick=startDemo;
const PHASE_LABELS={prelaunch:['Countdown','On the pad'],ascent:['Ascent','Direct injection into the cluster plane'],parking:['Parking orbit','200 km coast'],transfer:['Transfer','Raise to the waiting orbit'],insert:['Insertion','Circularize below the cluster'],
  wait:['Wait','Let the plane come to you'],climb:['Climb','Raise to the target orbit'],rendezvous:['Rendezvous','Ground to onboard nav'],characterize:['Characterize','Tumble, CoM, appendages'],
  standoff:['Standoff','Close to a few diameters'],push:['Push','Beam on'],release:['Release','Back off and verify'],approach:['Approach','Close to the nozzle'],attach:['Attach kit','Robotic arm capture'],depart:['Depart','Kit checkout'],return:['Return','Back to the waiting orbit'],complete:['Complete','']};
function phaseList(){ const S=M.state; const base=['prelaunch','ascent','parking','transfer','insert','wait','climb','rendezvous','characterize'];
  return base.concat(S.tech==='ibs'?['standoff','push','release']:['approach','attach','depart'],['return']); }
function renderPhases(){
  const S=M.state, list=phaseList(), el=$('phases'); el.innerHTML=''; const cur=list.indexOf(S.phase);
  list.forEach((p,i)=>{ const d=document.createElement('div'); d.className='phase'+(i===cur?' active':(i<cur?' done':'')); const L=PHASE_LABELS[p]; d.innerHTML=`<span class="n">${i+1}</span><span>${L[0]}<small>${L[1]}</small></span>`; el.appendChild(d); });
  if(S.phase==='complete'){ const d=document.createElement('div'); d.className='phase active'; d.innerHTML=`<span class="n">✓</span><span>Campaign complete<small>${S.shepherd.targetsDone} objects handled</small></span>`; el.appendChild(d); }
}
const CALLOUT={
  prelaunch:S=>`Shepherd on the pad at ${S.scenario.launch.name}. It launches straight into the cluster's ${(S.scenario.cluster.inc).toFixed(1)}° plane and will never change inclination again.`,
  ascent:S=>`Ascent. Inclination is fixed at launch because a 1° plane change in LEO costs ~130 m/s, more than a whole deorbit push.`,
  parking:S=>`Coasting in a 200 km parking orbit before the transfer burn.`,
  transfer:S=>`Transfer to the waiting orbit ${S.scenario.parkOffset} km below the cluster. ${S.regime==='LEO'?'A lower orbit precesses faster under J2, so target planes sweep past the shepherd.':'A lower orbit drifts east at ~1.3°/day, so derelicts sweep past in longitude.'}`,
  insert:S=>`Circularizing in the waiting orbit.`,
  wait:S=>{ const w=S.wait; if(!w) return 'Waiting.'; return S.regime==='LEO'? `Waiting for ${S.targets[S.current].name}'s plane. RAAN gap ${w.gapDeg.toFixed(1)}°, closing at ${(Math.abs(w.gap0-w.gapDeg)>0?'':'')}${(w.gap0/ (w.eta/DAY+1e-9)).toFixed(3)}°/day. The plane change this avoids would cost ${(w.planeChangeDv/1e3).toFixed(2)} km/s. Propellant used while waiting: none.`
    : `Waiting for ${S.targets[S.current].name} to drift overhead. Longitude gap ${w.gapDeg.toFixed(1)}° closing at 1.28°/day. No propellant.`; },
  climb:S=>S.regime==='LEO'? `Planes aligned. Climb ${S.climbDv.toFixed(0)} m/s into the target's orbit.` : `Drifted under the target. Climb ${S.climbDv.toFixed(1)} m/s the last 100 km to GEO.`,
  rendezvous:S=>`Far‑range rendezvous: ground tracking, km‑level error, hands off to onboard angles‑only navigation.`,
  characterize:S=>`Hold at 100 m. Lidar and vision estimate tumble rate, centre of mass and the appendage envelope.`,
  standoff:S=>`Close to standoff. Standoff is set by beam divergence: a wider plume forces a closer approach or a lower capture fraction.`,
  push:S=>S.regime==='LEO'? `Beam on, retrograde, on arcs around apogee. Perigee drops while apogee stays. The shepherd descends with the target, which is the cost of contactless pushing and also the next drift orbit.`
    : `Beam on, prograde. Both spacecraft spiral up ${S.push.dhReq.toFixed(0)} km to the IADC graveyard.`,
  release:S=>`Beam off. Back off to 500 m and confirm the new orbit by tracking. Drag does the rest over the coming years.`,
  approach:S=>`Approach along the target's axis to the engine nozzle, the one standard feature every rocket body has.`,
  attach:S=>`Robotic arm captures the nozzle and bolts on a solid‑motor descent kit. The kit has its own attitude control and power.`,
  depart:S=>`Kit checkout. The servicer departs; the kit will wait for a pass whose perigee falls over the South Pacific uninhabited area.`,
  return:S=>S.tech==='kit'||S.regime==='GEO'? `Return to the waiting orbit below the cluster and resume drifting.` : `Stay in the lowered orbit: it precesses faster, so the push doubles as the phasing maneuver toward the next target.`,
  complete:S=>`Campaign over. ${S.shepherd.targetsDone} objects handled with ${S.shepherd.dvUsed.toFixed(0)} m/s of shepherd Δv; waiting avoided ${(S.shepherd.dvSavedByWaiting/1e3).toFixed(1)} km/s of plane changes.`,
};
function fmtMET(t){ const d=Math.floor(t/DAY),h=Math.floor((t%DAY)/3600),m=Math.floor((t%3600)/60); return d>=365? `T+${(d/365).toFixed(2)} yr (${d} d)` : `T+${d} d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function orbitStr(el){ const rp=el.a*(1-el.e)-P.RE, ra=el.a*(1+el.e)-P.RE; return (Math.abs(ra-rp)<3? rp.toFixed(0)+' km circ' : rp.toFixed(0)+'×'+ra.toFixed(0)+' km')+' · '+(el.i/d2r).toFixed(1)+'°'; }
function capacityEstimate(S){ // targets the remaining xenon could still handle at the current per-target cost
  const sh=S.shepherd; if(sh.targetsDone<1) { const t=S.targets.find(t=>t.eligible)||S.targets[0]; const z=M.pushSizing(t); const perT=(S.tech==='ibs'? (M.cfg.beamN+z.fCounter)/(M.cfg.isp*P.G0)*z.tPush*(S.regime==='LEO'?M.cfg.duty:1) : 0) + P.propMass(M.cfg.dryMass+sh.prop, S.regime==='LEO'?(S.tech==='kit'?204:102):13, M.cfg.isp); return Math.floor(sh.prop/perT); }
  const used=sh.propCap-sh.prop; return Math.floor(sh.prop/(used/sh.targetsDone)); }
function updateUI(){
  const S=M.state; if(!S) return; const sh=S.shepherd, tgt=S.targets[S.current];
  if(S.phase!==lastPhase){ lastPhase=S.phase; renderPhases(); $('callout_t').textContent=CALLOUT[S.phase](S); }
  else if(S.phase==='wait'||S.phase==='complete') $('callout_t').textContent=CALLOUT[S.phase](S);
  $('h_met').textContent=fmtMET(S.t); $('h_phase').textContent=PHASE_LABELS[S.phase][0]; $('h_view').textContent=S.prox.active?'Proximity, LVLH':'Orbit, ECI';
  $('h_extra').innerHTML= S.prox.active? `Range <b>${S.prox.sep<1000?S.prox.sep.toFixed(0)+' m':(S.prox.sep/1000).toFixed(1)+' km'}</b>` : (S.phase==='wait'&&S.wait? `${S.regime==='LEO'?'RAAN gap':'Lon gap'} <b>${S.wait.gapDeg.toFixed(1)}°</b> · ETA <b>${(S.wait.eta/DAY).toFixed(0)} d</b>`:'');
  $('t_orbit').textContent=orbitStr(sh.el); $('t_prop').textContent=`${sh.prop.toFixed(1)} / ${sh.propCap} kg`; $('propbar').style.width=(100*sh.prop/sh.propCap)+'%';
  $('t_kits').textContent=S.tech==='kit'?`${sh.kits} / ${sh.kitsCap}`:'n/a'; $('t_dv').textContent=sh.dvUsed.toFixed(0)+' m/s'; $('t_dvsaved').textContent=(sh.dvSavedByWaiting/1e3).toFixed(2)+' km/s';
  $('t_done').textContent=`${sh.targetsDone} / ${S.targets.filter(t=>t.eligible).length}`; const cap=capacityEstimate(S); $('t_cap').textContent= S.tech==='kit'? `${Math.min(cap,sh.kits)+sh.targetsDone} (kits limit)` : (isFinite(cap)?cap+sh.targetsDone:'—');
  if(tgt){ $('c_name').textContent=tgt.name+' · '+tgt.kind; $('c_mass').textContent=tgt.mass.toFixed(0)+' kg'; $('c_risk').textContent=tgt.casualtyRisk? tgt.casualtyRisk.toExponential(1)+(tgt.burnable?' ok':' > 1e‑4'):'n/a'; $('c_risk').className=tgt.burnable||S.regime==='GEO'?'good':'warn';
    $('c_orbit').textContent=orbitStr(tgt.el); $('c_gapk').textContent=S.regime==='LEO'?'RAAN gap':'Longitude gap'; $('c_gap').textContent=S.wait&&S.phase==='wait'?S.wait.gapDeg.toFixed(1)+'°':'aligned';
    const z=S.push||M.pushSizing(tgt); $('c_dv').textContent=S.tech==='ibs'?(S.phase==='push'?`${(S.dvDelivered||0).toFixed(1)} / ${z.dvReq.toFixed(1)} m/s`:z.dvReq.toFixed(1)+' m/s'):'210 m/s (kit)'; $('c_push').textContent=S.tech==='ibs'?(z.tPush/DAY).toFixed(0)+' d':'—';
    $('c_tum').textContent=tgt.tumble.toFixed(2)+' °/s'; $('c_life').textContent=tgt.lifetimeDays?(tgt.lifetimeDays/365).toFixed(1)+' yr':(S.regime==='GEO'?'n/a':'—'); }
  else { for(const k of ['c_name','c_mass','c_risk','c_orbit','c_gap','c_dv','c_push','c_tum','c_life']) $(k).textContent='—'; }
  const g=$('tgrid'); if(g.children.length!==S.targets.length){ g.innerHTML=''; S.targets.forEach(t=>{ const i=document.createElement('i'); i.title=t.name; g.appendChild(i); }); }
  const counts={idle:0,targeted:0,decaying:0,kit:0,done:0,skipped:0};
  S.targets.forEach((t,k)=>{ g.children[k].dataset.s=t.status; g.children[k].title=`${t.name} · ${t.status}`; if(t.status==='idle')counts.idle++; else if(t.status==='targeted'||t.status==='pushing')counts.targeted++; else if(t.status==='decaying'||t.status==='released')counts.decaying++; else if(t.status.startsWith('kit'))counts.kit++; else if(t.status==='reentered'||t.status==='graveyard')counts.done++; else if(t.status==='skipped')counts.skipped++; });
  $('t_counts').textContent=`${counts.idle} · ${counts.targeted} · ${counts.decaying} · ${counts.kit} · ${counts.done} · ${counts.skipped}`;
  if(S.events.length!==lastEvents||S.events[S.events.length-1]&&$('log').firstChild&&$('log').firstChild.dataset.t!==String(S.events[S.events.length-1].t)){ lastEvents=S.events.length; const L=$('log'); L.innerHTML=''; for(const e of S.events){ const d=document.createElement('div'); d.dataset.t=e.t; d.innerHTML=`<b>${fmtMET(e.t).replace('T+','')}</b>${e.text}`; L.appendChild(d); } }
  const w=autoWarp?S.warp:Math.pow(10,manualWarp); $('o_rate').textContent=fmtWarp(w); if(autoWarp) $('rate').value=Math.log10(Math.max(1,w));
}
// ---------- loop ----------
let last=performance.now();
function resize(){ SIM.scene.resize(); SIM.prox.resize(); if(SIM.fpv) SIM.fpv.resize(); }
window.addEventListener('resize',resize);
function frame(now){
  requestAnimationFrame(frame); const real=Math.min(0.1,(now-last)/1000); last=now;
  const S=M.state; if(started&&S){
    const demo=SIM.demo&&SIM.demo.active; let d=null;
    if(running){
      if(demo) d=SIM.demo.tick(S,real);
      if(!(d&&d.paused)){ const warp= d? d.warp : (autoWarp?S.warp:Math.pow(10,manualWarp)); let dt=real*warp; const maxSub= S.prox.active? 0.25*DAY : (S.phase==='wait'||S.phase==='complete'? 0.5*DAY : 120); const n=Math.max(1,Math.min(400,Math.ceil(dt/maxSub))); for(let k=0;k<n;k++) M.step(dt/n); }
      if(d&&d.cam&&d.cam!==demoCam){ demoCam=d.cam; setCam(d.cam); }
    }
    // which view: the demo decides; otherwise proximity when active, else ride-along during the launch if chosen, else orbit
    const prox=S.prox.active, inJourney=journey(S.phase);
    const fpvBtn=$('cam_fpv'); if(fpvBtn) fpvBtn.disabled=!inJourney||!SIM.fpv;
    if(camMode==='fpv'&&!inJourney&&!demo) setCam('earth');
    const view= d&&d.view? (d.view==='fpv'&&!SIM.fpv?'orbit':d.view) : (prox?'prox': (camMode==='fpv'?'fpv':'orbit'));
    $('proxBox').classList.toggle('hidden',view!=='prox'); $('orbitBox').classList.toggle('hidden',view!=='orbit'); $('fpvBox').classList.toggle('hidden',view!=='fpv'); $('view').classList.toggle('fpvOn',view==='fpv');
    SIM.scene.setVisible(view==='orbit'); SIM.prox.setVisible(view==='prox'); if(SIM.fpv) SIM.fpv.setVisible(view==='fpv');
    if(view==='prox'){ SIM.prox.update(S,real); SIM.prox.render(); } else if(view==='fpv'){ SIM.fpv.update(S,real); SIM.fpv.render(); } else { SIM.scene.update(S,real); SIM.scene.render(); }
    updateUI();
  } else { SIM.scene.setVisible(true); SIM.scene.update(idleState(),real); SIM.scene.render(); }
}
let _idle=null; function idleState(){ if(_idle) return _idle; // a quiet Earth before launch
  _idle={regime:'LEO',tech:'ibs',scenario:SIM.scenarios[0],t:0,earthRot:0.4,phase:'idle',phaseT:0,phaseDur:1,warp:1,events:[],launch:{site:SIM.scenarios[0].launch,path:[]},
    shepherd:{el:{a:P.RE+590,e:0,i:98*d2r,raan:0,argp:0,M:0},pos:{x:0,y:0,z:0},prop:0,propCap:1,kits:0,kitsCap:0,dvUsed:0,dvSavedByWaiting:0,targetsDone:0,mode:'launch'},targets:[],current:-1,prox:{active:false}}; _idle.shepherd.pos=P.posFromEl(_idle.shepherd.el); return _idle; }
resize(); requestAnimationFrame(frame);
})();
