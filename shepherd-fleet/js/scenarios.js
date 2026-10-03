// scenarios.js — debris clusters and launch sites. Attaches SIM.scenarios.
(function(){
'use strict';
window.SIM = window.SIM || {};
const d2r=Math.PI/180;
SIM.scenarios=[
  { id:'leo-sso', regime:'LEO', name:'Failed sun‑sync smallsats', short:'SSO smallsats',
    blurb:'A batch of dead Earth‑observation smallsats from one constellation, 790 km, 98.0°. All burn up fully: uncontrolled reentry is permitted.',
    cluster:{ alt:790, inc:98.0, count:30, kind:'smallsat', mass:[150,800], length:1.2, diam:1.0, am:[0.015,0.03], risk:[8e-6,6e-5], raanSpread:360 },
    launch:{ name:'Vandenberg', lat:34.7*d2r, lon:-120.6*d2r }, parkOffset:200, techs:['ibs','kit'] },
  { id:'leo-sl8', regime:'LEO', name:'SL‑8 (Kosmos‑3M) upper stages', short:'SL‑8 stages',
    blurb:'Kosmos‑3M second stages, 1.4 t each, 980 km, 82.9°. Casualty risk straddles the 1‑in‑10,000 line: some may reenter uncontrolled, the rest need a kit.',
    cluster:{ alt:980, inc:82.9, count:32, kind:'rocketbody', mass:[1400,1450], length:6.5, diam:2.4, am:[0.008,0.012], risk:[5e-5,2.4e-4], raanSpread:360 },
    launch:{ name:'Plesetsk', lat:62.9*d2r, lon:40.6*d2r }, parkOffset:200, techs:['ibs','kit'] },
  { id:'leo-sl16', regime:'LEO', name:'SL‑16 (Zenit) second stages', short:'SL‑16 stages',
    blurb:'Zenit‑2 second stages, ~9 t each, 840 km, 71.0°. Titanium tanks and steel engine parts survive reentry: controlled descent only.',
    cluster:{ alt:840, inc:71.0, count:20, kind:'rocketbody', mass:[8300,9000], length:11.0, diam:3.9, am:[0.004,0.006], risk:[3e-4,9e-4], raanSpread:360 },
    launch:{ name:'Baikonur', lat:45.9*d2r, lon:63.3*d2r }, parkOffset:200, techs:['ibs','kit'] },
  { id:'geo-comsats', regime:'GEO', name:'1990s GEO comsat derelicts', short:'GEO comsats',
    blurb:'Dead communications satellites abandoned in the same era, so their inclination vectors still cluster near 7.4°. No reentry: push to the IADC graveyard.',
    cluster:{ alt:35786, inc:7.4, count:30, kind:'comsat', mass:[1800,4200], length:2.6, diam:2.2, am:[0.015,0.03], risk:[0,0], lonSpread:360 },
    launch:{ name:'Cape Canaveral', lat:28.5*d2r, lon:-80.6*d2r }, parkOffset:100, techs:['ibs'] },
];
SIM.techs={
  ibs:{ name:'Ion beam shepherd', short:'Ion beam', blurb:'Contactless. A gridded ion source pushes the target from a few diameters away; a counter thruster holds standoff. LEO: lower perigee, let drag finish. GEO: raise to graveyard.' },
  kit:{ name:'Robotic‑arm descent kit', short:'Descent kit', blurb:'A servicer captures the stage at its engine nozzle with a robotic arm, bolts on a solid‑motor kit, and departs. The kit waits for a South Pacific window and fires for a controlled reentry.' },
};
})();
