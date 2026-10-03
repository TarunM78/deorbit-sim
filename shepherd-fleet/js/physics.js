// physics.js — orbital mechanics helpers. Attaches SIM.phys. ECI km, rad, s.
(function(){
'use strict';
window.SIM = window.SIM || {};
const MU=398600.4418, RE=6378.137, J2=1.08263e-3, DAY=86400, GEO_R=42164.17, OMEGA_E=7.2921159e-5, G0=9.80665;
const TWO_PI=2*Math.PI;

function meanMotion(a){ return Math.sqrt(MU/(a*a*a)); }
function period(a){ return TWO_PI/meanMotion(a); }
function raanRate(a,e,i){ const p=a*(1-e*e); return -1.5*meanMotion(a)*J2*(RE/p)*(RE/p)*Math.cos(i); }
function argpRate(a,e,i){ const p=a*(1-e*e); return 0.75*meanMotion(a)*J2*(RE/p)*(RE/p)*(5*Math.cos(i)*Math.cos(i)-1); }
function wrap(x){ x%=TWO_PI; return x<0?x+TWO_PI:x; }
function solveKepler(M,e){ M=wrap(M); let E=e<0.8?M:Math.PI; for(let k=0;k<12;k++){ const d=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E)); E-=d; if(Math.abs(d)<1e-10) break; } return E; }
function trueAnomaly(el){ const E=solveKepler(el.M,el.e); return Math.atan2(Math.sqrt(1-el.e*el.e)*Math.sin(E),Math.cos(E)-el.e); }
function perifocalToEci(px,py,vx,vy,el){
  const cO=Math.cos(el.raan),sO=Math.sin(el.raan),ci=Math.cos(el.i),si=Math.sin(el.i),cw=Math.cos(el.argp),sw=Math.sin(el.argp);
  const r11=cO*cw-sO*sw*ci, r12=-cO*sw-sO*cw*ci, r21=sO*cw+cO*sw*ci, r22=-sO*sw+cO*cw*ci, r31=sw*si, r32=cw*si;
  return { pos:{x:r11*px+r12*py, y:r21*px+r22*py, z:r31*px+r32*py}, vel:{x:r11*vx+r12*vy, y:r21*vx+r22*vy, z:r31*vx+r32*vy} };
}
function stateFromEl(el){
  const nu=trueAnomaly(el), p=el.a*(1-el.e*el.e), r=p/(1+el.e*Math.cos(nu));
  const px=r*Math.cos(nu), py=r*Math.sin(nu), h=Math.sqrt(MU*p);
  const vx=-MU/h*Math.sin(nu), vy=MU/h*(el.e+Math.cos(nu));
  return perifocalToEci(px,py,vx,vy,el);
}
function posFromEl(el){ return stateFromEl(el).pos; }
function posAtNu(el,nu){ const p=el.a*(1-el.e*el.e), r=p/(1+el.e*Math.cos(nu)); return perifocalToEci(r*Math.cos(nu),r*Math.sin(nu),0,0,el).pos; }
function orbitPoints(el,n){ n=n||180; const out=[]; for(let k=0;k<=n;k++) out.push(posAtNu(el,k/n*TWO_PI)); return out; }
function toScene(v){ return new THREE.Vector3(v.x*1e-3, v.z*1e-3, -v.y*1e-3); }
function latLonToEci(lat,lon,alt,earthRot){ const r=RE+alt, th=lon+earthRot; return {x:r*Math.cos(lat)*Math.cos(th), y:r*Math.cos(lat)*Math.sin(th), z:r*Math.sin(lat)}; }
function eciToLatLon(v,earthRot){ const r=Math.hypot(v.x,v.y,v.z); let lon=Math.atan2(v.y,v.x)-earthRot; lon=((lon+Math.PI)%TWO_PI+TWO_PI)%TWO_PI-Math.PI; return {lat:Math.asin(v.z/r), lon, alt:r-RE}; }
function propagate(el,dt,j2){ // secular J2 + mean motion
  const n=meanMotion(el.a); el.M=wrap(el.M+n*dt);
  if(j2!==false){ el.raan=wrap(el.raan+raanRate(el.a,el.e,el.i)*dt); el.argp=wrap(el.argp+argpRate(el.a,el.e,el.i)*dt); }
  return el;
}
// --- atmosphere: mean-activity density table (kg/m^3) vs altitude km, log-interp ---
const ATM=[[100,5.6e-7],[150,2.1e-9],[200,2.5e-10],[250,7.2e-11],[300,2.4e-11],[350,9.5e-12],[400,3.7e-12],[450,1.6e-12],[500,7.0e-13],[600,1.5e-13],[700,3.9e-14],[800,1.2e-14],[900,5.0e-15],[1000,2.5e-15],[1200,8e-16],[1500,2e-16]];
function density(h,solar){ // solar: multiplier 0.3..3 for cycle phase
  solar=solar||1; if(h<=ATM[0][0]) return ATM[0][1]*solar; if(h>=ATM[ATM.length-1][0]) return ATM[ATM.length-1][1]*solar*Math.exp(-(h-1500)/300);
  for(let k=1;k<ATM.length;k++){ if(h<=ATM[k][0]){ const [h0,d0]=ATM[k-1],[h1,d1]=ATM[k]; const f=(h-h0)/(h1-h0); return Math.exp(Math.log(d0)+(Math.log(d1)-Math.log(d0))*f)*solar; } }
  return 0;
}
// orbit-averaged drag decay of (a,e) over dt seconds. bc = Cd*A/m (m^2/kg). Samples the ellipse; returns new {a,e}.
function dragDecay(el,bc,dt,solar){
  const N=24; let dA=0,dE=0; const a=el.a,e=el.e, muSI=MU*1e9, aSI=a*1e3;
  for(let k=0;k<N;k++){ const E=k/N*TWO_PI, cE=Math.cos(E); const r=a*(1-e*cE); const h=r-RE; if(h<0) continue;
    const rho=density(h,solar); const v=Math.sqrt(MU*(2/r-1/a))*1e3; // m/s
    const accel=0.5*bc*rho*v*v;                     // m/s^2 tangential drag deceleration
    const cosNu=(cE-e)/(1-e*cE);
    const dadt=-2*aSI*aSI*v/muSI*accel;              // m/s   (Gauss, tangential)
    const dedt=-2*(e+cosNu)/v*accel;                 // 1/s
    const w=(1-e*cE)/N;                              // time-weight of this E sample
    dA+=dadt*w; dE+=dedt*w;
  }
  return {a:a+dA*dt*1e-3, e:Math.max(0,e+dE*dt)};
}
// crude lifetime estimate (days) by fast-forward integration with big steps
function lifetimeDays(el,bc,solar){
  let a=el.a,e=el.e,t=0; const step=10*DAY; for(let k=0;k<4000;k++){ const r=dragDecay({a,e},bc,step,solar); a=r.a; e=r.e; t+=step; if(a*(1-e)-RE<120) return t/DAY; if(t>100*365*DAY) break; } return null;
}
function hohmannDv(r1,r2){ const v1=Math.sqrt(MU/r1), v2=Math.sqrt(MU/r2), at=(r1+r2)/2; const dv1=Math.abs(Math.sqrt(MU*(2/r1-1/at))-v1), dv2=Math.abs(v2-Math.sqrt(MU*(2/r2-1/at))); return {dv1,dv2,total:dv1+dv2,tof:Math.PI*Math.sqrt(at*at*at/MU)}; }
function planeChangeDv(v,degrees){ return 2*v*Math.sin(degrees*Math.PI/360); } // km/s if v km/s
function elFromRpRa(rp,ra,i,raan,argp,M){ return {a:(rp+ra)/2, e:(ra-rp)/(ra+rp), i, raan, argp, M}; }
function propMass(m0,dv,isp){ return m0*(1-Math.exp(-dv/(isp*G0))); } // dv m/s
window.SIM.phys={MU,RE,J2,DAY,GEO_R,OMEGA_E,G0,TWO_PI,meanMotion,period,raanRate,argpRate,wrap,solveKepler,trueAnomaly,stateFromEl,posFromEl,posAtNu,orbitPoints,toScene,latLonToEci,eciToLatLon,propagate,density,dragDecay,lifetimeDays,hohmannDv,planeChangeDv,elFromRpRa,propMass};
})();
