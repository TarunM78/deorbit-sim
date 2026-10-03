// fpv.js — first-person "ride along" view: launch pad to the waiting orbit. Attaches SIM.fpv.
// Camera-relative rendering in km: the camera stays near the scene origin, a `world` group (Earth, clouds,
// atmosphere, pad, stars) is offset by -shepherdPos every frame, the vehicle sits at the origin (metres, scaled 1e-3).
(function () {
  'use strict';
  window.SIM = window.SIM || {};

  var P = SIM.phys || {};
  var MU = P.MU || 398600.4418, RE = P.RE || 6378.137, OMEGA_E = P.OMEGA_E || 7.2921159e-5;
  var DEG = Math.PI / 180, TWO_PI = Math.PI * 2;

  var JOURNEY = ['prelaunch', 'ascent', 'parking', 'transfer', 'insert'];
  var PHASE_IDX = { prelaunch: 0, ascent: 1, parking: 2, transfer: 3, insert: 4 };
  var STAGE_CHIP = { pad: 0, liftoff: 0, turn: 1, vacuum: 1, meco: 1, coast: 2, boost: 3, arrive: 4, done: 4 };
  // discrete events, ordered by mission milestone m = phaseIndex + frac (done = 5)
  var EVENTS = [
    ['LIFTOFF', 1.0], ['BOOSTER SEPARATION', 1.35], ['FAIRING OFF', 1.5], ['ENGINE CUTOFF', 1.85],
    ['SOLAR ARRAYS OUT', 2.1], ['BURN 1', 3.0], ['BURN 2', 4.0], ['ARRIVED', 5.0]
  ];
  var SEP_BOOSTER = 1.35, SEP_FAIRING = 1.5, SEP_UPPER = 1.95, ENGINE_OFF = 1.85;
  var STACK_LIFT = 2;          // m: rocket base above the pad surface (launch mount)
  var PROBE_Y = 39.4;          // m: probe bus centre in the stack
  var DEBRIS_LIFE = 6;         // s real: separated parts hidden after this

  // ------------------------------------------------------------------ module state
  var inited = false, visible = true, warned = false;
  var container, renderer, scene, camera, world, earth, earthMat, clouds, cloudMat, cloudInside = false;
  var atmo, atmoMat, stars, starsMat, sun, amb, hemi, fill, fog;
  var pad, padLocal = new THREE.Vector3();
  var earthBase, earthCanvas, earthTex, glowTex, panelTex;
  var trail, trailAttr, trailPos, trailAbs, trailN = 0, trailHead = 0, trailLast = new THREE.Vector3();
  var vehicle, stack, probeSpin, parts = {}, arrays = [], plumes = {};
  var skyLow = new THREE.Color(0x6fb0ff), skyHigh = new THREE.Color(0x0b1128), skyCol = new THREE.Color();
  var Y_AXIS = new THREE.Vector3(0, 1, 0);

  var st = {
    lastState: null, lastT: NaN, lastM: -1, first: true, hasLast: false, probeHome: false, siteKey: '',
    lastPos: new THREE.Vector3(), vel: new THREE.Vector3(), D: 0.18, refOff: new THREE.Vector3(),
    fired: EVENTS.map(function () { return false; }), spin: 0
  };
  var sm = { up: new THREE.Vector3(0, 1, 0), travel: new THREE.Vector3(1, 0, 0), velDir: new THREE.Vector3(0, 1, 0), ok: false };
  var derived = { stage: 'pad', stageIndex: 0, frac: 0, altKm: 0, speedKmh: 0, orbitSpeedKmh: 0, targetAltKm: 0, tPlus: -20, caption: '', eventFlash: null };

  // temporaries (never allocate per frame)
  var _p = new THREE.Vector3(), _gv = new THREE.Vector3(), _up = new THREE.Vector3(), _tr = new THREE.Vector3();
  var _sd = new THREE.Vector3(), _vd = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
  var _c = new THREE.Vector3(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
  var _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

  // ------------------------------------------------------------------ helpers
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smoothstep(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function expK(rate, dt) { return 1 - Math.exp(-rate * dt); }
  function toF(v, out) { return out.set(v.x, v.z, -v.y); }               // ECI km -> three (x, z, -y)
  function latLonToEci(lat, lon, alt, rot) {
    var r = RE + alt, th = lon + rot;
    return { x: r * Math.cos(lat) * Math.cos(th), y: r * Math.cos(lat) * Math.sin(th), z: r * Math.sin(lat) };
  }
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function fmtTarget(km) { // nearest 10 km, thin-space thousands: "35 690"
    var n = Math.round((km || 0) / 10) * 10;
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  function isJourneyPhase(phase) { return JOURNEY.indexOf(phase) >= 0; }
  function stageOf(phase, f) {
    switch (phase) {
      case 'prelaunch': return 'pad';
      case 'ascent': return f < 0.15 ? 'liftoff' : f < 0.45 ? 'turn' : f < 0.85 ? 'vacuum' : 'meco';
      case 'parking': return 'coast';
      case 'transfer': return 'boost';
      case 'insert': return 'arrive';
      default: return 'done';
    }
  }
  function captionFor(stage, f, siteName, target) {
    switch (stage) {
      case 'pad': return 'On the pad at ' + siteName + '. The probe is folded up inside the nose of the rocket.';
      case 'liftoff': return 'Liftoff. The rocket climbs straight up to get out of the thick air near the ground.';
      case 'turn': return "Tilting over. To stay up you don't need height, you need sideways speed. A lot of it.";
      case 'vacuum': return 'Above the air now. The sky has gone black. The engine keeps pushing sideways, faster and faster.';
      case 'meco': return "Engine off. Going sideways so fast that as it falls, the ground curves away underneath. That's orbit.";
      case 'coast': return 'Coasting. A low parking orbit, 200 km up, half a lap around the Earth. No engine needed.';
      case 'boost': return f < 0.08
        ? 'Burn 1. A short push makes the orbit egg-shaped: the far side now reaches up to ' + target + ' km.'
        : "Climbing on the long side of the egg. No engine: it's just the orbit's shape carrying us up.";
      case 'arrive': return 'Burn 2. A second push rounds the orbit off. The probe is now in its waiting orbit at ' + target + ' km.';
      default: return 'Arrived. From here the probe waits for its first piece of debris to drift into line.';
    }
  }

  // ------------------------------------------------------------------ procedural textures
  function makeEarthBase() {
    var W = 2048, H = 1024;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d');
    var X = function (lon) { return (lon + 180) / 360 * W; }, Y = function (lat) { return (90 - lat) / 180 * H; };
    var og = g.createLinearGradient(0, 0, 0, H);
    og.addColorStop(0, '#173f6e'); og.addColorStop(0.5, '#1d5288'); og.addColorStop(1, '#173f6e');
    g.fillStyle = og; g.fillRect(0, 0, W, H);
    var rnd = mulberry(1337);
    for (var k = 0; k < 900; k++) { // ocean mottling
      g.fillStyle = 'rgba(40,110,170,' + (0.05 + rnd() * 0.08).toFixed(3) + ')';
      var r = 10 + rnd() * 50;
      g.beginPath(); g.ellipse(rnd() * W, rnd() * H, r * 1.6, r, rnd() * 3, 0, TWO_PI); g.fill();
    }
    // land blobs: rough continents [lonCentre, latCentre, rxDeg, ryDeg, rotation] (same set as the orbit view)
    var blobs = [
      [-100, 45, 32, 22, -0.3], [-110, 62, 28, 10, 0.2], [-85, 20, 12, 9, 0.6],
      [-60, -15, 16, 24, 0.15], [-70, -40, 6, 14, 0.1],
      [20, 10, 22, 26, 0.0], [25, -15, 16, 16, 0.0], [35, 30, 12, 6, 0.0],
      [30, 55, 40, 16, 0.0], [90, 55, 55, 18, 0.0], [110, 35, 22, 14, 0.0],
      [75, 22, 10, 12, 0.3], [-5, 45, 12, 8, 0.0], [45, 25, 12, 10, 0.4],
      [134, -25, 18, 12, 0.0], [-42, 72, 10, 8, 0.0], [105, 0, 16, 6, 0.3]
    ];
    var rnd2 = mulberry(4242);
    for (var b = 0; b < blobs.length; b++) {
      var lo = blobs[b][0], la = blobs[b][1], rx = blobs[b][2], ry = blobs[b][3], rot = blobs[b][4];
      for (var j = 0; j < 90; j++) {
        var ang = rnd2() * TWO_PI, rr = Math.sqrt(rnd2());
        var dx = Math.cos(ang) * rr * rx, dy = Math.sin(ang) * rr * ry;
        var lon = lo + dx * Math.cos(rot) - dy * Math.sin(rot);
        var lat = la + dx * Math.sin(rot) + dy * Math.cos(rot);
        var green = 0.35 + 0.5 * Math.max(0, 1 - Math.abs(lat) / 60);
        var cr = Math.round(90 + 70 * (1 - green)), cg = Math.round(90 + 70 * green), cb = Math.round(50 + 30 * (1 - green));
        g.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.9)';
        var rad = (rx + ry) * 0.045 * (0.6 + rnd2() * 0.8);
        g.beginPath(); g.ellipse(X(lon), Y(lat), rad * W / 360, rad * H / 180, 0, 0, TWO_PI); g.fill();
      }
    }
    for (var s = 1; s >= -1; s -= 2) { // polar caps
      var y0 = Y(s * 90), y1 = Y(s * 66);
      var pg = g.createLinearGradient(0, y0, 0, y1);
      pg.addColorStop(0, 'rgba(235,242,250,1)'); pg.addColorStop(0.7, 'rgba(225,235,245,0.85)'); pg.addColorStop(1, 'rgba(225,235,245,0)');
      g.fillStyle = pg; g.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
    }
    return c;
  }
  function applySiteToTexture(lat, lon) { // small land patch + orange ring at the launch site
    var W = earthCanvas.width, H = earthCanvas.height;
    var g = earthCanvas.getContext('2d');
    g.drawImage(earthBase, 0, 0);
    var x = (lon / DEG + 180) / 360 * W, y = (90 - lat / DEG) / 180 * H;
    g.fillStyle = '#5f7645'; g.beginPath(); g.arc(x, y, 4, 0, TWO_PI); g.fill();
    g.strokeStyle = '#ff9a3c'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 8, 0, TWO_PI); g.stroke();
    earthTex.needsUpdate = true;
  }
  function makeCloudTexture() {
    var W = 1024, H = 512;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d');
    var rnd = mulberry(2024);
    for (var k = 0; k < 460; k++) {
      var cx = rnd() * W, cy = H * (0.5 + 0.44 * (rnd() * 2 - 1)), r = 10 + rnd() * 34, a = 0.12 + rnd() * 0.38;
      var sx = 1.3 + rnd() * 1.6;
      g.save(); g.translate(cx, cy); g.scale(sx, 1);
      var rg = g.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')'); rg.addColorStop(0.55, 'rgba(255,255,255,' + (a * 0.55).toFixed(3) + ')'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(0, 0, r, 0, TWO_PI); g.fill();
      g.restore();
    }
    for (var w = 0; w < 60; w++) { // thin streaks
      g.strokeStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.12).toFixed(3) + ')'; g.lineWidth = 2 + rnd() * 5;
      var x0 = rnd() * W, y0 = rnd() * H;
      g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(x0 + 40, y0 - 10 + rnd() * 20, x0 + 90, y0 + 10 - rnd() * 20, x0 + 140 + rnd() * 80, y0); g.stroke();
    }
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4;
    return t;
  }
  function makeGlowTex() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d'); var r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function makePanelTexture() {
    var c = document.createElement('canvas'); c.width = 128; c.height = 64;
    var g = c.getContext('2d');
    g.fillStyle = '#152452'; g.fillRect(0, 0, 128, 64);
    g.strokeStyle = '#3a5aa8'; g.lineWidth = 1.5;
    for (var x = 0; x <= 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
    for (var y = 0; y <= 64; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 4);
    return t;
  }
  function makeGroundTex() { // feathered land disc (hides the sphere facets near the pad)
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d'); var r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, 'rgba(92,110,66,1)'); r.addColorStop(0.5, 'rgba(92,110,66,1)'); r.addColorStop(1, 'rgba(92,110,66,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ------------------------------------------------------------------ build: environment
  function buildWorld() {
    world = new THREE.Group(); scene.add(world);
    earthBase = makeEarthBase();
    earthCanvas = document.createElement('canvas'); earthCanvas.width = earthBase.width; earthCanvas.height = earthBase.height;
    earthCanvas.getContext('2d').drawImage(earthBase, 0, 0);
    earthTex = new THREE.CanvasTexture(earthCanvas); earthTex.colorSpace = THREE.SRGBColorSpace; earthTex.anisotropy = 4;
    earthMat = new THREE.MeshStandardMaterial({ map: earthTex, roughness: 0.85, metalness: 0 });
    // 256x128: facet sagitta stays < 0.5 km so the pad's local ground disc can hide the polygon edges
    earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 256, 128), earthMat);
    world.add(earth);

    cloudMat = new THREE.MeshStandardMaterial({ map: makeCloudTexture(), transparent: true, opacity: 0.6, depthWrite: false, roughness: 1, metalness: 0, side: THREE.FrontSide, depthTest: false });
    clouds = new THREE.Mesh(new THREE.SphereGeometry(RE + 8, 96, 64), cloudMat);
    clouds.renderOrder = 2;
    world.add(clouds);

    atmoMat = new THREE.ShaderMaterial({
      uniforms: { col: { value: new THREE.Color(0x6fb2ff) }, str: { value: 0.9 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 col; uniform float str; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0-abs(dot(vN,vV)); f = pow(f,5.0); gl_FragColor = vec4(col, f*str); }',
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.BackSide
    });
    atmo = new THREE.Mesh(new THREE.SphereGeometry(RE + 90, 96, 64), atmoMat);
    atmo.renderOrder = 3;
    world.add(atmo);

    (function () { // stars
      var N = 2500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), rnd = mulberry(99);
      for (var i = 0; i < N; i++) {
        var u = rnd() * 2 - 1, ph = rnd() * TWO_PI, r = 30000 + rnd() * 6000, s = Math.sqrt(1 - u * u);
        pos[3 * i] = r * s * Math.cos(ph); pos[3 * i + 1] = r * u; pos[3 * i + 2] = r * s * Math.sin(ph);
        var b = 0.35 + Math.pow(rnd(), 3) * 0.65, tint = rnd();
        col[3 * i] = b * (0.85 + 0.15 * tint); col[3 * i + 1] = b * (0.88 + 0.08 * tint); col[3 * i + 2] = b * (0.95 + 0.05 * (1 - tint));
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      starsMat = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
      stars = new THREE.Points(g, starsMat); stars.frustumCulled = false; stars.visible = false;
      world.add(stars);
    })();

    // launch pad (child of the Earth mesh so it rotates with the ground); built in km, local +Y = radial
    pad = new THREE.Group();
    var ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ map: makeGroundTex(), transparent: true, depthWrite: false, roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = 0.00005; ground.renderOrder = 1; pad.add(ground);
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0x4a5540, roughness: 1, metalness: 0 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.0003; pad.add(ring);
    var disc = new THREE.Mesh(new THREE.CircleGeometry(0.1, 48), new THREE.MeshStandardMaterial({ color: 0x8a8d93, roughness: 0.9, metalness: 0.05 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.0005; pad.add(disc);
    var mount = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.0012, 0.006), new THREE.MeshStandardMaterial({ color: 0x555a63, roughness: 0.7, metalness: 0.4 }));
    mount.position.y = 0.0005 + 0.0006; pad.add(mount);
    var tower = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.09, 0.005), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.6, metalness: 0.5 }));
    tower.position.set(0.012, 0.045, 0.004); pad.add(tower);
    earth.add(pad);

    // trail: 40 points behind the vehicle, positions rewritten camera-relative every frame
    trailPos = new Float32Array(40 * 3); trailAbs = new Float64Array(40 * 3);
    var tg = new THREE.BufferGeometry();
    trailAttr = new THREE.BufferAttribute(trailPos, 3); trailAttr.setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', trailAttr); tg.setDrawRange(0, 0);
    trail = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xffd9a0, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.35, depthWrite: false }));
    trail.frustumCulled = false; trail.visible = false;
    scene.add(trail);

    // lights: sun from ECI +X (scene +X); sky light ramps up near the ground so the pad reads as daytime
    sun = new THREE.DirectionalLight(0xfff2dc, 2.2); sun.position.set(1, 0, 0); scene.add(sun);
    amb = new THREE.AmbientLight(0x9aa8c8, 0.25); scene.add(amb);
    hemi = new THREE.HemisphereLight(0xdde8ff, 0x5a6a50, 0.3); scene.add(hemi);
    fill = new THREE.DirectionalLight(0xfff6e8, 0.35); fill.position.set(0, 0.2, 0.2); scene.add(fill);
  }

  // ------------------------------------------------------------------ build: vehicle (metres, scaled 1e-3 by the vehicle group)
  function makePlume(color, innerColor, radius, length, spriteN, spriteScale) {
    var g = new THREE.Group();
    var outer = new THREE.Mesh(new THREE.ConeGeometry(radius, length, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    outer.rotation.x = Math.PI; outer.position.y = -length / 2; g.add(outer);
    var inner = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.55, length * 0.55, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: innerColor, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    inner.rotation.x = Math.PI; inner.position.y = -length * 0.275; g.add(inner);
    var sprites = [];
    for (var i = 0; i < spriteN; i++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: innerColor, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sp.position.y = -(0.6 + i * 1.6) * spriteScale * 0.5; sp.scale.set(spriteScale, spriteScale, 1); sp.userData.base = spriteScale * (1 - 0.18 * i);
      g.add(sp); sprites.push(sp);
    }
    g.visible = false;
    return { group: g, outer: outer, inner: inner, sprites: sprites, baseOuter: 0.4, baseInner: 0.7 };
  }
  function flicker(pl) {
    if (!pl.group.visible) return;
    pl.outer.material.opacity = pl.baseOuter * (0.85 + 0.3 * Math.random());
    pl.inner.material.opacity = pl.baseInner * (0.8 + 0.4 * Math.random());
    for (var i = 0; i < pl.sprites.length; i++) { var s = pl.sprites[i].userData.base * (0.8 + 0.4 * Math.random()); pl.sprites[i].scale.set(s, s, 1); }
  }
  function makePart(name, holder, parent, kind) {
    parent.add(holder);
    var part = { name: name, holder: holder, kind: kind, status: 'attached', homeParent: parent, t: 0,
      homePos: holder.position.clone(), homeQuat: holder.quaternion.clone(),
      p0: new THREE.Vector3(), out: new THREE.Vector3(), axis: new THREE.Vector3(), rate: 0 };
    parts[name] = part;
    return part;
  }
  function buildVehicle() {
    vehicle = new THREE.Group(); vehicle.scale.setScalar(1e-3); scene.add(vehicle);
    stack = new THREE.Group(); stack.position.y = STACK_LIFT; vehicle.add(stack);
    var white = new THREE.MeshStandardMaterial({ color: 0xf1f3f6, roughness: 0.55, metalness: 0.1 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.6 });
    var metal = new THREE.MeshStandardMaterial({ color: 0x5c626c, roughness: 0.4, metalness: 0.8 });
    var teal = new THREE.MeshStandardMaterial({ color: 0x3ecfb5, roughness: 0.5, metalness: 0.3 });
    var panel = new THREE.MeshStandardMaterial({ map: panelTex, roughness: 0.35, metalness: 0.5 });

    // first stage: 0..28 m
    var booster = new THREE.Group();
    var b1 = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 28, 32), white); b1.position.y = 14; booster.add(b1);
    var band = new THREE.Mesh(new THREE.CylinderGeometry(1.87, 1.87, 2.2, 32), dark); band.position.y = 26.9; booster.add(band);
    var finGeo = new THREE.BoxGeometry(0.12, 4.2, 2.2), bellGeo = new THREE.CylinderGeometry(0.35, 0.75, 1.6, 16, 1, true);
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2;
      var fin = new THREE.Mesh(finGeo, white); fin.position.set(Math.cos(a) * 2.75, 2.1, Math.sin(a) * 2.75); fin.rotation.y = -a; booster.add(fin);
      var bell = new THREE.Mesh(bellGeo, metal); bell.position.set(Math.cos(a + Math.PI / 4) * 1.05, -0.8, Math.sin(a + Math.PI / 4) * 1.05); booster.add(bell);
    }
    plumes.main = makePlume(0xff7a2a, 0xffe2a8, 2.4, 25, 3, 7); plumes.main.group.position.y = -1.6; booster.add(plumes.main.group);
    makePart('booster', booster, stack, 'booster');

    // second stage: 28..38 m
    var upper = new THREE.Group(); upper.position.y = 28;
    var u1 = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 10, 32), white); u1.position.y = 5; upper.add(u1);
    var ubell = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.95, 2.2, 16, 1, true), metal); ubell.position.y = -1.1; upper.add(ubell);
    var adapter = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.85, 0.8, 32), dark); adapter.position.y = 10.4; upper.add(adapter);
    plumes.upper = makePlume(0xff8a3a, 0xfff0c0, 1.6, 12, 2, 4); plumes.upper.group.position.y = -2.2; upper.add(plumes.upper.group);
    makePart('upper', upper, stack, 'upper');

    // fairing halves: 38..45 m, half lathes so they split along the vehicle X axis
    var prof = [new THREE.Vector2(2.1, 0), new THREE.Vector2(2.1, 4), new THREE.Vector2(1.6, 5.5), new THREE.Vector2(0.6, 6.8), new THREE.Vector2(0.0, 7.0)];
    var fairMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide });
    for (var h = 0; h < 2; h++) {
      var fg = new THREE.Group(); fg.position.y = 38; fg.rotation.y = h * Math.PI;
      fg.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 24, 0, Math.PI), fairMat));
      var part = makePart(h === 0 ? 'fairA' : 'fairB', fg, stack, 'fairing');
      part.side = h === 0 ? 1 : -1;
    }

    // probe: bus 1.2 m teal with dark band, two 4 m arrays on ±Z that unfold, thruster on -X
    var probe = new THREE.Group(); probe.position.y = PROBE_Y; probe.rotation.z = Math.PI / 2; // probe +X along the rocket axis
    probeSpin = new THREE.Group(); probe.add(probeSpin);
    probeSpin.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), teal));
    var bandP = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.42, 1.22), dark); bandP.position.y = -0.25; probeSpin.add(bandP);
    var thr = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.3, 16, 1, true), metal); thr.rotation.z = Math.PI / 2; thr.position.x = -0.72; probeSpin.add(thr);
    for (var s = -1; s <= 1; s += 2) {
      var pivot = new THREE.Group(); pivot.position.z = s * 0.6; probeSpin.add(pivot);
      var yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), dark); yoke.rotation.x = Math.PI / 2; yoke.position.z = s * 0.25; pivot.add(yoke);
      var arr = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 4), panel); arr.position.z = s * 2.5; pivot.add(arr);
      arrays.push({ pivot: pivot, sign: s });
    }
    plumes.probe = makePlume(0x4a8cff, 0xcfe6ff, 0.55, 3.0, 2, 1.6);
    plumes.probe.group.rotation.z = Math.PI / 2; plumes.probe.group.position.x = -0.85; probeSpin.add(plumes.probe.group);
    probe.visible = false;
    makePart('probe', probe, stack, 'probe');
    setArrays(1);
  }
  function setArrays(fold) { // 1 = folded flat alongside the bus (+X), 0 = extended on ±Z
    for (var i = 0; i < arrays.length; i++) arrays[i].pivot.rotation.y = arrays[i].sign * fold * Math.PI / 2;
  }

  // ------------------------------------------------------------------ separation / reset
  function separate(part, animate) {
    if (part.status !== 'attached') return;
    if (!animate) { part.status = 'gone'; part.holder.visible = false; return; }
    part.holder.getWorldPosition(_a); part.holder.getWorldQuaternion(_q);
    scene.add(part.holder);
    part.holder.position.copy(_a); part.holder.quaternion.copy(_q); part.holder.scale.setScalar(1e-3);
    part.p0.copy(_a); part.t = 0; part.status = 'flying';
    if (part.kind === 'fairing') { part.out.set(part.side, 0, 0).applyQuaternion(_q); part.axis.set(0, 0, 1); part.rate = 0.35 * part.side; }
    else if (part.kind === 'booster') { part.axis.set(0.3, 0.1, 1).normalize(); part.rate = 0.25; }
    else { part.axis.set(1, 0.2, 0.4).normalize(); part.rate = 0.15; }
  }
  function animateDebris(part, dt) {
    if (part.status !== 'flying') return;
    part.t += dt;
    if (part.t > DEBRIS_LIFE) { part.status = 'gone'; part.holder.visible = false; return; }
    var t = part.t, h = part.holder;
    h.position.copy(part.p0);
    if (part.kind === 'booster') { h.position.addScaledVector(sm.travel, -(0.006 * t + 0.012 * t * t)).addScaledVector(sm.up, -0.004 * t * t); }
    else if (part.kind === 'fairing') { h.position.addScaledVector(part.out, 0.004 * t + 0.004 * t * t).addScaledVector(sm.travel, -(0.004 * t + 0.008 * t * t)).addScaledVector(sm.up, -0.002 * t * t); }
    else { h.position.addScaledVector(sm.travel, -(0.0015 * t + 0.0025 * t * t)).addScaledVector(sm.up, -0.0008 * t * t); }
    _q2.setFromAxisAngle(part.axis, part.rate * dt); h.quaternion.multiply(_q2);
  }
  function resetAll() {
    for (var k in parts) {
      var part = parts[k];
      part.homeParent.add(part.holder);
      part.holder.position.copy(part.homePos); part.holder.quaternion.copy(part.homeQuat); part.holder.scale.setScalar(1);
      part.holder.visible = k !== 'probe'; part.status = 'attached'; part.t = 0;
    }
    vehicle.position.set(0, 0, 0); probeSpin.rotation.set(0, 0, 0);
    st.probeHome = false; st.hasLast = false; st.vel.set(0, 0, 0); st.first = true; sm.ok = false;
    for (var i = 0; i < st.fired.length; i++) st.fired[i] = false;
    setArrays(1);
    plumes.main.group.visible = plumes.upper.group.visible = plumes.probe.group.visible = false;
    trailN = 0; trailHead = 0; trail.visible = false; trail.geometry.setDrawRange(0, 0);
  }
  function rehomeProbe() { // the probe becomes the vehicle: absorb its stack transform into the vehicle group
    var probe = parts.probe.holder;
    probe.getWorldPosition(_a); probe.getWorldQuaternion(_q);
    _b.copy(_a).sub(vehicle.position);
    vehicle.position.copy(_a); vehicle.quaternion.copy(_q);
    vehicle.add(probe); probe.position.set(0, 0, 0); probe.quaternion.identity(); probe.scale.setScalar(1);
    st.refOff.sub(_b);
    st.probeHome = true;
  }

  // ------------------------------------------------------------------ init / api
  function init(el) {
    if (inited) return;
    container = el;
    try { if (getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch (e) { /* ignore */ }
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(skyLow, 1);
    var cv = renderer.domElement;
    cv.style.position = 'absolute'; cv.style.inset = '0'; cv.style.width = '100%'; cv.style.height = '100%'; cv.style.display = 'block';
    container.appendChild(cv);

    scene = new THREE.Scene();
    fog = new THREE.FogExp2(skyLow.getHex(), 0.06); scene.fog = fog;
    camera = new THREE.PerspectiveCamera(55, 1, 0.002, 60000);
    glowTex = makeGlowTex(); panelTex = makePanelTexture();
    buildWorld(); buildVehicle();
    inited = true;
    resize();
    if (typeof ResizeObserver !== 'undefined') { try { new ResizeObserver(function () { resize(); }).observe(container); } catch (e) { /* ignore */ } }
    if (SIM.fpvHud && SIM.fpvHud.init) SIM.fpvHud.init(container);
  }
  function resize() {
    if (!inited) return;
    var w = container.clientWidth, h = container.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function render() { if (inited && visible) renderer.render(scene, camera); }
  function setVisible(b) {
    visible = !!b;
    if (renderer) renderer.domElement.style.display = visible ? 'block' : 'none';
    if (visible) resize();
    if (SIM.fpvHud && SIM.fpvHud.setVisible) SIM.fpvHud.setVisible(visible);
  }
  function setUserOrbit() { /* v1: autoplay chase camera only */ }

  function update(state, realDt) {
    if (!inited || !state || !state.shepherd || !state.shepherd.pos) return;
    try { step(state, realDt); }
    catch (e) { if (!warned) { warned = true; console.error('[fpv] update failed', e); } }
  }

  // ------------------------------------------------------------------ per-frame
  function step(state, realDt) {
    var dt = clamp(+realDt || 0, 0, 0.1);
    var sh = state.shepherd, phase = state.phase;
    var pi = PHASE_IDX.hasOwnProperty(phase) ? PHASE_IDX[phase] : 5;
    var f = (state.phaseDur > 0 && isFinite(state.phaseDur)) ? clamp(state.phaseT / state.phaseDur, 0, 1) : 0;
    var m = pi >= 5 ? 5 : pi + f;                       // mission milestone, monotonic during a run
    var t = +state.t || 0;

    // restart detection (new state object, time going backwards, or milestone going backwards)
    if (state !== st.lastState || (st.hasLast && t < st.lastT - 1e-6) || m < st.lastM - 0.05) { resetAll(); st.lastState = state; }
    st.lastM = m;

    // position / velocity (km, km/s; scene frame)
    toF(sh.pos, _p);
    var vel = sh.vel;
    if (vel && (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) > 1e-12) toF(vel, st.vel);
    else if (st.hasLast && t > st.lastT + 1e-9) st.vel.copy(_p).sub(st.lastPos).divideScalar(t - st.lastT);
    if (!st.hasLast || t !== st.lastT) { st.lastPos.copy(_p); st.lastT = t; st.hasLast = true; }
    var r = _p.length(); if (!(r > 1)) { _p.set(RE, 0, 0); r = RE; }
    var alt = r - RE;

    // basis: up (radial), ground-relative velocity, travel (horizontal), velDir (full)
    _up.copy(_p).divideScalar(r);
    _gv.set(_p.z, 0, -_p.x).multiplyScalar(-OMEGA_E).add(st.vel);     // vel - omega (Y x pos)
    var gspeed = _gv.length();
    _vd.copy(_gv);
    if (gspeed > 1e-4) _vd.divideScalar(gspeed); else _vd.copy(_up);
    _tr.copy(_gv).addScaledVector(_up, -_gv.dot(_up));
    if (_tr.lengthSq() > 1e-8) _tr.normalize();
    else { _tr.set(_up.z, 0, -_up.x); if (_tr.lengthSq() > 1e-12) _tr.normalize(); else _tr.set(1, 0, 0); }   // local east on the pad
    if (!sm.ok) { sm.up.copy(_up); sm.travel.copy(_tr); sm.velDir.copy(_vd); sm.ok = true; }
    else {
      var ks = expK(3, dt);
      sm.up.lerp(_up, ks).normalize();
      sm.travel.lerp(_tr, ks); sm.travel.addScaledVector(sm.up, -sm.travel.dot(sm.up));
      if (sm.travel.lengthSq() > 1e-10) sm.travel.normalize(); else sm.travel.copy(_tr);
      sm.velDir.lerp(_vd, ks); if (sm.velDir.lengthSq() > 1e-10) sm.velDir.normalize(); else sm.velDir.copy(_vd);
    }
    _sd.crossVectors(sm.travel, sm.up); if (_sd.lengthSq() > 1e-10) _sd.normalize(); else _sd.set(0, 0, 1);

    // sky, fog, stars, atmosphere strength, ground sky-light
    var sf = smoothstep(alt / 90);
    skyCol.lerpColors(skyLow, skyHigh, sf);
    renderer.setClearColor(skyCol, 1); fog.color.copy(skyCol);
    fog.density = 0.06 * (1 - smoothstep(alt / 40));
    starsMat.opacity = 0.95 * sf; stars.visible = sf > 0.01;
    atmoMat.uniforms.str.value = 0.25 + 0.5 * sf;
    hemi.intensity = 0.3 + 1.7 * (1 - sf);
    fill.intensity = 0.35 + 0.7 * (1 - sf);
    var inside = alt < 8;
    if (inside !== cloudInside) { cloudInside = inside; cloudMat.side = inside ? THREE.BackSide : THREE.FrontSide; cloudMat.depthTest = inside; cloudMat.needsUpdate = true; }

    // world placement
    world.position.copy(_p).negate();
    var rot = +state.earthRot || 0;
    earth.rotation.y = rot; clouds.rotation.y = rot + t * 1.5e-6;

    // launch site: pad on the Earth mesh + ring on the texture
    var site = (state.launch && state.launch.site) || null;
    var lat = site ? +site.lat || 0 : 0, lon = site ? +site.lon || 0 : 0;
    var key = lat.toFixed(6) + ',' + lon.toFixed(6);
    if (key !== st.siteKey) {
      st.siteKey = key;
      toF(latLonToEci(lat, lon, 0, 0), padLocal);
      pad.position.copy(padLocal);
      pad.quaternion.setFromUnitVectors(Y_AXIS, _a.copy(padLocal).normalize());
      applySiteToTexture(lat, lon);
    }

    // vehicle configuration from the milestone
    var boosterOn = m < SEP_BOOSTER, fairOn = m < SEP_FAIRING, upperOn = m < SEP_UPPER, alone = !upperOn;
    var engine = pi === 1 && m < ENGINE_OFF;
    var fold = m < 2 ? 1 : m < 2.1 ? 1 - (m - 2) / 0.1 : 0;
    var probeBurn = (m >= 3 && m < 3.08) || pi === 4;
    setArrays(smoothstep(fold));

    // attitude target
    if (!alone) {
      if (pi === 0 || m < 1.08) _a.copy(sm.up);
      else if (m < 1.5) { _q.setFromUnitVectors(sm.up, sm.velDir); _q2.identity().slerp(_q, smoothstep((m - 1.08) / 0.42)); _a.copy(sm.up).applyQuaternion(_q2); }
      else _a.copy(sm.velDir);
      _z.copy(_sd).addScaledVector(_a, -_sd.dot(_a)); if (_z.lengthSq() > 1e-10) _z.normalize(); else _z.set(0, 0, 1);
      _x.crossVectors(_a, _z).normalize();
      _m.makeBasis(_x, _a, _z);
    } else {
      _x.copy(sm.travel); _z.copy(_sd); _a.crossVectors(_z, _x).normalize();
      _m.makeBasis(_x, _a, _z);
    }
    _q.setFromRotationMatrix(_m);
    if (st.first) vehicle.quaternion.copy(_q); else vehicle.quaternion.slerp(_q, expK(4, dt));
    if (alone) {
      if (!st.probeHome) rehomeProbe();
      vehicle.position.multiplyScalar(Math.exp(-dt));      // drift the origin back onto the shepherd position
      st.spin += 2 * DEG * dt; probeSpin.rotation.x = st.spin;
    }

    // staging
    var anim = !st.first;
    if (!boosterOn) separate(parts.booster, anim);
    if (!fairOn) { separate(parts.fairA, anim); separate(parts.fairB, anim); parts.probe.holder.visible = true; }
    if (!upperOn) separate(parts.upper, anim);
    for (var k in parts) animateDebris(parts[k], dt);
    plumes.main.group.visible = engine && boosterOn;
    plumes.upper.group.visible = engine && !boosterOn && upperOn;
    plumes.probe.group.visible = probeBurn && alone;
    flicker(plumes.main); flicker(plumes.upper); flicker(plumes.probe);

    // chase camera
    var visLen = boosterOn ? 45 : fairOn ? 17 : upperOn ? 14 : 6;
    var centre = boosterOn ? 22.5 : fairOn ? 36.5 : upperOn ? 35 : 0;
    var D = 4e-3 * visLen;
    st.D = st.first ? D : st.D + (D - st.D) * expK(1.5, dt);
    if (alone) _a.set(0, 0, 0); else _a.set(0, (STACK_LIFT + centre) * 1e-3, 0).applyQuaternion(vehicle.quaternion);
    if (st.first) st.refOff.copy(_a); else st.refOff.lerp(_a, expK(2, dt));
    _b.copy(vehicle.position).add(st.refOff);                                 // reference point (km, camera-relative)
    var Ds = st.D;
    camera.position.copy(_b).addScaledVector(sm.travel, -Ds).addScaledVector(sm.up, 0.45 * Ds).addScaledVector(_sd, 0.35 * Ds);
    camera.up.copy(sm.up);
    _c.copy(_b).addScaledVector(sm.travel, 0.6 * Ds);
    camera.lookAt(_c);
    fill.position.copy(camera.position).addScaledVector(sm.up, 0.3 * Ds);

    // derived for the HUD
    var stage = stageOf(phase, f);
    var flash = null;
    for (var e = 0; e < EVENTS.length; e++) {
      if (!st.fired[e] && m >= EVENTS[e][1] - 1e-9) { st.fired[e] = true; if (!st.first) flash = EVENTS[e][0]; }
    }
    derived.stage = stage;
    derived.stageIndex = STAGE_CHIP[stage];
    derived.frac = f;
    derived.altKm = alt;
    derived.speedKmh = gspeed * 3600;
    derived.orbitSpeedKmh = Math.sqrt(MU / r) * 3600;
    derived.targetAltKm = +sh.parkAlt || 0;
    derived.tPlus = phase === 'prelaunch' ? t - 20 : t;
    derived.caption = captionFor(stage, f, site && site.name ? site.name : 'the launch site', fmtTarget(derived.targetAltKm));
    derived.eventFlash = flash;

    // trail (absolute ECI km in trailAbs, rewritten relative to the vehicle every frame)
    if (stage !== 'pad' && gspeed > 0.05) {
      _a.copy(_p).sub(trailLast);
      if (trailN > 0 && _a.dot(st.vel) < 0) { trailN = 0; trailHead = 0; }   // position jumped backwards: discontinuity, drop the trail
      if (trailN === 0 || _a.lengthSq() > 1e-4) {
        var idx = trailHead * 3; trailAbs[idx] = _p.x; trailAbs[idx + 1] = _p.y; trailAbs[idx + 2] = _p.z;
        trailHead = (trailHead + 1) % 40; if (trailN < 40) trailN++; trailLast.copy(_p);
      }
    }
    if (trailN > 0 && stage !== 'pad') {
      for (var i = 0; i < trailN; i++) { var j = i * 3; trailPos[j] = trailAbs[j] - _p.x; trailPos[j + 1] = trailAbs[j + 1] - _p.y; trailPos[j + 2] = trailAbs[j + 2] - _p.z; }
      trailAttr.needsUpdate = true; trail.geometry.setDrawRange(0, trailN); trail.visible = true;
    } else trail.visible = false;

    st.first = false;
    if (SIM.fpvHud && SIM.fpvHud.update) SIM.fpvHud.update(state, derived);
  }

  SIM.fpv = {
    init: init, update: update, render: render, resize: resize, setVisible: setVisible, setUserOrbit: setUserOrbit,
    isJourneyPhase: isJourneyPhase,
    info: function () { return renderer ? renderer.info.render.calls : 0; }
  };
})();
