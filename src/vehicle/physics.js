/* =====================================================================
   Vehicle dynamics.
   - 6-DOF rigid body, semi-implicit Euler at a fixed sub-step.
   - Raycast suspension with springs, bump/rebound damping, anti-roll
     bars and bump stops.
   - Combined-slip tyre model (normalised slip, Pacejka-like shape) with
     load sensitivity and surface-dependent grip.
   - Drivetrain: engine torque map, turbo lag, idle control, stalling,
     clutch (friction-constraint solve), torque converter, gearbox,
     open/limited-slip differentials, FWD/RWD/AWD, EV motor with regen.
   - Assists: ABS, traction control, ESC.
   Body frame: forward = -z, right = +x, up = +y.
   Pure JS (no three.js) so it can be unit tested under Node.
   ===================================================================== */
import { UPGRADES } from './specs.js';

const G = 9.81;
const RHO = 1.22;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// surface -> tyre-grip key, curve parameters, rolling resistance
const SURF = {
  asphalt: { key: 'dry', kp: 0.1, ap: 0.13, C: 1.45, rr: 0.011, mult: 1.0 },
  concrete: { key: 'dry', kp: 0.1, ap: 0.13, C: 1.45, rr: 0.011, mult: 0.98 },
  cobble: { key: 'dry', kp: 0.1, ap: 0.13, C: 1.4, rr: 0.016, mult: 0.86 },
  sidewalk: { key: 'dry', kp: 0.1, ap: 0.13, C: 1.45, rr: 0.013, mult: 0.95 },
  gravel: { key: 'gravel', kp: 0.17, ap: 0.19, C: 1.12, rr: 0.026, mult: 1.0 },
  verge: { key: 'gravel', kp: 0.17, ap: 0.2, C: 1.12, rr: 0.03, mult: 0.95 },
  dirt: { key: 'gravel', kp: 0.18, ap: 0.2, C: 1.15, rr: 0.035, mult: 0.92 },
  grass: { key: 'gravel', kp: 0.2, ap: 0.22, C: 1.2, rr: 0.05, mult: 0.75 },
  sand: { key: 'gravel', kp: 0.25, ap: 0.25, C: 1.1, rr: 0.09, mult: 0.7 },
  rock: { key: 'dry', kp: 0.12, ap: 0.14, C: 1.35, rr: 0.02, mult: 0.8 },
  snow: { key: 'snow', kp: 0.16, ap: 0.18, C: 1.2, rr: 0.03, mult: 1.0 },
  ice: { key: 'ice', kp: 0.07, ap: 0.09, C: 1.5, rr: 0.012, mult: 1.0 },
  water: { key: 'wet', kp: 0.15, ap: 0.2, C: 1.2, rr: 0.15, mult: 0.35 },
};

export class CarPhysics {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.opts = { tires: 'summer', tune: 'stock', susp: 'comfort', trans: spec.gearbox.type === 'manual' ? 'manual' : 'auto', autoClutch: true, abs: true, tcs: true, esc: true, autoReverse: true, ...opts };
    const B = spec.body;
    this.m = spec.mass;
    const k = 0.62;
    const L = B.L, W = B.W, H = B.H * 0.8;
    this.Ib = [this.m / 12 * (H * H + L * L) * k, this.m / 12 * (W * W + L * L) * k, this.m / 12 * (W * W + H * H) * k * 0.9];
    this.cgH = spec.cgH;
    // axle positions relative to CoM
    const a = B.wb * (1 - spec.weightF), b = B.wb * spec.weightF;
    this.a = a; this.b = b;
    const S = spec.susp;
    const stiff = UPGRADES.susp[this.opts.susp]?.stiff || 1;
    const r = spec.tire.r;
    const mkWheel = (front, left) => {
      const kS = (front ? S.kF : S.kR) * stiff;
      const corner = this.m * G * (front ? spec.weightF : 1 - spec.weightF) / 2;
      const x0 = corner / kS;
      const track = front ? B.trackF : B.trackR;
      return {
        front, left, x: (left ? -1 : 1) * track / 2, z: front ? -a : b,
        y: r + S.rest - x0 - this.cgH, // attachment height in body frame
        k: kS, rest: S.rest, travel: S.travel, r, I: front ? 1.1 : 1.15,
        driven: spec.drive === 'AWD' || (spec.drive === 'FWD' ? front : !front),
        w: 0, angle: 0, steer: 0, comp: x0, compV: 0, contact: false, Fz: corner, Fz0: corner,
        Fx: 0, Fy: 0, slip: 0, slipAngle: 0, kappa: 0, vx: 0, vy: 0, surface: 'asphalt', brake: 0, absOn: false,
        cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, fx: 0, fy: 0, fz: -1, sx: 1, sy: 0, sz: 0, load: 0, wet: 0, snow: 0, ice: 0, skid: 0,
      };
    };
    this.wheels = [mkWheel(true, true), mkWheel(true, false), mkWheel(false, true), mkWheel(false, false)];
    if (spec.drive === 'AWD') {
      const s = spec.split;
      this.wheels[0].tw = this.wheels[1].tw = s / 2;
      this.wheels[2].tw = this.wheels[3].tw = (1 - s) / 2;
    } else for (const w of this.wheels) w.tw = w.driven ? 0.5 : 0;
    // engine
    const E = spec.engine;
    this.ev = E.type === 'ev';
    this.tune = UPGRADES.tune[this.opts.tune]?.power || 1;
    this.peakT = this.ev ? E.maxTorque : Math.max(...E.torque.map((p) => p[1]));
    this.Ie = E.inertia;
    this.rpm = 0; this.we = 0; this.running = false; this.starter = 0; this.stalled = false;
    this.boost = 0;
    this.gear = this.ev ? 1 : 0;
    this.autoMode = this.opts.trans === 'auto' || this.ev;
    this.sel = 'P'; // P R N D for automatics
    this.shiftT = 0; this.shiftCool = 0;
    this.clutchLocked = false;
    this.clutchEng = 1;
    this.tcFactor = 1;
    this.lockup = false;
    this.fuel = spec.fuel.tank * spec.fuel.start;
    this.fuelUsed = 0;
    this.odo = 0;
    this.energy = 0;
    this.damage = { engine: 0, body: 0, front: 0, rear: 0, left: 0, right: 0, glass: 0 };
    this.events = [];
    this.inWater = 0;
    this.flooded = false;
    // state
    this.p = [0, 0, 0]; this.v = [0, 0, 0]; this.q = [0, 0, 0, 1]; this.w = [0, 0, 0];
    this.R = new Float64Array(9);
    this.updateR();
    this.speed = 0; this.fwdSpeed = 0;
    this.steerAngle = 0;
    this.yawRate = 0;
    this.load = 0; this.throttleEff = 0;
    this.horn = false;
    this.esc = 0; this.tcsActive = 0; this.absActive = 0;
    this.accel = [0, 0, 0];
    this.reverseHold = 0;
  }

  /* ------------------------------ helpers ------------------------------ */
  updateR() {
    const [x, y, z, w] = this.q, R = this.R;
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
    R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
    R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
  }
  // body -> world vector
  toWorld(x, y, z, out) { const R = this.R; out[0] = R[0] * x + R[1] * y + R[2] * z; out[1] = R[3] * x + R[4] * y + R[5] * z; out[2] = R[6] * x + R[7] * y + R[8] * z; return out; }
  toBody(x, y, z, out) { const R = this.R; out[0] = R[0] * x + R[3] * y + R[6] * z; out[1] = R[1] * x + R[4] * y + R[7] * z; out[2] = R[2] * x + R[5] * y + R[8] * z; return out; }
  get forward() { return [-this.R[2], -this.R[5], -this.R[8]]; }
  get up() { return [this.R[1], this.R[4], this.R[7]]; }
  get right() { return [this.R[0], this.R[3], this.R[6]]; }
  // yaw angle about +y (0 = facing north / -z)
  yaw() { return Math.atan2(this.R[2], this.R[8]); }

  reset(x, y, z, yaw) {
    // yaw: rotation about +y; forward = (-sin yaw, 0, -cos yaw)
    this.p = [x, y + this.cgH + 0.05, z];
    this.v = [0, 0, 0]; this.w = [0, 0, 0];
    this.q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    this.updateR();
    for (const w of this.wheels) { w.w = 0; w.comp = w.Fz0 / w.k; w.compV = 0; }
    this.we = this.running ? this.spec.engine.idle * Math.PI / 30 : 0;
    this.inWater = 0; this.flooded = false;
  }

  engineTorqueMax(rpm) {
    const E = this.spec.engine;
    const T = E.torque;
    if (rpm <= T[0][0]) return T[0][1] * Math.max(0, rpm / T[0][0]);
    for (let i = 1; i < T.length; i++) if (rpm <= T[i][0]) return lerp(T[i - 1][1], T[i][1], (rpm - T[i - 1][0]) / (T[i][0] - T[i - 1][0]));
    return T[T.length - 1][1] * Math.max(0, 1 - (rpm - T[T.length - 1][0]) / 600);
  }
  ratio(g = this.gear) {
    const GB = this.spec.gearbox;
    if (g > 0) return GB.ratios[g - 1] * GB.final;
    if (g < 0) return -GB.reverse * GB.final;
    return 0;
  }
  get nGears() { return this.spec.gearbox.ratios.length; }

  gripFor(surface, wet, snow, ice) {
    const T = UPGRADES.tires[this.opts.tires] || UPGRADES.tires.summer;
    const S = SURF[surface] || SURF.asphalt;
    let mu;
    if (S.key === 'gravel') mu = T.grip.gravel;
    else if (S.key === 'snow') mu = T.grip.snow;
    else if (S.key === 'ice') mu = T.grip.ice;
    else mu = lerp(T.grip.dry, T.grip.wet, clamp(wet, 0, 1));
    if (S.key !== 'ice' && S.key !== 'snow') {
      if (snow > 0) mu = lerp(mu, T.grip.snow * (S.key === 'gravel' ? 1.05 : 1), clamp(snow, 0, 1));
      if (ice > 0) mu = lerp(mu, T.grip.ice, clamp(ice, 0, 1));
    }
    return mu * S.mult * this.spec.tire.mu;
  }

  /* ------------------------------ step ------------------------------ */
  step(dt, input, env) {
    const spec = this.spec, E = spec.engine;
    const W = this.wheels;
    this.events.length = 0;
    this.updateR();
    const R = this.R;
    const up = [R[1], R[4], R[7]];
    const fwd = [-R[2], -R[5], -R[8]];
    const right = [R[0], R[3], R[6]];
    const v = this.v, wv = this.w, p = this.p;
    const speed = Math.hypot(v[0], v[1], v[2]);
    const fwdSpeed = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
    this.speed = speed; this.fwdSpeed = fwdSpeed;
    let F = [0, -this.m * G, 0];
    let T = [0, 0, 0];
    const addForceAt = (fx, fy, fz, px, py, pz) => {
      F[0] += fx; F[1] += fy; F[2] += fz;
      const rx = px - p[0], ry = py - p[1], rz = pz - p[2];
      T[0] += ry * fz - rz * fy; T[1] += rz * fx - rx * fz; T[2] += rx * fy - ry * fx;
    };

    /* ---------- steering ---------- */
    const S = spec.steer;
    const maxA = S.max * Math.PI / 180;
    let target = clamp(input.steer || 0, -1, 1) * maxA;
    if (input.steerAssist) target /= 1 + Math.max(0, Math.abs(fwdSpeed) - 4) * 0.035;
    // a badly damaged front end bends the steering: a gentle pull toward the damaged side
    // (none from minor bumps; at most ~0.15 degrees of wheel angle for a wrecked front)
    const Dm = this.damage, side = Dm.left - Dm.right;
    const pull = Math.abs(side) > 0.08 ? 0.0026 * smooth(0.5, 1, Dm.front) * Math.sign(-side) : 0;
    target += pull;
    if (pull && !this.pullWarned) { this.pullWarned = true; this.events.push(pull < 0 ? 'pullLeft' : 'pullRight'); }
    if (!pull) this.pullWarned = false;
    const rate = input.directSteer ? 50 : maxA * 2.6;
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);
    const d = this.steerAngle;
    // Ackermann
    const L = spec.body.wb, tr = spec.body.trackF;
    if (Math.abs(d) > 1e-4) {
      const Rt = L / Math.tan(Math.abs(d));
      const inner = Math.atan(L / (Rt - tr / 2)), outer = Math.atan(L / (Rt + tr / 2));
      const sgn = Math.sign(d);
      // right turn (d>0): right wheel is inner
      W[0].steer = sgn * (sgn > 0 ? outer : inner);
      W[1].steer = sgn * (sgn > 0 ? inner : outer);
    } else { W[0].steer = W[1].steer = 0; }
    if (spec.fixedRear) { /* heavy vehicles: no rear steer */ }

    /* ---------- suspension & contacts ---------- */
    const g = env.groundOut || (env.groundOut = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'asphalt', wet: 0, snow: 0, ice: 0, water: -Infinity });
    const A = [0, 0, 0], tmp = [0, 0, 0];
    let contacts = 0;
    for (const w of W) {
      this.toWorld(w.x, w.y, w.z, A);
      A[0] += p[0]; A[1] += p[1]; A[2] += p[2];
      w.ax = A[0]; w.ay = A[1]; w.az = A[2];
      const reach = w.rest + w.r;
      const px = A[0] - up[0] * reach, pz = A[2] - up[2] * reach;
      const ok = env.ground(px, pz, A[1] + 0.4, g);
      w.contact = false;
      let len = reach;
      if (ok) {
        const nx = g.nx, ny = g.ny, nz = g.nz;
        const dn = -(nx * up[0] + ny * up[1] + nz * up[2]);
        if (dn < -0.2) {
          const t = (nx * (px - A[0]) + ny * (g.y - A[1]) + nz * (pz - A[2])) / dn;
          if (t < reach && t > -0.6) {
            len = t;
            w.contact = true;
            w.nx = nx; w.ny = ny; w.nz = nz;
            w.surface = g.surface; w.wet = g.wet; w.snow = g.snow; w.ice = g.ice;
            w.water = g.water;
          }
        }
      }
      const springLen = len - w.r;
      let comp = w.contact ? clamp(w.rest - springLen, 0, w.rest + 0.2) : 0;
      w.compV = (comp - w.comp) / dt;
      w.comp = comp;
      w.cx = A[0] - up[0] * len; w.cy = A[1] - up[1] * len; w.cz = A[2] - up[2] * len;
      if (w.contact) contacts++;
    }
    // anti-roll bars
    for (const [l, r2, kArb] of [[W[0], W[1], spec.susp.arbF], [W[2], W[3], spec.susp.arbR]]) {
      const diff = (l.comp - r2.comp) * kArb;
      l.arb = diff; r2.arb = -diff;
    }
    for (const w of W) {
      if (!w.contact) { w.Fz = 0; continue; }
      let Fs = w.k * w.comp + (w.compV > 0 ? spec.susp.bump : spec.susp.rebound) * w.compV + (w.arb || 0);
      if (w.comp > w.travel) Fs += (w.comp - w.travel) * w.k * 8 + Math.max(0, w.compV) * spec.susp.bump * 3;
      Fs = Math.max(0, Fs);
      w.Fz = Fs;
      addForceAt(up[0] * Fs, up[1] * Fs, up[2] * Fs, w.ax, w.ay, w.az);
    }

    /* ---------- tyre frames & slip velocities ---------- */
    for (const w of W) {
      if (!w.contact) continue;
      const sn = Math.sin(w.steer), cs = Math.cos(w.steer);
      // wheel forward in world: R * (sin d, 0, -cos d)
      this.toWorld(sn, 0, -cs, tmp);
      const dn = tmp[0] * w.nx + tmp[1] * w.ny + tmp[2] * w.nz;
      let fx = tmp[0] - w.nx * dn, fy = tmp[1] - w.ny * dn, fz = tmp[2] - w.nz * dn;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      // right = f x n
      const sx = fy * w.nz - fz * w.ny, sy = fz * w.nx - fx * w.nz, sz = fx * w.ny - fy * w.nx;
      w.fx = fx; w.fy = fy; w.fz = fz; w.sx = sx; w.sy = sy; w.sz = sz;
      const rx = w.cx - p[0], ry = w.cy - p[1], rz = w.cz - p[2];
      const vcx = v[0] + wv[1] * rz - wv[2] * ry, vcy = v[1] + wv[2] * rx - wv[0] * rz, vcz = v[2] + wv[0] * ry - wv[1] * rx;
      w.vx = vcx * fx + vcy * fy + vcz * fz;
      w.vy = vcx * sx + vcy * sy + vcz * sz;
      const muBase = this.gripFor(w.surface, w.wet, w.snow, w.ice);
      const ls = clamp(1 - 0.12 * (w.Fz / w.Fz0 - 1), 0.7, 1.12);
      w.mu = muBase * ls;
      w.sp = SURF[w.surface] || SURF.asphalt;
    }

    /* ---------- engine & driver inputs ---------- */
    let throttle = clamp(input.throttle || 0, 0, 1);
    let brake = clamp(input.brake || 0, 0, 1);
    const handbrake = clamp(input.handbrake || 0, 0, 1);
    // automatic: auto-reverse convenience (hold brake at standstill -> R, pedals swap)
    if (this.autoMode && this.opts.autoReverse && input.arcadePedals) {
      const slow = Math.abs(fwdSpeed) < 0.6;
      if (this.sel === 'D' || this.sel === 'P' || this.sel === 'N') {
        if (slow && brake > 0.5 && throttle < 0.05) { this.reverseHold += dt; if (this.reverseHold > 0.45) { this.selectAuto('R'); this.reverseHold = 0; } }
        else this.reverseHold = 0;
        if ((this.sel === 'P' || this.sel === 'N') && throttle > 0.1) this.selectAuto('D');
      } else if (this.sel === 'R') {
        // in reverse the brake key drives backwards and the throttle key brakes
        const t2 = brake, b2 = throttle;
        throttle = t2; brake = b2;
        if (slow && b2 > 0.5 && t2 < 0.05) { this.reverseHold += dt; if (this.reverseHold > 0.3) { this.selectAuto('D'); this.reverseHold = 0; } }
        else this.reverseHold = 0;
      }
    }
    this.pedalThrottle = throttle; this.pedalBrake = brake;
    // ignition (manual without auto clutch: the clutch must be pressed, or neutral selected)
    this.clutchPedal = input.clutch || 0;
    if (input.ignition) this.toggleIgnition();
    if (this.starter > 0) {
      this.starter -= dt;
      this.we = Math.max(this.we, Math.min(this.we + 900 * dt, 260 * Math.PI / 30));
      if (this.starter <= 0) {
        if ((this.fuel > 0.05 || this.ev) && !this.flooded && this.damage.engine < 1) {
          // the engine catches and flares above idle; the idle controller then settles it
          this.running = true; this.stalled = false; this.events.push('start');
          this.we = Math.max(this.we, E.idle * 1.25 * Math.PI / 30);
          this.stallGrace = 1.0;
        }
        else {
          this.noStartReason = this.flooded ? 'water' : this.damage.engine >= 1 ? 'engine' : 'fuel';
          this.events.push('nostart');
        }
      }
    }
    if (this.ev) { this.we = Math.abs(this.wheelsDrivenSpeed()) * Math.abs(this.ratio(1)); }
    // shifting
    if (input.shiftUp) this.shift(+1);
    if (input.shiftDown) this.shift(-1);
    if (input.select) this.selectAuto(input.select);
    if (this.shiftT > 0) this.shiftT -= dt;
    if (this.shiftCool > 0) this.shiftCool -= dt;
    if (this.autoMode && !this.ev && this.sel === 'D' && !input.manualOverride) this.autoShift(throttle, brake);

    const rpm = this.we * 30 / Math.PI;
    this.rpm = rpm;
    // engine torque
    let Te = 0;
    const dmgK = 1 - 0.65 * this.damage.engine;
    if (this.ev) {
      const wm = Math.max(1, this.we);
      const Pmax = E.maxPower * 1000 * this.tune;
      const Tmax = Math.min(E.maxTorque * this.tune, Pmax / wm);
      Te = (this.running ? throttle * Tmax : 0) * dmgK;
      // regen when lifting off (and a little extra with the brake)
      if (this.running && throttle < 0.02 && this.speed > 1.5 && this.sel !== 'N') Te -= E.regen * E.maxTorque * (smooth(1.5, 6, this.speed));
      this.throttleEff = throttle;
      this.load = clamp(Math.abs(Te) / E.maxTorque, 0, 1);
    } else {
      let thr = throttle;
      if (this.running) {
        const idleW = E.idle * Math.PI / 30;
        // idle controller
        const idleThr = clamp((idleW - this.we) / (idleW * 0.35) + 0.07, 0, 0.45);
        thr = Math.max(thr, idleThr);
        if (rpm > E.limiter) thr = 0;
        if (E.governor && this.speed * 3.6 > E.governor) thr = Math.min(thr, clamp(1 - (this.speed * 3.6 - E.governor) / 3, 0, 1));
        if (this.shiftT > 0 && !this.autoMode) thr = Math.min(thr, 0.05);
        if (this.shiftT > 0 && this.autoMode) thr *= 0.45;
        thr *= this.tcFactor;
        // turbo spool
        const tb = E.turbo || 0;
        const targetBoost = thr * smooth(1200, 2600, rpm);
        this.boost += (targetBoost - this.boost) * clamp(dt / (0.25 + tb * 0.9), 0, 1);
        const boostK = 1 - tb * 0.42 * (1 - this.boost);
        const Tmax = this.engineTorqueMax(rpm) * this.tune * boostK * dmgK;
        const drag = (0.06 + 0.12 * rpm / E.redline) * this.peakT * 0.45;
        Te = thr * Tmax - (1 - thr) * drag;
        this.throttleEff = thr;
        this.load = clamp(thr * Tmax / this.peakT, 0, 1);
      } else {
        Te = -(0.08 + 0.1 * rpm / E.redline) * this.peakT * 0.5 - (this.we > 0 ? 8 : 0);
        this.throttleEff = 0; this.load = 0; this.boost *= 0.95;
      }
    }

    /* ---------- tyre forces at current wheel speed ---------- */
    const vmin = 1.6;
    const tire = (w, wSpin, out) => {
      const sp = w.sp;
      const denom = Math.max(Math.abs(w.vx), vmin);
      const kappa = (wSpin * w.r - w.vx) / denom;
      const tanA = w.vy / Math.max(Math.abs(w.vx), vmin);
      const sx = kappa / sp.kp, sy = tanA / Math.tan(sp.ap);
      const rho = Math.hypot(sx, sy);
      const C = sp.C, Bc = Math.tan(Math.PI / (2 * C));
      const shape = Math.sin(C * Math.atan(Bc * rho));
      const Fmax = w.mu * w.Fz;
      let Fx = 0, Fy = 0;
      if (rho > 1e-6) { Fx = Fmax * shape * sx / rho; Fy = -Fmax * 0.88 * shape * sy / rho; }
      // slope for implicit wheel integration
      const gslope = Math.max(0.03, Math.cos(C * Math.atan(Bc * rho)) / (1 + Bc * Bc * rho * rho));
      out.Fx = Fx; out.Fy = Fy; out.kappa = kappa; out.alpha = Math.atan(tanA); out.rho = rho;
      out.dFdw = (Fmax * C * Bc / sp.kp) * gslope * w.r / denom;
      return out;
    };
    const tf = { Fx: 0, Fy: 0, kappa: 0, alpha: 0, rho: 0, dFdw: 0 };
    for (const w of W) {
      if (!w.contact) { w.Fx0 = 0; w.k0 = 0; continue; }
      tire(w, w.w, tf);
      w.Fx0 = tf.Fx; w.k0 = tf.dFdw; w.kappa = tf.kappa; w.slipAngle = tf.alpha; w.rho = tf.rho;
    }

    /* ---------- assists ---------- */
    // TCS: cut torque when driven wheels spin
    this.tcsActive = 0;
    if (this.opts.tcs && throttle > 0.05) {
      let worst = 0;
      for (const w of W) if (w.driven && w.contact) worst = Math.max(worst, w.kappa / w.sp.kp);
      if (worst > 1.4) { this.tcFactor = Math.max(0.15, this.tcFactor - dt * 4); this.tcsActive = 1; }
      else this.tcFactor = Math.min(1, this.tcFactor + dt * 2.5);
    } else this.tcFactor = Math.min(1, this.tcFactor + dt * 3);
    // brakes
    const Bk = spec.brakes;
    for (const w of W) {
      let bt = brake * (w.front ? Bk.front : Bk.rear);
      if (!w.front) bt += handbrake * 2600 * (spec.mass / 1500);
      w.absOn = false;
      if (w.absK == null) w.absK = 1;
      if (this.opts.abs && Bk.abs !== false && bt > 0 && w.contact && Math.abs(w.vx) > 2.5 && handbrake < 0.1) {
        // slip-targeting modulation around the friction peak
        const lock = -w.kappa / w.sp.kp;
        if (lock > 1.08) { w.absK = Math.max(0.12, w.absK - dt * 30); w.absOn = true; }
        else if (lock < 0.92) w.absK = Math.min(1, w.absK + dt * 8);
        bt *= w.absK;
      } else w.absK = Math.min(1, w.absK + dt * 10);
      w.brake = bt;
    }
    // parking pawl
    if (this.autoMode && this.sel === 'P') for (const w of W) if (w.driven) w.brake = Math.max(w.brake, 6000);
    // ESC
    this.esc = 0;
    if (this.opts.esc && Bk.abs !== false && Math.abs(fwdSpeed) > 6) {
      const yr = wv[0] * up[0] + wv[1] * up[1] + wv[2] * up[2];
      const ref = -fwdSpeed * Math.tan(d) / (L * (1 + 0.0015 * fwdSpeed * fwdSpeed));
      const err = yr - ref;
      if (Math.abs(err) > 0.12 + Math.abs(ref) * 0.25) {
        // positive yaw (about +y) = turning left
        const over = Math.abs(yr) > Math.abs(ref);
        const turningLeft = yr > 0;
        let wi;
        if (over) wi = turningLeft ? W[1] : W[0]; // outer front
        else wi = turningLeft ? W[2] : W[3]; // inner rear
        wi.brake += clamp(Math.abs(err) * 2500, 0, 2500) * (spec.mass / 1600);
        this.esc = 1;
        this.tcFactor = Math.min(this.tcFactor, over ? 0.5 : 0.8);
      }
    }

    /* ---------- drivetrain solve ---------- */
    const Gr = this.ratio();
    const inGear = Gr !== 0 && this.running !== null;
    const drivenW = W.filter((w) => w.driven);
    // wheel equation pieces
    for (const w of W) {
      w.a = w.I / dt + w.r * (w.contact ? w.k0 : 0);
      const rr = w.contact ? w.sp.rr * w.Fz * w.r * Math.sign(w.w) : 0;
      w.b = -w.r * (w.contact ? w.Fx0 : 0) - rr;
      // brake torque inside the implicit solve (friction: opposes spin, clamped at zero below)
      w.bStatic = Math.abs(w.w) < 0.3 && w.brake > 0;
      if (w.brake > 0 && !w.bStatic) w.b -= w.brake * Math.sign(w.w);
      // limited slip / viscous coupling between left & right driven wheels (implicit-ish)
    }
    if (spec.lsd > 0) {
      for (const [l, r2] of [[W[0], W[1]], [W[2], W[3]]]) {
        if (!l.driven) continue;
        const dw = l.w - r2.w;
        const Tl = clamp(dw * spec.lsd * 0.02, -spec.lsd, spec.lsd);
        l.b -= Tl; r2.b += Tl;
      }
    }
    let clutchCap = 0;
    let mode = 'free';
    const GB = spec.gearbox;
    if (this.ev) {
      mode = this.sel === 'N' || this.sel === 'P' ? 'free' : 'locked';
      clutchCap = 1e9;
    } else if (inGear) {
      if (this.autoMode) {
        const wt = Gr * this.drivenSpeed();
        const idleW = E.idle * Math.PI / 30;
        this.lockup = this.gear >= 3 && this.we > 0 && Math.abs(wt / Math.max(this.we, 1)) > 0.86 && throttle < 0.92 && Math.abs(fwdSpeed) > 9 && Math.abs(wt) > idleW * 1.45 && brake < 0.5;
        mode = this.shiftT > 0.05 ? 'tc' : this.lockup ? 'locked' : 'tc';
        clutchCap = this.peakT * 2.2;
      } else {
        // manual clutch engagement
        let eng;
        if (this.opts.autoClutch) {
          const idle = E.idle;
          const slowLaunch = smooth(idle + 120, idle + 1100, rpm);
          // gearbox input speed, signed: rolling backwards in a forward gear is negative
          const gbRpm = this.drivenSpeed() * Gr * 30 / Math.PI;
          const moving = gbRpm > idle + 200;
          eng = moving ? 1 : slowLaunch;
          if (brake > 0.3 && Math.abs(fwdSpeed) < 2 && throttle < 0.1) eng = 0;
          // below idle without throttle (slowing down, rolling back, wheels locked): declutch
          if (gbRpm < idle * 0.9 && throttle < 0.15) eng = 0;
          // anti-stall: never let the auto clutch drag the engine below idle
          if (rpm < idle * 0.8) eng = Math.min(eng, smooth(idle * 0.55, idle * 0.8, rpm) * 0.5);
          if (this.shiftT > 0) eng = 0;
          if (input.clutch > 0) eng = Math.min(eng, 1 - input.clutch);
        } else eng = 1 - clamp(input.clutch || 0, 0, 1);
        this.clutchEng = eng;
        clutchCap = eng * this.peakT * 1.9;
        mode = clutchCap > 1 ? 'clutch' : 'free';
      }
    }
    this.driveMode = mode;
    let Tc = 0; // torque delivered into the gearbox input
    if (mode === 'locked' || mode === 'clutch') {
      // try locked solution
      const c = Gr * Gr * this.Ie / dt;
      let num = 0, den = 1;
      for (const w of drivenW) { num += w.tw * (w.b + w.tw * Gr * Te) / w.a; den += c * w.tw * w.tw / w.a; }
      // speed mismatch must be absorbed in this step if we lock now
      const wg = Gr * this.drivenSpeed();
      const mismatch = this.ev ? 0 : this.we - wg;
      // locked: we_new = Gr * sum(tw * (w + d))  => include mismatch through engine inertia term
      const S2 = (num + (this.Ie / dt) * Gr * mismatch * this.sumTw2a(drivenW)) / den;
      const dwe = Gr * S2; // change in gearbox input speed
      const weNew = wg + dwe;
      const TcLocked = Te - this.Ie * (weNew - this.we) / dt;
      if (Math.abs(TcLocked) <= clutchCap) {
        Tc = TcLocked;
        for (const w of drivenW) {
          const dlt = (w.b + w.tw * Gr * Tc) / w.a;
          w.wNew = w.w + dlt;
        }
        this.we = this.ev ? Math.abs(Gr * this.drivenSpeedNew(drivenW)) : Gr * this.drivenSpeedNew(drivenW);
        this.clutchLocked = true;
      } else {
        Tc = Math.sign(TcLocked) * clutchCap;
        for (const w of drivenW) w.wNew = w.w + (w.b + w.tw * Gr * Tc) / w.a;
        this.we += (Te - Tc) / this.Ie * dt;
        this.clutchLocked = false;
      }
    } else if (mode === 'tc') {
      // torque converter: soft coupling with torque multiplication
      const wt = Gr * this.drivenSpeed();
      const we = Math.max(this.we, 1);
      const Ktc = (this.peakT / Math.pow((E.type === 'diesel' ? 1700 : 2300) * Math.PI / 30, 2));
      let Timp, TR = 1;
      if (we >= wt) { Timp = Ktc * we * (we - wt); TR = lerp(2.0, 1.0, clamp(wt / we / 0.85, 0, 1)); }
      else Timp = Math.max(-0.12 * this.peakT, Ktc * Math.abs(wt) * (we - wt) * 0.5); // weak coupling on overrun
      const Tt = Timp * TR;
      const damp = Ktc * we * TR;
      for (const w of drivenW) {
        const aa = w.a + w.tw * w.tw * Gr * Gr * damp * 1.0;
        w.wNew = w.w + (w.b + w.tw * Gr * Tt) / aa;
      }
      this.we += (Te - Timp) / this.Ie * dt;
      Tc = Tt;
      this.clutchLocked = false;
    } else {
      for (const w of drivenW) w.wNew = w.w + w.b / w.a;
      this.we += Te / this.Ie * dt;
      this.clutchLocked = false;
    }
    for (const w of W) if (!w.driven) w.wNew = w.w + w.b / w.a;
    // brakes: no reversal through zero; static wheels held up to the brake torque
    for (const w of W) {
      if (w.brake <= 0) continue;
      if (!w.bStatic) {
        if (w.w * w.wNew < 0) w.wNew = 0;
      } else {
        const aEff = w.I / dt + w.r * (w.contact ? w.k0 : 0);
        const need = (w.wNew) * aEff; // torque that would be needed to keep it still
        if (Math.abs(need) <= w.brake) w.wNew = 0; else w.wNew -= Math.sign(w.wNew) * w.brake / aEff;
      }
    }
    // engine speed after brakes when locked
    if (this.clutchLocked && !this.ev) this.we = Gr * this.drivenSpeedNew(drivenW);
    if (!this.ev) {
      this.we = Math.max(this.we, 0);
      if (this.stallGrace > 0) this.stallGrace -= dt;
      // a stall needs a load: the clutch must be (mostly) engaged with a gear selected
      const loaded = (mode === 'clutch' || mode === 'locked') && this.clutchEng > 0.25;
      if (this.running && this.we * 30 / Math.PI < 320 && !(this.starter > 0) && !this.autoMode && loaded && !(this.stallGrace > 0)) {
        this.running = false; this.stalled = true; this.events.push('stall');
      }
      if (!this.running && this.starter <= 0) this.we = Math.max(0, this.we - 60 * dt * (this.clutchLocked ? 0 : 1));
      if (this.we * 30 / Math.PI > E.limiter + 300) this.we = (E.limiter + 300) * Math.PI / 30;
    }
    for (const w of W) { w.w = w.wNew; w.angle = (w.angle + w.w * dt) % (Math.PI * 2); }

    /* ---------- final tyre forces ---------- */
    let skid = 0;
    this.absActive = W.some((w) => w.absOn) ? 1 : 0;
    for (const w of W) {
      if (!w.contact) { w.Fx = w.Fy = 0; w.skid = 0; continue; }
      tire(w, w.w, tf);
      w.Fx = tf.Fx; w.Fy = tf.Fy; w.kappa = tf.kappa; w.slipAngle = tf.alpha; w.rho = tf.rho;
      // low speed: kill lateral creep when nearly stopped
      const fx = w.fx * w.Fx + w.sx * w.Fy, fy = w.fy * w.Fx + w.sy * w.Fy, fz = w.fz * w.Fx + w.sz * w.Fy;
      const lift = 0.1;
      addForceAt(fx, fy, fz, w.cx + up[0] * lift, w.cy + up[1] * lift, w.cz + up[2] * lift);
      w.skid = clamp((w.rho - 0.85) * 1.2, 0, 1) * clamp(Math.hypot(w.vx, w.vy) / 4, 0, 1);
      skid = Math.max(skid, w.skid);
    }
    this.skid = skid;

    /* ---------- aerodynamics, water ---------- */
    const Cd = spec.aero.cd * spec.aero.A * (1 + this.damage.body * 0.15);
    const dragK = 0.5 * RHO * Cd * speed;
    F[0] -= dragK * v[0]; F[1] -= dragK * v[1]; F[2] -= dragK * v[2];
    if (env.wind) { const wx = env.wind[0] - v[0], wz = env.wind[1] - v[2]; const k2 = 0.5 * RHO * 1.0 * spec.body.L * spec.body.H * 0.4 * Math.hypot(wx, wz); F[0] += k2 * wx * 0.3; F[2] += k2 * wz * 0.3; }
    // water: buoyancy & drag when the body is submerged
    const wl = env.waterLevel ? env.waterLevel(p[0], p[2]) : -Infinity;
    if (wl > p[1] - this.cgH) {
      const sub = clamp((wl - (p[1] - this.cgH)) / (spec.body.H), 0, 1);
      this.inWater = sub;
      F[1] += this.m * G * 1.25 * sub;
      const k3 = 900 * sub * spec.body.L;
      F[0] -= k3 * v[0]; F[1] -= k3 * v[1] * 2; F[2] -= k3 * v[2];
      T[0] -= wv[0] * this.m * 2 * sub; T[1] -= wv[1] * this.m * 2 * sub; T[2] -= wv[2] * this.m * 2 * sub;
      if (sub > 0.45 && this.running && !this.ev) { this.running = false; this.flooded = true; this.events.push('flood'); }
    } else this.inWater = 0;

    /* ---------- body-ground contact (rollover, bottoming out) ---------- */
    const B = spec.body;
    const hw = B.W / 2 * 0.95, hl = B.L / 2 * 0.95;
    const yBot = -this.cgH + B.clearance * 0.9, yTop = B.H - this.cgH;
    const pts = [[-hw, yBot, -hl], [hw, yBot, -hl], [-hw, yBot, hl], [hw, yBot, hl], [-hw, yTop, -hl * 0.6], [hw, yTop, -hl * 0.6], [-hw, yTop, hl * 0.7], [hw, yTop, hl * 0.7], [0, yBot, 0], [0, yTop, 0]];
    for (const q of pts) {
      this.toWorld(q[0], q[1], q[2], A);
      const wx = A[0] + p[0], wy = A[1] + p[1], wz = A[2] + p[2];
      if (!env.ground(wx, wz, wy + 1.0, g)) continue;
      const pen = g.y - wy;
      if (pen <= 0) continue;
      const rx = wx - p[0], ry = wy - p[1], rz = wz - p[2];
      const vx = v[0] + wv[1] * rz - wv[2] * ry, vy = v[1] + wv[2] * rx - wv[0] * rz, vz = v[2] + wv[0] * ry - wv[1] * rx;
      const vn = vx * g.nx + vy * g.ny + vz * g.nz;
      let Fn = pen * this.m * 60 - vn * this.m * 4;
      Fn = Math.max(0, Fn);
      // sliding friction
      const vtx = vx - vn * g.nx, vty = vy - vn * g.ny, vtz = vz - vn * g.nz;
      const vt = Math.hypot(vtx, vty, vtz) || 1;
      const Ff = Math.min(Fn * 0.55, vt * this.m * 3);
      addForceAt(g.nx * Fn - vtx / vt * Ff, g.ny * Fn - vty / vt * Ff, g.nz * Fn - vtz / vt * Ff, wx, wy, wz);
      if (vn < -3) this.events.push('scrape');
      this.scraping = Math.max(this.scraping || 0, clamp(vt / 8, 0, 1));
    }

    /* ---------- integrate ---------- */
    const m = this.m;
    const ax = F[0] / m, ay = F[1] / m, az = F[2] / m;
    this.accel[0] = ax; this.accel[1] = ay + G; this.accel[2] = az;
    v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt;
    // angular: body-frame
    const Tb = this.toBody(T[0], T[1], T[2], [0, 0, 0]);
    const wb = this.toBody(wv[0], wv[1], wv[2], [0, 0, 0]);
    const I = this.Ib;
    const Lx = I[0] * wb[0], Ly = I[1] * wb[1], Lz = I[2] * wb[2];
    // gyroscopic term w x Iw
    const gx = wb[1] * Lz - wb[2] * Ly, gy = wb[2] * Lx - wb[0] * Lz, gz = wb[0] * Ly - wb[1] * Lx;
    wb[0] += (Tb[0] - gx) / I[0] * dt; wb[1] += (Tb[1] - gy) / I[1] * dt; wb[2] += (Tb[2] - gz) / I[2] * dt;
    // tiny angular damping for stability
    const ad = Math.exp(-0.05 * dt);
    wb[0] *= ad; wb[1] *= ad; wb[2] *= ad;
    this.toWorld(wb[0], wb[1], wb[2], wv);
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
    // quaternion integration
    const [qx, qy, qz, qw] = this.q;
    const hx = wv[0] * 0.5 * dt, hy = wv[1] * 0.5 * dt, hz = wv[2] * 0.5 * dt;
    let nx = qx + hx * qw + hy * qz - hz * qy;
    let ny = qy + hy * qw + hz * qx - hx * qz;
    let nz = qz + hz * qw + hx * qy - hy * qx;
    let nw = qw - hx * qx - hy * qy - hz * qz;
    const ql = Math.hypot(nx, ny, nz, nw);
    this.q[0] = nx / ql; this.q[1] = ny / ql; this.q[2] = nz / ql; this.q[3] = nw / ql;
    this.yawRate = wv[1];

    // standstill: settle when parked/braked so the car does not creep
    if (speed < 0.08 && Math.hypot(wv[0], wv[1], wv[2]) < 0.06 && contacts >= 3 && (brake > 0.2 || handbrake > 0.2 || (this.autoMode && this.sel === 'P') || (!this.running && this.gear !== 0)) && throttle < 0.05) {
      v[0] *= 0.6; v[2] *= 0.6; v[1] *= 0.9;
      wv[0] *= 0.6; wv[1] *= 0.6; wv[2] *= 0.6;
    }

    /* ---------- fuel, odometer ---------- */
    this.odo += Math.abs(fwdSpeed) * dt;
    if (this.running) {
      if (this.ev) {
        const Pw = Te * this.we; // W (negative = regen)
        const e = (Pw > 0 ? Pw / 0.9 : Pw * 0.7) * dt / 3.6e6; // kWh
        this.energy += e;
        this.fuel = clamp(this.fuel - e, 0, spec.fuel.tank);
        if (this.fuel <= 0) { this.running = false; this.events.push('empty'); }
      } else {
        const Pkw = Math.max(0, Te) * this.we / 1000;
        const lps = (Pkw * E.bsfc / 3600) / (E.type === 'diesel' ? 840 : 745) + (E.type === 'diesel' ? 0.00016 : 0.00022) * (spec.mass > 5000 ? 3 : 1);
        this.fuel -= lps * dt;
        this.fuelUsed += lps * dt;
        if (this.fuel <= 0) { this.fuel = 0; this.running = false; this.events.push('empty'); }
      }
    }
    this.rpm = this.we * 30 / Math.PI;
  }

  sumTw2a(list) { let s = 0; for (const w of list) s += w.tw * w.tw / w.a; return s; }
  drivenSpeed() { let s = 0; for (const w of this.wheels) if (w.driven) s += w.tw * w.w; return s; }
  drivenSpeedNew(list) { let s = 0; for (const w of list) s += w.tw * w.wNew; return s; }
  wheelsDrivenSpeed() { return this.drivenSpeed(); }

  toggleIgnition() {
    if (this.running) { this.running = false; this.events.push('stop'); return; }
    if (this.starter > 0) return;
    if (this.ev) { if (this.fuel > 0) { this.running = true; this.events.push('ready'); } return; }
    if (!this.autoMode && this.gear !== 0 && !this.opts.autoClutch && !(this.clutchPedal > 0.5)) { this.events.push('needclutch'); return; }
    this.starter = 0.75 + Math.random() * 0.4;
    this.events.push('crank');
  }
  startEngineNow() {
    this.running = true; this.stalled = false; this.starter = 0; this.stallGrace = 1.0;
    if (!this.ev) this.we = this.spec.engine.idle * Math.PI / 30;
  }
  shift(dir) {
    if (this.autoMode && !this.ev) {
      // tiptronic in D
      if (this.sel !== 'D') {
        const order = ['P', 'R', 'N', 'D'];
        const i = clamp(order.indexOf(this.sel) + dir, 0, 3);
        this.selectAuto(order[i]);
        return;
      }
      const ng = clamp(this.gear + dir, 1, this.nGears);
      if (ng !== this.gear) { this.gear = ng; this.shiftT = this.spec.gearbox.shiftTime; this.shiftCool = 1.2; this.events.push('shift'); }
      return;
    }
    if (this.ev) {
      const order = ['P', 'R', 'N', 'D'];
      const i = clamp(order.indexOf(this.sel) + dir, 0, 3);
      this.selectAuto(order[i]);
      return;
    }
    const ng = clamp(this.gear + dir, -1, this.nGears);
    if (ng === this.gear) return;
    // without the auto clutch a gear only goes in with the clutch pressed (neutral always)
    if (!this.opts.autoClutch && ng !== 0 && this.running && !(this.clutchPedal > 0.5)) { this.events.push('grind', 'needclutch'); return; }
    if (ng === -1 && this.fwdSpeed < -0.0 && false) return;
    if (ng === -1 && Math.abs(this.fwdSpeed) > 2) { this.events.push('grind'); return; }
    this.gear = ng;
    this.shiftT = this.spec.gearbox.shiftTime;
    this.events.push('shift');
  }
  selectAuto(sel) {
    if (!this.autoMode) return;
    if (sel === this.sel) return;
    if ((sel === 'R' && this.fwdSpeed > 1.5) || (sel === 'P' && Math.abs(this.fwdSpeed) > 1)) { this.events.push('grind'); return; }
    this.sel = sel;
    if (this.ev) { this.gear = sel === 'R' ? -1 : sel === 'D' ? 1 : 0; if (sel === 'R') this.gearEV = -1; this.events.push('select'); return; }
    this.gear = sel === 'R' ? -1 : sel === 'D' ? 1 : 0;
    this.shiftT = 0.25;
    this.events.push('select');
  }
  autoShift(throttle, brake = 0) {
    if (this.shiftT > 0 || this.shiftCool > 0 || this.gear < 1) return;
    if (brake > 0.4) {
      // under hard braking only drop gears to avoid lugging the engine
      const E2 = this.spec.engine;
      const r2 = Math.abs(this.drivenSpeed()) * Math.abs(this.ratio(this.gear)) * 30 / Math.PI;
      if (this.gear > 1 && r2 < E2.idle + 60) { this.gear--; this.shiftT = this.spec.gearbox.shiftTime; this.shiftCool = 0.5; }
      return;
    }
    const E = this.spec.engine;
    const wheelW = Math.abs(this.drivenSpeed());
    const rpmAt = (g) => wheelW * Math.abs(this.ratio(g)) * 30 / Math.PI;
    const r = rpmAt(this.gear);
    const diesel = E.type === 'diesel';
    const top = E.redline * (diesel ? 0.9 : 0.93);
    const up = lerp(E.idle + (diesel ? 700 : 1000), top, Math.pow(throttle, 1.5));
    const down = lerp(E.idle + 180, E.redline * (diesel ? 0.5 : 0.55), throttle * throttle);
    if (this.gear < this.nGears && r > up && rpmAt(this.gear + 1) > E.idle + 120) {
      this.gear++; this.shiftT = this.spec.gearbox.shiftTime; this.shiftCool = 0.8; this.events.push('shift');
    } else if (this.gear > 1 && (r < down || (throttle > 0.95 && rpmAt(this.gear - 1) < E.redline * 0.82 && r < E.redline * 0.6))) {
      if (rpmAt(this.gear - 1) < E.redline * 0.9) { this.gear--; this.shiftT = this.spec.gearbox.shiftTime; this.shiftCool = 0.8; this.events.push('shift'); }
    }
  }

  // Position of a point given in body coordinates
  pointWorld(x, y, z, out = [0, 0, 0]) {
    this.toWorld(x, y, z, out);
    out[0] += this.p[0]; out[1] += this.p[1]; out[2] += this.p[2];
    return out;
  }
  gearLabel() {
    if (this.autoMode) {
      if (this.sel === 'D') return this.ev ? 'D' : 'D' + this.gear;
      return this.sel;
    }
    return this.gear === -1 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
  }

  /* Apply an impulse at a world point (collisions). */
  applyImpulse(jx, jy, jz, px, py, pz) {
    const m = this.m;
    this.v[0] += jx / m; this.v[1] += jy / m; this.v[2] += jz / m;
    const rx = px - this.p[0], ry = py - this.p[1], rz = pz - this.p[2];
    const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    const tb = this.toBody(tx, ty, tz, [0, 0, 0]);
    const wb = this.toBody(this.w[0], this.w[1], this.w[2], [0, 0, 0]);
    wb[0] += tb[0] / this.Ib[0]; wb[1] += tb[1] / this.Ib[1]; wb[2] += tb[2] / this.Ib[2];
    this.toWorld(wb[0], wb[1], wb[2], this.w);
  }
  // effective inverse mass along normal n at point
  invMassAt(nx, ny, nz, px, py, pz) {
    const rx = px - this.p[0], ry = py - this.p[1], rz = pz - this.p[2];
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    const cb = this.toBody(cx, cy, cz, [0, 0, 0]);
    const ib = [cb[0] / this.Ib[0], cb[1] / this.Ib[1], cb[2] / this.Ib[2]];
    const iw = this.toWorld(ib[0], ib[1], ib[2], [0, 0, 0]);
    const kx = iw[1] * rz - iw[2] * ry, ky = iw[2] * rx - iw[0] * rz, kz = iw[0] * ry - iw[1] * rx;
    return 1 / this.m + (kx * nx + ky * ny + kz * nz);
  }
  velocityAt(px, py, pz) {
    const rx = px - this.p[0], ry = py - this.p[1], rz = pz - this.p[2];
    const w = this.w, v = this.v;
    return [v[0] + w[1] * rz - w[2] * ry, v[1] + w[2] * rx - w[0] * rz, v[2] + w[0] * ry - w[1] * rx];
  }
}
