# First-person "Ride along" view — spec

Goal: a demo-grade, **incredibly easy to understand** ride-along view of the probe's journey from the launch pad to its
waiting orbit. A non-technical viewer should be able to watch it with the sound off and get it: rocket goes up, tilts
over, gets fast, coasts, two small burns, arrives at the target altitude. Cinematic chase camera, huge plain-language
captions, two big numbers (altitude, speed), a "where am I" mini-map.

Same module contract as `SIM.scene` / `SIM.prox` (see SPEC.md). Plain script IIFEs, three.js 0.160 UMD global `THREE`,
no external assets, no own RAF loop in the real module. Nothing in these modules may read DOM outside their container.

Files (all new, this feature only):

```
js/fpv.js        -> window.SIM.fpv      3D ride-along renderer (owner: agent FPV-3D)
js/fpv-hud.js    -> window.SIM.fpvHud   DOM overlay inside the container: stage strip, captions, readouts, mini-map (owner: agent FPV-HUD)
test-fpv.html    -> standalone harness with a fake launch state generator (owner: agent FPV-TEST)
```

Load order in index.html (added later by the lead, do not edit index.html/app.js/mission.js now):
`physics.js, scenarios.js, mission.js, scene.js, prox.js, fpv-hud.js, fpv.js, app.js`.

## Public API

```js
SIM.fpv = {
  init(container),           // creates ONE WebGLRenderer canvas inside container, then calls SIM.fpvHud.init(container)
  update(state, realDt),     // every RAF while visible; reads state, moves objects, computes `derived`, calls SIM.fpvHud.update(state, derived)
  render(), resize(), setVisible(bool),   // setVisible also forwards to SIM.fpvHud.setVisible
  isJourneyPhase(phase)      // true for 'prelaunch','ascent','parking','transfer','insert' (app.js uses it to decide when to show this view)
}

SIM.fpvHud = {
  init(container),           // appends an absolutely positioned overlay div (pointer-events:none except the mini-map toggle) into container
  update(state, derived),    // cheap; only touch DOM when text actually changes
  setVisible(bool)
}
```

### `derived` (computed by fpv.js, consumed by fpv-hud.js)

```js
derived = {
  stage: 'pad'|'liftoff'|'turn'|'vacuum'|'meco'|'coast'|'boost'|'arrive'|'done',   // see Stage table
  stageIndex: 0..4,          // index into the 5 strip chips: 0 Launch, 1 Climb, 2 Coast, 3 Boost, 4 Arrive
  frac: 0..1,                // progress within the current mission phase (state.phaseT/state.phaseDur, clamped)
  altKm, speedKmh,           // altitude above RE; ground-relative speed (inertial vel minus Earth rotation ω×r), km/h
  orbitSpeedKmh,             // the speed needed for a circular orbit at the CURRENT altitude, km/h (sqrt(MU/r)*3600 minus nothing: inertial). Use for the "speed to orbit" bar
  targetAltKm,               // state.shepherd.parkAlt
  tPlus,                     // state.t seconds since T-0 (negative during prelaunch: t - 20)
  caption,                   // the plain-language sentence for right now (fpv.js owns the caption table so 3D events and words stay in sync)
  eventFlash: null | string  // a short label to flash for ~1.5 s real time when a discrete event happens: 'LIFTOFF', 'BOOSTER SEPARATION', 'FAIRING OFF', 'ENGINE CUTOFF', 'SOLAR ARRAYS OUT', 'BURN 1', 'BURN 2', 'ARRIVED'. Set only on the frame the event happens; the HUD handles the timing.
}
```

## Stage table (fpv.js owns this; both agents must agree on the words)

| state.phase | frac        | stage     | chip | caption (exact text)                                                                                   | 3D                                                                                  |
|-------------|-------------|-----------|------|--------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| prelaunch   | any         | pad       | 0    | `On the pad at <site name>. The probe is folded up inside the nose of the rocket.`                      | rocket vertical on a pad, sky blue, engine off                                        |
| ascent      | 0 – 0.15    | liftoff   | 0    | `Liftoff. The rocket climbs straight up to get out of the thick air near the ground.`                  | engine plume on, rocket vertical, then starts tilting                                |
| ascent      | 0.15 – 0.45 | turn      | 1    | `Tilting over. To stay up you don't need height, you need sideways speed. A lot of it.`                | gravity turn; booster separates at frac 0.35 (BOOSTER SEPARATION)                   |
| ascent      | 0.45 – 0.85 | vacuum    | 1    | `Above the air now. The sky has gone black. The engine keeps pushing sideways, faster and faster.`      | fairing halves fall away at 0.5 (FAIRING OFF), probe now visible on the upper stage |
| ascent      | 0.85 – 1    | meco      | 1    | `Engine off. Going sideways so fast that as it falls, the ground curves away underneath. That's orbit.`| plume off (ENGINE CUTOFF), upper stage drifts away at frac 0.95, probe alone        |
| parking     | any         | coast     | 2    | `Coasting. A low parking orbit, 200 km up, half a lap around the Earth. No engine needed.`               | solar arrays unfold over the first 10% of the phase (SOLAR ARRAYS OUT)              |
| transfer    | 0 – 0.08    | boost     | 3    | `Burn 1. A short push makes the orbit egg-shaped: the far side now reaches up to <target> km.`          | small blue thruster plume from the probe (BURN 1)                                   |
| transfer    | 0.08 – 1    | boost     | 3    | `Climbing on the long side of the egg. No engine: it's just the orbit's shape carrying us up.`          | plume off                                                                           |
| insert      | any         | arrive    | 4    | `Burn 2. A second push rounds the orbit off. The probe is now in its waiting orbit at <target> km.`     | plume on (BURN 2)                                                                   |
| anything else | –         | done      | 4    | `Arrived. From here the probe waits for its first piece of debris to drift into line.`                  | probe alone, arrays out (ARRIVED flashes once on entering)                          |

`<site name>` = `state.launch.site.name`, `<target>` = `state.shepherd.parkAlt` rounded to the nearest 10 km, printed
with a thin-space thousands separator (`35 690`). Captions must fit in two lines at 20 px on a 700 px wide view.

## Frames, precision, camera (fpv.js)

* Work in **km**, ECI orientation mapped to three.js as `(x, z, -y)` (same handedness as `SIM.phys.toScene` but ×1000).
  Write a local helper `toF(v) -> THREE.Vector3` for it. Do not use `toScene`.
* **Camera-relative rendering to avoid float jitter:** the camera stays at the scene origin. Each frame set
  `world.position = toF(shepPos).negate()` on a group `world` that holds Earth, atmosphere, clouds, pad, stars-parent.
  The vehicle group sits near the origin (offset by metres), so a 1.2 m probe bus renders rock-steady 6 578 km from
  Earth's centre. Camera near = 0.002 km (2 m), far = 60 000 km. Do NOT use logarithmicDepthBuffer (kills perf on
  laptops); the near/far ratio is acceptable because nothing but the vehicle is close.
* Vehicle position = `state.shepherd.pos` (km ECI). Velocity: use `state.shepherd.vel` if its magnitude > 1e-6, else
  finite difference of `pos` between frames divided by sim dt (`state.dt` or `state.t` delta); keep the last good value
  when paused (dt = 0). Ground-relative velocity = vel − (Ω_E ẑ × pos).
* Basis: `up` = pos normalised (radial). `travel` = ground-relative velocity direction with the radial component removed,
  normalised; if too small (on the pad) use local east = normalise(ẑ × up). Smooth both with an exponential lerp at
  about 3 /s real time so coarse sim steps (ascent runs ~0.75 s sim per frame) never make the view snap.
* Vehicle attitude: rocket long axis = slerp(up → travel-with-climb) as `frac` goes 0.08 → 0.5 during ascent (gravity
  turn); after that the axis follows the full ground-relative velocity direction. Probe alone: +X face along travel,
  arrays on ±Z (like prox.js), a slow 2 deg/s roll for life.
* Chase camera: `camPos = vehicle − travel·D + up·0.45·D + side·0.35·D` where `side = travel × up` and `D` = 4 × the
  visible vehicle's length (rocket 45 m → D≈0.18 km; probe alone ≈ 6 m → D≈0.024 km, lerp between them over ~2 s
  real time when the vehicle changes). Look at `vehicle + travel·0.6·D`. FOV 55. Result: the vehicle sits lower-left
  of centre, the direction of travel points into the frame, the Earth's limb is visible. Keep the horizon roughly
  level: camera `up` vector = radial `up`.
* No user mouse orbit in v1 (a demo autoplay). Keep a `setUserOrbit(bool)` stub that does nothing, for API symmetry.

## What to draw (fpv.js)

1. **Earth** radius RE, 96×64 segments, procedural 2048×1024 canvas texture: deep blue ocean with subtle noise, a few
   green-brown land masses with noise-edged coasts (procedural, seeded so it's the same every run), white polar caps,
   a small orange ring at the launch site (`state.launch.site.lat/lon`). Rotate the Earth mesh by `state.earthRot` about
   scene +Y. Sun: DirectionalLight from ECI +X (scene +X), intensity 2.2, plus ambient 0.25 and a faint blue hemisphere
   light. MeshStandardMaterial with slight roughness; a specular ocean is a nice-to-have, not required.
2. **Atmosphere**: (a) a rim-glow shell at RE+90 km with a custom fresnel ShaderMaterial, additive, pale blue, BackSide,
   seen from orbit as the thin blue line; (b) **sky dome effect near the ground**: `renderer.setClearColor` blends from
   sky blue `#6fb0ff` at alt 0 to `#0b1128` by alt 90 km (smoothstep), and add `scene.fog` whose colour matches and whose
   density falls to 0 by 40 km, so the pad view looks like daytime and the blackness of space "arrives" during ascent.
   Stars (Points, ~2500, radius 30 000 km, in `world`) fade in with the same curve (material opacity).
3. **Clouds**: one extra sphere at RE+8 km with a procedural alpha texture (soft noise blobs, 1024×512), 60 % opacity,
   rotating with the Earth plus a tiny extra drift. Cheap and hugely helps the sense of altitude and speed.
4. **Launch pad**: at the site, a flat 0.2 km grey disc, a thin tower (box 0.005×0.09×0.005 km) beside the rocket, and a
   0.6 km ring of dim ground so the pad reads as ground when the camera is 200 m away. Attached to the Earth mesh so it
   rotates with it.
5. **Rocket** (built in metres then scaled 1e-3 into km; total length 45 m): first stage cylinder Ø3.7 m × 28 m white
   with a dark interstage band, 4 small fins, 4 engine bells; second stage Ø3.7 m × 10 m; fairing Ø4.2 m × 7 m in two
   halves (so they can split); the probe (bus 1.2 m + folded arrays, teal `#3ecfb5`) inside the fairing, invisible until
   fairing off. Engine plume: an additive cone + a few flickering sprites, orange-white, length 25 m during ascent while
   engine on; a second, smaller plume on the second stage after booster separation.
   Staging (all `frac` of the ascent phase): booster separates at 0.35 (drifts back along −travel, tumbles slowly,
   removed after 6 s real); fairing halves open and fall away at 0.5; engine off at 0.85; upper stage drifts away at 0.95.
6. **Probe alone**: bus 1.2 m box teal with dark panels, two 4 m arrays on ±Z that unfold (rotate from folded flat against
   the bus to extended) over the first 10 % of `parking`; a small blue additive thruster plume (2 m) on the −travel face
   during transfer frac < 0.08 and all of insert.
7. **Speed cues**: a faint trail of 40 small points behind the vehicle along its recent path (positions in km, stored
   camera-relative each frame) so motion is visible against black sky.
8. Renderer: `antialias:true`, ACES tone mapping exposure 1.1, `setPixelRatio(min(devicePixelRatio,2))`, clear colour
   as per the sky blend, canvas fills container (`position:absolute; inset:0`).

Idle/unknown phases (app.js may pass `phase:'idle'`): treat as `done`, never throw.

## HUD (fpv-hud.js), all DOM, inside the container, matches the app's look

Fonts: `var(--body)` Fira Sans, `var(--mono)` Fira Code (index.html defines them; fall back to system if missing).
Colours: text `#e9edf6`, muted `#9aa5c4`, accent teal `#22a690`, amber `#f2b955`, panel `rgba(11,17,40,.72)`.
Everything is `pointer-events:none` so any future canvas interaction still works.

1. **Stage strip**, top centre: five chips `Launch · Climb · Coast · Boost · Arrive`, joined by short lines. Done chips
   teal with a ✓, the active chip amber and slightly larger with a soft pulse, upcoming chips muted. 14 px Fira Sans 500.
2. **Big readouts**, bottom left, in one panel:
   * `ALTITUDE` — big number (Fira Code 34 px) + `km`, with a thin horizontal bar 0 → `targetAltKm` (label `target
     <targetAlt> km` at the right end). Number tweens toward the value (don't jump).
   * `SPEED` — big number `km/h` with a bar 0 → `orbitSpeedKmh`, labelled `orbit speed` at the right end. When speed ≥
     97 % of orbit speed the bar turns teal and the label becomes `in orbit ✓`.
   * Tiny line under both: `T+ 04:32` (mm:ss, `T− 00:12` before liftoff) in Fira Code 12 px muted.
   Numbers use a thin space as thousands separator, no decimals above 100, one decimal below.
3. **Caption**, bottom centre-right, a translucent panel, 20 px Fira Sans 500, max two lines, `derived.caption`.
   Cross-fade (opacity 150 ms) when the text changes.
4. **Event flash**, centre-top under the strip: `derived.eventFlash` shown in Fira Code 16 px letter-spaced uppercase
   amber, fades out over 1.5 s real time.
5. **Mini-map**, top right, a 150×150 2D canvas: side view of the launch plane. Earth as a filled circle (radius scaled
   so the target orbit fits with 12 px margin), the 200 km parking orbit as a faint dashed circle, the target orbit as a
   teal dashed circle, the path so far (`state.launch.path`, projected onto the launch plane) as an amber line, the probe
   as an amber dot with a small "you" label. Plane basis from the shepherd elements: `p̂ = (cosΩ, sinΩ, 0)`,
   `q̂ = (−cosi·sinΩ, cosi·cosΩ, sini)` in ECI; project `x = pos·p̂, y = pos·q̂`. Redraw at most 20 times/s.
   Title text inside: `where am I` 11 px muted.
6. Title label, top left, small: `RIDE ALONG · launch to orbit` in Fira Code 12 px muted.

Layout must work down to 600 px wide: at < 760 px hide the mini-map and shrink the readouts to 26 px.

## Test harness (test-fpv.html)

Standalone page: includes three.js, physics.js, scenarios.js, mission.js, fpv-hud.js, fpv.js (NOT app.js/scene.js/prox.js).
Uses the REAL `SIM.mission.setup('leo-sso','ibs')` and `SIM.mission.step(dt)` so the motion is the real one, with its own
RAF loop: `dt = real * warp` where warp is the state's `warp`, sub-stepped like app.js (max 120 s sub-steps, ≤400 per
frame). Buttons (plain DOM, top-left, outside the fpv container): scenario select (the four ids from `SIM.scenarios`),
`Play/Pause`, `Skip phase` (`SIM.mission.skipPhase()`), `Restart`, and a warp multiplier slider 0.1× to 4× applied on top of
the state's warp. Stops stepping once `SIM.fpv.isJourneyPhase(state.phase)` is false (shows "journey complete" in the
button bar) so it never runs into the proximity phases. If `state.shepherd.vel` stays zero, the harness does nothing
special: fpv.js must cope via finite differences.

Console must be clean (no errors, no per-frame warnings). Target 60 fps on an integrated GPU: keep total draw calls
under ~40 and avoid per-frame allocations of geometries/materials (reuse Vector3s).
