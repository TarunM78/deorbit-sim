# Shepherd Fleet sim

Interactive 3D model of the Deorbit CONOPS: a shepherd launches into a debris cluster's plane, parks below it, and waits for J2 (LEO) or longitude drift (GEO) to bring each target into alignment. Three technology paths:

* **LEO · ion beam** — contactless retrograde push lowers perigee; drag does the rest (uncontrolled reentry, only for objects with casualty risk < 1e‑4).
* **LEO · descent kit** — the servicer's robotic arm captures the rocket body at its nozzle and bolts on a solid‑motor kit; the kit waits for a South Pacific window and fires for a controlled reentry.
* **GEO · ion beam** — prograde push to the IADC graveyard, then drop 100 km and drift east to the next derelict.

## Files

```
index.html        page shell, setup panel, HUD, telemetry
js/physics.js     Kepler propagation, J2 rates, drag decay, Hohmann, rocket equation
js/scenarios.js   debris clusters (SSO smallsats, SL-8, SL-16, GEO comsats) and launch sites
js/mission.js     mission state machine (launch → wait → climb → prox ops → return …)
js/scene.js       orbit-scale 3D view (Earth, orbits, icons, ring labels, reentries)
js/prox.js        proximity-scale 3D view (target model, shepherd, beam, arm, kit)
js/app.js         UI glue and render loop
SPEC.md           module interface contract
test-scene.html   standalone harness for scene.js
test-prox.html    standalone harness for prox.js
```

## Run locally

```
cd shepherd-fleet
python -m http.server 8000
```
then open http://localhost:8000/ . Needs internet for three.js (cdnjs) and Google Fonts.

## Headless regression

```
node -e "global.window=global;global.THREE={Vector3:class{constructor(x,y,z){this.x=x;this.y=y;this.z=z}}};require('./js/physics.js');require('./js/scenarios.js');require('./js/mission.js');const M=SIM.mission,S=M.setup('leo-sl8','kit');while(S.phase!=='complete')M.step(S.warp/60);console.log(S.shepherd.targetsDone,S.events.at(-1).text)"
```
