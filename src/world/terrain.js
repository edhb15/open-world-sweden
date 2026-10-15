/* =====================================================================
   Final ground height = natural terrain + water carving + road corridors.
   Physics uses exact chunk heightfields when available so wheels sit on
   the rendered mesh.
   ===================================================================== */
import { terrainWater } from './geo.js';

export const CHUNK = 256;
const wo = { level: -Infinity, kind: 0 };
const info = { w: 0 };

export class Terrain {
  constructor(net) {
    this.net = net;
    this.fields = new Map(); // chunk key -> {H: Float32Array, N, step, x0, z0}
  }
  // analytic height (slow path)
  height(x, z) {
    const h = terrainWater(x, z, wo);
    return this.net.corridor(x, z, h);
  }
  // full sample for mesh building: returns h and writes water level / road weight
  sample(x, z, out) {
    const h0 = terrainWater(x, z, wo);
    const h = this.net.corridor(x, z, h0, info);
    out.level = wo.level; out.kind = wo.kind; out.road = info.w;
    return h;
  }
  setField(cx, cz, field) { this.fields.set(cx * 100003 + cz, field); }
  dropField(cx, cz) { this.fields.delete(cx * 100003 + cz); }
  // exact height of the rendered high-res mesh where available
  groundAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const f = this.fields.get(cx * 100003 + cz);
    if (!f) return this.height(x, z);
    const fx = (x - f.x0) / f.step, fz = (z - f.z0) / f.step;
    const i = Math.min(f.N - 2, Math.max(0, Math.floor(fx))), j = Math.min(f.N - 2, Math.max(0, Math.floor(fz)));
    const tx = fx - i, tz = fz - j;
    const H = f.H, N = f.N;
    const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
    // triangles (a,c,b) and (b,c,d) – diagonal b-c
    if (tx + tz <= 1) return a + (b - a) * tx + (c - a) * tz;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }
  normalAt(x, z, out) {
    const e = 0.6;
    const hx = this.groundAt(x + e, z) - this.groundAt(x - e, z);
    const hz = this.groundAt(x, z + e) - this.groundAt(x, z - e);
    const l = Math.hypot(hx, 2 * e, hz);
    out.x = -hx / l; out.y = (2 * e) / l; out.z = -hz / l;
    return out;
  }
}
