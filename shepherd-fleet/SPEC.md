# Shepherd Fleet sim — module interface spec

Single-page app, plain scripts (no modules/bundler), three.js 0.160.0 UMD from cdnjs as global `THREE`.
Files (all in this folder), loaded in this order by `index.html`:

```
js/physics.js    -> window.SIM.phys      (owner: lead)
js/scenarios.js  -> window.SIM.scenarios (owner: lead)
js/mission.js    -> window.SIM.mission   (owner: lead)  state machine, owns SIM.state
js/scene.js      -> window.SIM.scene     (owner: agent A) orbit-scale 3D view
js/prox.js       -> window.SIM.prox      (owner: agent B) proximity-scale 3D view
js/app.js        -> glue, UI, RAF loop   (owner: lead)
```

`window.SIM = {}` is created by physics.js. Every module attaches to it and must not touch other modules' internals.
Each view module owns ONE `THREE.WebGLRenderer` canvas appended into the container it is given. app.js toggles which
canvas is visible via `setVisible(bool)`; both get `resize()` on window resize.

## Frames and units

* **ECI (physics):** right-handed, km, Earth spin axis = +Z, +X = vernal equinox. Angles in radians.
* **three.js orbit view:** `SIM.phys.toScene(v)` maps ECI km -> `THREE.Vector3` scene units where **1 unit = 1000 km**,
  Earth axis = scene +Y. Implemented as `(x, y, z)_ECI -> (x, z, -y)` scaled by 1e-3. Agent A must use it for every
  position and for orbit curves. Earth radius is 6.378137 units.
* **Proximity view (LVLH, metres):** target centre of mass at origin. +X = along-track (prograde), +Y = radial outward
  (zenith), +Z = cross-track (completes right-handed). Shepherd position is given by `state.prox.shepPos` (metres).
* Time: `state.t` = seconds since mission epoch (launch T-0). `state.earthRot` = Earth rotation angle about +Z (rad).

## Orbital elements object

```js
el = { a, e, i, raan, argp, M }   // km, -, rad, rad, rad, rad (mean anomaly at state.t)
```
Helpers in `SIM.phys` (available to A and B):

```js
SIM.phys.MU, RE, J2, DAY, GEO_R, OMEGA_E   // 398600.4418 km^3/s^2, 6378.137 km, 1.08263e-3, 86400, 42164.17 km, 7.2921159e-5 rad/s
SIM.phys.posFromEl(el)          -> {x,y,z} km ECI at el.M (solves Kepler)
SIM.phys.orbitPoints(el, n=180) -> Array<{x,y,z}> km ECI, one full revolution of the ellipse (for drawing)
SIM.phys.toScene({x,y,z})       -> THREE.Vector3 (scene units)
SIM.phys.raanRate(a,e,i)        -> rad/s  (J2 nodal regression)
SIM.phys.meanMotion(a)          -> rad/s
SIM.phys.latLonToEci(latRad, lonRad, altKm, earthRot) -> {x,y,z}
SIM.phys.eciToLatLon({x,y,z}, earthRot) -> {lat, lon} rad (geodetic approx = geocentric)
```

## `SIM.state` schema (read-only for A and B; written only by mission.js/app.js)

```js
state = {
  regime: 'LEO' | 'GEO',
  tech:   'ibs' | 'kit',                 // ibs = contactless ion beam, kit = robotic-arm descent kit
  scenario: { id, name, cluster:{ alt, inc, count, ... } },   // see scenarios.js
  t, dt,                                 // sim seconds since T-0, last step size
  earthRot,                              // rad
  phase: string,                         // see Phase keys below
  phaseT, phaseDur,                      // seconds into phase, phase length (may be Infinity for 'wait')
  warp,                                  // current sim seconds per real second
  events: [ {t, text} ],                 // newest last, max 40; UI shows them
  launch: {                              // valid while phase in ['prelaunch','ascent','parking','transfer','insert']
    site: {lat, lon, name},
    path: Array<{x,y,z}>,                // km ECI, ascent track computed so far (scene draws as trail)
  },
  shepherd: {
    el, pos:{x,y,z}, vel:{x,y,z},        // pos/vel km, km/s ECI; el updated every step
    dryMass, prop, propCap,              // kg (xenon)
    kits, kitsCap,                       // integers; kit tech only
    dvUsed, dvSavedByWaiting,            // m/s cumulative
    targetsDone,
    mode: 'launch'|'wait'|'transfer'|'prox'|'push'|'return'|'done'
  },
  targets: [ {
    id, name, mass, kind: 'rocketbody'|'comsat'|'smallsat', length, diam,   // m
    el, pos:{x,y,z},
    casualtyRisk,                        // number, e.g. 3e-5
    burnable: bool,                      // casualtyRisk < 1e-4
    eligible: bool,                      // can this tech handle it (ibs needs burnable in LEO)
    status: 'idle'|'targeted'|'pushing'|'released'|'decaying'|'kitted'|'kitwait'|'kitburn'|'reentered'|'graveyard'|'skipped',
    tumble,                              // deg/s
    perigeeAlt, apogeeAlt,               // km, kept current
    lifetimeDays,                        // estimate while decaying, else null
    reentry: { lat, lon, t } | null,     // set when status becomes 'reentered'
    kit: { mass, dv, burning:bool } | null
  } ],
  current: index into targets or -1,     // the target being worked
  prox: {                                // valid when state.proxActive
    active: bool,
    sep,                                 // metres shepherd->target
    shepPos: {x,y,z},                    // metres LVLH (see frame). IBS push: (-sep, 0, 0). Kit approach: comes in from -X toward the nozzle.
    beamOn: bool, counterOn: bool,
    beamHalfAngleDeg, standoff,          // from sliders
    tumble,                              // deg/s, current target
    arm: 0..1,                           // kit tech: robotic arm extension (0 stowed, 1 touching nozzle)
    kitAttached: bool,                   // kit tech: kit is on the target
    kitBurn: bool,                       // kit tech: kit motor firing (also visible in orbit view as a plume)
    targetKind, targetLength, targetDiam // to pick a model
  }
}
```

### Phase keys
```
prelaunch  ascent  parking  transfer  insert            (launch sequence; shepherd.mode='launch')
wait                                                      (parked, waiting for plane/longitude alignment)
climb  rendezvous  characterize                            (transfer to target orbit and approach)
standoff  push  release                                   (ibs)
approach  attach  depart                                  (kit)
return                                                     (drop back to the waiting orbit)
complete
```
Proximity view is active for phases: rendezvous, characterize, standoff, push, release, approach, attach, depart.
app.js picks the view; the modules only need `setVisible`.

## Agent A — `js/scene.js` (orbit-scale view)

```js
SIM.scene = {
  init(container: HTMLElement),      // create renderer/canvas inside container
  update(state, realDt),             // called every RAF; read state, move objects
  render(),
  resize(),
  setVisible(bool),
  setCameraMode('earth'|'follow'|'cluster'),   // earth: whole system; follow: chase the shepherd; cluster: look down the cluster's orbit plane
  setUserOrbit(bool),                // enable/disable mouse-drag orbit + wheel zoom (implement it yourself; OrbitControls is not on the UMD build)
  setLabels(bool)                    // show/hide the 3D ring labels
}
```
Must draw:
1. Earth (procedural canvas texture: oceans, some land blobs, polar caps, a clearly marked **South Pacific Ocean
   Uninhabited Area** patch centred 48°S 123°W, and a small marker for the launch site), rotating by `state.earthRot`.
   A thin atmosphere shell. Sunlight from +X.
2. Orbit curves: one `THREE.Line` per target (thin, low alpha, colour by status) and one brighter line for the
   shepherd. Rebuild a curve only when its elements changed materially (cache a,e,i,raan,argp signature) — up to 40
   targets, must stay at 60 fps. GEO scenarios: draw the equatorial GEO ring as reference.
3. Object markers: targets as small spheres sized by `mass` (min 0.12, max 0.3 units) colour by status:
   idle #8b95b5, targeted/pushing #f2b955, decaying #ff9a5c, kitted/kitwait/kitburn #c792ff, reentered (flash then fade
   over 3 s of real time, then hidden) #ffffff, graveyard #3ecfb5, skipped #ff6f6f (rendered with an X sprite or ring).
   Shepherd: a distinct teal marker + a short velocity tick. During `push`/`kitburn` show a small plume sprite.
4. Launch: while `state.phase` in prelaunch..insert draw `state.launch.path` as a bright trail from the site and a
   small rocket marker at its end. Camera should auto-frame the launch (use `follow`).
5. A ground-track-free "RAAN gap" aid: when `state.phase === 'wait'` and `state.current >= 0`, draw the shepherd's
   orbit plane and the current target's orbit plane as two faint translucent discs (radius = a) so the user sees the
   planes converging. In GEO scenarios draw instead a faint radial line from Earth centre to shepherd and to target
   (longitude gap).
6. Reentry: when a target's status becomes 'reentered', spawn a short streak from its last position toward Earth at
   `target.reentry.lat/lon` and a flash. Keep a small ring on the surface at that lat/lon for the rest of the run
   (red for uncontrolled, teal for kit-controlled inside SPOUA).
7. Camera: `earth` default distance ~ 4.5 Earth radii for LEO, ~ 14 for GEO; `follow` keeps the shepherd centred with
   Earth in frame; `cluster` looks from above the cluster orbit normal. Smooth (lerp) transitions. Mouse orbit/zoom.
8. Starfield.
9. **Labels on the rings, in 3D, not a legend.** Every reference curve carries a small sprite label (canvas-rendered
   text, Fira Code 11-12 px equivalent, colour matching the curve, `depthTest:false`, sized so it stays readable at the
   default camera distance and scales with distance no larger than ~1.6 scene units wide). Place each label on the curve
   at the point nearest the camera-right side (recompute each frame or on camera move, cheap). Required labels:
   * shepherd orbit: `shepherd · 780 km · i 83.0°` (build from state.shepherd.el; alt = a-RE, inclination in deg; in GEO
     scenarios `shepherd · GEO −100 km drift`)
   * current target orbit: `target · <name> · 980 km`
   * cluster reference ring (mean cluster orbit): `<cluster name> · 980 km · i 83.0°`
   * GEO scenarios: `GEO · 35 786 km`, `graveyard · GEO +<dh> km`, `drift orbit · GEO −100 km`
   * a decaying target's orbit: `<name> · <perigee>×<apogee> km`
   * SPOUA patch on the Earth: `SPOUA`
   Non-current, idle target orbits stay unlabeled (too many). Provide `setLabels(bool)` to hide all sprite labels.
Scene background `#0b1128`. Nothing in scene.js may read DOM elements outside its container. The HUD is app.js's job.

Test harness: `test-scene.html` that includes three.js + physics.js + scene.js and fakes a `state` with a shepherd in a
780 km, 83° orbit and 30 targets at 980 km spread in RAAN, cycling status values, so it can be opened standalone.

## Agent B — `js/prox.js` (proximity view)

```js
SIM.prox = {
  init(container),
  update(state, realDt),      // uses state.prox and state.targets[state.current]
  render(), resize(), setVisible(bool),
  setUserOrbit(bool)          // mouse orbit around the pair
}
```
Must draw (metres, LVLH frame above):
1. Target model chosen by `state.prox.targetKind`:
   * `rocketbody`: cylinder length/diam from state (e.g. SL-8: 6.5 m × 2.4 m; SL-16: 11 m × 3.9 m), grey/white paint,
     engine nozzle bell at the -X end, payload adapter ring at +X end, slow tumble at `state.prox.tumble` deg/s about a
     fixed skewed axis.
   * `comsat`: gold MLI bus 2.2×2.6×2.0, two 9 m solar wings, dish, tumbling.
   * `smallsat`: 1 m bus with one 2.5 m wing.
2. Shepherd model at `state.prox.shepPos`: 1.2 m bus, two 4 m arrays, beam thruster facing +X (toward target), counter
   thruster facing -X, lidar head. For `tech==='kit'` also a stowed robotic arm (3 links, 2.5 m reach) and a rack of
   kits on the +X face (`shepherd.kits` remaining, small boxes).
3. IBS visuals when `beamOn`: translucent cone from beam thruster to target with half-angle `beamHalfAngleDeg`, pale blue
   `#a9c4ea`, additive; particle stream inside it (~1000 points) flowing +X; a faint bloom disc where it hits the target.
   `counterOn`: teal `#3ecfb5` cone and particles flowing -X behind the shepherd. Force arrows + sprite labels
   "force on target" (+X at target) and "shepherd follows" (+X at shepherd), a dashed standoff dimension line with a
   sprite reading `standoff NN m`.
4. Kit visuals: `arm` 0..1 drives the arm unfolding from the shepherd toward the target's nozzle (IK not needed: animate
   joint angles so the end effector ends inside the nozzle bell at arm=1). When `kitAttached` becomes true, move one kit
   box from the rack to the nozzle and leave it there (and decrement the rack). When `kitBurn` is true draw an orange
   plume from the kit pointing -X (retrograde).
5. Camera: slow auto-orbit around the midpoint of the pair, radius ~1.15×sep + 12 m, or user mouse orbit if enabled.
   Distant tiny Earth for orientation at (-40, -140, -300) in LEO, and a lit horizon glow.
6. Lighting: warm key light, cool fill, ambient. Background `#0b1128`. Starfield.

Test harness: `test-prox.html` with a fake state cycling arm 0→1, kitAttached, kitBurn, and an IBS mode with
beamOn/counterOn true, standoff 15 m, so it can be opened standalone.

## Shared rules
* Pin three.js 0.160.0 UMD: `https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js`.
* Do not create your own `requestAnimationFrame` loop in the real module (test harnesses may). app.js drives `update`+`render`.
* Dispose geometries you rebuild. Cap per-frame allocations.
* No external assets; textures are procedural canvases.
* Every module wraps itself in an IIFE and exposes only its `SIM.<name>` object.
