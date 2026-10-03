// fpv-hud.js — DOM overlay for the first-person "Ride along" view. Attaches SIM.fpvHud.
// Stage strip, event flash, big readouts (altitude / speed), caption, "where am I" mini-map.
// All DOM lives inside the container passed to init(); nothing outside it is read or touched.
// Contract (see FPV_SPEC.md): init(container), update(state, derived), setVisible(bool).
(function(){
'use strict';
window.SIM = window.SIM || {};

var TEXT='#e9edf6', MUTED='#9aa5c4', TEAL='#22a690', TEAL2='#3ecfb5', AMBER='#f2b955', PANEL='rgba(11,17,40,.72)';
var THIN=' ';                       // thin-space thousands separator
var CHIPS=['Launch','Climb','Coast','Boost','Arrive'];
var TWEEN_RATE=6;                        // exponential approach, 1/s (real time)
var FLASH_MS=1500, CAP_FADE_MS=150, MAP_INTERVAL=50; // mini-map redraw at most 20×/s
var MAP_PX=150, MAP_MARGIN=12;

var CSS=[
'.fpvh-root{position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;color:'+TEXT+';',
'  font-family:var(--body,"Fira Sans",ui-sans-serif,system-ui,sans-serif);font-size:13.5px;line-height:1.3;user-select:none;-webkit-user-select:none}',
'.fpvh-root *{box-sizing:border-box}',
'.fpvh-mono{font-family:var(--mono,"Fira Code",ui-monospace,Menlo,Consolas,monospace)}',
'.fpvh-panel{background:'+PANEL+';border:1px solid rgba(255,255,255,.06);border-radius:6px}',
/* title */
'.fpvh-title{position:absolute;top:12px;left:12px;padding:5px 9px;font-size:12px;letter-spacing:.06em;color:'+MUTED+';white-space:nowrap}',
'.fpvh-root.fpvh-mid .fpvh-title{display:flex;flex-direction:column;gap:1px;line-height:1.2;padding:4px 8px}',
'.fpvh-root.fpvh-mid .fpvh-titleSub{font-size:10.5px;opacity:.85}',
'.fpvh-root.fpvh-mid .fpvh-titleDot{display:none}',
/* stage strip */
'.fpvh-strip{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:6px 9px;white-space:nowrap}',
'.fpvh-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.08);',
'  font-size:14px;font-weight:500;color:'+MUTED+';transition:color .25s,border-color .25s,transform .25s,background-color .25s;transform:scale(1)}',
'.fpvh-chipMark{display:inline-block;width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;position:relative;flex:none}',
'.fpvh-chipMark::after{content:"";position:absolute;inset:0;display:none}',
'.fpvh-chip.fpvh-done{color:'+TEAL2+';border-color:rgba(34,166,144,.55);background:rgba(34,166,144,.10)}',
'.fpvh-chip.fpvh-done .fpvh-chipMark{border:0;background:'+TEAL+';color:#08110f;font-size:9px;line-height:10px;text-align:center;font-weight:700}',
'.fpvh-chip.fpvh-done .fpvh-chipMark::before{content:"\\2713";position:absolute;inset:0;display:block;line-height:10px}',
'.fpvh-chip.fpvh-active{color:'+AMBER+';border-color:rgba(242,185,85,.7);background:rgba(242,185,85,.10);transform:scale(1.1);animation:fpvh-pulse 2s ease-in-out infinite}',
'.fpvh-chip.fpvh-active .fpvh-chipMark{border:0;background:'+AMBER+';box-shadow:0 0 6px rgba(242,185,85,.8)}',
'.fpvh-link{display:inline-block;width:14px;height:1px;background:rgba(255,255,255,.16);flex:none;transition:background-color .25s}',
'.fpvh-link.fpvh-done{background:'+TEAL+'}',
'@keyframes fpvh-pulse{0%,100%{box-shadow:0 0 0 0 rgba(242,185,85,.40)}60%{box-shadow:0 0 0 7px rgba(242,185,85,0)}}',
'.fpvh-root.fpvh-mid .fpvh-strip{gap:3px;padding:5px 8px}',
'.fpvh-root.fpvh-mid .fpvh-chip{font-size:13px;padding:2px 7px 2px 6px}',
'.fpvh-root.fpvh-mid .fpvh-link{width:9px}',
'.fpvh-root.fpvh-narrow .fpvh-chip{font-size:12.5px}',
'.fpvh-root.fpvh-narrow .fpvh-title{display:none}',
/* event flash */
'.fpvh-flash{position:absolute;top:58px;left:0;right:0;text-align:center;font-size:16px;letter-spacing:.22em;text-transform:uppercase;color:'+AMBER+';',
'  font-weight:500;opacity:0;text-shadow:0 0 12px rgba(242,185,85,.55),0 1px 2px rgba(0,0,0,.6);will-change:opacity}',
/* readouts */
'.fpvh-ro{position:absolute;left:12px;bottom:12px;width:224px;padding:10px 14px 9px;display:flex;flex-direction:column;gap:9px}',
'.fpvh-roLbl{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:'+MUTED+'}',
'.fpvh-roVal{display:flex;align-items:baseline;gap:6px;margin-top:1px}',
'.fpvh-num{font-size:34px;font-weight:500;line-height:1.05;font-variant-numeric:tabular-nums;color:'+TEXT+';white-space:nowrap}',
'.fpvh-root.fpvh-narrow .fpvh-num{font-size:26px}',
'.fpvh-bottom{display:contents}',
'.fpvh-root.fpvh-narrow .fpvh-bottom{display:flex;position:absolute;left:12px;right:12px;bottom:12px;flex-direction:column;gap:8px;align-items:stretch}',
'.fpvh-root.fpvh-narrow .fpvh-ro{position:static;width:auto;flex-direction:row;align-items:flex-end;gap:6px 16px;padding:8px 12px 7px}',
'.fpvh-root.fpvh-narrow .fpvh-roItem{flex:1 1 0;min-width:0}',
'.fpvh-root.fpvh-narrow .fpvh-tplus{margin:0 0 1px;flex:0 0 auto}',
'.fpvh-unit{font-size:12px;color:'+MUTED+'}',
'.fpvh-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.10);overflow:hidden;margin-top:5px}',
'.fpvh-bar i{display:block;height:100%;width:0;background:'+AMBER+';border-radius:2px;transition:background-color .3s}',
'.fpvh-barLbl{font-size:10.5px;color:'+MUTED+';text-align:right;margin-top:3px;letter-spacing:.02em;transition:color .3s}',
'.fpvh-roItem.fpvh-inorbit .fpvh-bar i{background:'+TEAL2+'}',
'.fpvh-roItem.fpvh-inorbit .fpvh-barLbl{color:'+TEAL2+'}',
'.fpvh-tplus{font-size:12px;color:'+MUTED+';margin-top:-2px;font-variant-numeric:tabular-nums}',
/* caption */
'.fpvh-capWrap{position:absolute;left:252px;right:12px;bottom:12px;display:flex;justify-content:flex-end;align-items:flex-end}',
'.fpvh-root.fpvh-narrow .fpvh-capWrap{position:static;justify-content:flex-start}',
'.fpvh-root.fpvh-narrow .fpvh-cap{max-width:none;font-size:19px}',
'.fpvh-cap{display:grid;max-width:560px;padding:10px 14px;border-left:3px solid '+TEAL+';border-radius:0 6px 6px 0;font-size:20px;font-weight:500;line-height:1.3;',
'  text-wrap:balance;text-wrap:pretty}',
'.fpvh-capTxt{grid-area:1/1;opacity:1;transition:opacity '+CAP_FADE_MS+'ms ease}',
'.fpvh-capTxt.fpvh-off{opacity:0}',
/* mini-map */
'.fpvh-map{position:absolute;top:12px;right:12px;width:'+MAP_PX+'px;height:'+MAP_PX+'px;overflow:hidden}',
'.fpvh-map canvas{display:block;width:'+MAP_PX+'px;height:'+MAP_PX+'px}',
'.fpvh-mapTitle{position:absolute;top:5px;left:8px;font-size:11px;color:'+MUTED+';letter-spacing:.04em;text-shadow:0 0 4px rgba(11,17,40,1),0 0 2px rgba(11,17,40,1)}',
'.fpvh-root.fpvh-narrow .fpvh-map{display:none}'
].join('\n');

// ---------- module state ----------
var root=null, el={}, ctx=null, dpr=1, visible=true, containerEl=null, ro=null;
var last={ alt:'', spd:'', t:'', altLbl:'', spdLbl:'', cap:'', flash:'', stageKey:'', altBar:-1, spdBar:-1, inOrbit:null, flashOp:-1, capIdx:0, capClearAt:0, width:-1 };
var disp={ alt:0, spd:0, init:false, stageIndex:-1 };
var flashStart=-1e9, flashText='';
var lastMapDraw=-1e9;
var lastNow=0;

function mk(tag, cls, parent, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; if(parent) parent.appendChild(e); return e; }
function num(v, d){ return (typeof v==='number' && isFinite(v)) ? v : d; }

// thin-space thousands; no decimals >=100, one decimal below
function fmtNum(v){
  if(!isFinite(v)) return '—';
  var neg=v<0; v=Math.abs(v); var s;
  if(v>=99.95){ s=String(Math.round(v)); var out='', n=s.length; for(var k=0;k<n;k++){ if(k>0 && (n-k)%3===0) out+=THIN; out+=s.charAt(k); } s=out; }
  else s=v.toFixed(1);
  return (neg?'−':'')+s;
}
function pad2(n){ return n<10 ? '0'+n : ''+n; }
function fmtT(t){
  if(!isFinite(t)) return 'T+ —';
  var sign = t<0 ? 'T− ' : 'T+ ';
  var a=Math.abs(t); var h=Math.floor(a/3600), m=Math.floor((a%3600)/60), s=Math.floor(a%60);
  return sign + (h>0 ? h+':'+pad2(m)+':'+pad2(s) : pad2(m)+':'+pad2(s));
}
function setText(node, key, str){ if(last[key]!==str){ last[key]=str; node.textContent=str; } }

// ---------- init ----------
function injectStyle(){
  if(document.getElementById('fpvh-style')) return;
  var st=document.createElement('style'); st.id='fpvh-style'; st.textContent=CSS; document.head.appendChild(st);
}

function init(container){
  if(!container) return;
  injectStyle();
  if(root && root.parentNode) root.parentNode.removeChild(root);
  containerEl=container;
  root=mk('div','fpvh-root',container);

  // title
  var title=mk('div','fpvh-title fpvh-panel fpvh-mono',root);
  mk('span','',title,'RIDE ALONG');
  var sub=mk('span','fpvh-titleSub',title); mk('span','fpvh-titleDot',sub,' · '); mk('span','',sub,'launch to orbit');

  // stage strip
  var strip=mk('div','fpvh-strip fpvh-panel',root);
  el.chips=[]; el.links=[];
  for(var i=0;i<CHIPS.length;i++){
    if(i>0) el.links.push(mk('i','fpvh-link',strip));
    var chip=mk('span','fpvh-chip',strip);
    mk('i','fpvh-chipMark',chip);
    mk('span','fpvh-chipTxt',chip,CHIPS[i]);
    el.chips.push(chip);
  }

  // event flash
  el.flash=mk('div','fpvh-flash fpvh-mono',root);

  // bottom group: caption + readouts (absolute children on wide widths, stacked column on narrow)
  el.bottom=mk('div','fpvh-bottom',root);
  var capWrap=mk('div','fpvh-capWrap',el.bottom);
  el.cap=mk('div','fpvh-cap fpvh-panel',capWrap);
  el.capA=mk('span','fpvh-capTxt',el.cap,'');
  el.capB=mk('span','fpvh-capTxt fpvh-off',el.cap,'');
  el.capLayers=[el.capA,el.capB];

  // readouts
  var ro_=mk('div','fpvh-ro fpvh-panel',el.bottom);
  el.altItem=mk('div','fpvh-roItem',ro_);
  mk('div','fpvh-roLbl fpvh-mono',el.altItem,'Altitude');
  var av=mk('div','fpvh-roVal',el.altItem); el.altNum=mk('b','fpvh-num fpvh-mono',av,'0.0'); mk('span','fpvh-unit',av,'km');
  el.altBar=mk('i','',mk('div','fpvh-bar',el.altItem)); el.altLbl=mk('div','fpvh-barLbl fpvh-mono',el.altItem,'target — km');
  el.spdItem=mk('div','fpvh-roItem',ro_);
  mk('div','fpvh-roLbl fpvh-mono',el.spdItem,'Speed');
  var sv=mk('div','fpvh-roVal',el.spdItem); el.spdNum=mk('b','fpvh-num fpvh-mono',sv,'0.0'); mk('span','fpvh-unit',sv,'km/h');
  el.spdBar=mk('i','',mk('div','fpvh-bar',el.spdItem)); el.spdLbl=mk('div','fpvh-barLbl fpvh-mono',el.spdItem,'orbit speed');
  el.tplus=mk('div','fpvh-tplus fpvh-mono',ro_,'T+ 00:00');

  // mini-map
  el.map=mk('div','fpvh-map fpvh-panel',root);
  el.mapCv=mk('canvas','',el.map);
  mk('div','fpvh-mapTitle',el.map,'where am I');
  ctx=el.mapCv.getContext('2d');
  setupCanvas();

  // responsive
  if(ro){ try{ ro.disconnect(); }catch(e){} ro=null; }
  if(typeof ResizeObserver!=='undefined'){
    ro=new ResizeObserver(function(entries){ var w=entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : container.clientWidth; applyWidth(w); });
    ro.observe(container);
  } else {
    window.addEventListener('resize', function(){ if(containerEl) applyWidth(containerEl.clientWidth); });
  }
  applyWidth(container.clientWidth);

  // reset cached strings so the first update writes everything
  last.alt=last.spd=last.t=last.altLbl=last.spdLbl=last.cap=last.flash=last.stageKey='';
  last.altBar=last.spdBar=-1; last.inOrbit=null; last.flashOp=-1; last.capIdx=0; last.capClearAt=0;
  disp.init=false; disp.stageIndex=-1; flashStart=-1e9; lastMapDraw=-1e9; lastNow=0;
  root.style.display = visible ? '' : 'none';
}

function setupCanvas(){
  dpr=Math.min(window.devicePixelRatio||1, 2);
  el.mapCv.width=Math.round(MAP_PX*dpr); el.mapCv.height=Math.round(MAP_PX*dpr);
  lastMapDraw=-1e9;
}

function applyWidth(w){
  if(!root) return;
  w=num(w, 1000);
  if(w===last.width) return; last.width=w;
  var narrow=w<760, mid=w<980;
  root.classList.toggle('fpvh-narrow', narrow);
  root.classList.toggle('fpvh-mid', mid);
}

// ---------- update ----------
function update(state, derived){
  if(!root || !visible) return;
  var d=derived||{}, s=state||{};
  var now=performance.now();
  var dt=lastNow ? Math.min(0.25, (now-lastNow)/1000) : 0; lastNow=now;

  // --- stage strip ---
  var stage=d.stage||'pad';
  var si=Math.max(0, Math.min(4, Math.round(num(d.stageIndex,0))));
  var allDone = stage==='done';
  var stageKey=si+(allDone?'d':'');
  if(stageKey!==last.stageKey){
    last.stageKey=stageKey;
    for(var i=0;i<5;i++){
      var c=el.chips[i]; var done = allDone || i<si; var active = !allDone && i===si;
      c.classList.toggle('fpvh-done', done); c.classList.toggle('fpvh-active', active);
      if(i>0) el.links[i-1].classList.toggle('fpvh-done', allDone || i<=si);
    }
  }
  // snap displayed numbers on a restart (stage index went backwards)
  if(si<disp.stageIndex) disp.init=false;
  disp.stageIndex=si;

  // --- numbers (tween) ---
  var altT=num(d.altKm,0), spdT=num(d.speedKmh,0);
  if(!disp.init){ disp.alt=altT; disp.spd=spdT; disp.init=true; }
  else { var k=1-Math.exp(-TWEEN_RATE*dt); disp.alt+=(altT-disp.alt)*k; disp.spd+=(spdT-disp.spd)*k; }
  if(Math.abs(disp.alt-altT)<0.005) disp.alt=altT;
  if(Math.abs(disp.spd-spdT)<0.05) disp.spd=spdT;
  setText(el.altNum,'alt',fmtNum(disp.alt));
  setText(el.spdNum,'spd',fmtNum(disp.spd));

  var targetAlt=num(d.targetAltKm, num(s.shepherd && s.shepherd.parkAlt, 0));
  var orbitSpd=num(d.orbitSpeedKmh, 0);
  var altF = targetAlt>0 ? Math.max(0, Math.min(1, disp.alt/targetAlt)) : 0;
  var spdF = orbitSpd>0 ? Math.max(0, Math.min(1, disp.spd/orbitSpd)) : 0;
  var altPct=Math.round(altF*1000)/10, spdPct=Math.round(spdF*1000)/10;
  if(altPct!==last.altBar){ last.altBar=altPct; el.altBar.style.width=altPct+'%'; }
  if(spdPct!==last.spdBar){ last.spdBar=spdPct; el.spdBar.style.width=spdPct+'%'; }
  setText(el.altLbl,'altLbl', targetAlt>0 ? 'target '+fmtNum(Math.round(targetAlt/10)*10)+' km' : 'target — km');
  var inOrbit = orbitSpd>0 && spdT>=0.97*orbitSpd;
  if(inOrbit!==last.inOrbit){ last.inOrbit=inOrbit; el.spdItem.classList.toggle('fpvh-inorbit', inOrbit); }
  setText(el.spdLbl,'spdLbl', inOrbit ? 'in orbit ✓' : 'orbit speed');
  setText(el.tplus,'t', fmtT(num(d.tPlus, num(s.t,0))));

  // --- caption cross-fade ---
  var cap = typeof d.caption==='string' ? d.caption : last.cap;
  if(cap!==last.cap){
    last.cap=cap;
    var oldL=el.capLayers[last.capIdx], newIdx=1-last.capIdx, newL=el.capLayers[newIdx];
    newL.textContent=cap; newL.classList.remove('fpvh-off'); oldL.classList.add('fpvh-off');
    last.capIdx=newIdx; last.capClearAt=now+CAP_FADE_MS+60;
  }
  if(last.capClearAt && now>=last.capClearAt){ last.capClearAt=0; var off=el.capLayers[1-last.capIdx]; if(off.textContent) off.textContent=''; }

  // --- event flash ---
  var ev=d.eventFlash;
  if(typeof ev==='string' && ev && !(ev===flashText && now-flashStart<300)){
    flashText=ev; flashStart=now; setText(el.flash,'flash',ev);
  }
  var age=(now-flashStart)/FLASH_MS, op;
  if(age>=1) op=0; else { var f=age<0.25 ? 1 : 1-(age-0.25)/0.75; op=Math.round(f*f*50)/50; }
  if(op!==last.flashOp){ last.flashOp=op; el.flash.style.opacity=op; }

  // --- mini-map ---
  if(!root.classList.contains('fpvh-narrow') && now-lastMapDraw>=MAP_INTERVAL){
    lastMapDraw=now;
    try{ drawMap(s, targetAlt); }catch(e){ /* never throw from the HUD */ }
  }
}

// ---------- mini-map ----------
function drawMap(s, targetAlt){
  if(!ctx) return;
  var RE=(window.SIM.phys && window.SIM.phys.RE) || 6378.137;
  var sh=s.shepherd||{}, elm=sh.el||{};
  var inc=num(elm.i,0), raan=num(elm.raan,0);
  var cO=Math.cos(raan), sO=Math.sin(raan), ci=Math.cos(inc), si=Math.sin(inc);
  // plane basis p̂=(cosΩ, sinΩ, 0), q̂=(−cos i·sinΩ, cos i·cosΩ, sin i)
  var px=cO, py=sO, pz=0, qx=-ci*sO, qy=ci*cO, qz=si;
  var rTarget=RE+(targetAlt>0?targetAlt:200), rPark=RE+200;
  var W=MAP_PX, cx=W/2, cy=W/2;
  var scale=(W/2-MAP_MARGIN)/rTarget;

  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,W);

  // Earth
  var rE=RE*scale;
  var g=ctx.createRadialGradient(cx-rE*0.35, cy-rE*0.35, rE*0.1, cx, cy, rE);
  g.addColorStop(0,'#3a67b5'); g.addColorStop(1,'#1c3564');
  ctx.beginPath(); ctx.arc(cx,cy,rE,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
  ctx.lineWidth=1; ctx.strokeStyle='rgba(120,170,255,.55)'; ctx.stroke();

  // parking orbit (faint dashed)
  ctx.beginPath(); ctx.arc(cx,cy,rPark*scale,0,Math.PI*2);
  ctx.setLineDash([3,3]); ctx.strokeStyle='rgba(233,237,246,.28)'; ctx.lineWidth=1; ctx.stroke();
  // target orbit (teal dashed)
  ctx.beginPath(); ctx.arc(cx,cy,rTarget*scale,0,Math.PI*2);
  ctx.setLineDash([4,3]); ctx.strokeStyle='rgba(62,207,181,.9)'; ctx.lineWidth=1; ctx.stroke();
  ctx.setLineDash([]);

  // path so far (amber)
  var path=s.launch && s.launch.path;
  if(path && path.length>1){
    ctx.beginPath(); var started=false;
    for(var k=0;k<path.length;k++){
      var p=path[k]; if(!p) continue;
      var x=p.x*px+p.y*py+p.z*pz, y=p.x*qx+p.y*qy+p.z*qz;
      var X=cx+x*scale, Y=cy-y*scale;
      if(!started){ ctx.moveTo(X,Y); started=true; } else ctx.lineTo(X,Y);
    }
    ctx.strokeStyle=AMBER; ctx.lineWidth=1.5; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.globalAlpha=0.9; ctx.stroke(); ctx.globalAlpha=1;
  }

  // probe
  var pos=sh.pos;
  if(pos && isFinite(pos.x) && isFinite(pos.y) && isFinite(pos.z)){
    var ux=pos.x*px+pos.y*py+pos.z*pz, uy=pos.x*qx+pos.y*qy+pos.z*qz;
    var PX=cx+ux*scale, PY=cy-uy*scale;
    ctx.beginPath(); ctx.arc(PX,PY,5,0,Math.PI*2); ctx.fillStyle='rgba(242,185,85,.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(PX,PY,2.6,0,Math.PI*2); ctx.fillStyle=AMBER; ctx.fill();
    // label pushed outward from Earth's centre, kept inside the canvas
    var m=Math.hypot(ux,uy)||1, ox=ux/m, oy=-uy/m;
    ctx.font='10px "Fira Code",ui-monospace,Menlo,Consolas,monospace'; ctx.textBaseline='middle'; ctx.textAlign='left';
    var tw=ctx.measureText('you').width, LX=0, LY=0;
    for(var side=0; side<2; side++){            // outward first; flip inward if it would sit on the "where am I" title
      var dx=side?-ox:ox, dy=side?-oy:oy;
      LX=PX+dx*9; LY=PY+dy*9;
      if(dx<-0.3) LX-=tw; else if(dx<=0.3){ LX-=tw/2; LY=PY+(dy<0?-10:10); }
      LX=Math.max(3,Math.min(W-3-tw,LX)); LY=Math.max(7,Math.min(W-7,LY));
      if(!(LX<84 && LY<22)) break;
    }
    ctx.fillStyle=AMBER; ctx.fillText('you',LX,LY);
  }
}

function setVisible(b){
  visible=!!b;
  if(root) root.style.display = visible ? '' : 'none';
  if(visible){ lastNow=0; lastMapDraw=-1e9; }
}

window.SIM.fpvHud={ init:init, update:update, setVisible:setVisible };
})();
