# GEO Shepherd Sim: physics notes

What `index.html` actually computes, what it only draws, and where it should go next.

## 1. Constants

| Symbol | Value | Note |
|---|---|---|
| mu | 3.986004418e14 m^3/s^2 | Earth gravitational parameter |
| R_E | 6378.137 km | Earth equatorial radius |
| R_GEO | 42 164.17 km | GEO radius (altitude 35 786 km) |
| v_GEO | sqrt(mu / R_GEO) = 3074.7 m/s | circular speed at GEO |
| n_GEO | sqrt(mu / R_GEO^3) = 7.292e-5 rad/s | GEO mean motion (one rev per sidereal day) |
| Isp | 1500 s | both thrusters |
| v_e | Isp * g0 = 14 710 m/s | exhaust velocity |
| m_s | 500 kg | shepherd mass, held constant |
| i_cluster | 7.4 deg | derelict cluster inclination (Laplace-plane tilt) |
| drift altitude | 100 km below GEO | parking / phasing orbit |
| C_R | 1.3 | reflectivity coefficient in the IADC formula |

## 2. Sizing equations (as coded in `sizing()`)

Required raise (IADC), with A/m in m^2/kg:

    dh_req [km] = 235 + 1000 * C_R * (A/m)

Delta-v for a small circular-to-circular raise (Hohmann, first order):

    dv_req = v_GEO * dh_req / (2 * R_GEO)

Target acceleration from the captured fraction of the beam:

    a_t = etaB * F_beam / m_t

Counter-thruster force needed to hold standoff (beam recoil plus the shepherd's own share of the acceleration):

    F_counter = F_beam + m_s * a_t

Continuous beam-on time:

    t_push = dv_req / a_t

Push propellant (beam plus counter thruster, integrated over t_push):

    m_push = (2 * m_t / etaB + m_s) * dv_req / v_e

The live propellant counter integrates `(F_beam + F_counter) / v_e` each step, which is the same quantity.

Drift propellant (100 km down and back up, ~3.6 m/s each way):

    m_drift = m_s * (2 * 3.6) / v_e

Longitude drift rate of an orbit dh below GEO, relative to the GEO-synchronous frame:

    lambda_dot = 1.5 * n_GEO * dh / R_GEO

At dh = 100 km this is 2.59e-7 rad/s = 1.28 deg/day eastward, i.e. 0.0128 deg/day per km of altitude offset. Half the belt (180 deg) takes ~140 days.

## 3. Worked default case

Inputs: m_t = 3000 kg, F_beam = 40 mN, etaB = 0.80, A/m = 0.020 m^2/kg, standoff 15 m.

| Quantity | Computation | Result |
|---|---|---|
| dh_req | 235 + 1000 * 1.3 * 0.020 | 261 km |
| dv_req | 3074.7 * 261 000 / (2 * 42 164 170) | 9.52 m/s |
| a_t | 0.8 * 0.040 / 3000 | 1.067e-5 m/s^2 (10.7 um/s^2) |
| F_counter | 0.040 + 500 * 1.067e-5 | 45.3 mN |
| t_push | 9.52 / 1.067e-5 = 892 000 s | 10.3 days |
| m_push | (2 * 3000 / 0.8 + 500) * 9.52 / 14 710 | 5.18 kg |
| m_drift | 500 * 7.2 / 14 710 | 0.24 kg |
| total per target | m_push + m_drift | 5.4 kg |

The deck quotes "~2 weeks and ~8 kg" for the same target. The difference is duty cycle and margin: the sim assumes continuous firing at 100% beam-on and no eclipse or attitude-hold losses. A ~75% duty cycle plus 30% margin recovers the deck numbers.

## 4. How the push is propagated

Near-circular, tangential low thrust:

    da/dt = 2 * a_t / n_GEO

integrated per substep (substeps are capped at 0.1 day). Both target and shepherd radius follow this; the shepherd is pinned at `standoff` metres behind the target along-track.

As the stack climbs, its longitude drifts westward relative to the GEO frame at `-1.5 * n * (r - R_GEO) / R_GEO`, so the target's stored longitude is updated every step and the next target's relative position is correct when the shepherd drifts on.

Delta-v delivered accumulates as `a_t * dt`; at end of push it is clamped to `dv_req`.

Tumble rate is decayed as `exp(-dt / 4 days)` while the beam is on. This is a placeholder for beam-torque detumbling, not a torque model.

## 5. Schematic versus physical

Physical (propagated or computed from the equations above):
- Push altitude gain, delta-v, propellant, counter thrust, beam-on time.
- Longitude drift of shepherd and stack from altitude offset.
- Drift-phase duration from actual longitude gap to the next target.

Schematic (fixed ops estimates from the CONOPS, not propagated):
- Climb 2 d, rendezvous 2 d, characterize 5 d, close 1 d, verify 3 d.
- Range profiles inside those phases are linear interpolations.
- Radial offsets in orbit view are exaggerated x30 so a 261 km raise reads next to a 42 164 km orbit.
- Inclination is a single 7.4 deg tilt applied to the cluster ring and all targets. There is no Laplace-plane precession, so relative inclination between targets is exactly zero.
- No solar radiation pressure, J2, or lunisolar perturbation.
- Relative motion is along-track (longitude) and radial only. There is no Clohessy-Wiltshire dynamics, so the shepherd holds standoff by construction.
- Beam half-angle only changes the drawn cone. It does not feed etaB, which stays at the slider value.
- Shepherd mass is constant; propellant burned is not subtracted.

## 6. Next steps toward higher fidelity

1. Replace the pinned standoff with Clohessy-Wiltshire (or Yamanaka-Ankersen) relative dynamics and a simple controller, so counter-thrust error and standoff drift become visible.
2. Model etaB as a function of standoff and plume half-angle (e.g. a self-similar plume with Gaussian or cos^n current profile intersected with the target cross-section), so the divergence slider affects propellant and time.
3. Give each derelict its own inclination vector and precess it about the Laplace pole (~53 yr period), so plane-change cost between targets is non-zero and target ordering matters.
4. Add an eclipse duty cycle (up to ~72 min/day near equinox) and a thrust-arc constraint to turn beam-on time into wall-clock time.
5. Subtract propellant from shepherd mass and let the counter thruster force update accordingly.
6. Add multi-target routing over the belt (longitude gap versus inclination cluster) to compare fleet throughput.
7. Add SRP on the high A/m target during the push, which is the reason the IADC formula includes the A/m term.
