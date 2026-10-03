/* js/physics-stub.js — minimal stand-in for js/physics.js, used ONLY by test-scene.html when the real
 * physics.js is not present. Implements the subset of the SIM.phys API that scene.js needs. */
(function () {
  'use strict';
  window.SIM = window.SIM || {};
  const MU = 398600.4418, RE = 6378.137, J2 = 1.08263e-3, DAY = 86400, GEO_R = 42164.17, OMEGA_E = 7.2921159e-5;

  function meanMotion(a) { return Math.sqrt(MU / (a * a * a)); }
  function raanRate(a, e, i) {
    const n = meanMotion(a), p = a * (1 - e * e);
    return -1.5 * n * J2 * (RE / p) * (RE / p) * Math.cos(i);
  }
  function solveE(M, e) {
    M = M % (2 * Math.PI);
    let E = e < 0.8 ? M : Math.PI;
    for (let k = 0; k < 12; k++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }
  function perifocalToEci(px, py, el) {
    const cO = Math.cos(el.raan), sO = Math.sin(el.raan), ci = Math.cos(el.i), si = Math.sin(el.i), cw = Math.cos(el.argp), sw = Math.sin(el.argp);
    const x = (cO * cw - sO * sw * ci) * px + (-cO * sw - sO * cw * ci) * py;
    const y = (sO * cw + cO * sw * ci) * px + (-sO * sw + cO * cw * ci) * py;
    const z = (sw * si) * px + (cw * si) * py;
    return { x, y, z };
  }
  function posFromEl(el) {
    const E = solveE(el.M, el.e);
    const px = el.a * (Math.cos(E) - el.e), py = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    return perifocalToEci(px, py, el);
  }
  function orbitPoints(el, n) {
    n = n || 180;
    const out = new Array(n);
    for (let k = 0; k < n; k++) {
      const E = k / n * 2 * Math.PI;
      out[k] = perifocalToEci(el.a * (Math.cos(E) - el.e), el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E), el);
    }
    return out;
  }
  function toScene(v) { return new THREE.Vector3(v.x * 1e-3, v.z * 1e-3, -v.y * 1e-3); }
  function latLonToEci(lat, lon, altKm, earthRot) {
    const r = RE + (altKm || 0), th = lon + (earthRot || 0), cl = Math.cos(lat);
    return { x: r * cl * Math.cos(th), y: r * cl * Math.sin(th), z: r * Math.sin(lat) };
  }
  function eciToLatLon(v, earthRot) {
    const lat = Math.atan2(v.z, Math.hypot(v.x, v.y));
    let lon = Math.atan2(v.y, v.x) - (earthRot || 0);
    while (lon > Math.PI) lon -= 2 * Math.PI;
    while (lon < -Math.PI) lon += 2 * Math.PI;
    return { lat, lon };
  }
  SIM.phys = { MU, RE, J2, DAY, GEO_R, OMEGA_E, meanMotion, raanRate, posFromEl, orbitPoints, toScene, latLonToEci, eciToLatLon, __stub: true };
})();
