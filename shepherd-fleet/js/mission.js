// mission.js — mission state machine. Owns SIM.state. Attaches SIM.mission.
(function(){
'use strict';
window.SIM = window.SIM || {};
const P=SIM.phys, DAY=P.DAY, RE=P.RE, MU=P.MU, TWO_PI=P.TWO_PI, d2r=Math.PI/180;
const SPOUA={lat:-48*d2r, lon:-123*d2r};

// tunables (bound to sliders by app.js)
const cfg={
  beamN:0.040, etaB:0.8, beamHalf:15, standoff:15, isp:1500, dryMass:500, propCap:300,
  kitsCap:6, kitIsp:300, targetPerigee:350, solar:1.5, duty:0.45,
};
let state=null, rng=mulberry(7);
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const lerp=(a,b,f)=>a+(b-a)*f, clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function log(text){ state.events.push({t:state.t,text}); if(state.events.length>40) state.events.shift(); }
function dvSpend(dv_mps){ // rocket equation on the shepherd's current mass
  const m0=cfg.dryMass+state.shepherd.prop+state.shepherd.kits*kitMassNominal();
  const dm=P.propMass(m0,dv_mps,cfg.isp); state.shepherd.prop=Math.max(0,state.shepherd.prop-dm); state.shepherd.dvUsed+=dv_mps; return dm;
}
function kitMassNominal(){ return state? (state.kitMassNominal||0):0; }
function kitMassFor(mass,regime){ // solid motor kit sized for 210 m/s on the target (+kit), Isp 300, plus 60 kg dry
  const dv=(regime||state.regime)==='LEO'?210:0; const mp=(mass+60)*(Math.exp(dv/(cfg.kitIsp*P.G0))-1); return 60+mp;
}
function rand(a,b){ return a+(b-a)*rng(); }

// ---------- setup ----------
function setup(scenarioId,tech){
  const sc=SIM.scenarios.find(s=>s.id===scenarioId); rng=mulberry(sc.id.length*31+7);
  const c=sc.cluster, alt=c.alt, inc=c.inc*d2r, a=RE+alt;
  const targets=[];
  for(let k=0;k<c.count;k++){
    const mass=rand(c.mass[0],c.mass[1]); const risk=rand(c.risk[0],c.risk[1]); const am=rand(c.am[0],c.am[1]);
    const raan= sc.regime==='LEO'? (k/c.count)*c.raanSpread*d2r*(0.85+0.3*rng()) : 0.6;
    const M= sc.regime==='LEO'? rng()*TWO_PI : (k/c.count)*TWO_PI + rand(-0.03,0.03);
    targets.push({ id:k, name:(c.kind==='rocketbody'?'R/B':c.kind==='comsat'?'SAT':'SS')+'-'+String(k+1).padStart(2,'0'), mass, kind:c.kind, length:c.length, diam:c.diam, am, bc:2.2*am,
      el:{a, e:0, i:inc, raan:P.wrap(raan), argp:0, M}, pos:{x:0,y:0,z:0}, casualtyRisk:risk, burnable:risk<1e-4,
      eligible: true, status:'idle', tumble:rand(0.2,1.2), perigeeAlt:alt, apogeeAlt:alt, lifetimeDays:null, reentry:null, kit:null });
  }
  for(const t of targets){ t.eligible = tech==='kit' || sc.regime==='GEO' || t.burnable; if(!t.eligible) t.status='skipped'; }
  const parkAlt=alt-sc.parkOffset;
  state={ regime:sc.regime, tech, scenario:sc, t:0, dt:0, earthRot:0.4, phase:'prelaunch', phaseT:0, phaseDur:20, warp:10, events:[],
    launch:{site:sc.launch, path:[]},
    shepherd:{ el:{a:RE+200,e:0,i:inc,raan:0,argp:0,M:0}, pos:{x:0,y:0,z:0}, vel:{x:0,y:0,z:0}, dryMass:cfg.dryMass, prop:cfg.propCap, propCap:cfg.propCap,
      kits: tech==='kit'?cfg.kitsCap:0, kitsCap: tech==='kit'?cfg.kitsCap:0, dvUsed:0, dvSavedByWaiting:0, targetsDone:0, mode:'launch', parkAlt, clusterAlt:alt },
    targets, current:-1,
    prox:{active:false, sep:0, shepPos:{x:-15,y:0,z:0}, beamOn:false, counterOn:false, beamHalfAngleDeg:cfg.beamHalf, standoff:cfg.standoff, tumble:0, arm:0, kitAttached:false, kitBurn:false, targetKind:c.kind, targetLength:c.length, targetDiam:c.diam},
    wait:null, push:null, kitMassNominal: tech==='kit'? kitMassFor((c.mass[0]+c.mass[1])/2,sc.regime):0, cfg,
  };
  // launch plane: the plane through the site at T-0 with the cluster inclination
  const site=sc.launch, thetaSite=site.lon+state.earthRot;
  const u=Math.asin(clamp(Math.sin(site.lat)/Math.sin(inc),-1,1));
  const raan0=P.wrap(thetaSite-Math.atan2(Math.cos(inc)*Math.sin(u),Math.cos(u)));
  state.shepherd.el.raan=raan0; state.shepherd.el.M=u; state.launch.u=u;
  state.shepherd.pos=P.latLonToEci(site.lat,site.lon,0,state.earthRot);
  for(const t of targets) updateTargetGeom(t);
  log(`${sc.name}: ${targets.length} objects, ${targets.filter(t=>t.eligible).length} eligible for ${SIM.techs[tech].short}.`);
  enter('prelaunch');
  return state;
}
function updateTargetGeom(t){ t.pos=P.posFromEl(t.el); t.perigeeAlt=t.el.a*(1-t.el.e)-RE; t.apogeeAlt=t.el.a*(1+t.el.e)-RE; }

// ---------- phases ----------
// pacing: how many real seconds each phase should take on screen; warp = phaseDur / seconds
const PACE={prelaunch:3, ascent:10, parking:4, transfer:7, insert:1, climb:5, rendezvous:3, characterize:4, standoff:2, push:14, release:3, approach:5, attach:7, depart:3, return:4};
const WARP={wait:20*DAY, complete:40*DAY};
function paceWarp(phase,dur){ if(PACE[phase]&&isFinite(dur)&&dur>0) return Math.max(2,dur/PACE[phase]); return WARP[phase]||DAY; }
function enter(phase){
  const S=state, sh=S.shepherd, tgt=S.targets[S.current];
  S.phase=phase; S.phaseT=0; S.phaseDur=Infinity; S.prox.beamOn=S.prox.counterOn=false; S.prox.kitBurn=false;
  switch(phase){
    case 'prelaunch': S.phaseDur=20; sh.mode='launch'; break;
    case 'ascent': S.phaseDur=560; S.launch.path=[]; log(`Liftoff from ${S.scenario.launch.name} into a ${(S.shepherd.el.i/d2r).toFixed(1)}° plane.`); break;
    case 'parking': S.phaseDur=0.5*P.period(RE+200); sh.el.a=RE+200; sh.el.e=0; log('Parking orbit, 200 km.'); break;
    case 'transfer': { const h=P.hohmannDv(RE+200,RE+sh.parkAlt); S.phaseDur=h.tof; sh.el=P.elFromRpRa(RE+200,RE+sh.parkAlt,sh.el.i,sh.el.raan,P.wrap(sh.el.argp+sh.el.M),0); S.transferDv=h;
      log(`Transfer burn ${(h.dv1*1e3).toFixed(0)} m/s toward ${sh.parkAlt.toFixed(0)} km${S.regime==='GEO'?' (GEO −100 km drift orbit)':' waiting orbit'}.`); break; }
    case 'insert': S.phaseDur=60; break;
    case 'wait': sh.mode='wait'; pickNextTarget(); break;
    case 'climb': { sh.mode='transfer'; const rp=sh.el.a*(1-sh.el.e), ra=sh.el.a*(1+sh.el.e), rT=RE+sh.clusterAlt;
      // raise/lower to the target's circular orbit in the target's plane
      const h=P.hohmannDv(Math.min(rp,rT)===rT?rp:rp, rT); const dv=(Math.abs(Math.sqrt(MU/rT)-Math.sqrt(MU*(2/ra-1/((rp+rT)/2)))) + Math.abs(Math.sqrt(MU*(2/rp-1/((rp+rT)/2)))-Math.sqrt(MU*(2/rp-1/sh.el.a))))*1e3;
      S.phaseDur=Math.PI*Math.sqrt(Math.pow((rp+rT)/2,3)/MU); S.climbFrom={rp,ra,raan:sh.el.raan}; S.climbDv=dv; dvSpend(dv);
      sh.el={a:(rp+rT)/2, e:Math.abs(rT-rp)/(rT+rp), i:sh.el.i, raan:tgt.el.raan, argp: rp<rT? P.wrap(tgt.el.argp+tgt.el.M-Math.PI): P.wrap(tgt.el.argp+tgt.el.M), M: rp<rT?0:Math.PI};
      log(`${S.regime==='LEO'?'Planes aligned with':'Drifted under'} ${tgt.name}. Climb ${(dv).toFixed(0)} m/s, ${(S.phaseDur/60).toFixed(0)} min.`); break; }
    case 'rendezvous': sh.mode='prox'; sh.el={...tgt.el}; S.phaseDur=2*DAY; S.prox.sep=2000; log(`Far‑range rendezvous with ${tgt.name}: ground tracking hands off to onboard navigation.`); break;
    case 'characterize': S.phaseDur=5*DAY; S.prox.sep=100; log(`Characterizing ${tgt.name} at 100 m: tumble ${tgt.tumble.toFixed(2)}°/s, mass ${tgt.mass.toFixed(0)} kg.`); break;
    case 'standoff': S.phaseDur=DAY; break;
    case 'push': { sh.mode='push'; tgt.status='pushing'; const z=pushSizing(tgt); S.push=z; S.phaseDur=z.tPush; S.prox.sep=cfg.standoff;
      log(S.regime==='LEO'? `Beam on. Retrograde push at apogee arcs: ${z.dvReq.toFixed(0)} m/s to drop perigee to ${cfg.targetPerigee} km, ${(z.tPush/DAY).toFixed(0)} days.`
                            : `Beam on. Prograde push: ${z.dvReq.toFixed(1)} m/s to raise ${(z.dhReq).toFixed(0)} km, ${(z.tPush/DAY).toFixed(0)} days.`); break; }
    case 'release': S.phaseDur=3*DAY; break;
    case 'approach': sh.mode='prox'; S.phaseDur=2*DAY; log(`Detumbling ${tgt.name} contactlessly with the beam, then approaching along its axis to the nozzle.`); break;
    case 'attach': S.phaseDur=DAY; S.prox.arm=0; S.prox.kitAttached=false; log(`Arm out. Capturing ${tgt.name} at the engine nozzle.`); break;
    case 'depart': S.phaseDur=DAY; break;
    case 'return': { sh.mode='return'; if(S.tech==='kit'||S.regime==='GEO'){ const rp=RE+sh.parkAlt, ra=sh.el.a*(1+sh.el.e); const h=P.hohmannDv(rp,ra); S.phaseDur=h.tof; dvSpend(h.total*1e3);
        sh.el={a:(rp+ra)/2,e:(ra-rp)/(ra+rp),i:sh.el.i,raan:sh.el.raan,argp:P.wrap(sh.el.argp+sh.el.M),M:0}; S.returnTo=rp; log(`Drop to the ${sh.parkAlt.toFixed(0)} km waiting orbit, ${(h.total*1e3).toFixed(1)} m/s.`); }
      else { S.phaseDur=DAY; log('Staying low: the lowered orbit precesses faster and carries the shepherd toward the next plane.'); } break; }
    case 'complete': sh.mode='done'; log(`Campaign complete: ${sh.targetsDone} objects handled, ${sh.prop.toFixed(0)} kg xenon left.`); break;
  }
  S.warp=paceWarp(phase,S.phaseDur);
  if(phase==='wait'&&S.wait){ S.warp=Math.min(60*DAY,Math.max(DAY,S.wait.eta/8)); }   // a wait plays out in ~8 s, never faster than 1 day/s
}
function pushSizing(tgt){
  const sh=state.shepherd, acc=cfg.etaB*cfg.beamN/tgt.mass, fCounter=cfg.beamN+cfg.dryMass*acc;
  if(state.regime==='LEO'){ const a0=tgt.el.a, v=Math.sqrt(MU/a0)*1e3, dr=(a0-RE-cfg.targetPerigee); const dvReq=v*dr/(4*a0); const tPush=dvReq/(acc*cfg.duty);
    return {acc,fCounter,dvReq,tPush,rp0:a0,rpT:RE+cfg.targetPerigee,mode:'lower'}; }
  const dhReq=235+1000*1.3*tgt.am; const a0=tgt.el.a, v=Math.sqrt(MU/a0)*1e3; const dvReq=v*dhReq/(2*a0); const tPush=dvReq/acc;
  return {acc,fCounter,dvReq,dhReq,tPush,a0,mode:'raise'};
}
function pickNextTarget(){
  const S=state, sh=S.shepherd; let best=null;
  for(const t of S.targets){ if(t.status!=='idle'||!t.eligible) continue;
    if(S.tech==='kit'&&sh.kits<=0) continue;
    let wait, gapDeg;
    if(S.regime==='LEO'){ const rel=P.raanRate(sh.el.a,sh.el.e,sh.el.i)-P.raanRate(t.el.a,t.el.e,t.el.i); const g=P.wrap(t.el.raan-sh.el.raan);
      wait= rel>0? g/rel : (TWO_PI-g)/(-rel); gapDeg=(rel>0?g:TWO_PI-g)/d2r; }
    else { const rel=1.5*P.meanMotion(P.GEO_R)*(P.GEO_R-sh.el.a)/P.GEO_R; const g=P.wrap(t.el.M-sh.el.M); wait=g/rel; gapDeg=g/d2r; }
    if(!best||wait<best.wait) best={t,wait,gapDeg};
  }
  if(!best){ S.current=-1; S.wait=null; enter('complete'); return; }
  S.current=best.t.id; best.t.status='targeted'; S.wait={gapDeg:best.gapDeg, eta:best.wait, gap0:best.gapDeg};
  const v=Math.sqrt(MU/best.t.el.a); const saved=P.planeChangeDv(v,best.gapDeg)*1e3;
  S.wait.planeChangeDv=saved;
  log(S.regime==='LEO'? `Next: ${best.t.name}. RAAN gap ${best.gapDeg.toFixed(1)}°, closing by differential J2 in ${(best.wait/DAY).toFixed(0)} d. A plane change would cost ${(saved/1e3).toFixed(2)} km/s.`
                       : `Next: ${best.t.name}. Longitude gap ${best.gapDeg.toFixed(1)}°, drift closes it in ${(best.wait/DAY).toFixed(0)} d for no propellant.`);
}

// ---------- step ----------
function step(dt){
  const S=state, sh=S.shepherd, tgt=S.targets[S.current]||null; S.dt=dt; S.t+=dt; S.phaseT+=dt; S.earthRot=P.wrap(S.earthRot+P.OMEGA_E*dt);
  const f=Math.min(1,S.phaseT/S.phaseDur), ph=S.phase;
  // background: every non-current target
  for(const t of S.targets){ if(t===tgt&&['pushing'].includes(t.status)) continue; stepTarget(t,dt); }
  // shepherd by phase
  switch(ph){
    case 'prelaunch': sh.pos=P.latLonToEci(S.scenario.launch.lat,S.scenario.launch.lon,0,S.earthRot); break;
    case 'ascent': { // monotonic: altitude 0 -> 200 km (ease-out), downrange angle accelerating, ends tangent to the parking orbit
      const alt=200*(1-Math.pow(1-f,2.5)); const el2={...sh.el,a:RE+alt,e:0,M:S.launch.u+0.35*Math.pow(f,2.2)};
      sh.pos=P.posFromEl(el2); S.launch.path.push({...sh.pos}); if(S.launch.path.length>400) S.launch.path.shift(); sh.el.M=S.launch.u+0.35; break; }
    case 'parking': P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); S.launch.path.push({...sh.pos}); if(S.launch.path.length>600) S.launch.path.shift(); break;
    case 'transfer': P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); S.launch.path.push({...sh.pos}); if(S.launch.path.length>600) S.launch.path.shift(); break;
    case 'insert': sh.el.a=RE+sh.parkAlt; sh.el.e=0; sh.el.M=Math.PI; sh.el.argp=P.wrap(sh.el.argp); P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); break;
    case 'wait': P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); if(tgt){ // remaining alignment
        if(S.regime==='LEO'){ const rel=P.raanRate(sh.el.a,sh.el.e,sh.el.i)-P.raanRate(tgt.el.a,tgt.el.e,tgt.el.i); const g=P.wrap(tgt.el.raan-sh.el.raan); const gd=(rel>0?g:TWO_PI-g)/d2r; S.wait.gapDeg=gd; S.wait.eta=rel>0?g/rel:(TWO_PI-g)/(-rel);
          if(gd<0.35||gd>359.6){ sh.dvSavedByWaiting+=S.wait.planeChangeDv; enter('climb'); } }
        else { const rel=1.5*P.meanMotion(P.GEO_R)*(P.GEO_R-sh.el.a)/P.GEO_R; const g=P.wrap(tgt.el.M-sh.el.M); S.wait.gapDeg=g/d2r; S.wait.eta=g/rel; if(g<0.004||g>TWO_PI-0.004) enter('climb'); } }
      break;
    case 'climb': P.propagate(sh.el,dt,false); sh.pos=P.posFromEl(sh.el); break;
    case 'rendezvous': case 'characterize': case 'standoff': case 'approach': case 'release': case 'depart': case 'attach':
      if(tgt){ P.propagate(tgt.el,dt); updateTargetGeom(tgt); sh.el={...tgt.el}; sh.pos=tgt.pos; }
      break;
    case 'push': { if(!tgt) break; const z=S.push; const a0=tgt.el.a;
      if(z.mode==='lower'){ const rp=lerp(z.rp0,z.rpT,f); const ra=z.rp0; tgt.el.a=(rp+ra)/2; tgt.el.e=(ra-rp)/(ra+rp); S.dvDelivered=z.dvReq*f; }
      else { tgt.el.a=z.a0+z.dhReq*f; S.dvDelivered=z.dvReq*f; }
      P.propagate(tgt.el,dt); updateTargetGeom(tgt); sh.el={...tgt.el}; sh.pos=tgt.pos;
      sh.prop=Math.max(0,sh.prop-(cfg.beamN+z.fCounter)/(cfg.isp*P.G0)*dt*(z.mode==='lower'?cfg.duty:1)); sh.dvUsed+= (z.dvReq/S.phaseDur)*dt*(cfg.dryMass/cfg.dryMass);
      tgt.tumble=Math.max(0.02,tgt.tumble*Math.exp(-dt/(6*DAY)));
      break; }
    case 'return': if(S.tech==='kit'||S.regime==='GEO'){ P.propagate(sh.el,dt,false); sh.pos=P.posFromEl(sh.el); } else { P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); } break;
    case 'complete': P.propagate(sh.el,dt); sh.pos=P.posFromEl(sh.el); break;
  }
  // velocity (km/s ECI): analytic when on a Kepler orbit, finite-difference otherwise
  if(ph==='prelaunch'){ sh.vel={x:-P.OMEGA_E*sh.pos.y, y:P.OMEGA_E*sh.pos.x, z:0}; }
  else if(ph==='ascent'){ const prev=S._prevPos||sh.pos; sh.vel= dt>0? {x:(sh.pos.x-prev.x)/dt,y:(sh.pos.y-prev.y)/dt,z:(sh.pos.z-prev.z)/dt} : {x:0,y:0,z:0}; }
  else { sh.vel=P.stateFromEl(sh.el).vel; }
  S._prevPos={...sh.pos};
  // proximity state
  const px=S.prox; px.active=['rendezvous','characterize','standoff','push','release','approach','attach','depart'].includes(ph);
  if(px.active&&tgt){
    px.tumble=tgt.tumble; px.beamHalfAngleDeg=cfg.beamHalf; px.standoff=cfg.standoff; px.targetKind=tgt.kind; px.targetLength=tgt.length; px.targetDiam=tgt.diam;
    const sign = (S.tech==='ibs'&&S.regime==='LEO')? +1 : -1;   // LEO IBS pushes retrograde from ahead
    switch(ph){
      case 'rendezvous': px.sep=lerp(2000,100,f); break;
      case 'characterize': px.sep=100; break;
      case 'standoff': px.sep=lerp(100,cfg.standoff,f); break;
      case 'push': px.sep=cfg.standoff; px.beamOn=true; px.counterOn=true; break;
      case 'release': px.sep=lerp(cfg.standoff,500,f); break;
      case 'approach': { const d=attachSep(tgt); px.sep=lerp(2000,d,Math.pow(f,0.6)); px.arm=0; px.beamOn=px.counterOn=f<0.5; if(f<0.5) tgt.tumble=Math.max(0.02,tgt.tumble*Math.exp(-dt/(0.25*DAY))); break; }
      case 'attach': px.sep=attachSep(tgt); px.arm= f<0.45? f/0.45 : f<0.6? 1 : Math.max(0,1-(f-0.6)/0.4); if(f>=0.5&&!px.kitAttached){ px.kitAttached=true; sh.kits--; tgt.kit={mass:kitMassFor(tgt.mass),dv:210,burning:false}; tgt.status='kitted'; log(`Kit attached to ${tgt.name} (${tgt.kit.mass.toFixed(0)} kg). Checkout, then departure.`); } break;
      case 'depart': px.sep=lerp(attachSep(tgt),500,f); px.arm=0; break;
    }
    px.shepPos={x:sign*px.sep,y:0,z:0};
  } else { px.beamOn=px.counterOn=false; }
  // phase transitions
  if(S.phaseT>=S.phaseDur) advance();
}
function stepTarget(t,dt){
  const S=state;
  if(t.status==='reentered'||t.status==='graveyard') return;
  if(t.status==='kitwait'){ if(S.t>=t.kit.burnT){ const over=S.t-t.kit.burnT; P.propagate(t.el,dt-over); kitBurn(t); P.propagate(t.el,over,false); updateTargetGeom(t); } else { P.propagate(t.el,dt); updateTargetGeom(t); } return; }
  if(t.status==='kitburn'){ t.kit.burning=(S.t-t.kit.burnT)<180;
    if(S.t>=t.kit.reentryT){ const over=S.t-t.kit.reentryT; P.propagate(t.el,dt-over,false); updateTargetGeom(t); const ll=P.eciToLatLon(t.pos,P.wrap(S.earthRot-P.OMEGA_E*over)); t.status='reentered'; t.reentry={lat:ll.lat,lon:ll.lon,t:t.kit.reentryT,controlled:true}; log(`${t.name} reentered under control at ${(ll.lat/d2r).toFixed(0)}°, ${(ll.lon/d2r).toFixed(0)}° (SPOUA).`); }
    else { P.propagate(t.el,dt,false); updateTargetGeom(t); } return; }
  if(t.status==='decaying'){ const sub=Math.max(1,Math.ceil(dt/(0.5*DAY))); for(let k=0;k<sub;k++){ const r=P.dragDecay(t.el,t.bc,dt/sub,cfg.solar); t.el.a=r.a; t.el.e=r.e; }
    P.propagate(t.el,dt); updateTargetGeom(t);
    if(t.perigeeAlt<120){ const ll=P.eciToLatLon(t.pos,S.earthRot); t.status='reentered'; t.reentry={lat:ll.lat,lon:ll.lon,t:S.t,controlled:false}; log(`${t.name} reentered (uncontrolled) after ${((S.t-t.releasedT)/DAY/365).toFixed(1)} years.`); }
    else if(!t._lifeT||S.t-t._lifeT>30*DAY){ t._lifeT=S.t; t.lifetimeDays=P.lifetimeDays(t.el,t.bc,cfg.solar); }
    return; }
  P.propagate(t.el,dt); updateTargetGeom(t);
}
function attachSep(t){ return (SIM.prox&&SIM.prox.attachSep)? SIM.prox.attachSep(t.kind,t.length,t.diam) : t.length/2+2.5; }
function scheduleKit(t){ // find first time within 12 days when the point half an orbit ahead lies over SPOUA
  const S=state; const el={...t.el}; const T=P.period(el.a); const Tb=0.5*P.period((el.a+RE+40)/2); let tt=S.t;
  for(let k=0;k<12*DAY/60;k++){ const e2={...el}; P.propagate(e2,T/2,false); const pos=P.posFromEl(e2); const ll=P.eciToLatLon(pos,P.wrap(S.earthRot+P.OMEGA_E*(tt-S.t+Tb)));
    const d=Math.acos(clamp(Math.sin(ll.lat)*Math.sin(SPOUA.lat)+Math.cos(ll.lat)*Math.cos(SPOUA.lat)*Math.cos(ll.lon-SPOUA.lon),-1,1));
    if(d<12*d2r){ t.kit.burnT=tt; return; } P.propagate(el,60); tt+=60; }
  t.kit.burnT=tt;
}
function kitBurn(t){ const S=state; const ra=t.el.a, rp=RE+40; const u=P.wrap(t.el.argp+t.el.M);
  t.el={a:(rp+ra)/2,e:(ra-rp)/(ra+rp),i:t.el.i,raan:t.el.raan,argp:P.wrap(u-Math.PI),M:Math.PI}; t.status='kitburn'; t.kit.burning=true;
  t.kit.reentryT=t.kit.burnT+0.5*P.period(t.el.a); log(`${t.name}: kit fires ${t.kit.dv} m/s at apogee. Perigee 40 km over the South Pacific in ${(0.5*P.period(t.el.a)/60).toFixed(0)} min.`); }
function advance(){
  const S=state, sh=S.shepherd, tgt=S.targets[S.current];
  switch(S.phase){
    case 'prelaunch': enter('ascent'); break;
    case 'ascent': enter('parking'); break;
    case 'parking': enter('transfer'); break;
    case 'transfer': enter('insert'); break;
    case 'insert': log(`In the waiting orbit at ${sh.parkAlt.toFixed(0)} km. From here the shepherd never changes inclination.`); enter('wait'); break;
    case 'climb': sh.el.a=RE+sh.clusterAlt; sh.el.e=0; sh.el.M=P.wrap(sh.el.argp+sh.el.M); sh.el.argp=0; enter('rendezvous'); break;
    case 'rendezvous': enter('characterize'); break;
    case 'characterize': enter(S.tech==='ibs'?'standoff':'approach'); break;
    case 'standoff': enter('push'); break;
    case 'push': if(S.regime==='LEO'){ tgt.status='decaying'; tgt.releasedT=S.t; tgt.lifetimeDays=P.lifetimeDays(tgt.el,tgt.bc,cfg.solar); log(`Beam off. ${tgt.name} now ${tgt.perigeeAlt.toFixed(0)}×${tgt.apogeeAlt.toFixed(0)} km, est. lifetime ${(tgt.lifetimeDays/365).toFixed(1)} yr.`); }
                 else { tgt.status='graveyard'; log(`${tgt.name} in graveyard orbit, GEO +${(tgt.el.a-P.GEO_R).toFixed(0)} km.`); }
                 sh.targetsDone++; enter('release'); break;
    case 'release': enter('return'); break;
    case 'approach': enter('attach'); break;
    case 'attach': enter('depart'); break;
    case 'depart': tgt.status='kitwait'; scheduleKit(tgt); sh.targetsDone++; log(`${tgt.name} released. Kit waits ${((tgt.kit.burnT-S.t)/3600).toFixed(1)} h for a South Pacific window.`); enter('return'); break;
    case 'return': if(S.tech==='kit'||S.regime==='GEO'){ sh.el.a=S.returnTo; sh.el.e=0; sh.el.M=P.wrap(sh.el.argp+sh.el.M); sh.el.argp=0; }
      if(sh.prop<=2){ log('Xenon exhausted.'); enter('complete'); } else enter('wait'); break;
    case 'complete': S.phaseDur=Infinity; break;
    default: break;
  }
}
function skipPhase(){ if(state.phase==='wait'){ if(state.current>=0){ const tgt=state.targets[state.current]; state.shepherd.el.raan=tgt.el.raan; if(state.regime==='GEO') state.shepherd.el.M=tgt.el.M-0.003; state.shepherd.dvSavedByWaiting+=state.wait.planeChangeDv; enter('climb'); } return; }
  if(state.phase==='complete') return; state.phaseT=state.phaseDur; }
SIM.mission={setup,step,skipPhase,cfg,get state(){return state;},pushSizing,WARP,PACE};
})();
