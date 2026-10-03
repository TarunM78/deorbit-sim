# Demo mode — spec (under 60 seconds, autoplay, one story)

Goal: a viewer with no background watches for ~55 s and gets the whole idea: a probe launches, waits for a piece of
space junk's orbit to line up (for free), closes in, pushes it down with an ion beam without touching it, and the junk
burns up harmlessly years earlier than it would have. Big plain words, one idea per beat, no numbers unless they help.

New module `js/demo.js` -> `window.SIM.demo`. Plain IIFE, no own RAF loop, no edits to any other file (the lead wires
app.js/index.html; other sessions own those). It drives the existing sim through `SIM.mission` (`state` getter,
`skipPhase()`) and tells the app what to show each frame.

```js
SIM.demo = {
  init(container),                      // creates its own DOM overlay inside container (the #view element); pointer-events none except its buttons
  start({ onReplay, onExplore }),       // begin the timeline against the CURRENT SIM.mission.state (app.js has already called mission.setup('leo-sso','ibs'))
  stop(),                               // leave demo mode, hide overlay
  get active(),                         // bool
  tick(state, realDt)                   // called every RAF while active, BEFORE the app steps the sim; returns the directive below
}
directive = {
  warp,           // sim seconds per real second the app must use this frame
  paused,         // true = do not step the sim this frame (end card)
  view,           // 'fpv' | 'orbit' | 'prox'  (app forces this view regardless of state.prox.active)
  cam,            // 'earth' | 'follow' | 'cluster'  camera mode for the orbit view
}
```

The app applies `directive.warp` instead of its own auto/manual warp, keeps its existing sub-stepping, forces the view, and
calls `SIM.scene.setCameraMode(directive.cam)` when it changes. Everything else (HUD, phase list, log) keeps working.

## Timeline

Budgets are REAL seconds per mission phase. On entering a phase the demo sets `warp = state.phaseDur / budget` (for `wait`
use `state.wait.eta / budget`, and if the phase has not ended when the budget is up, call `SIM.mission.skipPhase()`; do the
same for any phase that overruns by more than 25 %, so the demo can never stall). Beats are the captions; a beat can span
several phases. Sum ≈ 50 s of motion + end card.

| # | phases                         | budget (s) | view / cam        | caption (exact)                                                                                                        |
|---|--------------------------------|-----------:|-------------------|------------------------------------------------------------------------------------------------------------------------|
| 0 | prelaunch                      | 2.5        | fpv               | TITLE CARD (centre): `Space junk is piling up.` / sub: `One way to clean it: a probe that pushes junk down without ever touching it.` |
| 1 | ascent, parking, transfer, insert | 8, 2, 2, 1 | fpv            | (none: the ride-along view has its own captions)                                                                       |
| 2 | wait                           | 6          | orbit / earth     | `Now it waits. The Earth's bulge slowly swings the junk's orbit into line with ours. That costs nothing.`               |
| 3 | climb                          | 2          | orbit / follow    | `Lined up. A small burn climbs to the junk.`                                                                            |
| 4 | rendezvous, characterize       | 2.5, 2.5   | prox              | `Closing in. Cameras and lidar measure the tumbling rocket body.`                                                       |
| 5 | standoff, push                 | 1, 10      | prox              | `Ion beam on. The exhaust pushes the junk without touching it. Its orbit drops a little every day.`                     |
| 6 | release                        | 2          | prox              | `Beam off. Back away. The junk is now in a lower orbit.`                                                                |
| 7 | decay beat: return + whatever follows, until the pushed target's status is `reentered` or 8 s pass | 8 | orbit / earth | `Lower means more air. The junk burns up harmlessly within a few years, instead of circling for centuries.` |
| 8 | END CARD (sim paused)          | until click| orbit / earth     | see below                                                                                                              |

Notes for beat 7: use `warp = 45 × 86400` (45 days per second); the app's sub-stepping caps this safely. Force
`view:'orbit'` even if `state.prox.active` becomes true (the shepherd may already be working on its next target, which is
fine and looks alive). Remember the pushed target's index from beat 5 (`state.current` at push) so the reentry check reads
the right object. When it reenters, hold 1.5 s more (the orbit view draws a streak), then show the end card.

End card (centre panel, sim paused, overlay still shows the orbit view behind):
* Big line: `One launch. One probe. Junk pushed down, nothing touched.`
* Three tiles (Fira Code numbers): `pushed down` = `state.shepherd.targetsDone`; `fuel spent waiting` = `0 kg`;
  `plane changes avoided` = `state.shepherd.dvSavedByWaiting/1000` km/s with one decimal (label under it: `worth of fuel`).
* Buttons (these DO take pointer events): `Replay` → `onReplay()`; `Explore the full sim` → `onExplore()` then `stop()`.

## Overlay (all DOM inside the container, class prefix `.demo-`)

* Title card: centred, 34 px Fira Sans 600 + 18 px sub, on `rgba(11,17,40,.72)` panel, fades out over 400 ms at the
  end of beat 0.
* Beat caption: bottom centre, max-width 640 px, 22 px Fira Sans 500, panel `rgba(11,17,40,.78)` with a 3 px teal left
  border, cross-fade 200 ms on change. Hidden during beat 1 (fpv has its own) and during the end card.
* Progress bar: 3 px tall along the very bottom of the container, teal, width = elapsed / 55 s (clamped), with a
  Fira Code 11 px `demo · 0:37` label at its right end. Hidden on the end card.
* `Skip demo` button, top centre-right (below the app's camera buttons: top 52 px, right 12 px), small, `pointer-events:auto`;
  calls `onExplore()` then `stop()`.
* Colours/fonts as index.html: text `#e9edf6`, muted `#9aa5c4`, teal `#22a690`, amber `#f2b955`,
  `var(--body)`/`var(--mono)` with Fira fallbacks.
* Responsive: at container width < 760 px the title is 26 px and captions 18 px.

## Robustness

* `tick` must never throw; if a phase key it doesn't know appears (kit tech, GEO), treat unknown phases as beat 7 with
  `warp = 45 days/s` and the same rule to skip after 8 s. The demo is only started with `leo-sso` / `ibs` by the lead,
  but must not crash otherwise.
* `state.t` going backwards (restart) resets the timeline.
* No per-frame DOM writes unless text changed.

## Test harness `test-demo.html`

Standalone page mirroring the app's view switching so the demo can be QA'd without app.js: loads three.js (cdnjs 0.160.0),
js/physics.js, scenarios.js, mission.js, scene.js, prox.js, fpv-hud.js, fpv.js, demo.js (NOT app.js). Three absolute
`inset:0` containers `#orbitBox`, `#proxBox`, `#fpvBox` inside a `#view` div (full window minus a 40 px bar), plus
`SIM.demo.init(view)`. Bar: `Start demo` button, live `phase · T+ · warp` readout. Loop: RAF; if demo active,
`d = SIM.demo.tick(S, real)`; `warp = d.warp`; unless `d.paused`, sub-step like app.js (`maxSub = S.prox.active ? 0.25*DAY :
(S.phase==='wait'||S.phase==='complete' ? 0.5*DAY : 120)`, n ≤ 400); show the container for `d.view`, call that module's
`setVisible(true)`/others false, `update(S, real)`, `render()`; call `SIM.scene.setCameraMode(d.cam)` when it changes.
`onReplay` = `mission.setup('leo-sso','ibs')` then `SIM.demo.start(...)` again; `onExplore` = keep running with `warp =
S.warp` and pick the view from `S.prox.active` (like app.js). If `SIM.fpv` is missing, use the orbit view for beats 0–1.
