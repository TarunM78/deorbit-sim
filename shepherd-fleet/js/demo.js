// demo.js — autoplay demo mode (~55 s, one story). Attaches SIM.demo.
// Drives the existing sim through SIM.mission (state getter, skipPhase()) and returns a per-frame directive
// {warp, paused, view, cam} that the host (app.js or test-demo.html) applies. No own RAF loop, no edits elsewhere.
(function(){
'use strict';
window.SIM = window.SIM || {};
const DAY = (SIM.phys && SIM.phys.DAY) || 86400;
const TOTAL = 55;                 // progress bar reference length (real seconds)
const DECAY_WARP = 45 * DAY;      // beat 7: 45 days per real second
const DECAY_MAX = 8;              // beat 7 gives up after this many real seconds
const REENTRY_HOLD = 1.5;         // hold after the pushed target reenters (orbit view draws a streak)
const GRACE = 0.15;               // real seconds past a budget before skipPhase() (frame quantisation)

// phase -> beat; anything missing (kit tech, GEO, future phases) is treated as beat 7
const BEAT_OF = { prelaunch:0, ascent:1, parking:1, transfer:1, insert:1, wait:2, climb:3, rendezvous:4, characterize:4, standoff:5, push:5, release:6, return:7, complete:7 };
// real-second budgets per mission phase (beats 0-6); beat 7 phases run at DECAY_WARP instead
const BUDGET = { prelaunch:2.5, ascent:8, parking:2, transfer:2, insert:1, wait:6, climb:2, rendezvous:2.5, characterize:2.5, standoff:1, push:10, release:2 };
const BEATS = [
  { view:'fpv',   cam:'follow', caption:null },   // 0 title card
  { view:'fpv',   cam:'follow', caption:null },   // 1 ride-along has its own captions
  { view:'orbit', cam:'earth',  caption:"Now it waits. The Earth's bulge slowly swings the junk's orbit into line with ours. That costs nothing." },
  { view:'orbit', cam:'follow', caption:'Lined up. A small burn climbs to the junk.' },
  { view:'prox',  cam:'follow', caption:'Closing in. Cameras and lidar measure the tumbling rocket body.' },
  { view:'prox',  cam:'follow', caption:'Ion beam on. The exhaust pushes the junk without touching it. Its orbit drops a little every day.' },
  { view:'prox',  cam:'follow', caption:'Beam off. Back away. The junk is now in a lower orbit.' },
  { view:'orbit', cam:'earth',  caption:'Lower means more air. The junk burns up harmlessly within a few years, instead of circling for centuries.' },
  { view:'orbit', cam:'earth',  caption:null },   // 8 end card
];
const TITLE = 'Space junk is piling up.';
const TITLE_SUB = 'One way to clean it: a probe that pushes junk down without ever touching it.';
const END_LINE = 'One launch. One probe. Junk pushed down, nothing touched.';

const CSS = [
'.demo-root{position:absolute;inset:0;pointer-events:none;z-index:30;overflow:hidden;color:#e9edf6;font-family:var(--body,"Fira Sans",ui-sans-serif,system-ui,sans-serif);--demo-mono:var(--mono,"Fira Code",ui-monospace,Menlo,Consolas,monospace)}',
'.demo-root.demo-hidden{display:none}',
'.demo-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(11,17,40,.72);border-radius:8px;text-align:center;box-sizing:border-box;padding:28px 36px;max-width:min(760px,calc(100% - 48px));width:max-content}',
'.demo-title{transition:opacity .4s ease;opacity:1}',
'.demo-title.demo-fade{opacity:0}',
'.demo-title h1{font-size:34px;font-weight:600;line-height:1.15;margin:0 0 12px;text-wrap:balance}',
'.demo-title p{font-size:18px;font-weight:400;line-height:1.4;margin:0;color:#c7cfe6;text-wrap:balance}',
'.demo-cap{position:absolute;left:50%;bottom:30px;transform:translateX(-50%);width:calc(100% - 48px);max-width:640px;box-sizing:border-box;font-size:22px;font-weight:500;line-height:1.35;background:rgba(11,17,40,.78);border-left:3px solid #22a690;border-radius:0 6px 6px 0;padding:12px 16px;opacity:1;transition:opacity .2s ease}',
'.demo-cap.demo-fade{opacity:0}',
'.demo-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(34,166,144,.18)}',
'.demo-prog i{display:block;height:100%;width:0;background:#22a690}',
'.demo-plabel{position:absolute;right:8px;bottom:6px;font-family:var(--demo-mono);font-size:11px;color:#9aa5c4;font-variant-numeric:tabular-nums}',
'.demo-skip{position:absolute;top:52px;right:12px;pointer-events:auto;font-family:inherit;font-size:12px;font-weight:500;background:rgba(11,17,40,.7);color:#e9edf6;border:1px solid #2b3666;border-radius:4px;padding:5px 9px;cursor:pointer}',
'.demo-skip:hover{border-color:#22a690}',
'.demo-end{background:rgba(11,17,40,.82)}',
'.demo-end h2{font-size:30px;font-weight:600;line-height:1.2;margin:0 0 22px;text-wrap:balance}',
'.demo-tiles{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin:0 0 24px}',
'.demo-tile{background:rgba(27,36,80,.75);border:1px solid #2b3666;border-radius:6px;padding:12px 18px;min-width:150px;box-sizing:border-box}',
'.demo-tile b{display:block;font-family:var(--demo-mono);font-weight:500;font-size:30px;line-height:1.1;color:#f2b955;font-variant-numeric:tabular-nums}',
'.demo-tile span{display:block;font-size:14px;font-weight:500;margin-top:6px;color:#e9edf6}',
'.demo-tile small{display:block;font-size:12px;color:#9aa5c4;margin-top:2px;min-height:14px}',
'.demo-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}',
'.demo-btn{pointer-events:auto;font-family:inherit;font-size:14px;font-weight:500;background:rgba(15,22,49,.9);color:#e9edf6;border:1px solid #2b3666;border-radius:4px;padding:9px 16px;cursor:pointer}',
'.demo-btn:hover{border-color:#22a690}',
'.demo-btn.demo-primary{background:#22a690;color:#08110f;border-color:#22a690}',
'.demo-btn:focus-visible,.demo-skip:focus-visible{outline:2px solid #22a690;outline-offset:1px}',
'.demo-narrow .demo-title h1{font-size:26px}',
'.demo-narrow .demo-title p{font-size:15px}',
'.demo-narrow .demo-cap{font-size:18px}',
'.demo-narrow .demo-end h2{font-size:22px}',
'.demo-narrow .demo-tile b{font-size:24px}',
'.demo-narrow .demo-panel{padding:20px 22px}',
].join('\n');

// ---------- module state ----------
let container = null, dom = null;
let active = false, cb = { onReplay:null, onExplore:null };
let elapsed = 0, lastT = -Infinity;
let beat = -1, curPhase = null, phaseStart = 0, skipped = false, warp = 1;
let pushedIdx = -1, beat7Start = -1, reenteredAt = -1, ended = false;
let view = 'fpv', cam = 'follow';
let capText = '', capShown = false, capSwapAt = -1, titleHideAt = -1;   // fades are driven from tick() (no timers)
let progPct = -1, progLabel = '', narrow = null;
const DEFAULT_DIR = { warp:1, paused:false, view:'orbit', cam:'earth' };

// ---------- DOM ----------
function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function init(cont){
  container = cont || null; if(!container) return;
  if(!document.getElementById('demo-style')){ const s = el('style'); s.id = 'demo-style'; s.textContent = CSS; document.head.appendChild(s); }
  const root = el('div', 'demo-root demo-hidden');
  const title = el('div', 'demo-panel demo-title'); title.appendChild(el('h1', null, TITLE)); title.appendChild(el('p', null, TITLE_SUB));
  const cap = el('div', 'demo-cap'); cap.style.display = 'none';
  const prog = el('div', 'demo-prog'); const progBar = el('i'); prog.appendChild(progBar);
  const plabel = el('div', 'demo-plabel', 'demo · 0:00');
  const skip = el('button', 'demo-skip', 'Skip demo'); skip.type = 'button'; skip.onclick = () => explore();
  const end = el('div', 'demo-panel demo-end'); end.style.display = 'none';
  end.appendChild(el('h2', null, END_LINE));
  const tiles = el('div', 'demo-tiles');
  const tileDefs = [['pushed down',''], ['fuel spent waiting',''], ['plane changes avoided','worth of fuel']];
  const tileVals = tileDefs.map(d => { const t = el('div', 'demo-tile'); const b = el('b', null, '—'); t.appendChild(b); t.appendChild(el('span', null, d[0])); t.appendChild(el('small', null, d[1])); tiles.appendChild(t); return b; });
  end.appendChild(tiles);
  const btns = el('div', 'demo-btns');
  const replay = el('button', 'demo-btn demo-primary', 'Replay'); replay.type = 'button';
  replay.onclick = () => { try { if(typeof cb.onReplay === 'function') cb.onReplay(); } catch(e){ if(SIM.demo.debug) console.error('[demo] onReplay threw', e); } };
  const exploreBtn = el('button', 'demo-btn', 'Explore the full sim'); exploreBtn.type = 'button'; exploreBtn.onclick = () => explore();
  btns.appendChild(replay); btns.appendChild(exploreBtn); end.appendChild(btns);
  root.appendChild(title); root.appendChild(cap); root.appendChild(prog); root.appendChild(plabel); root.appendChild(skip); root.appendChild(end);
  container.appendChild(root);
  dom = { root, title, cap, prog, progBar, plabel, skip, end, tileVals };
}
function explore(){ try { if(typeof cb.onExplore === 'function') cb.onExplore(); } catch(e){ if(SIM.demo.debug) console.error('[demo] onExplore threw', e); } stop(); }

// ---------- timeline ----------
function resetTimeline(){
  elapsed = 0; beat = -1; curPhase = null; phaseStart = 0; skipped = false; warp = 1;
  pushedIdx = -1; beat7Start = -1; reenteredAt = -1; ended = false; view = 'fpv'; cam = 'follow';
  capText = ''; capShown = false; capSwapAt = -1; titleHideAt = -1; progPct = -1; progLabel = '';
  if(dom){
    dom.title.style.display = ''; dom.title.classList.remove('demo-fade');
    dom.cap.style.display = 'none'; dom.cap.classList.remove('demo-fade'); dom.cap.textContent = '';
    dom.end.style.display = 'none'; dom.skip.style.display = ''; dom.prog.style.display = ''; dom.plabel.style.display = '';
    dom.progBar.style.width = '0%'; dom.plabel.textContent = 'demo · 0:00';
  }
}
function start(opts){
  cb = { onReplay: (opts && opts.onReplay) || null, onExplore: (opts && opts.onExplore) || null };
  resetTimeline(); lastT = -Infinity; active = true;
  if(dom) dom.root.classList.remove('demo-hidden');
}
function stop(){
  active = false; ended = false; capSwapAt = -1; titleHideAt = -1;
  if(dom) dom.root.classList.add('demo-hidden');
}

function enterPhase(state, phase){
  curPhase = phase; phaseStart = elapsed; skipped = false;
  const b = BEAT_OF[phase]; const nb = Math.max(beat, b === undefined ? 7 : b);
  if(nb >= 7){ warp = DECAY_WARP; return; }
  const budget = BUDGET[phase];
  const dur = phase === 'wait' ? (state.wait && state.wait.eta) : state.phaseDur;
  if(typeof budget === 'number' && typeof dur === 'number' && isFinite(dur) && dur > 0) warp = Math.max(1, dur / budget);
  else warp = DECAY_WARP;
}
function setBeat(b, state){
  beat = b; const B = BEATS[b] || BEATS[7]; view = B.view; cam = B.cam;
  if(SIM.demo.debug) console.log('[demo] beat', b, state && state.phase, 'elapsed', elapsed.toFixed(2));
  if(b === 7){ beat7Start = elapsed; reenteredAt = -1; }
  if(dom){
    if(b >= 1 && dom.title.style.display !== 'none' && !dom.title.classList.contains('demo-fade')){
      dom.title.classList.add('demo-fade'); titleHideAt = elapsed + 0.45;   // 400 ms CSS fade, then display:none
    }
    setCaption(B.caption);
  }
}
function setCaption(text){
  if(!dom) return;
  if(!text){ // hide
    if(capShown){ capShown = false; capText = ''; dom.cap.style.display = 'none'; dom.cap.classList.remove('demo-fade'); }
    capSwapAt = -1;
    return;
  }
  if(text === capText && capShown) return;
  if(!capShown){ capText = text; capShown = true; dom.cap.textContent = text; dom.cap.classList.remove('demo-fade'); dom.cap.style.display = ''; return; }
  // cross-fade: out 200 ms, swap text (in updateOverlay), in 200 ms
  capText = text; dom.cap.classList.add('demo-fade'); capSwapAt = elapsed + 0.2;
}
function showEnd(state){
  ended = true; setBeat(8, state);
  if(!dom) return;
  const sh = (state && state.shepherd) || {};
  const done = sh.targetsDone != null ? sh.targetsDone : 0;
  const saved = (sh.dvSavedByWaiting || 0) / 1000;
  dom.tileVals[0].textContent = String(done);
  dom.tileVals[1].textContent = '0 kg';
  dom.tileVals[2].textContent = saved.toFixed(1) + ' km/s';
  dom.cap.style.display = 'none'; capShown = false; capText = '';
  dom.prog.style.display = 'none'; dom.plabel.style.display = 'none'; dom.skip.style.display = 'none';
  dom.end.style.display = '';
}
function updateOverlay(){
  if(!dom) return;
  if(capSwapAt >= 0 && elapsed >= capSwapAt){ capSwapAt = -1; dom.cap.textContent = capText; dom.cap.classList.remove('demo-fade'); }
  if(titleHideAt >= 0 && elapsed >= titleHideAt){ titleHideAt = -1; dom.title.style.display = 'none'; }
  if(ended) return;
  const f = Math.min(1, elapsed / TOTAL); const pct = Math.round(f * 500) / 5;   // 0.2 % steps
  if(pct !== progPct){ progPct = pct; dom.progBar.style.width = pct + '%'; }
  const s = Math.floor(elapsed); const lab = 'demo · ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  if(lab !== progLabel){ progLabel = lab; dom.plabel.textContent = lab; }
  const w = container ? container.clientWidth : 0; const nw = w > 0 && w < 760;
  if(nw !== narrow){ narrow = nw; dom.root.classList.toggle('demo-narrow', nw); }
}
function tickInner(state, realDt){
  if(!active || !state) return DEFAULT_DIR;
  let dt = +realDt; if(!(dt >= 0)) dt = 0; if(dt > 0.25) dt = 0.25;
  if(typeof state.t === 'number'){ if(state.t < lastT - 1e-6) resetTimeline(); lastT = state.t; }
  if(!ended) elapsed += dt;
  const phase = state.phase;
  if(phase !== curPhase) enterPhase(state, phase);
  if(!ended){
    const b = BEAT_OF[phase]; const nb = b === undefined ? 7 : b;
    if(nb > beat) setBeat(nb, state);
    if(phase === 'push' && pushedIdx < 0 && typeof state.current === 'number' && state.current >= 0) pushedIdx = state.current;
    if(beat < 7){
      // Land the end of the wait on a frame boundary: the host sub-steps a whole frame at the wait's 0.5-day granularity,
      // so without this the 50-minute climb (beat 3) would be swallowed by the same frame that ends the wait.
      if(phase === 'wait' && state.wait && state.regime === 'LEO' && dt > 0){
        const W = state.wait; const eta = W.eta, gap = W.gapDeg;
        if(typeof eta === 'number' && isFinite(eta) && eta > 0 && typeof gap === 'number' && gap > 0.35){
          const rem = eta * (1 - 0.35 / gap);                    // sim seconds until mission.js's 0.35 deg threshold
          if(rem < warp * dt) warp = Math.max(1, (rem + 90) / dt); // overshoot by 90 s so the threshold is crossed this frame
        }
      }
      const budget = BUDGET[phase];
      if(typeof budget === 'number' && !skipped){
        const inPhase = elapsed - phaseStart;
        if(inPhase > budget + GRACE || inPhase > budget * 1.25){
          skipped = true;
          if(SIM.demo.debug) console.log('[demo] skipPhase', phase, 'after', inPhase.toFixed(2), 's (budget', budget + ')');
          if(SIM.mission && typeof SIM.mission.skipPhase === 'function') SIM.mission.skipPhase();
        }
      }
    } else {
      const tgt = pushedIdx >= 0 && state.targets ? state.targets[pushedIdx] : null;
      if(tgt && tgt.status === 'reentered' && reenteredAt < 0){ reenteredAt = elapsed; if(SIM.demo.debug) console.log('[demo] pushed target reentered at', elapsed.toFixed(2)); }
      if((reenteredAt >= 0 && elapsed - reenteredAt >= REENTRY_HOLD) || elapsed - beat7Start >= DECAY_MAX) showEnd(state);
    }
  }
  updateOverlay();
  return { warp: ended ? 0 : warp, paused: ended, view, cam };
}
let lastDir = DEFAULT_DIR;
function tick(state, realDt){
  try { lastDir = tickInner(state, realDt); }
  catch(e){ if(SIM.demo && SIM.demo.debug) console.error('[demo] tick failed', e); }
  return lastDir;
}

SIM.demo = { init, start, stop, get active(){ return active; }, tick, debug:false };
})();
