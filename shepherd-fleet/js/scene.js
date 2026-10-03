/* js/scene.js — Shepherd Fleet: orbit-scale 3D view (Agent A)
 *
 * Exposes window.SIM.scene = { init, update, render, resize, setVisible, setCameraMode, setUserOrbit, setLabels }
 * Requires global THREE (0.160.0 UMD) and SIM.phys. 1 scene unit = 1000 km, Earth axis = scene +Y.
 * No requestAnimationFrame loop here: app.js calls update(state, realDt) then render().
 */
(function () {
  'use strict';
  window.SIM = window.SIM || {};

  // ------------------------------------------------------------------ constants
  const COL = {
    bg: '#0b1128',
    idle: '#8b95b5', targeted: '#f2b955', pushing: '#f2b955', released: '#ff9a5c', decaying: '#ff9a5c',
    kitted: '#c792ff', kitwait: '#c792ff', kitburn: '#c792ff', reentered: '#ffffff',
    graveyard: '#3ecfb5', skipped: '#ff6f6f',
    shepherd: '#3ee6d0', cluster: '#7d8fc9', geo: '#5b8def', grave: '#3ecfb5', drift: '#c792ff',
    launch: '#ffd27a', site: '#ffd27a', spoua: '#3ecfb5', reentryBad: '#ff4d4d', reentryGood: '#3ecfb5',
    plume: '#ffb060'
  };
  const LAUNCH_PHASES = { prelaunch: 1, ascent: 1, parking: 1, transfer: 1, insert: 1 };
  const SPOUA = { lat: -48, lon: -123, rLat: 17, rLon: 40 }; // deg, ellipse semi-axes
  const CURVE_N = 180;
  const LAUNCH_MAX = 4096;
  const LABEL_PX = 12;            // font px equivalent
  const LABEL_MAX_W = 1.6;        // world width cap at close range (spec)
  const DEG = 180 / Math.PI;

  // ------------------------------------------------------------------ module state
  const S = {
    ready: false, visible: true, container: null, renderer: null, scene: null, camera: null,
    w: 1, h: 1, tanHalf: Math.tan(22.5 * Math.PI / 180),
    earth: null, earthGroup: null, siteMarker: null, siteLabel: null, spouaLabel: null, siteKey: '',
    stars: null,
    targets: new Map(),      // id -> rec
    shep: null,
    launch: null,
    wait: null,
    rings: null,
    labelsOn: true,
    labels: [],              // every label object ever made (for setLabels)
    fx: [],                  // transient reentry effects
    surfaceRings: [],
    regime: 'LEO',
    phase: '',
    cam: null,
    userOrbit: true,
    clusterSig: null,
    sphereGeom: null,
    xTex: null, plumeTex: null, flashTex: null,
    tmp: { v1: null, v2: null, v3: null, v4: null, q: null }
  };

  // ------------------------------------------------------------------ small helpers
  const TWO_PI = 2 * Math.PI;
  // wrapped difference a-b in (-π, π]; modulo arithmetic only (no loops), non-finite input -> 0
  function angDiff(a, b) {
    const d = a - b;
    if (!isFinite(d)) return 0;
    return ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  }
  function wrapDeg180(d) { if (!isFinite(d)) return 0; return ((d + 180) % 360 + 360) % 360 - 180; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function finiteEl(el) { return !!el && isFinite(el.a) && isFinite(el.e) && isFinite(el.i) && isFinite(el.raan) && isFinite(el.argp) && el.a > 0 && el.e >= 0 && el.e < 1; }
  function finiteVec(v) { return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z); }
  function fmtKm(x) { // "35 786"
    const n = Math.round(Math.abs(x));
    const s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (x < 0 ? '−' : '') + s;
  }
  function inSPOUA(latDeg, lonDeg) {
    if (!isFinite(latDeg) || !isFinite(lonDeg)) return false;
    const dl = wrapDeg180(lonDeg - SPOUA.lon);
    const a = (latDeg - SPOUA.lat) / SPOUA.rLat, b = dl / SPOUA.rLon;
    return a * a + b * b <= 1;
  }
  function sceneVec(p, out) { // ECI km -> scene, into an existing vector (true scale, no exaggeration)
    const v = SIM.phys.toScene(p);
    out.copy(v);
    return out;
  }
  // GEO drawing-only radial exaggeration about R_GEO: r_draw = R_GEO + (r - R_GEO)*30 within ±GEO_BAND km of GEO,
  // continued piecewise-linearly (monotonic, continuous) outside so GTO/launch positions still map sensibly.
  const GEO_EXAG = 30, GEO_BAND = 400;
  function radialMap(r) {
    if (S.regime !== 'GEO' || !isFinite(r)) return r;
    const P = SIM.phys, G = P.GEO_R, RE = P.RE, d = r - G, B = GEO_BAND * GEO_EXAG;
    if (Math.abs(d) <= GEO_BAND) return G + d * GEO_EXAG;
    if (d > GEO_BAND) return G + B + (d - GEO_BAND);
    const k = (G - B - RE) / (G - GEO_BAND - RE);      // compress [RE, G-band] onto [RE, G-30*band]
    return RE + Math.max(0, r - RE) * k;
  }
  function drawVec(p, out) { // ECI km -> scene units with the GEO exaggeration applied (every object position/curve)
    const v = SIM.phys.toScene(p);
    if (S.regime === 'GEO') {
      const r = Math.hypot(p.x, p.y, p.z);
      if (r > 1e-6) v.multiplyScalar(radialMap(r) / r);
    }
    out.copy(v);
    return out;
  }
  function planeNormalScene(i, raan, out) { // orbit-plane normal (ECI h-hat) mapped to scene axes
    const nx = Math.sin(i) * Math.sin(raan), ny = -Math.sin(i) * Math.cos(raan), nz = Math.cos(i);
    out.set(nx, nz, -ny);
    return out;
  }

  // ------------------------------------------------------------------ procedural textures
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeEarthTexture() {
    const W = 2048, H = 1024;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = lon => (lon + 180) / 360 * W;
    const Y = lat => (90 - lat) / 180 * H;

    // oceans
    const og = g.createLinearGradient(0, 0, 0, H);
    og.addColorStop(0, '#173f6e'); og.addColorStop(0.5, '#1d5288'); og.addColorStop(1, '#173f6e');
    g.fillStyle = og; g.fillRect(0, 0, W, H);
    const rnd = mulberry(1337);
    for (let k = 0; k < 900; k++) { // ocean mottling
      g.fillStyle = 'rgba(40,110,170,' + (0.05 + rnd() * 0.08).toFixed(3) + ')';
      const r = 10 + rnd() * 50;
      g.beginPath(); g.ellipse(rnd() * W, rnd() * H, r * 1.6, r, rnd() * 3, 0, 6.283); g.fill();
    }

    // land blobs: rough continents  [lonCentre, latCentre, rxDeg, ryDeg, rotation]
    const blobs = [
      [-100, 45, 32, 22, -0.3], [-110, 62, 28, 10, 0.2], [-85, 20, 12, 9, 0.6],     // North America
      [-60, -15, 16, 24, 0.15], [-70, -40, 6, 14, 0.1],                             // South America
      [20, 10, 22, 26, 0.0], [25, -15, 16, 16, 0.0], [35, 30, 12, 6, 0.0],          // Africa
      [30, 55, 40, 16, 0.0], [90, 55, 55, 18, 0.0], [110, 35, 22, 14, 0.0],         // Eurasia
      [75, 22, 10, 12, 0.3], [-5, 45, 12, 8, 0.0], [45, 25, 12, 10, 0.4],           // India, Europe, Arabia
      [134, -25, 18, 12, 0.0], [-42, 72, 10, 8, 0.0], [105, 0, 16, 6, 0.3]          // Australia, Greenland, SE Asia
    ];
    const rnd2 = mulberry(4242);
    for (const b of blobs) {
      const [lo, la, rx, ry, rot] = b;
      for (let k = 0; k < 90; k++) {
        const ang = rnd2() * 6.283, rr = Math.sqrt(rnd2());
        const dx = Math.cos(ang) * rr * rx, dy = Math.sin(ang) * rr * ry;
        const lon = lo + dx * Math.cos(rot) - dy * Math.sin(rot);
        const lat = la + dx * Math.sin(rot) + dy * Math.cos(rot);
        const green = 0.35 + 0.5 * Math.max(0, 1 - Math.abs(lat) / 60);
        const r = Math.round(90 + 70 * (1 - green)), gg = Math.round(90 + 70 * green), bb = Math.round(50 + 30 * (1 - green));
        g.fillStyle = 'rgba(' + r + ',' + gg + ',' + bb + ',0.9)';
        const rad = (rx + ry) * 0.045 * (0.6 + rnd2() * 0.8);
        g.beginPath(); g.ellipse(X(lon), Y(lat), rad * W / 360 * 1.0, rad * H / 180 * 1.0, 0, 0, 6.283); g.fill();
      }
    }

    // polar caps
    for (const s of [1, -1]) {
      const y0 = Y(s * 90), y1 = Y(s * 66);
      const pg = g.createLinearGradient(0, y0, 0, y1);
      pg.addColorStop(0, 'rgba(235,242,250,1)'); pg.addColorStop(0.7, 'rgba(225,235,245,0.85)'); pg.addColorStop(1, 'rgba(225,235,245,0)');
      g.fillStyle = pg; g.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
    }

    // graticule (subtle)
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 30) { g.beginPath(); g.moveTo(X(lon), 0); g.lineTo(X(lon), H); g.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { g.beginPath(); g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke();

    // SPOUA patch: hatched teal ellipse centred 48S 123W
    const cx = X(SPOUA.lon), cy = Y(SPOUA.lat), rx = SPOUA.rLon / 360 * W, ry = SPOUA.rLat / 180 * H;
    g.save();
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 6.283); g.clip();
    g.fillStyle = 'rgba(62,207,181,0.18)'; g.fillRect(cx - rx, cy - ry, 2 * rx, 2 * ry);
    g.strokeStyle = 'rgba(62,207,181,0.45)'; g.lineWidth = 2;
    for (let x = cx - rx - ry; x < cx + rx + ry; x += 22) { g.beginPath(); g.moveTo(x, cy - ry); g.lineTo(x + ry, cy + ry); g.stroke(); }
    g.restore();
    g.setLineDash([12, 8]); g.strokeStyle = '#3ecfb5'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 6.283); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#3ecfb5'; g.font = 'bold 34px "Fira Code", Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SPOUA', cx, cy);
    g.font = '20px "Fira Code", Consolas, monospace'; g.fillStyle = 'rgba(62,207,181,0.85)';
    g.fillText('uninhabited area · 48°S 123°W', cx, cy + 32);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }
  function makeRadialTex(inner, outer, size) {
    const c = document.createElement('canvas'); c.width = c.height = size || 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width / 2);
    grd.addColorStop(0, inner); grd.addColorStop(0.35, inner); grd.addColorStop(1, outer);
    g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // ------------------------------------------------------------------ object icons (fixed pixel size sprites)
  const ICON_DPR = 2;
  const ICON_PX = { shepherd: 34, rocketbody: 24, comsat: 26, smallsat: 18, rocket: 28 };
  const iconCache = new Map(); // key -> { tex, px }
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // Every icon is drawn pointing +X (screen right) inside a box of `px` CSS pixels; the canvas has a margin for glow.
  function drawIcon(g, kind, px, color, opts) {
    const s = px, lw = Math.max(1.6, px * 0.075);
    const body = '#141b38', fill = hexToRgba(color, 0.42);
    g.lineWidth = lw; g.strokeStyle = color; g.lineJoin = 'round'; g.lineCap = 'round';
    const rect = (x, y, w, h) => { g.beginPath(); g.rect(x * s, y * s, w * s, h * s); g.fillStyle = body; g.fill(); g.fillStyle = fill; g.fill(); g.stroke(); };
    const poly = (pts) => { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0] * s, p[1] * s) : g.moveTo(p[0] * s, p[1] * s)); g.closePath(); g.fillStyle = body; g.fill(); g.fillStyle = fill; g.fill(); g.stroke(); };
    const line = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0 * s, y0 * s); g.lineTo(x1 * s, y1 * s); g.stroke(); };
    const kitBox = (x, y, w, h) => { g.fillStyle = COL.plume; g.strokeStyle = '#ffd9a8'; g.beginPath(); g.rect(x * s, y * s, w * s, h * s); g.fill(); g.stroke(); g.strokeStyle = color; };
    if (kind === 'rocketbody') {
      // cylinder body, nozzle bell at -X (left), adapter ring at +X (right)
      rect(0.28, 0.33, 0.5, 0.34);
      poly([[0.28, 0.4], [0.16, 0.34], [0.08, 0.24], [0.08, 0.76], [0.16, 0.66], [0.28, 0.6]]);
      rect(0.78, 0.4, 0.12, 0.2);
      g.globalAlpha = 0.55; line(0.4, 0.33, 0.4, 0.67); line(0.62, 0.33, 0.62, 0.67); g.globalAlpha = 1;
      if (opts.kit) kitBox(0.02, 0.41, 0.14, 0.18);
    } else if (kind === 'comsat') {
      // two wide wings, bus, dish
      rect(0.02, 0.4, 0.34, 0.2); rect(0.64, 0.4, 0.34, 0.2);
      g.globalAlpha = 0.6; line(0.13, 0.4, 0.13, 0.6); line(0.24, 0.4, 0.24, 0.6); line(0.75, 0.4, 0.75, 0.6); line(0.86, 0.4, 0.86, 0.6); g.globalAlpha = 1;
      rect(0.38, 0.34, 0.24, 0.32);
      g.beginPath(); g.arc(0.5 * s, 0.2 * s, 0.14 * s, 0.15 * Math.PI, 0.85 * Math.PI, false); g.fillStyle = fill; g.fill(); g.stroke();
      line(0.5, 0.26, 0.5, 0.34);
      if (opts.kit) kitBox(0.42, 0.68, 0.16, 0.14);
    } else if (kind === 'smallsat') {
      rect(0.05, 0.4, 0.36, 0.2);
      g.globalAlpha = 0.6; line(0.17, 0.4, 0.17, 0.6); line(0.29, 0.4, 0.29, 0.6); g.globalAlpha = 1;
      rect(0.46, 0.3, 0.4, 0.4);
      if (opts.kit) kitBox(0.86, 0.42, 0.12, 0.16);
    } else if (kind === 'shepherd') {
      if (opts.push) { // glowing beam wedge ahead of the nozzle (+X)
        const gr = g.createLinearGradient(0.7 * s, 0, 1.0 * s, 0);
        gr.addColorStop(0, 'rgba(169,196,234,0.8)'); gr.addColorStop(1, 'rgba(169,196,234,0)');
        g.fillStyle = gr; g.beginPath(); g.moveTo(0.72 * s, 0.5 * s); g.lineTo(1.0 * s, 0.2 * s); g.lineTo(1.0 * s, 0.8 * s); g.closePath(); g.fill();
      }
      // solar wings up/down, bus, beam nozzle at +X, counter thruster at -X, lidar head
      rect(0.42, 0.02, 0.16, 0.3); rect(0.42, 0.68, 0.16, 0.3);
      g.globalAlpha = 0.6; line(0.42, 0.12, 0.58, 0.12); line(0.42, 0.22, 0.58, 0.22); line(0.42, 0.78, 0.58, 0.78); line(0.42, 0.88, 0.58, 0.88); g.globalAlpha = 1;
      rect(0.34, 0.34, 0.32, 0.32);
      poly([[0.66, 0.43], [0.76, 0.36], [0.76, 0.64], [0.66, 0.57]]);
      poly([[0.34, 0.45], [0.26, 0.41], [0.26, 0.59], [0.34, 0.55]]);
      g.fillStyle = color; g.beginPath(); g.arc(0.5 * s, 0.5 * s, 0.05 * s, 0, 6.283); g.fill();
    } else if (kind === 'rocket') {
      // launcher pointing +X with flame at -X
      const fg = g.createLinearGradient(0.0 * s, 0, 0.3 * s, 0);
      fg.addColorStop(0, 'rgba(255,120,40,0)'); fg.addColorStop(0.5, 'rgba(255,170,70,0.9)'); fg.addColorStop(1, 'rgba(255,240,200,1)');
      g.fillStyle = fg; g.beginPath(); g.moveTo(0.3 * s, 0.38 * s); g.lineTo(0.0 * s, 0.5 * s); g.lineTo(0.3 * s, 0.62 * s); g.closePath(); g.fill();
      poly([[0.3, 0.36], [0.72, 0.36], [0.96, 0.5], [0.72, 0.64], [0.3, 0.64]]);
      poly([[0.3, 0.36], [0.24, 0.22], [0.42, 0.36]]); poly([[0.3, 0.64], [0.24, 0.78], [0.42, 0.64]]);
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.rect(0.72 * s, 0.44 * s, 0.1 * s, 0.12 * s); g.fill();
    }
    if (opts.skipped) { // X overlay
      g.strokeStyle = COL.skipped; g.lineWidth = lw * 1.4;
      line(0.2, 0.2, 0.8, 0.8); line(0.8, 0.2, 0.2, 0.8);
    }
  }
  function iconTexture(kind, color, opts) {
    opts = opts || {};
    const key = kind + '|' + color + '|' + (opts.kit ? 'k' : '') + (opts.push ? 'p' : '') + (opts.skipped ? 'x' : '');
    let e = iconCache.get(key);
    if (e) return e;
    const px = ICON_PX[kind] || 24;
    const margin = Math.ceil(px * 0.25);
    const ext = px + 2 * margin;
    const c = document.createElement('canvas');
    c.width = c.height = ext * ICON_DPR;
    const g = c.getContext('2d');
    g.setTransform(ICON_DPR, 0, 0, ICON_DPR, margin * ICON_DPR, margin * ICON_DPR);
    g.shadowColor = hexToRgba(color, 0.7); g.shadowBlur = px * 0.18;
    drawIcon(g, kind, px, color, opts);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    e = { tex, px: ext };
    iconCache.set(key, e);
    return e;
  }
  function makeIconSprite(kind, color, opts) {
    const e = iconTexture(kind, color, opts);
    const mat = new THREE.SpriteMaterial({ map: e.tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 12;
    sp.userData.px = e.px;
    return sp;
  }
  function setIconSprite(sp, kind, color, opts) {
    const e = iconTexture(kind, color, opts);
    if (sp.material.map !== e.tex) { sp.material.map = e.tex; sp.material.needsUpdate = true; }
    sp.userData.px = e.px;
  }
  function makeRingTex(color) {
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const g = c.getContext('2d');
    g.strokeStyle = color; g.lineWidth = 5; g.shadowColor = color; g.shadowBlur = 8;
    g.beginPath(); g.arc(48, 48, 36, 0, 6.283); g.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // scale for sizeAttenuation:false sprites so `px` CSS pixels are covered regardless of zoom
  function applyPx(sp, px) { const k = S.pxScale; sp.scale.set(px * k, px * k, 1); }
  // screen-space heading (radians, CCW, +X right) of a world direction at a world point
  function screenHeading(pos, dir) {
    const a = S.tmp.v5.copy(pos).project(S.camera);
    const b = S.tmp.v6.copy(pos).addScaledVector(dir, 0.05).project(S.camera);
    return Math.atan2((b.y - a.y) * S.h, (b.x - a.x) * S.w);
  }

  // ------------------------------------------------------------------ labels (canvas sprites)
  function makeLabel(color, center) {
    const canvas = document.createElement('canvas');
    const mat = new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: true });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(center ? center[0] : 0, center ? center[1] : 0.5);
    sprite.renderOrder = 20;
    sprite.visible = false;
    const lbl = { sprite, mat, tex: null, canvas, text: '', color: color, pxW: 1, pxH: 1, on: false, nextAt: 0, prio: 3, sx: 0, sy: 0, sd: 1 };
    S.labels.push(lbl);
    return lbl;
  }
  function setLabelText(lbl, text, color) {
    color = color || lbl.color;
    if (text === lbl.text && color === lbl.color && lbl.tex) return;   // cached by string: no redraw
    const now = performance.now();
    if (lbl.tex && now < lbl.nextAt) return;                          // fast-changing text: redraw at most 4 Hz
    lbl.nextAt = now + 250;
    lbl.text = text; lbl.color = color;
    const c = lbl.canvas, DPR = 2, pad = 7;
    const g = c.getContext('2d');
    const font = '500 ' + LABEL_PX + 'px "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace';
    g.font = font;
    const tw = Math.ceil(g.measureText(text).width);
    const w = tw + pad * 2, h = LABEL_PX + 10;
    const needNew = c.width !== w * DPR || c.height !== h * DPR;
    if (needNew) { c.width = w * DPR; c.height = h * DPR; }
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(11,17,40,0.62)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0.5, 0.5, w - 1, h - 1, 4); else g.rect(0.5, 0.5, w - 1, h - 1);
    g.fill();
    g.font = font; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = color;
    g.fillText(text, pad, h / 2 + 0.5);
    lbl.pxW = w; lbl.pxH = h;
    if (!lbl.tex || needNew) {
      if (lbl.tex) lbl.tex.dispose();
      lbl.tex = new THREE.CanvasTexture(c);
      lbl.tex.colorSpace = THREE.SRGBColorSpace;
      lbl.tex.minFilter = THREE.LinearFilter;
      lbl.mat.map = lbl.tex;
      lbl.mat.needsUpdate = true;
    } else {
      lbl.tex.needsUpdate = true;
    }
  }
  function showLabel(lbl, on) { lbl.on = on; lbl.sprite.visible = on && S.labelsOn; }
  // Put the label at the curve point that sits furthest toward camera-right.
  // Prefers the right-most curve point that is on screen (with room for the text); falls back to the
  // point furthest along the camera-right axis when the whole curve is off screen.
  function placeLabelOnCurve(lbl, rec, right, vp) {
    const a = rec.arr, n = rec.drawN || rec.n, e = vp.elements;
    let best = -Infinity, bi = -1, bestR = -Infinity, ri = 0;
    for (let i = 0; i < n; i++) {
      const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w > 0) {
        const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
        if (nx < 0.72 && nx > -0.98 && ny < 0.9 && ny > -0.9 && nx > best) { best = nx; bi = i; }
      }
      const d = x * right.x + y * right.y + z * right.z;
      if (d > bestR) { bestR = d; ri = i; }
    }
    if (bi < 0) bi = ri;
    lbl.sprite.position.set(a[3 * bi], a[3 * bi + 1], a[3 * bi + 2]);
  }
  // For equatorial reference rings (built with i=raan=argp=0): point k sits at ECI azimuth 2πk/n.
  function placeLabelAtAzimuth(R, az) {
    if (!R.label.on) return;
    const rec = R.curve, n = rec.drawN || rec.n;
    if (n < 1) return;
    const u = ((az % TWO_PI) + TWO_PI) % TWO_PI / TWO_PI;
    const k = Math.round(u * n) % n;
    R.label.sprite.position.set(rec.arr[3 * k], rec.arr[3 * k + 1], rec.arr[3 * k + 2]);
  }
  function sizeLabel(lbl, camPos) {
    const sp = lbl.sprite;
    const p = S.tmp.v4;
    sp.getWorldPosition(p);
    const d = p.distanceTo(camPos);
    // constant on-screen size; only capped at close range so labels never balloon
    let w = lbl.pxW * 2 * d * S.tanHalf / S.h;
    const cap = Math.max(LABEL_MAX_W, w * 0.999); // see report: strict 1.6 cap is unreadable at default distance
    w = Math.min(w, cap);
    const parentScale = sp.parent && sp.parent !== S.scene ? 1 : 1; // parents used here have unit scale
    sp.scale.set(w * parentScale, w * lbl.pxH / lbl.pxW * parentScale, 1);
  }

  // ------------------------------------------------------------------ curves
  function makeCurve(color, opacity, n) {
    n = n || CURVE_N;
    const arr = new Float32Array(n * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false });
    const line = new THREE.LineLoop(geom, mat);
    line.frustumCulled = false;
    return { line, geom, mat, arr, n, drawN: n, sig: null };
  }
  function fillCurveFromEl(rec, el) {
    const pts = SIM.phys.orbitPoints(el, rec.n);
    let m = Math.min(pts.length, rec.n);
    // drop a duplicated closing point if physics returns one
    if (pts.length > 1 && m === rec.n && pts.length > rec.n) { /* extra points ignored */ }
    const a = rec.arr;
    const v = S.tmp.v4;
    for (let i = 0; i < m; i++) {
      drawVec(pts[i], v);
      if (!finiteVec(v)) { m = 0; break; } // bad geometry from physics: draw nothing this rebuild
      a[3 * i] = v.x; a[3 * i + 1] = v.y; a[3 * i + 2] = v.z;
    }
    rec.drawN = m;
    rec.geom.setDrawRange(0, m);
    rec.geom.attributes.position.needsUpdate = true;
    if (!rec.sig) rec.sig = { a: 0, e: 0, i: 0, raan: 0, argp: 0, geo: false };
    rec.sig.a = el.a; rec.sig.e = el.e; rec.sig.i = el.i; rec.sig.raan = el.raan; rec.sig.argp = el.argp; rec.sig.geo = S.regime === 'GEO';
  }
  function curveStale(rec, el) {
    if (!finiteEl(el)) return false; // keep the last good curve; never rebuild from NaN/Infinity
    const s = rec.sig;
    if (!s || s.geo !== (S.regime === 'GEO')) return true;
    // rebuild only on material change: a by > 0.2 %, e by > 0.002, angles by > 2e-3 rad
    return Math.abs(el.a - s.a) > 0.002 * s.a || Math.abs(el.e - s.e) > 0.002 ||
      Math.abs(angDiff(el.i, s.i)) > 2e-3 || Math.abs(angDiff(el.raan, s.raan)) > 2e-3 ||
      Math.abs(angDiff(el.argp, s.argp)) > 2e-3;
  }
  function fillCircle(rec, rKm, iRad, raanRad) { // ring in a plane (used for GEO/graveyard/drift/cluster reference)
    const el = { a: rKm, e: 0, i: iRad, raan: raanRad, argp: 0, M: 0 };
    fillCurveFromEl(rec, el);
  }
  function disposeCurve(rec) { rec.geom.dispose(); rec.mat.dispose(); if (rec.line.parent) rec.line.parent.remove(rec.line); }

  // ------------------------------------------------------------------ init
  function init(container) {
    S.container = container;
    const T = THREE;
    S.tmp.v1 = new T.Vector3(); S.tmp.v2 = new T.Vector3(); S.tmp.v3 = new T.Vector3(); S.tmp.v4 = new T.Vector3();
    S.tmp.v5 = new T.Vector3(); S.tmp.v6 = new T.Vector3(); S.tmp.q = new T.Quaternion(); S.tmp.m = new T.Matrix4();

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(new T.Color(COL.bg), 1);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);
    S.renderer = renderer;

    const scene = new T.Scene();
    scene.background = new T.Color(COL.bg);
    S.scene = scene;

    const camera = new T.PerspectiveCamera(45, 1, 0.05, 6000);
    S.camera = camera;

    // lights: sun from +X
    const sun = new T.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(300, 0, 0);
    scene.add(sun);
    scene.add(new T.AmbientLight(0x6b7ba8, 0.35));

    // Earth
    const RE = SIM.phys.RE * 1e-3;
    S.earthGroup = new T.Group();
    scene.add(S.earthGroup);
    const earthMat = new T.MeshPhongMaterial({ map: makeEarthTexture(), specular: new T.Color(0x1a2a44), shininess: 12 });
    S.earth = new T.Mesh(new T.SphereGeometry(RE, 96, 64), earthMat);
    S.earthGroup.add(S.earth);
    // atmosphere: fresnel rim shell
    const atmoMat = new T.ShaderMaterial({
      uniforms: { col: { value: new T.Color(0x6fb2ff) } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 col; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0-abs(dot(vN,vV)); f = pow(f,3.2); gl_FragColor = vec4(col, f*0.9); }',
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.FrontSide
    });
    const atmo = new T.Mesh(new T.SphereGeometry(RE * 1.035, 64, 48), atmoMat);
    S.earthGroup.add(atmo);
    // SPOUA 3D label (child of earth so it rotates with the ground)
    S.spouaLabel = makeLabel(COL.spoua, [0.5, 0.5]);
    setLabelText(S.spouaLabel, 'SPOUA', COL.spoua);
    sceneVec(SIM.phys.latLonToEci(SPOUA.lat / DEG, SPOUA.lon / DEG, 120, 0), S.spouaLabel.sprite.position);
    S.earthGroup.add(S.spouaLabel.sprite);
    showLabel(S.spouaLabel, true);
    // launch site marker (position set from state)
    S.siteMarker = new T.Sprite(new T.SpriteMaterial({ map: makeRingTex(COL.site), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, color: COL.site }));
    S.siteMarker.renderOrder = 11;
    S.siteMarker.visible = false;
    S.earthGroup.add(S.siteMarker);
    S.siteLabel = makeLabel(COL.site, [0, 0.5]);
    S.earthGroup.add(S.siteLabel.sprite);

    // starfield
    (function () {
      const N = 3000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const rnd = mulberry(99);
      for (let i = 0; i < N; i++) {
        const u = rnd() * 2 - 1, ph = rnd() * 6.283, r = 2500 + rnd() * 800, s = Math.sqrt(1 - u * u);
        pos[3 * i] = r * s * Math.cos(ph); pos[3 * i + 1] = r * u; pos[3 * i + 2] = r * s * Math.sin(ph);
        const b = 0.35 + Math.pow(rnd(), 3) * 0.65, tint = rnd();
        col[3 * i] = b * (0.85 + 0.15 * tint); col[3 * i + 1] = b * (0.88 + 0.08 * tint); col[3 * i + 2] = b * (0.95 + 0.05 * (1 - tint));
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      const m = new T.PointsMaterial({ size: 1.8, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
      S.stars = new T.Points(g, m);
      S.stars.frustumCulled = false;
      scene.add(S.stars);
    })();

    // shared resources
    S.pxScale = 2 * S.tanHalf / 600;
    S.ringTex = makeRingTex(COL.targeted);
    S.plumeTex = makeRadialTex('rgba(255,190,110,1)', 'rgba(255,120,40,0)', 64);
    S.flashTex = makeRadialTex('rgba(255,255,255,1)', 'rgba(255,200,150,0)', 64);

    // shepherd
    {
      const curve = makeCurve(COL.shepherd, 0.9);
      scene.add(curve.line);
      const marker = makeIconSprite('shepherd', COL.shepherd);
      marker.renderOrder = 14;
      scene.add(marker);
      const tickArr = new Float32Array(6);
      const tickGeom = new T.BufferGeometry();
      tickGeom.setAttribute('position', new T.BufferAttribute(tickArr, 3));
      const tick = new T.Line(tickGeom, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
      tick.frustumCulled = false;
      scene.add(tick);
      const plume = new T.Sprite(new T.SpriteMaterial({ map: S.plumeTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.95 }));
      plume.scale.set(0.5, 0.5, 1); plume.visible = false;
      scene.add(plume);
      const label = makeLabel(COL.shepherd); label.prio = 0;
      scene.add(label.sprite);
      const ring = new T.Sprite(new T.SpriteMaterial({ map: S.ringTex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, color: COL.targeted }));
      ring.renderOrder = 11; ring.visible = false;
      scene.add(ring);
      S.curRing = ring;
      S.shep = { curve, marker, tick, tickArr, tickGeom, plume, label, velDir: new T.Vector3(1, 0, 0) };
    }

    // launch trail
    {
      const arr = new Float32Array(LAUNCH_MAX * 3);
      const geom = new T.BufferGeometry();
      geom.setAttribute('position', new T.BufferAttribute(arr, 3));
      geom.setDrawRange(0, 0);
      const line = new T.Line(geom, new T.LineBasicMaterial({ color: COL.launch, transparent: true, opacity: 1 }));
      line.frustumCulled = false; line.visible = false;
      scene.add(line);
      const rocket = makeIconSprite('rocket', COL.launch);
      rocket.visible = false;
      scene.add(rocket);
      S.launch = { arr, geom, line, rocket, count: 0, lastLen: -1, dir: new T.Vector3() };
    }

    // wait-phase aids
    {
      const edgeArr = new Float32Array(96 * 3);
      for (let i = 0; i < 96; i++) { const a = i / 96 * 2 * Math.PI; edgeArr[3 * i] = Math.cos(a); edgeArr[3 * i + 1] = Math.sin(a); edgeArr[3 * i + 2] = 0; }
      const mk = (color) => {
        const m = new T.Mesh(new T.CircleGeometry(1, 96), new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.13, side: T.DoubleSide, depthWrite: false }));
        m.visible = false; m.renderOrder = -1; scene.add(m);
        const eg = new T.BufferGeometry(); eg.setAttribute('position', new T.BufferAttribute(edgeArr, 3));
        const edge = new T.LineLoop(eg, new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5, depthWrite: false }));
        edge.frustumCulled = false; m.add(edge);
        return m;
      };
      const mkLine = (color) => {
        const arr = new Float32Array(6);
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(arr, 3));
        const l = new T.Line(g, new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.45 }));
        l.frustumCulled = false; l.visible = false; scene.add(l);
        return { line: l, arr, geom: g };
      };
      S.wait = { discShep: mk(COL.shepherd), discTgt: mk(COL.targeted), lineShep: mkLine(COL.shepherd), lineTgt: mkLine(COL.targeted) };
    }

    // reference rings
    {
      const mk = (color, opacity) => {
        const c = makeCurve(color, opacity);
        c.line.visible = false; scene.add(c.line);
        const l = makeLabel(color); l.prio = 1; scene.add(l.sprite);
        return { curve: c, label: l, key: '' };
      };
      S.rings = { geo: mk(COL.geo, 0.5), grave: mk(COL.grave, 0.35), drift: mk(COL.drift, 0.35), cluster: mk(COL.cluster, 0.45) };
    }

    // camera state
    S.cam = {
      mode: 'earth', userMode: 'earth', launchAuto: false,
      theta: 0.65, phi: 0.32, dist: 4.5 * RE, distSet: false,
      pos: new T.Vector3(0, 12, 28), focus: new T.Vector3(), up: new T.Vector3(0, 1, 0),
      tPos: new T.Vector3(0, 12, 28), tFocus: new T.Vector3(), tUp: new T.Vector3(0, 1, 0),
      basis: new T.Matrix4(), snap: true
    };
    camera.position.copy(S.cam.pos);
    camera.lookAt(0, 0, 0);

    installMouse(renderer.domElement);
    S.ready = true;
    resize();
  }

  // ------------------------------------------------------------------ mouse orbit / zoom (hand-rolled)
  function installMouse(el) {
    let dragging = false, lx = 0, ly = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (!S.userOrbit) return;
      dragging = true; lx = e.clientX; ly = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || !S.userOrbit) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      S.cam.theta -= dx * 0.0055;
      S.cam.phi = clamp(S.cam.phi + dy * 0.0055, -1.45, 1.45);
    });
    const end = (e) => { dragging = false; try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!S.userOrbit) return;
      e.preventDefault();
      const f = Math.exp(clamp(e.deltaY, -200, 200) * 0.0016);
      S.cam.dist = clamp(S.cam.dist * f, 0.6, 900);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------------ target records
  function makeTargetRec(t) {
    const T = THREE;
    const curve = makeCurve(COL.idle, 0.3);
    S.scene.add(curve.line);
    const kind = ICON_PX[t.kind] ? t.kind : 'rocketbody';
    const marker = makeIconSprite(kind, COL.idle);
    S.scene.add(marker);
    return {
      id: t.id, kind, curve, marker, mat: marker.material, label: null, status: t.status, prevStatus: t.status,
      lastPos: new T.Vector3(), fade: -1, colorKey: '', iconKey: ''
    };
  }
  function disposeTargetRec(rec) {
    disposeCurve(rec.curve);
    S.scene.remove(rec.marker); rec.mat.dispose();
    if (rec.plume) { S.scene.remove(rec.plume); rec.plume.material.dispose(); }
    if (rec.label) { S.scene.remove(rec.label.sprite); if (rec.label.tex) rec.label.tex.dispose(); rec.label.mat.dispose(); const k = S.labels.indexOf(rec.label); if (k >= 0) S.labels.splice(k, 1); }
  }
  function statusColor(st) { return COL[st] || COL.idle; }

  // ------------------------------------------------------------------ reentry effects
  function spawnReentry(rec, tgt, state) {
    const T = THREE;
    const r = tgt.reentry || {};
    const latD = (r.lat || 0) * DEG, lonD = (r.lon || 0) * DEG;
    const controlled = !!tgt.kit || tgt.status === 'kitburn' || rec.prevStatus === 'kitburn' || rec.prevStatus === 'kitted' || rec.prevStatus === 'kitwait';
    const good = controlled && inSPOUA(latD, lonD);
    const color = good ? COL.reentryGood : COL.reentryBad;
    // surface point in the rotating (earth) frame and in the inertial frame now
    const surfNow = new T.Vector3();
    sceneVec(SIM.phys.latLonToEci(r.lat || 0, r.lon || 0, 40, state.earthRot || 0), surfNow);
    // streak
    const arr = new Float32Array(6);
    arr[0] = rec.lastPos.x; arr[1] = rec.lastPos.y; arr[2] = rec.lastPos.z;
    arr[3] = surfNow.x; arr[4] = surfNow.y; arr[5] = surfNow.z;
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(arr, 3));
    const m = new T.LineBasicMaterial({ color: color, transparent: true, opacity: 1 });
    const line = new T.Line(g, m); line.frustumCulled = false;
    S.scene.add(line);
    S.fx.push({ kind: 'streak', obj: line, geom: g, mat: m, t: 0, dur: 2.8 });
    // flash
    const fm = new T.SpriteMaterial({ map: S.flashTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, color: color });
    const fs = new T.Sprite(fm); fs.position.copy(surfNow); fs.scale.set(0.3, 0.3, 1);
    S.scene.add(fs);
    S.fx.push({ kind: 'flash', obj: fs, mat: fm, t: 0, dur: 1.4 });
    // persistent surface ring (child of earth so it stays on the ground)
    const ring = new T.Mesh(new T.RingGeometry(0.22, 0.3, 32), new T.MeshBasicMaterial({ color: color, side: T.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
    sceneVec(SIM.phys.latLonToEci(r.lat || 0, r.lon || 0, 12, 0), ring.position);
    ring.lookAt(0, 0, 0);
    S.earthGroup.add(ring);
    S.surfaceRings.push(ring);
  }
  function tickFx(dt) {
    for (let k = S.fx.length - 1; k >= 0; k--) {
      const f = S.fx[k];
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        S.scene.remove(f.obj);
        if (f.geom) f.geom.dispose();
        f.mat.dispose();
        S.fx.splice(k, 1);
        continue;
      }
      if (f.kind === 'streak') f.mat.opacity = 1 - u;
      else { const s = 0.3 + 1.6 * Math.sin(Math.min(1, u * 1.6) * Math.PI); f.obj.scale.set(s, s, 1); f.mat.opacity = 1 - u * u; }
    }
  }

  // ------------------------------------------------------------------ update
  function update(state, realDt) {
    if (!S.ready || !state) return;
    const dt = clamp(realDt || 0.016, 0, 0.1);
    const T = THREE, P = SIM.phys, RE = P.RE;
    const v1 = S.tmp.v1, v2 = S.tmp.v2, v3 = S.tmp.v3;
    S.regime = state.regime === 'GEO' ? 'GEO' : 'LEO';
    const isGEO = S.regime === 'GEO';
    const phase = state.phase || '';
    const inLaunch = !!LAUNCH_PHASES[phase];
    const earthRot = state.earthRot || 0;

    // --- Earth
    S.earthGroup.rotation.y = earthRot;
    const site = state.launch && state.launch.site;
    if (S.siteMarker.visible) applyPx(S.siteMarker, 16);
    if (site) {
      const key = site.lat + ',' + site.lon + ',' + (site.name || '');
      if (key !== S.siteKey) {
        S.siteKey = key;
        sceneVec(P.latLonToEci(site.lat, site.lon, 5, 0), S.siteMarker.position);
        S.siteMarker.visible = true;
        sceneVec(P.latLonToEci(site.lat, site.lon, 140, 0), S.siteLabel.sprite.position);
        setLabelText(S.siteLabel, site.name || 'launch site', COL.site);
        showLabel(S.siteLabel, true);
      }
    }

    // --- shepherd
    const sh = state.shepherd;
    let shepPos = null;
    if (sh && sh.el) {
      if (curveStale(S.shep.curve, sh.el)) fillCurveFromEl(S.shep.curve, sh.el);
      const pos = sh.pos || P.posFromEl(sh.el);
      shepPos = drawVec(pos, v1);
      if (!finiteVec(shepPos)) shepPos.copy(S.shep.marker.position); // hold last good position
      S.shep.marker.position.copy(shepPos);
      S.shep.marker.visible = !inLaunch || phase === 'insert';
      // velocity tick
      let vel = sh.vel;
      if (vel) { sceneVec(vel, v2); } else { v2.set(0, 1, 0).cross(shepPos); }
      if (v2.lengthSq() > 1e-12) v2.normalize(); else v2.set(1, 0, 0);
      S.shep.velDir.copy(v2);
      const a = S.shep.tickArr;
      a[0] = shepPos.x; a[1] = shepPos.y; a[2] = shepPos.z;
      a[3] = shepPos.x + v2.x * 0.55; a[4] = shepPos.y + v2.y * 0.55; a[5] = shepPos.z + v2.z * 0.55;
      S.shep.tickGeom.attributes.position.needsUpdate = true;
      S.shep.tick.visible = S.shep.marker.visible;
      // plume during push (+ icon variant with beam wedge)
      const pushing = phase === 'push' || (state.prox && state.prox.active && state.prox.beamOn && phase !== 'standoff');
      setIconSprite(S.shep.marker, 'shepherd', COL.shepherd, pushing ? { push: true } : null);
      S.shep.plume.visible = !!pushing;
      if (pushing) {
        S.shep.plume.position.copy(shepPos).addScaledVector(v2, -0.18);
        const s = 0.42 + 0.08 * Math.sin(state.t * 7);
        S.shep.plume.scale.set(s, s, 1);
      }
      // label
      let txt;
      if (isGEO) {
        const dh = sh.el.a - P.GEO_R;
        txt = 'shepherd · GEO ' + (dh < 0 ? '−' : '+') + fmtKm(Math.abs(dh)) + ' km drift';
      } else {
        txt = 'shepherd · ' + fmtKm(sh.el.a - RE) + ' km · i ' + (sh.el.i * DEG).toFixed(1) + '°';
      }
      setLabelText(S.shep.label, txt, COL.shepherd);
      showLabel(S.shep.label, true);
      S.shep.curve.line.visible = true;
    } else {
      S.shep.marker.visible = false; S.shep.tick.visible = false; S.shep.plume.visible = false; S.shep.curve.line.visible = false;
      showLabel(S.shep.label, false);
    }

    // --- targets
    const targets = state.targets || [];
    let maxMass = 1;
    for (let i = 0; i < targets.length; i++) if (targets[i].mass > maxMass) maxMass = targets[i].mass;
    const seen = S.tmp.seen || (S.tmp.seen = new Set());
    seen.clear();
    const cur = typeof state.current === 'number' ? state.current : -1;
    const kitBurnTarget = (state.prox && state.prox.kitBurn) ? cur : -1;
    let raanSx = 0, raanSy = 0, aSum = 0, iSum = 0, nCl = 0;
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k];
      if (!t || !t.el) continue;
      const id = t.id != null ? t.id : k;
      seen.add(id);
      let rec = S.targets.get(id);
      if (!rec) { rec = makeTargetRec(t); S.targets.set(id, rec); }
      const st = t.status || 'idle';
      // status transition bookkeeping
      if (st !== rec.status) {
        rec.prevStatus = rec.status; rec.status = st;
        if (st === 'reentered') { rec.fade = 0; spawnReentry(rec, t, state); }
        else if (rec.fade >= 0) { rec.fade = -1; rec.marker.visible = true; rec.mat.opacity = 1; }
        rec.colorKey = '';
      }
      // orbit curve
      const isReentered = st === 'reentered';
      if (!isReentered && curveStale(rec.curve, t.el)) fillCurveFromEl(rec.curve, t.el);
      const isCur = k === cur;
      const isDecaying = st === 'decaying' || st === 'released';
      const col = statusColor(st);
      const ckey = col + (isCur ? '!' : '');
      if (ckey !== rec.colorKey) {
        rec.colorKey = ckey;
        rec.curve.mat.color.set(col);
        rec.curve.mat.opacity = isCur ? 0.75 : (st === 'idle' ? 0.22 : 0.4);
      }
      rec.curve.line.visible = !isReentered;
      // icon variant (cached per kind/status/kit/skipped)
      const hasKit = !!t.kit || st === 'kitted' || st === 'kitwait' || st === 'kitburn';
      const ikey = col + (hasKit ? 'k' : '') + (st === 'skipped' ? 'x' : '');
      if (ikey !== rec.iconKey) {
        rec.iconKey = ikey;
        setIconSprite(rec.marker, rec.kind, col, { kit: hasKit, skipped: st === 'skipped' });
      }
      // marker (fixed pixel size; mass nudges it ±20%)
      const pos = t.pos || P.posFromEl(t.el);
      drawVec(pos, v2);
      if (!finiteVec(v2)) v2.copy(rec.lastPos); // hold last good position on NaN/Infinity
      const px = rec.marker.userData.px * (0.85 + 0.3 * clamp(Math.sqrt((t.mass || 0) / maxMass), 0, 1));
      if (rec.fade >= 0) {
        rec.fade += dt;
        const u = rec.fade / 3;
        if (u >= 1) { rec.marker.visible = false; rec.fade = 3.01; }
        else {
          rec.marker.visible = true;
          rec.mat.opacity = 1 - u;
          applyPx(rec.marker, px * (1 + 1.6 * Math.exp(-u * 6)));
          rec.marker.position.copy(rec.lastPos); // stays where it was last seen
        }
      } else {
        rec.marker.visible = true;
        rec.marker.position.copy(v2);
        applyPx(rec.marker, px);
        rec.lastPos.copy(v2);
      }
      // pulsing amber ring on the current target
      if (isCur && !isReentered) {
        const R = S.curRing;
        R.visible = true; R.position.copy(v2);
        const ph = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.004;
        applyPx(R, px * 1.9 + 8 * Math.sin(ph));
        R.material.opacity = 0.55 + 0.4 * Math.sin(ph + 1);
      }
      // kit burn plume in orbit view
      if (k === kitBurnTarget || st === 'kitburn') {
        if (!rec.plume) {
          rec.plume = new T.Sprite(new T.SpriteMaterial({ map: S.plumeTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
          rec.plume.scale.set(0.5, 0.5, 1); S.scene.add(rec.plume);
        }
        rec.plume.visible = true; rec.plume.position.copy(v2);
      } else if (rec.plume) rec.plume.visible = false;
      // label
      let ltxt = null;
      if (isDecaying) {
        const pa = t.perigeeAlt != null ? t.perigeeAlt : t.el.a * (1 - t.el.e) - RE;
        const ap = t.apogeeAlt != null ? t.apogeeAlt : t.el.a * (1 + t.el.e) - RE;
        ltxt = (t.name || ('target ' + id)) + ' · ' + Math.round(pa) + '×' + Math.round(ap) + ' km';
      } else if (isCur && !isReentered) {
        ltxt = 'target · ' + (t.name || id) + ' · ' + fmtKm(t.el.a - RE) + ' km';
      }
      if (ltxt) {
        if (!rec.label) { rec.label = makeLabel(col); S.scene.add(rec.label.sprite); }
        setLabelText(rec.label, ltxt, col);
        rec.label.prio = isCur ? 2 : 3; showLabel(rec.label, true);
      } else if (rec.label) showLabel(rec.label, false);
      // cluster stats (all targets still in orbit)
      if (!isReentered && st !== 'graveyard') { raanSx += Math.cos(t.el.raan); raanSy += Math.sin(t.el.raan); aSum += t.el.a; iSum += t.el.i; nCl++; }
    }
    if (!(cur >= 0 && targets[cur] && targets[cur].status !== 'reentered')) S.curRing.visible = false;
    // remove vanished targets
    if (S.targets.size !== seen.size) {
      for (const [id, rec] of S.targets) if (!seen.has(id)) { disposeTargetRec(rec); S.targets.delete(id); }
    }

    // --- reference rings
    const sc = state.scenario || {};
    const cl = sc.cluster || {};
    let clA = cl.alt != null ? RE + cl.alt : (nCl ? aSum / nCl : RE + 980);
    let clI = cl.inc != null ? cl.inc / DEG : (nCl ? iSum / nCl : 0);
    let clRaan = cl.raan != null ? cl.raan : (nCl ? Math.atan2(raanSy, raanSx) : 0);
    S.cluster = { a: clA, i: clI, raan: clRaan };
    {
      const R = S.rings.cluster, c = R.curve;
      if (!isGEO) {
        if (!c.sig || Math.abs(c.sig.a - clA) > 0.5 || Math.abs(angDiff(c.sig.i, clI)) > 1e-3 || Math.abs(angDiff(c.sig.raan, clRaan)) > 2e-3) fillCircle(c, clA, clI, clRaan);
        c.line.visible = true;
        const name = cl.name || sc.name || 'cluster';
        setLabelText(R.label, name + ' · ' + fmtKm(clA - RE) + ' km · i ' + (clI * DEG).toFixed(1) + '°', COL.cluster);
        showLabel(R.label, true);
      } else { c.line.visible = false; showLabel(R.label, false); }
    }
    {
      const gd = sc.graveyardDh != null ? sc.graveyardDh : (cl.graveyardDh != null ? cl.graveyardDh : 300);
      const dd = sc.driftDh != null ? sc.driftDh : (cl.driftDh != null ? cl.driftDh : 100);
      const G = S.rings.geo, GR = S.rings.grave, D = S.rings.drift;
      if (isGEO) {
        if (!G.curve.sig) fillCircle(G.curve, P.GEO_R, 0, 0);
        if (!GR.curve.sig || Math.abs(GR.curve.sig.a - (P.GEO_R + gd)) > 0.5) fillCircle(GR.curve, P.GEO_R + gd, 0, 0);
        if (!D.curve.sig || Math.abs(D.curve.sig.a - (P.GEO_R - dd)) > 0.5) fillCircle(D.curve, P.GEO_R - dd, 0, 0);
        G.curve.line.visible = GR.curve.line.visible = D.curve.line.visible = true;
        setLabelText(G.label, 'GEO · ' + fmtKm(P.GEO_R - RE) + ' km', COL.geo);
        setLabelText(GR.label, 'graveyard · GEO +' + fmtKm(gd) + ' km', COL.grave);
        setLabelText(D.label, 'drift orbit · GEO −' + fmtKm(dd) + ' km', COL.drift);
        showLabel(G.label, true); showLabel(GR.label, true); showLabel(D.label, true);
      } else {
        G.curve.line.visible = GR.curve.line.visible = D.curve.line.visible = false;
        showLabel(G.label, false); showLabel(GR.label, false); showLabel(D.label, false);
      }
    }

    // --- launch trail
    {
      const L = S.launch;
      const path = inLaunch && state.launch && state.launch.path;
      if (inLaunch && (!path || path.length === 0) && site) {
        // on the pad: rocket icon sits at the (rotating) launch site
        L.line.visible = false; L.lastLen = -1; L.count = 0; L.dir.set(0, 0, 0);
        L.rocket.visible = true;
        sceneVec(P.latLonToEci(site.lat, site.lon, 2, earthRot), L.rocket.position);
        applyPx(L.rocket, L.rocket.userData.px);
      } else if (path && path.length > 0) {
        if (path.length !== L.lastLen) {
          L.lastLen = path.length;
          const n = Math.min(path.length, LAUNCH_MAX);
          const step = path.length / n;
          for (let i = 0; i < n; i++) {
            const p = path[Math.min(path.length - 1, Math.floor(i * step))];
            const v = drawVec(p, S.tmp.v4);
            if (!finiteVec(v)) v.set(0, 0, 0);
            L.arr[3 * i] = v.x; L.arr[3 * i + 1] = v.y; L.arr[3 * i + 2] = v.z;
          }
          L.count = n;
          L.geom.setDrawRange(0, n);
          L.geom.attributes.position.needsUpdate = true;
        }
        L.line.visible = L.count > 1;
        L.rocket.visible = true;
        const n = L.count;
        L.rocket.position.set(L.arr[3 * (n - 1)], L.arr[3 * (n - 1) + 1], L.arr[3 * (n - 1) + 2]);
        L.dir.set(0, 0, 0);
        if (n > 1) {
          L.dir.set(L.arr[3 * (n - 1)] - L.arr[3 * (n - 2)], L.arr[3 * (n - 1) + 1] - L.arr[3 * (n - 2) + 1], L.arr[3 * (n - 1) + 2] - L.arr[3 * (n - 2) + 2]);
          if (L.dir.lengthSq() > 1e-12) L.dir.normalize(); else L.dir.set(0, 0, 0);
        }
        applyPx(L.rocket, L.rocket.userData.px);
      } else {
        L.line.visible = false; L.rocket.visible = false; L.lastLen = -1; L.count = 0;
      }
    }

    // --- wait-phase aids
    {
      const W = S.wait;
      const tgt = (phase === 'wait' && cur >= 0 && targets[cur] && targets[cur].el) ? targets[cur] : null;
      const on = !!(tgt && sh && sh.el);
      const discs = on && !isGEO, lines = on && isGEO;
      W.discShep.visible = W.discTgt.visible = discs;
      W.lineShep.line.visible = W.lineTgt.line.visible = lines;
      if (discs) {
        planeNormalScene(sh.el.i, sh.el.raan, v3);
        W.discShep.quaternion.setFromUnitVectors(S.tmp.v5.set(0, 0, 1), v3);
        const rs = sh.el.a * 1e-3; W.discShep.scale.set(rs, rs, 1);
        planeNormalScene(tgt.el.i, tgt.el.raan, v3);
        W.discTgt.quaternion.setFromUnitVectors(S.tmp.v5.set(0, 0, 1), v3);
        const rt = tgt.el.a * 1e-3; W.discTgt.scale.set(rt, rt, 1);
      } else if (lines) {
        const a = W.lineShep.arr, b = W.lineTgt.arr;
        a[0] = a[1] = a[2] = 0; a[3] = shepPos.x; a[4] = shepPos.y; a[5] = shepPos.z;
        drawVec(tgt.pos || P.posFromEl(tgt.el), v3);
        b[0] = b[1] = b[2] = 0; b[3] = v3.x; b[4] = v3.y; b[5] = v3.z;
        W.lineShep.geom.attributes.position.needsUpdate = true;
        W.lineTgt.geom.attributes.position.needsUpdate = true;
      }
    }

    // --- transient effects
    tickFx(dt);

    // --- camera
    updateCamera(state, dt, shepPos, inLaunch, sh);

    // --- screen-aligned icon headings (need the final camera matrix)
    if (S.shep.marker.visible && shepPos) {
      applyPx(S.shep.marker, S.shep.marker.userData.px);
      S.shep.marker.material.rotation = screenHeading(shepPos, S.shep.velDir);
    }
    if (S.launch.rocket.visible && S.launch.dir.lengthSq() > 0) {
      S.launch.rocket.material.rotation = screenHeading(S.launch.rocket.position, S.launch.dir);
    }

    // --- labels: place on curves + size
    if (S.labelsOn) placeAllLabels();
    S.phase = phase;
  }

  // ------------------------------------------------------------------ camera
  function updateCamera(state, dt, shepPos, inLaunch, sh) {
    const C = S.cam, T = THREE, RE = SIM.phys.RE * 1e-3;
    const isGEO = S.regime === 'GEO';
    const v1 = S.tmp.v5, v2 = S.tmp.v6, v3 = S.tmp.v3;

    // auto-follow the ascent (only on the transition into 'ascent', so init in 'prelaunch' keeps the earth framing)
    const phaseNow = state.phase || '';
    if (phaseNow === 'ascent' && S.phase !== 'ascent' && S.phase !== '' && C.userMode === 'earth') { C.launchAuto = true; C.distSet = false; }
    if (!inLaunch && C.launchAuto) { C.launchAuto = false; C.distSet = false; }
    const mode = C.launchAuto ? 'follow' : C.userMode;
    if (mode !== C.mode) { C.mode = mode; C.distSet = false; }

    let focus = C.tFocus, up = C.tUp;
    const bx = v1, by = v2, bz = v3; // basis: bx = "forward"(theta=0), by = up, bz = side
    if (mode === 'follow' && (shepPos || (inLaunch && S.launch.rocket.visible))) {
      // basis: bx = radial out, by = orbit normal (up), bz = along-track. Camera sits above the orbit plane.
      const L = S.launch;
      const launching = inLaunch && L.rocket.visible;
      const p = launching ? L.rocket.position : shepPos;
      const rad = Math.max(p.length(), RE * 1.05);
      if (launching) {
        const n = L.count;
        if (n > 1) bz.set(L.arr[3 * (n - 1)] - L.arr[3 * (n - 2)], L.arr[3 * (n - 1) + 1] - L.arr[3 * (n - 2) + 1], L.arr[3 * (n - 1) + 2] - L.arr[3 * (n - 2) + 2]);
        else bz.set(0, 0, 0);
      } else if (sh && sh.vel) sceneVec(sh.vel, bz); else bz.set(0, 0, 0);
      bx.copy(p).normalize();                            // radial out
      if (bx.lengthSq() < 1e-10) bx.set(1, 0, 0);
      if (bz.lengthSq() < 1e-10) bz.set(0, 1, 0).cross(bx);
      by.crossVectors(bx, bz);                           // orbit normal
      if (by.lengthSq() < 1e-10) by.set(0, 1, 0);
      by.normalize();
      bz.crossVectors(by, bx).normalize();               // re-orthogonalised along-track
      if (isGEO) {
        // GEO: shepherd icon + local ring segment + Earth in frame: outward and above, looking back past the shepherd
        if (!C.distSet) { C.dist = 0.9 * rad; C.theta = 0; C.phi = 0.5; C.distSet = true; }
        focus.copy(p);
      } else {
        // LEO: whole orbit ring + Earth limb: behind and above the orbit plane, focus pulled toward Earth centre
        const a = launching ? Math.max(rad * 1.12, RE + 0.6) : rad;
        if (!C.distSet) { C.dist = 2.8 * a; C.theta = -Math.PI / 2; C.phi = 0.8; C.distSet = true; }
        focus.copy(p).multiplyScalar(0.6);
      }
      up.copy(by);
    } else if (mode === 'cluster') {
      const cl = S.cluster || { a: RE * 1000 + 980, i: 0, raan: 0 };
      if (!C.distSet) { C.dist = 2.9 * cl.a * 1e-3; C.theta = 0; C.phi = 1.45; C.distSet = true; }
      focus.set(0, 0, 0);
      planeNormalScene(cl.i, cl.raan, by);
      bx.set(0, 1, 0);
      if (Math.abs(bx.dot(by)) > 0.98) bx.set(1, 0, 0);
      bz.crossVectors(by, bx).normalize();
      bx.crossVectors(bz, by).normalize();
      up.copy(bx);
    } else {
      if (!C.distSet) { C.dist = (isGEO ? 16 : 4.5) * RE; C.theta = 0.65; C.phi = 0.32; C.distSet = true; }
      focus.set(0, 0, 0);
      bx.set(0, 0, 1); by.set(0, 1, 0); bz.set(1, 0, 0);
      up.set(0, 1, 0);
    }
    const cp = Math.cos(C.phi), sp = Math.sin(C.phi), ct = Math.cos(C.theta), st = Math.sin(C.theta);
    const tp = C.tPos;
    tp.copy(focus);
    tp.addScaledVector(bx, C.dist * cp * ct);
    tp.addScaledVector(bz, C.dist * cp * st);
    tp.addScaledVector(by, C.dist * sp);
    // keep the camera out of the Earth; never feed NaN/Infinity into the lerp
    if (!finiteVec(tp) || !finiteVec(focus) || !finiteVec(up)) return;
    if (tp.length() < RE * 1.05) tp.setLength(RE * 1.05);

    if (C.snap) { C.pos.copy(tp); C.focus.copy(focus); C.up.copy(up); C.snap = false; }
    else {
      const k = 1 - Math.exp(-dt * (mode === 'follow' ? 9 : 5));
      C.pos.lerp(tp, k); C.focus.lerp(focus, k); C.up.lerp(up, k);
    }
    if (C.up.lengthSq() < 1e-8) C.up.set(0, 1, 0);
    S.camera.position.copy(C.pos);
    S.camera.up.copy(C.up).normalize();
    S.camera.lookAt(C.focus);
    S.camera.updateMatrixWorld();
    S.camera.matrixWorldInverse.copy(S.camera.matrixWorld).invert();
  }

  // ------------------------------------------------------------------ labels per frame
  function placeAllLabels() {
    const cam = S.camera;
    const right = S.tmp.v5.set(cam.matrixWorld.elements[0], cam.matrixWorld.elements[1], cam.matrixWorld.elements[2]);
    const camPos = cam.position;
    const vp = S.tmp.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // curves in world space
    if (S.shep.label.on) placeLabelOnCurve(S.shep.label, S.shep.curve, right, vp);
    if (S.regime === 'GEO') {
      // the three equatorial reference rings: labels at azimuths 0/120/240 deg relative to the camera
      const camAz = Math.atan2(-camPos.z, camPos.x); // ECI azimuth of the camera about the spin axis
      placeLabelAtAzimuth(S.rings.geo, camAz);
      placeLabelAtAzimuth(S.rings.grave, camAz + 2 * Math.PI / 3);
      placeLabelAtAzimuth(S.rings.drift, camAz + 4 * Math.PI / 3);
      if (S.rings.cluster.label.on) placeLabelOnCurve(S.rings.cluster.label, S.rings.cluster.curve, right, vp);
    } else {
      for (const key in S.rings) { const R = S.rings[key]; if (R.label.on) placeLabelOnCurve(R.label, R.curve, right, vp); }
    }
    for (const rec of S.targets.values()) if (rec.label && rec.label.on) placeLabelOnCurve(rec.label, rec.curve, right, vp);
    // size everything that is on
    for (let i = 0; i < S.labels.length; i++) { const l = S.labels[i]; if (l.on) sizeLabel(l, camPos); }
    deoverlapLabels(vp);
  }
  // Push overlapping curve labels apart vertically (screen space), nudging the sprite along camera-up.
  function deoverlapLabels(vp) {
    const list = S.tmp.lblList || (S.tmp.lblList = []);
    list.length = 0;
    const e = vp.elements, W = S.w, H = S.h;
    const collect = (l) => {
      if (!l.on || l.sprite.parent !== S.scene) return;
      const p = l.sprite.position;
      const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
      if (w <= 0) return;
      l.sx = ((e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / w + 1) * 0.5 * W;
      l.sy = (1 - (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / w) * 0.5 * H;
      l.sd = w; // view depth (w == -z_view for a perspective camera)
      list.push(l);
    };
    collect(S.shep.label);
    for (const key in S.rings) collect(S.rings[key].label);
    for (const rec of S.targets.values()) if (rec.label) collect(rec.label);
    if (list.length < 2) return;
    // priority first (shepherd 0, reference rings 1, current target 2, others 3), then top-to-bottom:
    // a co-located target label lands one line below the shepherd label, never the other way round
    list.sort((a, b) => (a.prio - b.prio) || (a.sy - b.sy));
    const cam = S.camera.matrixWorld.elements;
    const up = S.tmp.v6.set(cam[4], cam[5], cam[6]);
    for (let i = 1; i < list.length; i++) {
      const a = list[i];
      let shift = 0;
      for (let j = 0; j < i; j++) {
        const b = list[j];
        const overlapX = a.sx < b.sx + b.pxW + 6 && b.sx < a.sx + a.pxW + 6;
        if (!overlapX) continue;
        const dy = (a.sy + shift) - b.sy;
        if (Math.abs(dy) < b.pxH + 8) shift += (b.sy + b.pxH + 8) - (a.sy + shift); // one line below
      }
      if (shift > 0) {
        a.sy += shift;
        const world = shift * 2 * a.sd * S.tanHalf / H;
        a.sprite.position.addScaledVector(up, -world);
      }
    }
  }

  // ------------------------------------------------------------------ public API
  function render() {
    if (!S.ready || !S.visible) return;
    S.renderer.render(S.scene, S.camera);
  }
  function resize() {
    if (!S.ready) return;
    const w = Math.max(1, S.container.clientWidth), h = Math.max(1, S.container.clientHeight);
    S.w = w; S.h = h;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
    S.tanHalf = Math.tan(S.camera.fov * 0.5 * Math.PI / 180);
    S.pxScale = 2 * S.tanHalf / h;
  }
  function setVisible(b) {
    S.visible = !!b;
    if (S.renderer) S.renderer.domElement.style.display = b ? 'block' : 'none';
    if (b) resize();
  }
  function setCameraMode(m) {
    if (m !== 'earth' && m !== 'follow' && m !== 'cluster') return;
    if (!S.cam) return;
    S.cam.userMode = m;
    S.cam.launchAuto = false;
    S.cam.distSet = false;
  }
  function setUserOrbit(b) { S.userOrbit = !!b; }
  function setLabels(b) {
    S.labelsOn = !!b;
    for (let i = 0; i < S.labels.length; i++) S.labels[i].sprite.visible = S.labelsOn && S.labels[i].on;
  }

  SIM.scene = { init, update, render, resize, setVisible, setCameraMode, setUserOrbit, setLabels };
  Object.defineProperty(SIM.scene, '_internals', { value: S, enumerable: false }); // debugging aid only
})();
