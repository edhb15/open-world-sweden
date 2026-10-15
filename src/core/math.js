/* =====================================================================
   Math helpers, deterministic random numbers and procedural noise.
   Everything here is pure JS so it also runs under Node for tests.
   ===================================================================== */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const KMH = 1 / 3.6; // km/h -> m/s

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, v) => {
  const t = saturate((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const angleDiff = (a, b) => wrapAngle(b - a);
export const len2 = (x, z) => Math.sqrt(x * x + z * z);

// Deterministic PRNG.
export function mulberry32(seed) {
  let s = seed >>> 0;
  const f = function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return f;
}
export class RNG {
  constructor(seed = 1) { this.next = mulberry32(seed); }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  weighted(items, weights) {
    let tot = 0;
    for (const w of weights) tot += w;
    let r = this.next() * tot;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }
}

// Integer hash -> [0,1)
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---------------- 2D simplex noise (Gustavson / Ashima style) ---------------- */
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export function makeSimplex(seed = 1337) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod8 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod8[i] = perm[i] & 7; }

  return function noise2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permMod8[ii + perm[jj]] * 2;
      t0 *= t0; n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permMod8[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1; n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permMod8[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2; n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * (n0 + n1 + n2); // roughly [-1, 1]
  };
}

export const noiseA = makeSimplex(1);
export const noiseB = makeSimplex(2);
export const noiseC = makeSimplex(3);
export const noiseD = makeSimplex(4);

export function fbm(noise, x, y, oct = 4, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += noise(x, y) * amp;
    norm += amp;
    amp *= gain; x *= lac; y *= lac;
  }
  return sum / norm;
}
export function ridged(noise, x, y, oct = 4, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(noise(x, y));
    sum += n * n * amp;
    norm += amp;
    amp *= gain; x *= lac; y *= lac;
  }
  return sum / norm;
}

/* ---------------- 2D geometry ---------------- */
// Closest point parameter on segment AB for point P.
export function segParam(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-12) return 0;
  return clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
}
export function distToSeg(px, pz, ax, az, bx, bz) {
  const t = segParam(px, pz, ax, az, bx, bz);
  const x = ax + (bx - ax) * t - px, z = az + (bz - az) * t - pz;
  return Math.sqrt(x * x + z * z);
}
// Segment intersection: returns {t,u} params or null.
export function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}
export function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Signed distance to polygon (positive inside).
export function polySDF(px, pz, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const dd = distToSeg(px, pz, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (dd < d) d = dd;
  }
  return pointInPoly(px, pz, poly) ? d : -d;
}

// Centripetal Catmull-Rom through points (array of [x,z]); returns dense samples at ~step meters.
export function catmullRom(points, step, alpha = 0.5) {
  const out = [];
  if (points.length < 2) return points.slice();
  const P = [points[0].slice(), ...points.map((p) => p.slice()), points[points.length - 1].slice()];
  // extrapolate end points
  P[0] = [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
  const n = points.length;
  P[n + 1] = [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]];
  const tj = (ti, a, b) => ti + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, alpha);
  for (let i = 0; i < n - 1; i++) {
    const p0 = P[i], p1 = P[i + 1], p2 = P[i + 2], p3 = P[i + 3];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(segLen / step));
    for (let k = 0; k < m; k++) {
      const t = t1 + ((t2 - t1) * k) / m;
      const A1x = ((t1 - t) / (t1 - t0)) * p0[0] + ((t - t0) / (t1 - t0)) * p1[0];
      const A1z = ((t1 - t) / (t1 - t0)) * p0[1] + ((t - t0) / (t1 - t0)) * p1[1];
      const A2x = ((t2 - t) / (t2 - t1)) * p1[0] + ((t - t1) / (t2 - t1)) * p2[0];
      const A2z = ((t2 - t) / (t2 - t1)) * p1[1] + ((t - t1) / (t2 - t1)) * p2[1];
      const A3x = ((t3 - t) / (t3 - t2)) * p2[0] + ((t - t2) / (t3 - t2)) * p3[0];
      const A3z = ((t3 - t) / (t3 - t2)) * p2[1] + ((t - t2) / (t3 - t2)) * p3[1];
      const B1x = ((t2 - t) / (t2 - t0)) * A1x + ((t - t0) / (t2 - t0)) * A2x;
      const B1z = ((t2 - t) / (t2 - t0)) * A1z + ((t - t0) / (t2 - t0)) * A2z;
      const B2x = ((t3 - t) / (t3 - t1)) * A2x + ((t - t1) / (t3 - t1)) * A3x;
      const B2z = ((t3 - t) / (t3 - t1)) * A2z + ((t - t1) / (t3 - t1)) * A3z;
      out.push([((t2 - t) / (t2 - t1)) * B1x + ((t - t1) / (t2 - t1)) * B2x, ((t2 - t) / (t2 - t1)) * B1z + ((t - t1) / (t2 - t1)) * B2z]);
    }
  }
  out.push(points[n - 1].slice());
  return out;
}

// Resample a polyline ([x,z] array) to uniform spacing. Returns new array of [x,z].
export function resample(pts, step) {
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const L = Math.hypot(bx - ax, bz - az);
    let d = step - carry;
    while (d <= L) {
      const t = d / L;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      d += step;
    }
    carry = L - (d - step);
  }
  const last = pts[pts.length - 1];
  const pl = out[out.length - 1];
  const rem = Math.hypot(last[0] - pl[0], last[1] - pl[1]);
  if (rem > step * 0.35) out.push(last.slice());
  else out[out.length - 1] = last.slice();
  return out;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Cubic bezier in 3D on arrays [x,y,z].
export function bezier3(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2]];
}

export function formatKr(v) {
  const s = Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return s + ' kr';
}
