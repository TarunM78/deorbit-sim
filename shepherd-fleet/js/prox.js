/* js/prox.js — Shepherd Fleet proximity-scale 3D view (Agent B)
 *
 * Frame: LVLH metres, target centre of mass at origin. +X along-track, +Y radial out, +Z cross-track.
 * Exposes window.SIM.prox = { init, update, render, resize, setVisible, setUserOrbit, attachSep }.
 * No RAF loop here: app.js drives update()+render(). Depends only on the global THREE (0.160 UMD).
 */
(function () {
  'use strict';
  window.SIM = window.SIM || {};
  var THREE = window.THREE;

  var BG = 0x0b1128;
  var COL_BEAM = 0xa9c4ea, COL_COUNTER = 0x3ecfb5, COL_FORCE = 0xf2b955, COL_KIT = 0xff8a3c, COL_DIM = 0xcfd8ff;
  var D2R = Math.PI / 180;
  var ARM_L = [0.95, 0.95, 0.6];                       // 2.5 m reach
  var ARM_STOW = [0, 165 * D2R, -150 * D2R];
  var SHOULDER_LOCAL = new THREE.Vector3(0.72, 0.05, -0.45);
  var STOW_U = new THREE.Vector3(0, 0, 1), STOW_V = new THREE.Vector3(0, 1, 0);

  var container, renderer, scene, camera, canvas;
  var visible = true, inited = false;
  var starfield, earth, earthAtmo, earthGlow, earthRegime = null;

  // target
  var tgt = { group: null, sig: '', kind: '', len: 6.5, diam: 2.4, angle: 0, axis: new THREE.Vector3(0.2, 0.9, 0.38).normalize(),
    nozzleLocal: new THREE.Vector3(), kitLocal: new THREE.Vector3(), bellLen: 1 };
  // shepherd
  var shep = { group: null, beamGlow: null, counterGlow: null, rack: [], rackSlots: [], armLinks: [], gripper: null, armRoot: null, techKit: false };
  // ibs visuals
  var beam, counter, forceArrowT, forceArrowS, labelForce, labelFollow, standoffLine, standoffTicks, labelStandoff;
  var beamI = 0, counterI = 0, lastStandoffText = '';
  // kit visuals
  var kit = { attached: false, box: null, anim: null, kitsAtAttach: -1, plume: null, plumeI: 0, light: null, burnT: 0 };
  // camera
  var cam = { theta: 0.65, phi: 0.3, radius: 30, radiusMul: 1, center: new THREE.Vector3(), userOrbit: false, dragging: false, lx: 0, ly: 0, autoPaused: false };

  // scratch
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
  var _u = new THREE.Vector3(), _vv = new THREE.Vector3(), _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);
  var _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  var _dir = new THREE.Vector3(), _sh = new THREE.Vector3(), _nz = new THREE.Vector3(), _kt = new THREE.Vector3();
  var softDot = null, panelTex = null, glowTex = null;

  /* ------------------------------------------------------------------ helpers */
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function expLerp(k, dt) { return 1 - Math.exp(-k * dt); }

  function disposeTree(obj) {
    obj.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) { if (!m.userData.shared) m.dispose(); });
      }
    });
  }

  function makeSoftDot() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d'); var r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function makeGlowTex() {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d'); var r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.25, 'rgba(255,255,255,0.35)'); r.addColorStop(0.6, 'rgba(255,255,255,0.08)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function makePanelTexture() {
    var c = document.createElement('canvas'); c.width = 256; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#152452'; g.fillRect(0, 0, 256, 128);
    var grad = g.createLinearGradient(0, 0, 256, 128); grad.addColorStop(0, 'rgba(120,160,255,0.25)'); grad.addColorStop(1, 'rgba(20,30,80,0.2)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#3a5aa8'; g.lineWidth = 2;
    for (var x = 0; x <= 256; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    for (var y = 0; y <= 128; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function makeEarthTexture() {
    var c = document.createElement('canvas'); c.width = 512; c.height = 256;
    var g = c.getContext('2d');
    var og = g.createLinearGradient(0, 0, 0, 256); og.addColorStop(0, '#1d5a96'); og.addColorStop(0.5, '#164a86'); og.addColorStop(1, '#1d5a96');
    g.fillStyle = og; g.fillRect(0, 0, 512, 256);
    var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var cols = ['#4f7a3a', '#6b8a3c', '#8a8a55', '#3f6b34'];
    for (var i = 0; i < 26; i++) {
      var cx = rnd() * 512, cy = 40 + rnd() * 176, n = 4 + Math.floor(rnd() * 6);
      g.fillStyle = cols[i % cols.length];
      for (var j = 0; j < n; j++) { g.beginPath(); g.ellipse(cx + (rnd() - 0.5) * 60, cy + (rnd() - 0.5) * 30, 8 + rnd() * 26, 6 + rnd() * 16, rnd() * 3, 0, Math.PI * 2); g.fill(); }
    }
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, 512, 14); g.fillRect(0, 242, 512, 14);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    for (i = 0; i < 40; i++) { g.beginPath(); g.ellipse(rnd() * 512, rnd() * 256, 10 + rnd() * 30, 3 + rnd() * 6, 0, 0, Math.PI * 2); g.fill(); }
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function makeLabel(text, color) {
    var c = document.createElement('canvas');
    var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    var sp = new THREE.Sprite(mat);
    var lab = { sprite: sp, text: '', aspect: 1, color: color, setText: null, setHeight: null };
    lab.setText = function (t) {
      if (t === lab.text) return;
      lab.text = t;
      var g = c.getContext('2d'); var px = 28;
      g.font = px + 'px "Fira Code", "Cascadia Mono", Consolas, monospace';
      var w = Math.ceil(g.measureText(t).width) + 20;
      c.width = w; c.height = px + 16;
      g = c.getContext('2d');
      g.font = px + 'px "Fira Code", "Cascadia Mono", Consolas, monospace';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(8,12,30,0.55)'; g.fillRect(0, 0, w, c.height);
      g.fillStyle = color; g.fillText(t, 10, c.height / 2 + 1);
      lab.aspect = w / c.height; tex.needsUpdate = true;
    };
    lab.setHeight = function (h) { sp.scale.set(h * lab.aspect, h, 1); };
    lab.setText(text); lab.setHeight(0.9);
    return lab;
  }

  /* particle stream: n points flowing along local +X (sign=+1) or -X (sign=-1) inside a cone */
  function makeStream(n, color, size) {
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var mat = new THREE.PointsMaterial({ color: color, size: size, map: softDot, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    var pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
    var t = new Float32Array(n), rho = new Float32Array(n), phi = new Float32Array(n), spd = new Float32Array(n);
    for (var i = 0; i < n; i++) { t[i] = Math.random(); rho[i] = Math.sqrt(Math.random()); phi[i] = Math.random() * Math.PI * 2; spd[i] = 0.45 + Math.random() * 0.5; }
    return {
      points: pts, n: n,
      update: function (dt, L, tanA, sign, intensity, speedMul) {
        var sm = speedMul || 1;
        for (var i = 0; i < n; i++) {
          t[i] += spd[i] * sm * dt / Math.max(L, 1) * 6;
          if (t[i] > 1) t[i] -= Math.floor(t[i]);
          var x = t[i] * L, r = rho[i] * x * tanA * 0.92;
          pos[i * 3] = sign * x; pos[i * 3 + 1] = r * Math.cos(phi[i]); pos[i * 3 + 2] = r * Math.sin(phi[i]);
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = 0.85 * intensity;
      }
    };
  }

  /* unit cone, apex at origin, opening along local +X (sign=1) or -X (sign=-1); scale.set(r, L, r) */
  function makeCone(color, opacity, sign) {
    var g = new THREE.ConeGeometry(1, 1, 40, 1, true); g.translate(0, -0.5, 0);
    var m = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    var mesh = new THREE.Mesh(g, m); mesh.rotation.z = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    mesh.userData.baseOpacity = opacity; mesh.frustumCulled = false;
    return mesh;
  }

  /* beam bundle: group positioned at the thruster mouth in the shepherd's local frame */
  function makeBeam(color, sign, nParticles, particleSize) {
    var group = new THREE.Group();
    var outer = makeCone(color, 0.10, sign), inner = makeCone(color, 0.08, sign);
    var stream = makeStream(nParticles, color, particleSize);
    var bloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(outer, inner, stream.points, bloom);
    return {
      group: group, outer: outer, inner: inner, stream: stream, bloom: bloom, sign: sign,
      set: function (dt, L, halfDeg, intensity, speedMul) {
        var tanA = Math.tan(halfDeg * D2R), r = L * tanA;
        outer.scale.set(r, L, r); inner.scale.set(r * 0.45, L, r * 0.45);
        outer.material.opacity = outer.userData.baseOpacity * intensity;
        inner.material.opacity = inner.userData.baseOpacity * intensity;
        stream.update(dt, L, tanA, sign, intensity, speedMul);
        var d = 2.4 * r + 1.2; bloom.scale.set(d, d, 1); bloom.position.set(sign * L, 0, 0); bloom.material.opacity = 0.6 * intensity;
        group.visible = intensity > 0.01;
      }
    };
  }

  /* ------------------------------------------------------------------ target models */
  function bellLength(len, diam) { return clamp(0.28 * diam + 0.08 * len, 0.6, 2.2); }

  function buildRocketBody(len, diam) {
    var g = new THREE.Group(); var r = diam / 2;
    var paint = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.25, roughness: 0.55 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x4d5158, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide });
    var band = new THREE.MeshStandardMaterial({ color: 0x8f959e, metalness: 0.4, roughness: 0.6 });
    var body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 40), paint); body.rotation.z = Math.PI / 2; g.add(body);
    // paint bands + tank seam
    for (var i = 0; i < 3; i++) {
      var b = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.12, 40), band); b.rotation.z = Math.PI / 2;
      b.position.x = -len / 2 + len * (0.18 + i * 0.32); g.add(b);
    }
    // aft skirt + engine block
    var skirt = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 1.0, 0.35, 40, 1, true), dark); skirt.rotation.z = Math.PI / 2; skirt.position.x = -len / 2 - 0.17; g.add(skirt);
    var block = new THREE.Mesh(new THREE.CylinderGeometry(diam * 0.16, diam * 0.2, 0.3, 24), dark); block.rotation.z = Math.PI / 2; block.position.x = -len / 2 - 0.35; g.add(block);
    // nozzle bell (lathe), axis along -X
    var bl = bellLength(len, diam), throat = diam * 0.11, exit = diam * 0.36, pts = [];
    for (i = 0; i <= 12; i++) { var s = i / 12; pts.push(new THREE.Vector2(throat + (exit - throat) * Math.pow(s, 0.6), s * bl)); }
    var bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), dark); bell.rotation.z = Math.PI / 2; bell.position.x = -len / 2 - 0.5; g.add(bell);
    // payload adapter ring at +X
    var ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.75, 0.06, 10, 40), band); ring.rotation.y = Math.PI / 2; ring.position.x = len / 2 + 0.05; g.add(ring);
    var adapter = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.8, 0.45, 32, 1, true), band); adapter.rotation.z = Math.PI / 2; adapter.position.x = len / 2 + 0.2; g.add(adapter);
    var bulk = new THREE.Mesh(new THREE.CircleGeometry(r * 0.55, 32), dark); bulk.rotation.y = Math.PI / 2; bulk.position.x = len / 2 + 0.42; g.add(bulk);
    tgt.bellLen = bl;
    tgt.nozzleLocal.set(-len / 2 - 0.5 - bl * 0.55, 0, 0);
    tgt.kitLocal.set(-len / 2 - 0.5 - bl * 0.42, 0, 0);
    return g;
  }

  function buildComsat() {
    var g = new THREE.Group();
    var gold = new THREE.MeshStandardMaterial({ color: 0xd8a63a, metalness: 0.85, roughness: 0.3 });
    var grey = new THREE.MeshStandardMaterial({ color: 0xc7ccd4, metalness: 0.4, roughness: 0.5 });
    var pmat = new THREE.MeshStandardMaterial({ map: panelTex, metalness: 0.5, roughness: 0.35 }); pmat.userData.shared = false;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.6, 2.0), gold));
    for (var s = -1; s <= 1; s += 2) {
      var yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8), grey); yoke.rotation.x = Math.PI / 2; yoke.position.z = s * 1.5; g.add(yoke);
      var wing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 9), pmat); wing.position.z = s * (2.0 + 4.5); g.add(wing);
    }
    var dish = new THREE.Mesh(new THREE.SphereGeometry(1.25, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.36), grey);
    dish.material = new THREE.MeshStandardMaterial({ color: 0xe6e9ee, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
    dish.position.set(0, -1.3 - 0.4, 0); dish.rotation.x = Math.PI; g.add(dish);
    var feed = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6), grey); feed.position.set(0, -2.15, 0); g.add(feed);
    var horn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 12), grey); horn.position.set(0, -2.6, 0); g.add(horn);
    var ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), grey); ant.position.set(1.0, 1.6, 0.5); g.add(ant);
    tgt.bellLen = 0.6; tgt.nozzleLocal.set(-1.1 - 0.35, 0, 0); tgt.kitLocal.set(-1.1 - 0.3, 0, 0);
    // small apogee motor nozzle at -X so the kit has somewhere to go
    var nz = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.4, 0.6, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x4d5158, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide }));
    nz.rotation.z = Math.PI / 2; nz.position.x = -1.1 - 0.3; g.add(nz);
    return g;
  }

  function buildSmallsat() {
    var g = new THREE.Group();
    var bus = new THREE.MeshStandardMaterial({ color: 0xbfc6d0, metalness: 0.5, roughness: 0.45 });
    var pmat = new THREE.MeshStandardMaterial({ map: panelTex, metalness: 0.5, roughness: 0.35 });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bus));
    var wing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 2.5), pmat); wing.position.z = 0.5 + 1.25 + 0.1; g.add(wing);
    var boom = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 6), bus); boom.position.set(0.3, 0.9, 0); g.add(boom);
    var patch = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.3), new THREE.MeshStandardMaterial({ color: 0xffffff })); patch.position.y = -0.51; g.add(patch);
    tgt.bellLen = 0.4; tgt.nozzleLocal.set(-0.5 - 0.22, 0, 0); tgt.kitLocal.set(-0.5 - 0.25, 0, 0);
    var nz = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.2, 0.35, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x4d5158, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide }));
    nz.rotation.z = Math.PI / 2; nz.position.x = -0.5 - 0.18; g.add(nz);
    return g;
  }

  function rebuildTarget(kind, len, diam) {
    if (tgt.group) { scene.remove(tgt.group); if (kit.box && kit.box.parent === tgt.group) tgt.group.remove(kit.box); disposeTree(tgt.group); }
    tgt.kind = kind; tgt.len = len; tgt.diam = diam;
    if (kind === 'comsat') { tgt.group = buildComsat(); tgt.len = 2.2; tgt.diam = 2.6; }
    else if (kind === 'smallsat') { tgt.group = buildSmallsat(); tgt.len = 1; tgt.diam = 1; }
    else tgt.group = buildRocketBody(len, diam);
    scene.add(tgt.group);
    if (kit.box && kit.attached && !kit.anim) { tgt.group.add(kit.box); kit.box.position.copy(tgt.kitLocal); kit.box.quaternion.identity(); }
  }

  /* ------------------------------------------------------------------ shepherd */
  function buildShepherd() {
    var g = new THREE.Group();
    var busMat = new THREE.MeshStandardMaterial({ color: 0xd2d8e2, metalness: 0.45, roughness: 0.4 });
    var goldMat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.8, roughness: 0.35 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, metalness: 0.8, roughness: 0.35 });
    var pmat = new THREE.MeshStandardMaterial({ map: panelTex, metalness: 0.5, roughness: 0.35 });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), busMat));
    var mli = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.5, 1.22), goldMat); mli.position.y = -0.3; g.add(mli);
    // solar arrays along ±Z
    for (var s = -1; s <= 1; s += 2) {
      var yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), darkMat); yoke.rotation.x = Math.PI / 2; yoke.position.z = s * 0.85; g.add(yoke);
      var arr = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 4), pmat); arr.position.z = s * (0.6 + 0.5 + 2.0); g.add(arr);
    }
    // beam thruster (+X) and counter thruster (-X)
    shep.beamGlow = new THREE.MeshStandardMaterial({ color: 0x222833, emissive: COL_BEAM, emissiveIntensity: 0, metalness: 0.5, roughness: 0.5 });
    shep.counterGlow = new THREE.MeshStandardMaterial({ color: 0x222833, emissive: COL_COUNTER, emissiveIntensity: 0, metalness: 0.5, roughness: 0.5 });
    var bt = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.3, 24, 1, true), darkMat); bt.rotation.z = -Math.PI / 2; bt.position.x = 0.75; g.add(bt);
    var bgrid = new THREE.Mesh(new THREE.CircleGeometry(0.21, 24), shep.beamGlow); bgrid.rotation.y = Math.PI / 2; bgrid.position.x = 0.85; g.add(bgrid);
    var ct = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.3, 24, 1, true), darkMat); ct.rotation.z = Math.PI / 2; ct.position.x = -0.75; g.add(ct);
    var cgrid = new THREE.Mesh(new THREE.CircleGeometry(0.21, 24), shep.counterGlow); cgrid.rotation.y = -Math.PI / 2; cgrid.position.x = -0.85; g.add(cgrid);
    // lidar head on +Y
    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), darkMat); mast.position.y = 0.75; g.add(mast);
    var head = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 20), busMat); head.rotation.z = Math.PI / 2; head.position.set(0.05, 0.95, 0); g.add(head);
    var lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 20), new THREE.MeshStandardMaterial({ color: 0x0a0d14, emissive: 0x3a70ff, emissiveIntensity: 0.6, roughness: 0.2 }));
    lens.rotation.y = Math.PI / 2; lens.position.set(0.165, 0.95, 0); g.add(lens);
    // small antenna dish on -Y
    var dish = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.35), new THREE.MeshStandardMaterial({ color: 0xe8ebf0, side: THREE.DoubleSide, roughness: 0.5 }));
    dish.position.set(-0.2, -0.85, 0); dish.rotation.x = Math.PI; g.add(dish);

    // kit rack on +X face (two rows of four)
    var kitGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
    var kitMat = new THREE.MeshStandardMaterial({ color: 0xff9a4a, metalness: 0.3, roughness: 0.5 });
    var kitBand = new THREE.MeshStandardMaterial({ color: 0x2b2f38, metalness: 0.5, roughness: 0.5 });
    shep.rackGroup = new THREE.Group(); g.add(shep.rackGroup);
    var rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 1.1), darkMat); rail.position.set(0.63, -0.33, 0); shep.rackGroup.add(rail);
    shep.rack = []; shep.rackSlots = [];
    for (var i = 0; i < 8; i++) {
      var row = Math.floor(i / 4), col = i % 4;
      var slot = new THREE.Vector3(0.78, -0.47 + row * 0.27, -0.42 + col * 0.28);
      var box = new THREE.Group();
      box.add(new THREE.Mesh(kitGeo, kitMat));
      var bandM = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.06, 0.23), kitBand); box.add(bandM);
      box.position.copy(slot); shep.rackGroup.add(box); shep.rack.push(box); shep.rackSlots.push(slot);
    }
    // shoulder mount
    shep.shoulderMount = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), darkMat); shep.shoulderMount.position.set(0.65, 0.05, -0.45); g.add(shep.shoulderMount);
    return g;
  }

  function buildArm() {
    var root = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({ color: 0xe4e7ec, metalness: 0.5, roughness: 0.35 });
    var jmat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, metalness: 0.8, roughness: 0.35 });
    var radii = [0.09, 0.08, 0.07];
    shep.armLinks = [];
    for (var i = 0; i < 3; i++) {
      var lg = new THREE.Group();
      var cyl = new THREE.Mesh(new THREE.CylinderGeometry(radii[i], radii[i], ARM_L[i], 12), mat); cyl.position.y = ARM_L[i] / 2; lg.add(cyl);
      lg.add(new THREE.Mesh(new THREE.SphereGeometry(radii[i] + 0.05, 14, 12), jmat));
      root.add(lg); shep.armLinks.push(lg);
    }
    var grip = new THREE.Group();
    grip.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.22), jmat));
    for (var s = -1; s <= 1; s += 2) { var claw = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.26, 0.07), mat); claw.position.set(s * 0.09, 0.18, 0); grip.add(claw); }
    root.add(grip); shep.gripper = grip; shep.armRoot = root;
    return root;
  }

  function makeKitBox() {
    var box = new THREE.Group();
    var m = new THREE.MeshStandardMaterial({ color: 0xff9a4a, metalness: 0.3, roughness: 0.5 });
    box.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), m));
    var band = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.52), new THREE.MeshStandardMaterial({ color: 0x2b2f38, metalness: 0.5, roughness: 0.5 })); box.add(band);
    var nz = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.18, 0.3, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a3e45, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide }));
    nz.rotation.z = Math.PI / 2; nz.position.x = -0.35; box.add(nz);
    // plume (visible when kitBurn)
    var plume = new THREE.Group(); plume.position.x = -0.45;
    var outer = makeCone(COL_KIT, 0.28, -1), inner = makeCone(0xffd27a, 0.35, -1);
    var stream = makeStream(320, 0xff9a40, 0.18);
    plume.add(outer, inner, stream.points); box.add(plume);
    var light = new THREE.PointLight(COL_KIT, 0, 12, 2); light.position.x = -1.2; plume.add(light);
    kit.plume = { group: plume, outer: outer, inner: inner, stream: stream, light: light };
    plume.visible = false;
    return box;
  }

  /* ------------------------------------------------------------------ scene setup */
  function buildEnvironment() {
    // starfield
    var n = 1800, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 1500 * (0.85 + Math.random() * 0.15), s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * s * Math.sin(th);
    }
    var sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starfield = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe6ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false }));
    scene.add(starfield);
    // Earth
    earth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshStandardMaterial({ map: makeEarthTexture(), roughness: 0.9, metalness: 0 }));
    earth.position.set(-40, -140, -300); scene.add(earth);
    earthAtmo = new THREE.Mesh(new THREE.SphereGeometry(1.04, 48, 32), new THREE.MeshBasicMaterial({ color: 0x5fa8ff, transparent: true, opacity: 0.22, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    earthAtmo.position.copy(earth.position); scene.add(earthAtmo);
    earthGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7fb6ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    earthGlow.position.copy(earth.position); scene.add(earthGlow);
    setEarthRegime('LEO');
    // lights
    var key = new THREE.DirectionalLight(0xffe2c4, 2.6); key.position.set(60, 80, 40); scene.add(key);
    var fill = new THREE.DirectionalLight(0x7fa6ff, 0.9); fill.position.set(-40, -30, -60); scene.add(fill);
    var earthshine = new THREE.DirectionalLight(0x4a7fd0, 0.35); earthshine.position.set(-40, -140, -300); scene.add(earthshine);
    scene.add(new THREE.AmbientLight(0x2a3a60, 0.9));
  }
  function setEarthRegime(regime) {
    if (regime === earthRegime) return; earthRegime = regime;
    var R = regime === 'GEO' ? 5 : 15;
    earth.scale.setScalar(R); earthAtmo.scale.setScalar(R);
    earthGlow.scale.set(R * 3.0, R * 3.0, 1); earthGlow.material.opacity = regime === 'GEO' ? 0.3 : 0.5;
  }

  function buildIbsVisuals() {
    beam = makeBeam(COL_BEAM, +1, 1000, 0.16); beam.group.position.x = 0.87; shep.group.add(beam.group);
    counter = makeBeam(COL_COUNTER, -1, 400, 0.14); counter.group.position.x = -0.87; shep.group.add(counter.group);
    forceArrowT = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 3, COL_FORCE, 0.7, 0.4); scene.add(forceArrowT);
    forceArrowS = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 2.5, COL_COUNTER, 0.6, 0.35); scene.add(forceArrowS);
    labelForce = makeLabel('force on target', '#f2b955'); scene.add(labelForce.sprite);
    labelFollow = makeLabel('shepherd follows', '#3ecfb5'); scene.add(labelFollow.sprite);
    var lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    standoffLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: COL_DIM, dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.75 }));
    standoffLine.frustumCulled = false; scene.add(standoffLine);
    var tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    standoffTicks = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: COL_DIM, transparent: true, opacity: 0.75 })); standoffTicks.frustumCulled = false; scene.add(standoffTicks);
    labelStandoff = makeLabel('standoff -- m', '#cfd8ff'); scene.add(labelStandoff.sprite);
  }

  /* ------------------------------------------------------------------ mouse orbit */
  function onPointerDown(e) { if (e.button !== 0) return; cam.dragging = true; cam.lx = e.clientX; cam.ly = e.clientY; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); }
  function onPointerMove(e) {
    if (!cam.dragging || !cam.userOrbit) return;
    var dx = e.clientX - cam.lx, dy = e.clientY - cam.ly; cam.lx = e.clientX; cam.ly = e.clientY;
    cam.theta -= dx * 0.006; cam.phi = clamp(cam.phi + dy * 0.006, -1.35, 1.35); cam.autoPaused = true;
  }
  function onPointerUp() { cam.dragging = false; }
  function onWheel(e) { if (!cam.userOrbit) return; e.preventDefault(); cam.radiusMul = clamp(cam.radiusMul * Math.exp(e.deltaY * 0.0012), 0.2, 5); }

  /* ------------------------------------------------------------------ arm update */
  function updateArm(k, shoulderW, nozzleW) {
    // IK pose (planar 2-link + wrist aligned with reach direction)
    var L1 = ARM_L[0], L2 = ARM_L[1], L3 = ARM_L[2];
    _u.subVectors(nozzleW, shoulderW); var dist = _u.length(); if (dist < 1e-4) { _u.set(1, 0, 0); dist = 1e-4; } _u.multiplyScalar(1 / dist);
    _vv.copy(_Y).addScaledVector(_u, -_Y.dot(_u)); if (_vv.lengthSq() < 1e-6) _vv.set(0, 0, 1); _vv.normalize();
    var r = clamp(dist - L3, 0.25, L1 + L2 - 0.02);
    var c = clamp((r * r - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
    var a2 = -Math.acos(c), a1 = Math.atan2(-L2 * Math.sin(a2), L1 + L2 * Math.cos(a2)), a3 = -(a1 + a2);
    // stowed frame in world = shepherd local axes
    _v1.copy(STOW_U).applyQuaternion(shep.group.quaternion); _v2.copy(STOW_V).applyQuaternion(shep.group.quaternion);
    // blend frames and angles
    _v3.copy(_v1).lerp(_u, k); if (_v3.lengthSq() < 1e-6) _v3.copy(_u); _v3.normalize();
    _v4.copy(_v2).lerp(_vv, k); _v4.addScaledVector(_v3, -_v4.dot(_v3)); if (_v4.lengthSq() < 1e-6) _v4.copy(_vv); _v4.normalize();
    var b1 = ARM_STOW[0] + (a1 - ARM_STOW[0]) * k, b2 = ARM_STOW[1] + (a2 - ARM_STOW[1]) * k, b3 = ARM_STOW[2] + (a3 - ARM_STOW[2]) * k;
    _p[0].copy(shoulderW);
    var ang = b1; _p[1].copy(_p[0]).addScaledVector(_v3, L1 * Math.cos(ang)).addScaledVector(_v4, L1 * Math.sin(ang));
    ang += b2; _p[2].copy(_p[1]).addScaledVector(_v3, L2 * Math.cos(ang)).addScaledVector(_v4, L2 * Math.sin(ang));
    ang += b3; _p[3].copy(_p[2]).addScaledVector(_v3, L3 * Math.cos(ang)).addScaledVector(_v4, L3 * Math.sin(ang));
    for (var i = 0; i < 3; i++) {
      var lg = shep.armLinks[i]; lg.position.copy(_p[i]);
      _dir.subVectors(_p[i + 1], _p[i]).normalize(); _q.setFromUnitVectors(_Y, _dir); lg.quaternion.copy(_q);
    }
    shep.gripper.position.copy(_p[3]); shep.gripper.quaternion.copy(_q);
  }

  /* ------------------------------------------------------------------ public API */
  var prox = {
    init: function (el) {
      if (inited) return;
      container = el;
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(BG, 1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      canvas = renderer.domElement; canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
      container.appendChild(canvas);
      scene = new THREE.Scene(); scene.background = new THREE.Color(BG);
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
      softDot = makeSoftDot(); glowTex = makeGlowTex(); panelTex = makePanelTexture();
      buildEnvironment();
      shep.group = buildShepherd(); scene.add(shep.group);
      scene.add(buildArm());
      buildIbsVisuals();
      kit.box = null;
      rebuildTarget('rocketbody', 6.5, 2.4);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      inited = true;
      this.resize();
    },

    update: function (state, realDt) {
      if (!inited || !state) return;
      var dt = clamp(realDt || 0.016, 0, 0.1);
      var px = state.prox || {};
      var cur = (state.targets && state.current >= 0) ? state.targets[state.current] : null;
      var isKit = state.tech === 'kit';
      var warp = (state.warp && isFinite(state.warp) && state.warp > 0) ? state.warp : 1;
      var simDt = dt * Math.min(warp, 60);
      setEarthRegime(state.regime === 'GEO' ? 'GEO' : 'LEO');

      // ---- target model
      var kind = px.targetKind || (cur && cur.kind) || 'rocketbody';
      var len = px.targetLength || (cur && cur.length) || 6.5, diam = px.targetDiam || (cur && cur.diam) || 2.4;
      var sig = kind + '|' + len.toFixed(2) + '|' + diam.toFixed(2);
      if (sig !== tgt.sig) { tgt.sig = sig; rebuildTarget(kind, len, diam); }
      var tumble = (px.tumble != null ? px.tumble : (cur ? cur.tumble : 0)) || 0;
      tgt.angle += tumble * D2R * simDt;
      tgt.group.quaternion.setFromAxisAngle(tgt.axis, tgt.angle);

      // ---- shepherd: position + yaw so the beam thruster points at the target
      var sp = px.shepPos || { x: -15, y: 0, z: 0 };
      shep.group.position.set(sp.x, sp.y, sp.z);
      _dir.set(-sp.x, 0, -sp.z); if (_dir.lengthSq() < 1e-6) _dir.set(1, 0, 0); _dir.normalize();
      shep.group.rotation.set(0, Math.atan2(-_dir.z, _dir.x), 0);
      var dist = Math.sqrt(sp.x * sp.x + sp.y * sp.y + sp.z * sp.z);
      var sep = (px.sep != null && px.sep > 0) ? px.sep : dist;
      shep.rackGroup.visible = isKit; shep.shoulderMount.visible = isKit; shep.armRoot.visible = isKit;

      // ---- IBS visuals
      var beamOn = !!px.beamOn && !isKit, counterOn = !!px.counterOn && !isKit;
      beamI += ((beamOn ? 1 : 0) - beamI) * expLerp(4, dt);
      counterI += ((counterOn ? 1 : 0) - counterI) * expLerp(4, dt);
      var halfA = px.beamHalfAngleDeg != null ? px.beamHalfAngleDeg : 10;
      var reach = Math.max(1.5, dist - 0.87 - Math.min(tgt.len, tgt.diam) * 0.35);
      beam.set(dt, reach, halfA, beamI, 1);
      counter.set(dt, Math.min(7, 0.5 * dist + 2), 14, counterI, 0.7);
      shep.beamGlow.emissiveIntensity = 1.6 * beamI; shep.counterGlow.emissiveIntensity = 1.6 * counterI;

      var showArrows = beamI > 0.02;
      forceArrowT.visible = forceArrowS.visible = labelForce.sprite.visible = labelFollow.sprite.visible = showArrows;
      var labelH = clamp(0.026 * cam.radius, 0.35, 1.3);
      if (showArrows) {
        var yT = tgt.diam * 0.5 + 0.8;
        forceArrowT.position.set(0, yT, 0); forceArrowT.setDirection(_dir); forceArrowT.setLength(4, 1.1, 0.6);
        labelForce.sprite.position.set(_dir.x * 2, yT + labelH * 0.9, _dir.z * 2); labelForce.setHeight(labelH);
        forceArrowS.position.set(sp.x, sp.y + 1.35, sp.z); forceArrowS.setDirection(_dir); forceArrowS.setLength(3.2, 0.9, 0.5);
        labelFollow.sprite.position.set(sp.x + _dir.x * 1.6, sp.y + 1.35 + labelH * 0.9, sp.z + _dir.z * 1.6); labelFollow.setHeight(labelH);
        forceArrowT.line.material.opacity = forceArrowT.cone.material.opacity = beamI;
        forceArrowS.line.material.opacity = forceArrowS.cone.material.opacity = beamI;
        forceArrowT.line.material.transparent = forceArrowT.cone.material.transparent = true;
        forceArrowS.line.material.transparent = forceArrowS.cone.material.transparent = true;
      }
      var showDim = !isKit;
      standoffLine.visible = standoffTicks.visible = labelStandoff.sprite.visible = showDim;
      if (showDim) {
        var yOff = -(Math.max(tgt.diam, 1.2) * 0.5 + 1.2);
        var a = standoffLine.geometry.attributes.position.array;
        a[0] = sp.x; a[1] = yOff; a[2] = sp.z; a[3] = 0; a[4] = yOff; a[5] = 0;
        standoffLine.geometry.attributes.position.needsUpdate = true; standoffLine.computeLineDistances();
        var t = standoffTicks.geometry.attributes.position.array, tk = 0.35;
        t[0] = sp.x; t[1] = yOff - tk; t[2] = sp.z; t[3] = sp.x; t[4] = yOff + tk; t[5] = sp.z;
        t[6] = 0; t[7] = yOff - tk; t[8] = 0; t[9] = 0; t[10] = yOff + tk; t[11] = 0;
        standoffTicks.geometry.attributes.position.needsUpdate = true;
        var txt = 'standoff ' + Math.round(sep) + ' m';
        if (txt !== lastStandoffText) { lastStandoffText = txt; labelStandoff.setText(txt); }
        labelStandoff.setHeight(labelH); labelStandoff.sprite.position.set(sp.x * 0.5, yOff - labelH * 0.8, sp.z * 0.5);
      }

      // ---- kit visuals
      if (isKit) {
        var kits = (state.shepherd && state.shepherd.kits != null) ? state.shepherd.kits : 0;
        var attached = !!px.kitAttached;
        if (attached && !kit.attached) {          // rising edge: launch a box from the rack
          kit.attached = true; kit.kitsAtAttach = kits;
          if (kit.box && kit.box.parent) kit.box.parent.remove(kit.box);
          if (!kit.box) kit.box = makeKitBox();
          var slotIdx = Math.max(0, Math.min(7, kits - 1));
          shep.group.updateMatrixWorld();
          kit.anim = { t: 0, from: shep.group.localToWorld(shep.rackSlots[slotIdx].clone()) };
          kit.box.position.copy(kit.anim.from); kit.box.quaternion.copy(shep.group.quaternion); scene.add(kit.box);
        } else if (!attached && kit.attached) {   // reset for the next target
          kit.attached = false; kit.anim = null; kit.kitsAtAttach = -1;
          if (kit.box && kit.box.parent) kit.box.parent.remove(kit.box);
        }
        var shown = kits - ((kit.attached && kits === kit.kitsAtAttach) ? 1 : 0);
        for (var i = 0; i < 8; i++) shep.rack[i].visible = i < shown;

        // arm
        var k = smooth(px.arm != null ? px.arm : 0);
        shep.group.updateMatrixWorld(); tgt.group.updateMatrixWorld();
        _sh.copy(SHOULDER_LOCAL); shep.group.localToWorld(_sh);
        _nz.copy(tgt.nozzleLocal); tgt.group.localToWorld(_nz);
        updateArm(k, _sh, _nz);

        // kit transfer animation then parent to target
        if (kit.anim) {
          kit.anim.t += dt / 1.4;
          _kt.copy(tgt.kitLocal); tgt.group.localToWorld(_kt);
          var s = smooth(kit.anim.t);
          kit.box.position.lerpVectors(kit.anim.from, _kt, s);
          kit.box.position.y += Math.sin(s * Math.PI) * 0.6;
          kit.box.quaternion.slerpQuaternions(shep.group.quaternion, tgt.group.quaternion, s);
          if (kit.anim.t >= 1) { kit.anim = null; scene.remove(kit.box); tgt.group.add(kit.box); kit.box.position.copy(tgt.kitLocal); kit.box.quaternion.identity(); }
        }
        // burn plume
        var burn = !!px.kitBurn && kit.attached && !kit.anim;
        kit.plumeI += ((burn ? 1 : 0) - kit.plumeI) * expLerp(6, dt);
        if (kit.plume) {
          var pl = kit.plume, I = kit.plumeI; pl.group.visible = I > 0.02;
          if (pl.group.visible) {
            kit.burnT += dt; var flick = 1 + 0.08 * Math.sin(kit.burnT * 37) + 0.05 * Math.sin(kit.burnT * 53);
            var L = 4.5 * flick, R = 0.55 * flick;
            pl.outer.scale.set(R, L, R); pl.inner.scale.set(R * 0.4, L * 0.75, R * 0.4);
            pl.outer.material.opacity = pl.outer.userData.baseOpacity * I; pl.inner.material.opacity = pl.inner.userData.baseOpacity * I;
            pl.stream.update(dt, L, 0.12, -1, I, 2.0);
            pl.light.intensity = 40 * I * flick;
          }
        }
      } else {
        if (kit.attached) { kit.attached = false; kit.anim = null; if (kit.box && kit.box.parent) kit.box.parent.remove(kit.box); }
        if (kit.plume) kit.plume.group.visible = false;
      }

      // ---- camera
      _v1.set(sp.x * 0.5, sp.y * 0.5, sp.z * 0.5);
      cam.center.lerp(_v1, expLerp(3, dt));
      var wantR = (1.15 * sep + 12) * cam.radiusMul;
      cam.radius += (wantR - cam.radius) * expLerp(3, dt);
      if (!(cam.userOrbit && cam.autoPaused)) cam.theta += 0.07 * dt;
      var cp = Math.cos(cam.phi);
      camera.position.set(cam.center.x + cam.radius * cp * Math.cos(cam.theta), cam.center.y + cam.radius * Math.sin(cam.phi), cam.center.z + cam.radius * cp * Math.sin(cam.theta));
      camera.lookAt(cam.center);
    },

    render: function () { if (inited && visible) renderer.render(scene, camera); },

    resize: function () {
      if (!inited) return;
      var w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    },

    setVisible: function (b) { visible = !!b; if (canvas) canvas.style.display = visible ? 'block' : 'none'; if (visible) this.resize(); },

    setUserOrbit: function (b) { cam.userOrbit = !!b; if (!cam.userOrbit) { cam.autoPaused = false; cam.radiusMul = 1; } },

    /* helper for the lead: separation (m) at which the arm can reach the nozzle for a given target */
    attachSep: function (kind, len, diam) {
      if (kind === 'comsat') return 1.1 + 0.35 + 1.9;
      if (kind === 'smallsat') return 0.5 + 0.22 + 1.9;
      return (len || 6.5) / 2 + 0.5 + bellLength(len || 6.5, diam || 2.4) * 0.55 + 1.9;
    }
  };

  window.SIM.prox = prox;
})();
