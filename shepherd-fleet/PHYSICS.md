# Shepherd Fleet — physics notes

What `js/physics.js`, `js/scenarios.js` and `js/mission.js` actually compute, and where the model is schematic. Units: km, s, rad in code; m/s and days in the UI.

## 1. Constants

| Symbol | Value | Use |
|---|---|---|
| mu | 398600.4418 km^3/s^2 | all two-body math |
| R_E | 6378.137 km | altitudes, atmosphere |
| J2 | 1.08263e-3 | nodal regression |
| R_GEO | 42164.17 km | GEO drift, graveyard |
| omega_E | 7.2921159e-5 rad/s | Earth rotation, ground points |
| Isp | 1500 s (shepherd), 300 s (kit) | rocket equation |
| dry mass | 500 kg shepherd; 60 kg kit | sizing |
| xenon | 300 kg default (slider) | mission capacity |
| beam | 40 mN, eta_B 0.8, half-angle 15 deg, standoff 15 m (sliders) | push sizing |
| duty | 0.45 | LEO push (apogee arcs + eclipse) |
| solar | 1.5 default (slider 0.5–3) | density multiplier |
| SPOUA | 48 S, 123 W | kit window target |

Clusters (`scenarios.js`): SSO smallsats 790 km / 98.0 deg / 30 objects; SL-8 stages 980 km / 82.9 deg / 32; SL-16 stages 840 km / 71.0 deg / 20; GEO comsats 35786 km / 7.4 deg / 30. Each target gets a random mass, A/m, casualty risk and tumble rate in the cluster's range; `burnable = risk < 1e-4`; with the ion-beam tech a non-burnable LEO target is marked `skipped`.

## 2. Launch model

The shepherd launches into the cluster's inclination and never changes it. The plane is the one through the site at T-0:

```
u      = asin( sin(lat_site) / sin(i) )                     argument of latitude of the site
theta  = lon_site + earthRot                                inertial longitude of the site
raan0  = theta - atan2( cos(i) * sin(u), cos(u) )
```

Ascent (560 s) is a scripted, monotonic profile on that plane: `alt = 200 * (1 - (1-f)^2.5)` km and downrange angle `M = u + 0.35 * f^2.2`, so speed rises from ~0.4 to ~7.8 km/s and the track ends tangent to a 200 km circular parking orbit. Half a parking revolution later a Hohmann transfer raises the orbit to the waiting altitude (cluster - 200 km in LEO, GEO - 100 km in GEO): `dv1`, `dv2` and `tof = pi*sqrt(a_t^3/mu)` from `hohmannDv`. Both burns are charged with the rocket equation `dm = m0 * (1 - exp(-dv/(Isp*g0)))`.

## 3. Waiting: the plane comes to you

LEO: nodal regression under J2, `p = a(1-e^2)`:

```
dRAAN/dt = -1.5 * n * J2 * (R_E/p)^2 * cos(i)
```

Worked (circular, deg/day): 98.0 deg, 590 km: +1.017; 790 km: +0.922; relative +0.096 deg/day. 82.9 deg, 780 km: -0.822; 980 km: -0.747; relative -0.076 deg/day. After a LEO ion-beam push the shepherd stays in the lowered 350x790 km orbit, which precesses +0.108 deg/day faster than the cluster, so the push itself becomes the phasing drift. `pickNextTarget` chooses the idle, eligible target with the shortest closing time in the drift direction; the climb starts when the gap is under 0.35 deg.

GEO: relative longitude rate for a small altitude offset, `1.5 * n_GEO * dh / R_GEO` = 1.284 deg/day at 100 km below GEO (0.0128 deg/day per km). Half the belt in ~140 days for 3.65 m/s each way.

The telemetry "dv avoided by waiting" adds, per target, the plane change the wait replaced: `dv = 2 * v * sin(gap/2)` (30 deg at 790 km = 3.86 km/s; 1 deg = 130 m/s).

Climb: Hohmann from the waiting orbit into the target's circular orbit in the target's plane (590 to 790 km: 106 m/s; 780 to 980 km: 102 m/s; GEO -100 to GEO: 3.65 m/s).

## 4. LEO ion-beam push

Retrograde beam on arcs around apogee lowers perigee while apogee stays at the original altitude:

```
a_t       = eta_B * F_beam / m_t                       target acceleration
F_counter = F_beam + m_s * a_t                         holds standoff
dv_req    = v * (alt0 - perigee_target) / (4 a)        first-order perigee lowering
t_push    = dv_req / (a_t * duty)
```

Worked, 300 kg smallsat at 790 km to a 350 km perigee: 114.4 m/s, a_t = 107 um/s^2, 27.6 days at duty 0.45. During the push perigee is interpolated linearly with delivered dv (`rp = rp0 + (rpT - rp0) * dv/dv_req`, `ra = rp0`), and the shepherd's elements are copied from the target so it descends with it. Propellant: `(F_beam + F_counter) / v_e * duty` per second of push. Tumble decays as `exp(-t / 6 d)` during the push; this is a placeholder for beam-torque damping, not a torque model.

## 5. Drag decay

`dragDecay` is an orbit average in eccentric anomaly E over 24 samples, King-Hele style, with the Gauss tangential equations:

```
rho    = table(h) * solar          log-interpolated mean-activity density, 100–1500 km
accel  = 0.5 * (Cd A/m) * rho * v^2
da/dt  = -2 a^2 v / mu * accel
de/dt  = -2 (e + cos nu) / v * accel
weight = (1 - e cos E) / N           time spent near each sample
```

with `Cd A/m = 2.2 * A/m`. A released target is stepped with this each sim step (sub-steps of at most 0.5 day) and reenters, uncontrolled, at the first step whose perigee is below 120 km; the reentry lat/lon is the object's position at that moment. `lifetimeDays` fast-forwards the same model in 10-day steps (cap 100 yr). Worked: 350x790 km, A/m 0.02, solar 1.5 gives ~230 days. These lifetimes are order-of-magnitude only: no real atmosphere model, no solar cycle history, no attitude-dependent area.

## 6. Descent-kit path

Approach (2 days): the servicer detumbles the stage contactlessly with its beam for the first half (`tumble *= exp(-dt / 0.25 d)`), then closes to the arm's reach distance, `SIM.prox.attachSep(kind, length, diam)` (about half the body length plus the nozzle bell plus 1.9 m; fallback `length/2 + 2.5` m). Attach (1 day): the arm extends to the engine nozzle, the kit is bolted on at f = 0.5, the arm retracts. Kit mass:

```
m_kit = 60 + (m_t + 60) * (exp(210 / (300 g0)) - 1)      170 kg for an SL-8 stage, ~700 kg for an SL-16
```

Depart, then `scheduleKit`: the kit's orbit is propagated in 60 s steps for up to 12 days; at each step the point half an orbit ahead is mapped to a ground position (Earth rotated by the post-burn half period) and the first time it lies within 12 deg great-circle of SPOUA becomes `burnT`. At `burnT` the burn is impulsive at the current point, which becomes apogee: new orbit `rp = R_E + 40 km`, `ra = a_old`, `argp = u - pi`, `M = pi`; reentry is logged half a period later at the perigee ground point (controlled, inside SPOUA). The step that crosses `burnT` or `reentryT` is split so both happen at the exact time. The servicer meanwhile Hohmanns back down to the waiting orbit.

## 7. GEO path

IADC raise `dh = 235 + 1000 * C_R * (A/m)` km with C_R = 1.3 (261 km at A/m 0.02); `dv = v * dh / (2 a)` = 9.5 m/s, continuous prograde push at `a_t` with both spacecraft spiralling up (`a` interpolated linearly with delivered dv, ~13 days at 40 mN on 3 t). After release the shepherd drops to GEO - 100 km (Hohmann, ~13 m/s) and drifts east to the next derelict; targets are placed at the same inclination and RAAN, spread in longitude.

## 8. What is schematic

* Phase durations for rendezvous, characterize, standoff, release, approach, attach, depart, return (1–5 days each) are CONOPS estimates, not propagated dynamics. On-screen time is fixed by the `PACE` table (e.g. push 14 s, attach 7 s); a wait plays out in ~8 s at no less than 1 day/s.
* Proximity motion is scripted separation along-track; there is no Clohessy–Wiltshire relative dynamics, no beam-divergence effect on eta_B, no sputter or plume impingement.
* J2 secular terms only. No solar radiation pressure, no third body, no Laplace-plane precession in GEO (single 7.4 deg cluster), no station-keeping cost for the shepherd while it waits in a drag-exposed orbit.
* Each cluster is a single inclination; RAAN is randomly spread. Argument of perigee drift is applied even to circular orbits (harmless but unphysical).
* The GEO orbit view multiplies radial offsets from GEO by 30 so 100 km and 300 km are visible; LEO is drawn to scale.
