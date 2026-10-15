/* =====================================================================
   The player's vehicle: physics + mesh + world queries + collisions +
   lights, indicators, wipers, horn, cruise control, fuel and damage.
   ===================================================================== */
import * as THREE from 'three';
import { CarPhysics } from './physics.js';
import { CarMesh } from './carmesh.js';
import { VEHICLE } from './specs.js';
import { collideBox } from './collide.js';
import { clamp, lerp, noiseA, noiseB, smoothstep } from '../core/math.js';
import { terrainWater, smallLakesNear } from '../world/geo.js';

const DT = 1 / 240;
const _wo = { level: -Infinity, kind: 0 };

export class PlayerCar {
  constructor(game, cfg) {
    this.game = game;
    this.cfg = cfg; // {model, color, plate, wheels, tires, tune, susp, trans, assists}
    const spec = VEHICLE[cfg.model];
    this.spec = spec;
    this.phys = new CarPhysics(spec, {
      tires: cfg.tires || 'summer', tune: cfg.tune || 'stock', susp: cfg.susp || 'comfort',
      trans: spec.gearbox.type === 'ev' ? 'auto' : cfg.trans || (spec.gearbox.type === 'manual' ? 'manual' : 'auto'),
      autoClutch: cfg.autoClutch !== false, abs: cfg.abs !== false, tcs: cfg.tcs !== false, esc: cfg.esc !== false,
    });
    if (spec.brakes.abs === false && cfg.absRetrofit !== true) this.phys.opts.abs = false;
    this.mesh = new CarMesh(spec, { color: cfg.color ?? spec.colors[0], plate: cfg.plate, wheels: cfg.wheels, seed: 7 });
    game.scene.add(this.mesh.group);
    this.acc = 0;
    this.lightMode = 'auto'; // off | auto | low | high
    this.headOn = false; this.highOn = false;
    this.indicator = 0; // -1 left, 1 right, 2 hazard
    this.blink = 0; this.blinkOn = false;
    this.indSteerPeak = 0;
    this.wiper = 0; // 0 off, 1 interval, 2 normal, 3 fast
    this.wiperPhase = 0; this.wiperT = 0;
    this.horn = false;
    this.cruise = null; // target speed m/s
    this.collisions = [];
    this.impacts = [];
    this.lastImpact = 0;
    this.groundInfo = { surface: 'asphalt', road: null };
    this.cand = [];
    this.box = { x: 0, z: 0, ax: 1, az: 0, bx: 0, bz: -1, hw: spec.body.W / 2, hl: spec.body.L / 2, y0: 0, y1: 0 };
    this.env = {
      ground: (x, z, yTop, out) => this.ground(x, z, yTop, out),
      waterLevel: (x, z) => this.waterLevelAt(x, z),
      wind: null,
    };
    this.tmpG = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'asphalt', wet: 0, snow: 0, ice: 0 };
    // headlight spot lights (left & right) for night driving
    this.beams = [];
    const zf = -spec.body.wb * (1 - spec.weightF) - 0.9;
    for (const sx of [-0.55, 0.55]) {
      const L = new THREE.SpotLight(0xfff2dd, 0, 0, 0.5, 0.55, 1.6);
      L.position.set(sx * spec.body.W * 0.7, 0.55 - spec.cgH, zf);
      L.target.position.set(sx * 2, -spec.cgH - 0.8, zf - 30);
      this.mesh.body.add(L, L.target);
      this.beams.push(L);
    }
  }

  place(x, z, yaw, onRoadY = null) {
    const y = onRoadY ?? this.surfaceHeight(x, z);
    this.phys.reset(x, y, z, yaw);
    // settle on the springs
    for (let i = 0; i < 120; i++) this.phys.step(DT, { throttle: 0, brake: 1, handbrake: 1 }, this.env);
    this.phys.v = [0, 0, 0]; this.phys.w = [0, 0, 0];
    this.sync();
  }
  surfaceHeight(x, z) {
    const o = this.tmpG;
    return this.ground(x, z, 1e5, o) ? o.y : this.game.terrain.height(x, z);
  }

  /* -------------------------- world queries -------------------------- */
  ground(x, z, yTop, out) {
    const g = this.game;
    const C = g.conditions;
    let best = -Infinity;
    if (g.net.surfaceAt(x, z, yTop, out)) {
      best = out.y;
      const r = out.road;
      // winter road condition: main roads ploughed and salted, small roads packed snow
      const cls = r ? r.type : 'street';
      const mainRoad = cls === 'motorway' || cls === 'expressway' || cls === 'primary' || cls === 'ramp' || cls === 'avenue';
      out.wet = C.wet;
      if (out.zone === 'sidewalk') out.surface = 'sidewalk';
      else if (out.zone === 'verge') out.surface = 'verge';
      else if (out.zone === 'median') out.surface = 'grass';
      out.snow = C.snow * (mainRoad ? 0.25 : cls === 'gravel' ? 0.95 : 0.7);
      // tracks are clearer than the lane centre
      if (C.snow > 0 && r && out.zone === 'road') {
        const f = ((out.d - r.xs.travelL) / r.xs.w) % 1;
        const track = Math.min(Math.abs(f - 0.27), Math.abs(f - 0.73)) < 0.12;
        if (track) out.snow *= 0.45;
      }
      out.ice = 0;
      if (C.ice > 0) {
        const n = noiseA(x / 45, z / 45) * 0.6 + noiseB(x / 13, z / 13) * 0.4;
        let ip = C.ice * (out.bridge ? 1.6 : 1) * (out.node ? 1.4 : 1);
        out.ice = clamp((n - (1 - ip * 0.9)) * 4, 0, 1);
      }
    }
    const th = g.terrain.groundAt(x, z);
    if (th <= yTop + 0.6 && th > best + 0.02) {
      best = th;
      out.y = th;
      g.terrain.normalAt(x, z, out.nN || (out.nN = {}));
      out.nx = out.nN.x; out.ny = out.nN.y; out.nz = out.nN.z;
      out.road = null; out.node = null; out.bridge = 0;
      const steep = out.ny < 0.8;
      const lvl = terrainWater(x, z, _wo);
      const nearWater = _wo.level > -1e8;
      out.surface = nearWater && th < _wo.level - 0.15 ? 'water' : steep ? 'rock' : th < 1.6 && th > -0.5 ? 'sand' : (noiseA(x / 30, z / 30) > 0.35 ? 'dirt' : 'grass');
      out.wet = C.wet; out.snow = C.snowGround; out.ice = 0;
      if (C.snowGround > 0.6) out.surface = out.surface === 'water' ? 'water' : 'snow';
    }
    // frozen lakes and sea ice can be driven on in deep winter
    if (C.frozen) {
      const lv = this.waterSurface(x, z);
      if (lv > -1e8 && lv > best && lv <= yTop + 0.6) {
        best = lv; out.y = lv; out.nx = 0; out.ny = 1; out.nz = 0; out.surface = C.frozen > 1 ? 'snow' : 'ice'; out.wet = 0; out.snow = C.frozen > 1 ? 0.8 : 0; out.ice = 1; out.road = null;
      }
    }
    return best > -Infinity;
  }
  waterSurface(x, z) {
    const h = terrainWater(x, z, _wo);
    return _wo.level > h + 0.05 ? _wo.level : -Infinity;
  }
  waterLevelAt(x, z) {
    if (this.game.conditions.frozen) return -Infinity;
    return this.waterSurface(x, z);
  }

  /* ------------------------------ update ------------------------------ */
  update(dt, input) {
    const P = this.phys;
    const game = this.game;
    // cruise control (adaptive: keeps distance with the leader if traffic tells us)
    let inp = input;
    if (this.cruise != null) {
      if (input.brake > 0.05 || !P.running) this.cruise = null;
      else {
        let target = this.cruise;
        if (game.traffic && game.traffic.leaderGap) {
          const g = game.traffic.leaderGap(this);
          if (g && g.dist < Math.max(12, P.fwdSpeed * 2.2)) target = Math.min(target, g.speed - (Math.max(12, P.fwdSpeed * 2.2) - g.dist) * 0.25);
        }
        const err = target - P.fwdSpeed;
        this.cruiseI = clamp((this.cruiseI || 0) + err * dt * 0.08, -0.3, 0.4);
        const thr = clamp(err * 0.25 + this.cruiseI + 0.12, 0, 1);
        inp = { ...input, throttle: Math.max(input.throttle, thr), brake: err < -3 ? clamp(-err * 0.08, 0, 0.4) : input.brake };
      }
    }
    // gather collision candidates once per frame
    const sp = P.speed;
    game.collision.query(P.p[0], P.p[2], this.spec.body.L / 2 + 2 + sp * dt * 2, this.cand);
    const ai = game.traffic ? game.traffic.boxesNear(P.p[0], P.p[2], 25) : [];
    this.acc += dt;
    let steps = 0;
    const evts = [];
    while (this.acc >= DT && steps < 40) {
      P.step(DT, steps === 0 ? inp : { ...inp, ignition: false, shiftUp: false, shiftDown: false, select: null }, this.env);
      for (const e of P.events) evts.push(e);
      if (steps % 2 === 0) this.collide(ai);
      this.acc -= DT; steps++;
    }
    if (steps >= 40) this.acc = 0;
    this.events = evts;
    this.updateLights(dt, inp);
    this.sync();
    // info about where we are
    const ri = game.net.roadInfoAt(P.p[0], P.p[2]);
    this.roadInfo = ri;
  }

  collide(ai) {
    const P = this.phys;
    const R = P.R;
    let ax = R[0], az = R[6];
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    const b = this.box;
    b.x = P.p[0]; b.z = P.p[2];
    b.ax = ax; b.az = az; b.bx = -az; b.bz = ax; // forward = right rotated
    // forward axis should point to the car's front (-z local)
    const fx = -R[2], fz = -R[8];
    if (b.bx * fx + b.bz * fz < 0) { b.bx = -b.bx; b.bz = -b.bz; }
    b.y0 = P.p[1] - P.cgH + 0.15; b.y1 = P.p[1] - P.cgH + this.spec.body.H;
    const contacts = this.contacts || (this.contacts = []);
    contacts.length = 0;
    for (const c of this.cand) collideBox(b, c, contacts);
    for (const o of ai) {
      const n0 = contacts.length;
      collideBox(b, o, contacts);
      for (let k = n0; k < contacts.length; k++) contacts[k].ai = o.ref;
    }
    for (const ct of contacts) this.resolve(ct);
  }

  resolve(ct) {
    const P = this.phys;
    const py = P.p[1] - P.cgH * 0.3;
    const nx = ct.nx, nz = ct.nz;
    // positional correction
    const corr = Math.min(ct.pen, 0.5) * 0.8;
    P.p[0] += nx * corr; P.p[2] += nz * corr;
    const vel = P.velocityAt(ct.px, py, ct.pz);
    let vrx = vel[0], vrz = vel[2];
    let aiV = null;
    if (ct.ai) { aiV = ct.ai.velocity(); vrx -= aiV[0]; vrz -= aiV[1]; }
    const vn = vrx * nx + vrz * nz;
    if (vn >= 0) return;
    const e = ct.c && ct.c.soft ? 0.05 : 0.18;
    const kInv = P.invMassAt(nx, 0, nz, ct.px, py, ct.pz) + (ct.ai ? 1 / ct.ai.mass : 0);
    let j = -(1 + e) * vn / kInv;
    // friction
    const tx = -nz, tz = nx;
    const vt = vrx * tx + vrz * tz;
    const jt = clamp(-vt / kInv, -0.4 * j, 0.4 * j);
    P.applyImpulse(nx * j + tx * jt, 0, nz * j + tz * jt, ct.px, py, ct.pz);
    if (ct.ai) ct.ai.hit(-(nx * j + tx * jt), -(nz * j + tz * jt), this);
    // damage & events
    const impactSpeed = -vn;
    if (impactSpeed > 1.2) {
      const now = this.game.time;
      if (now - this.lastImpact > 0.25 || impactSpeed > 5) {
        this.lastImpact = now;
        const dmg = Math.max(0, impactSpeed - 2.5) * 0.035 * (this.spec.mass < 3000 ? 1 : 0.4);
        const lb = P.toBody(ct.px - P.p[0], 0, ct.pz - P.p[2], [0, 0, 0]);
        const D = P.damage;
        D.body = clamp(D.body + dmg, 0, 1);
        if (lb[2] < -this.spec.body.L * 0.25) { D.front = clamp(D.front + dmg * 1.4, 0, 1); D.engine = clamp(D.engine + dmg * 0.9, 0, 1); }
        else if (lb[2] > this.spec.body.L * 0.25) D.rear = clamp(D.rear + dmg * 1.4, 0, 1);
        if (lb[0] < 0) D.left = clamp(D.left + dmg, 0, 1); else D.right = clamp(D.right + dmg, 0, 1);
        if (impactSpeed > 9) D.glass = clamp(D.glass + dmg * 1.2, 0, 1);
        if (D.engine >= 1 && P.running) { P.running = false; P.events.push('dead'); }
        this.impacts.push({ speed: impactSpeed, x: ct.px, z: ct.pz, kind: ct.ai ? 'car' : ct.c ? (ct.c.tree ? 'tree' : ct.c.bld ? 'building' : 'object') : 'object', lx: lb[0], lz: lb[2] });
      }
    }
  }

  updateLights(dt, inp) {
    const P = this.phys;
    const g = this.game;
    // headlights: Swedish law requires dipped beams or DRL at all times
    const dark = g.env ? g.env.night > 0.2 || g.env.daylight < 0.45 || (g.env.weather.fog > 0.3) || g.env.weather.rain > 0.5 : false;
    if (this.lightMode === 'auto') { this.headOn = dark && (P.running || P.starter > 0); }
    else if (this.lightMode === 'off') this.headOn = false;
    else this.headOn = true;
    this.highOn = this.lightMode === 'high';
    // indicators blink at ~1.5 Hz, self-cancel after a turn
    this.blink += dt;
    if (this.blink > 0.36) { this.blink = 0; this.blinkOn = !this.blinkOn; if (this.indicator !== 0) this.tick = this.blinkOn ? 'on' : 'off'; }
    if (this.indicator === -1 || this.indicator === 1) {
      const s = P.steerAngle * this.indicator;
      this.indSteerPeak = Math.max(this.indSteerPeak, s);
      if (this.indSteerPeak > 0.25 && s < 0.05) { this.indicator = 0; this.indSteerPeak = 0; }
    }
    // wipers
    const wSpeed = [0, 0.55, 0.9, 1.6][this.wiper];
    if (this.wiper > 0) {
      this.wiperT += dt;
      const interval = this.wiper === 1 ? 3.5 : 0;
      if (this.wiperPhase > 0 || this.wiperT > interval) {
        this.wiperPhase += dt * wSpeed;
        if (this.wiperPhase >= 1) { this.wiperPhase = 0; this.wiperT = 0; }
      }
    } else if (this.wiperPhase > 0) { this.wiperPhase = Math.min(1, this.wiperPhase + dt); if (this.wiperPhase >= 1) this.wiperPhase = 0; }
    const braking = P.pedalBrake > 0.05 || (P.ev && P.pedalThrottle < 0.02 && P.speed > 3);
    const dim = g.env ? clamp(1.2 - g.env.daylight, 0, 1) : 0;
    for (const L of this.beams) {
      L.intensity = this.headOn ? (this.highOn ? 900 : 420) * dim : 0;
      L.angle = this.highOn ? 0.42 : 0.55;
      L.target.position.y = this.highOn ? -this.spec.cgH - 0.2 : -this.spec.cgH - 1.4;
      L.visible = L.intensity > 0.5;
    }
    this.mesh.setLights({
      head: this.headOn && P.running !== null, high: this.highOn, drl: P.running || this.headOn, brake: braking,
      indL: (this.indicator === -1 || this.indicator === 2) && this.blinkOn, indR: (this.indicator === 1 || this.indicator === 2) && this.blinkOn,
      rev: P.gear === -1, night: g.env ? g.env.night : 0,
    });
  }

  sync() {
    const P = this.phys;
    const g = this.mesh.group;
    g.position.set(P.p[0], P.p[1], P.p[2]);
    g.quaternion.set(P.q[0], P.q[1], P.q[2], P.q[3]);
    this.mesh.updateWheels(P.wheels, P.cgH);
    g.updateMatrixWorld(true);
  }

  // forward/right vectors in world
  get forward() { return this.phys.forward; }
  get position() { return this.phys.p; }
  get speed() { return this.phys.speed; }
  dispose() { this.game.scene.remove(this.mesh.group); }
}
