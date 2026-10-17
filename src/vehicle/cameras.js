/* =====================================================================
   Camera rig: cockpit, hood, chase, cinematic (trackside) and orbit.
   ===================================================================== */
import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/math.js';

export const CAM_MODES = ['cockpit', 'hood', 'chase', 'cinematic'];

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'cockpit';
    this.look = { yaw: 0, pitch: 0 }; // free look offsets
    this.lookBack = false;
    this.chasePos = new THREE.Vector3();
    this.chaseInit = false;
    this.cine = null;
    this.headQ = new THREE.Quaternion();
    this.headInit = false;
    this.headOffset = new THREE.Vector3();
    this.shake = 0;
    this.fovBase = 62;
    this.orbit = { yaw: 0.6, pitch: 0.18, dist: 7 };
    this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3();
    this.q = new THREE.Quaternion();
  }
  setMode(m) { this.mode = m; this.chaseInit = false; this.cine = null; this.look.yaw = 0; this.look.pitch = 0; }
  cycle() { const i = CAM_MODES.indexOf(this.mode); this.setMode(CAM_MODES[(i + 1) % CAM_MODES.length]); }

  update(dt, car, game) {
    const cam = this.camera;
    const P = car.phys;
    const spec = car.spec;
    const carQ = this.q.set(P.q[0], P.q[1], P.q[2], P.q[3]);
    const pos = this.tmp.set(P.p[0], P.p[1], P.p[2]);
    let fov = this.fovBase;
    // free-look returns to centre when not held
    if (!this.lookHeld) { this.look.yaw = damp(this.look.yaw, this.lookBack ? Math.PI : 0, this.lookBack ? 14 : 4, dt); this.look.pitch = damp(this.look.pitch, 0, 4, dt); }
    if (this.mode === 'cockpit' || this.mode === 'hood') {
      const B = spec.body;
      const big = B.shape === 'bus' || B.shape === 'truck' || B.shape === 'van';
      // eye position in body frame (left-hand drive)
      const eye = this.mode === 'cockpit'
        ? car.cockpit ? car.cockpit.eye : new THREE.Vector3(-B.W * 0.2, B.H * 0.78 - spec.cgH, -0.15)
        : new THREE.Vector3(0, B.H * (big ? 0.95 : 0.74) - spec.cgH + 0.05, -B.L * (big ? 0.46 : 0.18));
      // head stabilisation: the head lags the body's pitch/roll a little
      if (!this.headInit) { this.headQ.copy(carQ); this.headInit = true; }
      this.headQ.slerp(carQ, 1 - Math.exp(-dt * 16));
      const q = this.tmp2;
      const camQ = new THREE.Quaternion().copy(this.headQ);
      // g-force head movement
      const acc = P.accel;
      const lx = P.toBody(acc[0], acc[1], acc[2], [0, 0, 0]);
      this.headOffset.x = damp(this.headOffset.x, clamp(-lx[0] * 0.006, -0.05, 0.05), 6, dt);
      this.headOffset.z = damp(this.headOffset.z, clamp(-lx[2] * 0.005, -0.04, 0.04), 6, dt);
      const e = eye.clone().add(this.headOffset).applyQuaternion(carQ).add(pos);
      cam.position.copy(e);
      const lookQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch, this.look.yaw, 0, 'YXZ'));
      cam.quaternion.copy(camQ).multiply(lookQ);
      // road vibration
      const vib = Math.min(1, P.speed / 30) * 0.0009 + (car.groundInfo.surface === 'gravel' ? 0.0015 : 0);
      cam.position.y += (Math.random() - 0.5) * vib * 2;
      fov = this.mode === 'cockpit' ? this.fovBase : this.fovBase + 4;
      fov += Math.min(6, P.speed * 0.08);
    } else if (this.mode === 'chase') {
      const B = spec.body;
      const dist = Math.max(5.5, B.L * 1.25) + Math.min(2.5, P.speed * 0.04);
      const height = Math.max(1.8, B.H * 1.15);
      const f = P.forward;
      let fx = f[0], fz = f[2];
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      // look direction lags the car's yaw (follow velocity a bit)
      const v = P.v;
      const vs = Math.hypot(v[0], v[2]);
      let dx = fx, dz = fz;
      if (vs > 3 && P.fwdSpeed > 0) { dx = lerp(fx, v[0] / vs, 0.35); dz = lerp(fz, v[2] / vs, 0.35); }
      if (P.fwdSpeed < -1) { dx = -fx * 0.0 + fx; dz = fz; }
      const ang = Math.atan2(dx, dz) + this.look.yaw;
      const tx = pos.x - Math.sin(ang) * dist, tz = pos.z - Math.cos(ang) * dist;
      const target = new THREE.Vector3(tx, pos.y + height, tz);
      if (!this.chaseInit) { this.chasePos.copy(target); this.chaseInit = true; }
      this.chasePos.x = damp(this.chasePos.x, target.x, 7, dt);
      this.chasePos.z = damp(this.chasePos.z, target.z, 7, dt);
      this.chasePos.y = damp(this.chasePos.y, target.y, 4, dt);
      // keep above ground
      const gh = game.terrain.groundAt(this.chasePos.x, this.chasePos.z) + 0.6;
      if (this.chasePos.y < gh) this.chasePos.y = gh;
      cam.position.copy(this.chasePos);
      cam.lookAt(pos.x, pos.y + B.H * 0.45 + this.look.pitch * 4, pos.z);
      fov = this.fovBase + 2 + Math.min(10, P.speed * 0.12);
    } else if (this.mode === 'cinematic') {
      // trackside camera: pick a spot ahead next to the road, hold until the car has passed
      const f = P.forward;
      const need = !this.cine || Math.hypot(this.cine.x - pos.x, this.cine.z - pos.z) > 140 || this.cine.t > 14;
      if (need) {
        const ahead = 40 + P.speed * 2.2;
        const side = Math.random() < 0.5 ? -1 : 1;
        const rx = -f[2] * side, rz = f[0] * side;
        const cx = pos.x + f[0] * ahead + rx * (9 + Math.random() * 8), cz = pos.z + f[2] * ahead + rz * (9 + Math.random() * 8);
        const cy = game.terrain.groundAt(cx, cz) + 1.2 + Math.random() * 6;
        this.cine = { x: cx, y: cy, z: cz, t: 0, zoom: 0.6 + Math.random() * 0.8 };
      }
      this.cine.t += dt;
      cam.position.set(this.cine.x, this.cine.y, this.cine.z);
      cam.lookAt(pos.x, pos.y + 0.4, pos.z);
      const d = Math.hypot(this.cine.x - pos.x, this.cine.z - pos.z);
      fov = clamp(2 * Math.atan(spec.body.L * 1.8 / Math.max(5, d)) * 180 / Math.PI * this.cine.zoom * 2.2, 14, 60);
    }
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = damp(cam.fov, fov, 3, dt); cam.updateProjectionMatrix(); }
  }

  // garage / menu orbit around a point
  orbitAround(dt, center, auto = true) {
    if (auto) this.orbit.yaw += dt * 0.12;
    const o = this.orbit;
    const cam = this.camera;
    cam.position.set(center.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, center.y + Math.sin(o.pitch) * o.dist + 0.6, center.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist);
    cam.lookAt(center.x, center.y + 0.5, center.z);
    if (cam.fov !== 45) { cam.fov = 45; cam.updateProjectionMatrix(); }
  }
}
