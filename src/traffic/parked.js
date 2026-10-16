/* =====================================================================
   Parked cars: in parking lots, at rest areas, dealership showrooms and
   along streets with parking lanes. Deterministic per spot, instanced,
   and solid (colliders) so the player can bump into them.
   ===================================================================== */
import { Fleet } from './fleet.js';
import { VEHICLE } from '../vehicle/specs.js';
import { hashStr } from '../core/math.js';
import { CHUNK } from '../world/terrain.js';

const STREET_MODELS = ['v7', '245', 'kompis', 'xc', 'lyra', '900', 'van', 'kompis', 'v7', 'xc'];
const SHOW_MODELS = ['v7', 'lyra', 'xc', 'kronstad', 'kompis'];
const COLORS = [0xe8e8e8, 0x1a1a1a, 0x8a9aa8, 0x2c3e50, 0x6d1f23, 0xd9d9d9, 0x3a4a5a, 0x4a5a3a, 0xb3121b, 0x1d4f91, 0xc0c4c8, 0x5a4636, 0xf2f2f2, 0x26303a];
const NEAR = 380;

export class ParkedCars {
  constructor(game) {
    this.game = game;
    this.fleet = new Fleet(game.scene, 110);
    this.byChunk = new Map(); // chunk key -> [car]
    this.dirty = true;
    this.t = 0;
    // streets with parking lanes, bucketed per terrain chunk
    this.kerb = new Map();
    for (const r of game.net.roads) {
      if (!(r.xs.parkR > 0 || r.xs.parkL > 0)) continue;
      for (let i = 0; i < r.n; i += 2) {
        const k = Math.floor(r.X[i] / CHUNK) + ':' + Math.floor(r.Z[i] / CHUNK);
        let L = this.kerb.get(k); if (!L) this.kerb.set(k, L = new Set()); L.add(r);
      }
    }
    game.parked = this;
  }
  key(ch) { return ch.cx + ':' + ch.cz; }
  make(x, y, z, yaw, seed, opts = {}) {
    const h = (k) => (hashStr(k + ':' + seed) % 10000) / 10000;
    const id = opts.truck ? 'truck' : opts.showroom ? SHOW_MODELS[Math.floor(h('m') * SHOW_MODELS.length)] : STREET_MODELS[Math.floor(h('m') * STREET_MODELS.length)];
    const spec = VEHICLE[id];
    if (!spec) return null;
    const color = opts.showroom ? spec.colors[Math.floor(h('c') * spec.colors.length)] : h('k') < 0.4 ? spec.colors[Math.floor(h('c') * spec.colors.length)] : COLORS[Math.floor(h('c') * COLORS.length)];
    return {
      spec, kind: 'parked', color, x, y: y + spec.cgH - 0.02, z, yaw, pitch: 0, roll: 0, wheelAngle: 0, steer: 0,
      lights: { head: 0, brake: false, indL: false, indR: false, rev: false }, set: null, slot: -1,
    };
  }
  addSpots(ch, spots) {
    const k = this.key(ch);
    if (this.byChunk.has(k)) this.removeSpots(ch);
    const x0 = ch.cx * CHUNK, z0 = ch.cz * CHUNK;
    const list = [];
    for (const s of spots) {
      // spots are in world space; their rot is the heading angle from +x
      const c = this.make(s.x, s.y, s.z, Math.atan2(-Math.cos(s.rot), -Math.sin(s.rot)), s.seed, s);
      if (c) list.push(c);
    }
    // kerbside parking on streets with a parking lane
    const net = this.game.net;
    for (const r of this.kerb.get(k) || []) {
      for (const side of [1, -1]) {
        const pw = side > 0 ? r.xs.parkR : r.xs.parkL;
        if (!(pw > 0)) continue;
        const d = side > 0 ? r.xs.travelR + pw / 2 : r.xs.travelL - pw / 2;
        for (let s = r.trimA + 14; s < r.len - r.trimB - 14; s += 6.2) {
          const p = net.pointAt(r, s, d);
          if (p[0] < x0 || p[0] >= x0 + CHUNK || p[2] < z0 || p[2] >= z0 + CHUNK) continue;
          const hs = hashStr('kerb' + r.id + ':' + side + ':' + Math.round(s));
          if (hs % 100 > 55) continue; // free spot
          const i = Math.min(r.n - 2, Math.max(0, Math.floor(s / 4)));
          const yaw = Math.atan2(-side * r.TX[i], -side * r.TZ[i]); // facing the direction of travel on that side
          const c = this.make(p[0], p[1], p[2], yaw, hs);
          if (c) list.push(c);
        }
      }
    }
    // colliders
    const col = list.map((c) => ({ type: 'obb', x: c.x, z: c.z, hw: c.spec.body.W / 2, hd: c.spec.body.L / 2, rot: -c.yaw, y0: c.y - c.spec.cgH, y1: c.y - c.spec.cgH + c.spec.body.H, parked: c }));
    if (col.length) this.game.collision.add('parked:' + k, col);
    this.byChunk.set(k, list);
    this.dirty = true;
  }
  removeSpots(ch) {
    const k = this.key(ch);
    const list = this.byChunk.get(k);
    if (!list) return;
    for (const c of list) this.fleet.remove(c);
    this.game.collision.remove('parked:' + k);
    this.byChunk.delete(k);
    this.dirty = true;
  }
  update(dt, game) {
    this.t -= dt;
    if (this.t > 0 && !this.dirty) return;
    this.t = 1.0;
    // only cars near the camera get instances
    const cam = game.camera.position;
    let changed = this.dirty;
    for (const list of this.byChunk.values()) for (const c of list) {
      const near = Math.abs(c.x - cam.x) < NEAR && Math.abs(c.z - cam.z) < NEAR;
      if (near && !c.set) { if (this.fleet.add(c)) changed = true; }
      else if (!near && c.set) { this.fleet.remove(c); changed = true; }
    }
    if (changed) { this.fleet.commit(); this.dirty = false; }
  }
  clear() { for (const list of this.byChunk.values()) for (const c of list) this.fleet.remove(c); this.dirty = true; }
}
