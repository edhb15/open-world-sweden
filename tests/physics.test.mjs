// Headless vehicle-dynamics checks against real-world reference figures.
import { CarPhysics } from '../src/vehicle/physics.js';
import { VEHICLE } from '../src/vehicle/specs.js';

const DT = 1 / 240;
function flat(surface = 'asphalt', wet = 0, snow = 0, ice = 0) {
  return {
    ground(x, z, yTop, o) { o.y = 0; o.nx = 0; o.ny = 1; o.nz = 0; o.surface = surface; o.wet = wet; o.snow = snow; o.ice = ice; o.water = -Infinity; return true; },
  };
}
function mk(id, opts = {}) {
  const c = new CarPhysics(VEHICLE[id], opts);
  c.reset(0, 0, 0, 0);
  c.startEngineNow();
  if (c.autoMode) c.selectAuto('D'); else c.gear = 1;
  // settle
  const env = flat();
  for (let i = 0; i < 240; i++) c.step(DT, { throttle: 0, brake: 1 }, env);
  return c;
}
const kmh = (c) => c.fwdSpeed * 3.6;
let fails = 0;
function check(name, val, lo, hi, unit = '') {
  const ok = val >= lo && val <= hi;
  if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(46) + val.toFixed(2).padStart(9) + ' ' + unit.padEnd(5) + `  [${lo}..${hi}]`);
}

// 1. acceleration 0-100
function accel(id, opts, manualShift) {
  const c = mk(id, opts);
  const env = flat();
  let t = 0;
  while (kmh(c) < 100 && t < 40) {
    const inp = { throttle: 1, brake: 0, steer: 0 };
    if (manualShift && c.rpm > c.spec.engine.redline * 0.97 && c.gear < c.nGears && c.shiftT <= 0) inp.shiftUp = true;
    c.step(DT, inp, env); t += DT;
  }
  return t;
}
check('Norrfors V7 (AWD auto, 250hp) 0-100', accel('v7'), 5.8, 8.0, 's');
check('Norrfors 245 (RWD manual, 116hp) 0-100', accel('245', {}, true), 10, 14.5, 's');
check('Kompis 1.4 (FWD manual, 100hp) 0-100', accel('kompis', {}, true), 10.5, 14.5, 's');
check('Lyra E (EV AWD, 300kW) 0-100', accel('lyra'), 4.0, 6.0, 's');
check('Kronstad S V8 (RWD) 0-100', accel('kronstad'), 4.2, 6.5, 's');
check('Fjällvik XC9 diesel 0-100', accel('xc'), 7.5, 10.5, 's');

// 2. braking 100-0
function brakeDist(id, opts, env) {
  const c = mk(id, opts);
  // accelerate on dry asphalt, settle at 100 km/h, then brake on the test surface
  const dry = flat();
  let k = 0;
  while (kmh(c) < 100 && k++ < 240 * 40) c.step(DT, { throttle: 1, shiftUp: !c.autoMode && c.rpm > c.spec.engine.redline * 0.95 && c.shiftT <= 0 }, dry);
  for (let i = 0; i < 120; i++) c.step(DT, { throttle: 0.25 }, dry);
  c.v = [0, 0, -100 / 3.6]; for (const w of c.wheels) w.w = (100 / 3.6) / w.r;
  let d = 0, t = 0;
  c.fwdSpeed = 100 / 3.6;
  while (c.fwdSpeed > 0.1 && t < 60) { const z0 = c.p[2]; c.step(DT, { throttle: 0, brake: 1 }, env); d += z0 - c.p[2]; t += DT; }
  return d;
}
check('V7 ABS braking 100-0 dry', brakeDist('v7', {}, flat()), 33, 42, 'm');
check('V7 ABS braking 100-0 wet', brakeDist('v7', {}, flat('asphalt', 1)), 40, 56, 'm');
check('245 no ABS (locked wheels) 100-0 dry', brakeDist('245', { abs: false }, flat()), 40, 58, 'm');
check('V7 winter tyres 100-0 on snow', brakeDist('v7', { tires: 'winter' }, flat('snow')), 50, 85, 'm');
check('V7 studded 100-0 on ice', brakeDist('v7', { tires: 'studded' }, flat('ice')), 80, 135, 'm');
check('V7 summer tyres 100-0 on ice', brakeDist('v7', { tires: 'summer' }, flat('ice')), 230, 450, 'm');

// 3. steady-state cornering: constant radius 60 m at increasing speed until it can't hold
function maxLat(id, opts = {}) {
  const c = mk(id, opts);
  const env = flat();
  let best = 0;
  // drive in a circle with a P controller on lateral position
  const R0 = 60;
  c.p = [R0, c.p[1], 0];
  // start heading north at the east point -> circle counter-clockwise (left turn)
  for (let i = 0; i < 240 * 50; i++) {
    const t = i * DT;
    const vT = Math.min(5 + t * 0.8, 40);
    const r = Math.hypot(c.p[0], c.p[2]);
    const ang = Math.atan2(c.p[2], c.p[0]);
    // desired heading: tangent (counter-clockwise on map = left turn)
    const tx = Math.sin(ang), tz = -Math.cos(ang);
    const f = c.forward;
    const herr = Math.atan2(f[0] * tz - f[2] * tx, f[0] * tx + f[2] * tz);
    const steer = Math.max(-1, Math.min(1, -(Math.atan(c.spec.body.wb / R0) / (c.spec.steer.max * Math.PI / 180)) + herr * 3.0 - (r - R0) * 0.12 - c.yawRate * 0.0));
    const thr = Math.max(0, Math.min(1, (vT - c.fwdSpeed) * 0.5));
    c.step(DT, { throttle: thr, brake: 0, steer, shiftUp: !c.autoMode && c.rpm > c.spec.engine.redline * 0.85 && c.shiftT <= 0 }, env);
    const lat = c.fwdSpeed * c.fwdSpeed / R0 / 9.81;
    if (Math.abs(r - R0) < 3) best = Math.max(best, lat);
    if (Math.abs(r - R0) > 8) { if (process.env.DBG) console.log('  lost track at', t.toFixed(1), 's', 'v', c.fwdSpeed.toFixed(1), 'r', r.toFixed(1), 'steer', steer.toFixed(2)); break; }
  }
  return best;
}
check('V7 max lateral g on R=60 m (dry)', maxLat('v7', { esc: false }), 0.8, 1.05, 'g');
check('Lastvik van max lateral g (dry)', maxLat('van', { esc: false }), 0.6, 0.95, 'g');

// 4. top speed
function vmax(id) {
  const c = mk(id);
  const env = flat();
  for (let i = 0; i < 240 * 90; i++) c.step(DT, { throttle: 1 }, env);
  return kmh(c);
}
check('V7 top speed', vmax('v7'), 210, 265, 'km/h');
check('Stadsbuss governed top speed', vmax('bus'), 82, 92, 'km/h');

// 5. parked car stays put, idle stable
{
  const c = mk('245');
  c.gear = 0;
  const env = flat();
  const p0 = [...c.p];
  for (let i = 0; i < 240 * 20; i++) c.step(DT, { throttle: 0, brake: 0, handbrake: 1 }, env);
  check('245 parked 20 s drift', Math.hypot(c.p[0] - p0[0], c.p[2] - p0[2]), 0, 0.05, 'm');
  check('245 idle rpm', c.rpm, 700, 1000, 'rpm');
}
// 6. automatic creep in D on flat
{
  const c = mk('v7');
  const env = flat();
  for (let i = 0; i < 240 * 15; i++) c.step(DT, { throttle: 0, brake: 0 }, env);
  check('V7 creep speed in D', kmh(c), 3, 12, 'km/h');
}
// 7. manual stall when releasing clutch without throttle (no auto clutch)
{
  const c = mk('kompis', { autoClutch: false });
  const env = flat();
  for (let i = 0; i < 240 * 2; i++) c.step(DT, { throttle: 0, brake: 0, clutch: Math.max(0, 1 - i / 60) }, env);
  check('Kompis stalls when dumping clutch (1=stalled)', c.running ? 0 : 1, 1, 1, '');
}
// 7b. starting with the ignition key (starter, not startEngineNow) must not stall a manual,
//     and with the auto clutch it keeps running through a launch and an emergency stop
for (const id of ['245', 'kompis']) {
  const c = new CarPhysics(VEHICLE[id], { trans: 'manual', autoClutch: true });
  c.reset(0, 0, 0, 0);
  const env = flat();
  let stalls = 0;
  const step = (inp) => { c.step(DT, inp, env); for (const e of c.events) if (e === 'stall') stalls++; };
  for (let i = 0; i < 240 * 3; i++) step({ throttle: 0, brake: 1, ignition: i === 0, shiftUp: i === 500 });
  for (let i = 0; i < 240 * 6; i++) step({ throttle: 1, brake: 0, shiftUp: c.rpm > 4000 && c.shiftT <= 0 && c.gear < 3 });
  for (let i = 0; i < 240 * 5; i++) step({ throttle: 0, brake: 1 });
  check(`${id} ignition start, launch & hard stop: stalls`, stalls, 0, 0, '');
}
// 7c. without the auto clutch: no cranking in gear unless the clutch is pressed
//     (otherwise the engine would start and stall straight away)
{
  const c = new CarPhysics(VEHICLE['245'], { trans: 'manual', autoClutch: false });
  c.reset(0, 0, 0, 0);
  const env = flat();
  c.gear = 1;
  const ev = [];
  for (let i = 0; i < 240 * 3; i++) { c.step(DT, { brake: 1, ignition: i === 0 }, env); ev.push(...c.events); }
  check('245 no auto clutch: crank in gear w/o clutch (1=refused)', !ev.includes('crank') && ev.includes('needclutch') ? 1 : 0, 1, 1, '');
  for (let i = 0; i < 240 * 3; i++) c.step(DT, { brake: 1, clutch: 1, ignition: i === 0 }, env);
  check('245 no auto clutch: starts in gear with clutch held', c.running ? 1 : 0, 1, 1, '');
}
// 7d. straight-line tracking: hands off at 90 km/h for 200 m. A car with a dented front
//     (one 50 km/h crash on the left) must still go straight; only a wrecked front pulls gently.
for (const [label, dmg, lo, hi] of [['undamaged', {}, -0.3, 0.3], ['50 km/h front-left crash', { front: 0.55, left: 0.39 }, -0.5, 0.5], ['wrecked front (pulls left)', { front: 1, left: 0.6, right: 0.1 }, -30, -5]]) {
  const c = mk('v7');
  Object.assign(c.damage, dmg);
  const env = flat();
  let k = 0;
  while (-c.p[2] < 200 && k++ < 240 * 30) c.step(DT, { throttle: kmh(c) < 90 ? 0.8 : 0.3, steer: 0, steerAssist: true }, env);
  check(`V7 hands-off drift over 200 m, ${label}`, c.p[0], lo, hi, 'm');
}
// 8. fuel consumption at steady 90 km/h (L/100km)
{
  const c = mk('v7');
  const env = flat();
  for (let i = 0; i < 240 * 30; i++) c.step(DT, { throttle: Math.max(0, Math.min(1, (25 - c.fwdSpeed) * 0.3 + 0.18)) }, env);
  const f0 = c.fuelUsed, o0 = c.odo;
  for (let i = 0; i < 240 * 60; i++) { const thr = Math.max(0, Math.min(1, (25 - c.fwdSpeed) * 0.3 + 0.18)); c.step(DT, { throttle: thr }, env); }
  check('V7 consumption at ~90 km/h', (c.fuelUsed - f0) / ((c.odo - o0) / 1000) * 100, 4.5, 9.5, 'L/100');
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall physics checks passed');
process.exitCode = fails ? 1 : 0;
