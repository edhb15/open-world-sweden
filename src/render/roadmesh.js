/* =====================================================================
   Road meshes per chunk: carriageways, sidewalks, curbs, verges,
   bridges, junction & roundabout surfaces and Swedish road markings.
   ===================================================================== */
import * as THREE from 'three';
import { lerp, clamp } from '../core/math.js';
import { CHUNK } from '../world/terrain.js';
import { xsBase, sIndex } from '../world/network.js';
import { terrainWater } from '../world/geo.js';
import { asphaltTexture, gravelTexture, cobbleTexture, concreteTexture, stoneTexture } from './textures.js';
import { envUniforms } from './terrainmesh.js';

/* ------------------------------ Materials ------------------------------ */
let MATS = null;
function roadShader(m, withTracks) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, envUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLane;\nvarying float vLane;\nvarying vec3 vWPos;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLane = aLane;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSnow, uWet, uTime;
varying float vLane; varying vec3 vWPos;
float rHash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float rNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(rHash(i), rHash(i+vec2(1,0)), f.x), mix(rHash(i+vec2(0,1)), rHash(i+vec2(1,1)), f.x), f.y); }
float gSnowAmt = 0.0;
`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float f = fract(vLane);
  float tracks = ${withTracks ? 'clamp(smoothstep(0.17, 0.07, abs(f - 0.27)) + smoothstep(0.17, 0.07, abs(f - 0.73)), 0.0, 1.0)' : '0.0'};
  float n = rNoise(vWPos.xz * 0.7) * 0.6 + rNoise(vWPos.xz * 3.1) * 0.4;
  float snow = uSnow * clamp(1.0 - tracks * (0.75 + 0.25 * n), 0.0, 1.0);
  snow *= smoothstep(0.15, 0.45, n + uSnow * 0.5);
  gSnowAmt = clamp(snow, 0.0, 1.0);
  // wet asphalt is darker; puddles in low spots
  float puddle = uWet * smoothstep(0.62, 0.8, rNoise(vWPos.xz * 0.35)) * (1.0 - tracks * 0.5);
  diffuseColor.rgb *= 1.0 - 0.42 * uWet - 0.2 * puddle;
  // slush in the tracks when snowy
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.75 + vec3(0.04), uSnow * tracks * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92) * (0.9 + 0.1 * n), gSnowAmt);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, uWet * (1.0 - gSnowAmt));
roughnessFactor = mix(roughnessFactor, 0.02, uWet * smoothstep(0.62, 0.8, rNoise(vWPos.xz * 0.35)) * (1.0 - gSnowAmt));`);
  };
  return m;
}
export function roadMaterials() {
  if (MATS) return MATS;
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...o });
  MATS = {
    asphalt: roadShader(std({ map: asphaltTexture(), color: 0x8c8c8e, roughness: 0.88 }), true),
    gravel: roadShader(std({ map: gravelTexture(), color: 0xb0a48e, roughness: 1 }), true),
    cobble: roadShader(std({ map: cobbleTexture(), color: 0xc0bbb4, roughness: 0.8 }), false),
    sidewalk: roadShader(std({ map: concreteTexture(), color: 0xcdcac2, roughness: 0.9 }), false),
    curb: roadShader(std({ map: stoneTexture(), color: 0xb5b3ae, roughness: 0.8 }), false),
    verge: roadShader(std({ map: gravelTexture(), color: 0x8f8574, roughness: 1 }), false),
    median: roadShader(std({ color: 0x4c5a33, roughness: 1 }), false),
    concrete: std({ map: concreteTexture(), color: 0xa9a7a1, roughness: 0.85 }),
    railing: std({ color: 0x7c8086, roughness: 0.5, metalness: 0.6 }),
    island: roadShader(std({ color: 0x55682f, roughness: 1 }), false),
    paint: roadShader(std({ side: THREE.FrontSide, color: 0xf4f3ee, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), false),
    paintY: roadShader(std({ color: 0xf2c21b, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), false),
  };
  return MATS;
}

/* ------------------------------ Builders ------------------------------ */
class Bucket {
  constructor() { this.pos = []; this.uv = []; this.lane = []; this.idx = []; this.nor = null; }
  v(x, y, z, u, w, lane = 0) { this.pos.push(x, y, z); this.uv.push(u, w); this.lane.push(lane); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, b, d, c); } // a b / c d   (a-b along row k, c-d along row k+1)
  geometry() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aLane', new THREE.Float32BufferAttribute(this.lane, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    return g;
  }
}

function zoneMat(zone, xs) {
  if (zone === 'road') return xs.surface === 'gravel' ? 'gravel' : xs.surface === 'cobble' ? 'cobble' : 'asphalt';
  if (zone === 'sidewalk') return 'sidewalk';
  if (zone === 'verge') return 'verge';
  if (zone === 'median') return 'median';
  if (zone === 'curb') return 'curb';
  return 'asphalt';
}

// Centre frame of a road at s.
function frame(r, s, out) {
  const i = sIndex(r, s);
  const t = (s - r.S[i]) / Math.max(1e-6, r.S[i + 1] - r.S[i]);
  out.x = lerp(r.X[i], r.X[i + 1], t); out.z = lerp(r.Z[i], r.Z[i + 1], t);
  out.y = lerp(r.Y[i], r.Y[i + 1], t);
  let tx = lerp(r.TX[i], r.TX[i + 1], t), tz = lerp(r.TZ[i], r.TZ[i + 1], t);
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  out.tx = tx; out.tz = tz; out.nx = -tz; out.nz = tx;
  out.bank = lerp(r.BANK[i], r.BANK[i + 1], t);
  out.bridge = r.bridge[Math.min(i, r.n - 2)];
  return out;
}

export function* roadChunkJob(world, cx, cz, detail, result) {
  const net = world.net;
  const M = roadMaterials();
  const B = {};
  const bucket = (k) => (B[k] ||= new Bucket());
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const colliders = [];
  const lights = [];
  // collect segments with midpoint in chunk
  const segs = new Map();
  const C = net.cell;
  for (let gx = Math.floor(x0 / C); gx < Math.floor((x0 + CHUNK) / C); gx++)
    for (let gz = Math.floor(z0 / C); gz < Math.floor((z0 + CHUNK) / C); gz++) {
      const l = net.grid.get(gx * 1000003 + gz);
      if (!l) continue;
      for (const enc of l) {
        const ri = (enc / 65536) | 0, i = enc & 65535;
        const r = net.roads[ri];
        const mx = (r.X[i] + r.X[i + 1]) / 2, mz = (r.Z[i] + r.Z[i + 1]) / 2;
        if (mx < x0 || mx >= x0 + CHUNK || mz < z0 || mz >= z0 + CHUNK) continue;
        let set = segs.get(r);
        if (!set) { set = new Set(); segs.set(r, set); }
        set.add(i);
      }
    }
  const F = {};
  let count = 0;
  for (const [r, set] of segs) {
    const list = [...set].sort((a, b) => a - b);
    // contiguous runs
    let runStart = list[0], prev = list[0];
    const runs = [];
    for (let q = 1; q <= list.length; q++) {
      const v = list[q];
      if (v === prev + 1) { prev = v; continue; }
      runs.push([runStart, prev]);
      runStart = v; prev = v;
    }
    for (const [i0, i1] of runs) {
      const sA = Math.max(r.S[i0], r.trimA), sB = Math.min(r.S[i1 + 1], r.len - r.trimB);
      if (sB - sA < 0.05) continue;
      const sl = [sA];
      for (let i = i0 + 1; i <= i1; i++) if (r.S[i] > sA + 0.05 && r.S[i] < sB - 0.05) sl.push(r.S[i]);
      sl.push(sB);
      buildRun(r, sl, bucket, x0, z0, F, colliders);
      if (detail >= 1) buildMarkings(net, r, sA, sB, bucket, x0, z0, F);
      if (detail >= 1) buildBridges(r, sA, sB, bucket, x0, z0, F, colliders);
    }
    if (++count % 6 === 0) yield;
  }
  // junction patches for nodes inside this chunk
  for (const n of net.nodes) {
    if (!n.patch) continue;
    const px = n.patch.center[0], pz = n.patch.center[2];
    if (px < x0 || px >= x0 + CHUNK || pz < z0 || pz >= z0 + CHUNK) continue;
    buildPatch(n, bucket, x0, z0, colliders, detail);
  }
  yield;
  const group = new THREE.Group();
  for (const k in B) {
    const g = B[k].geometry();
    if (!g) continue;
    const mesh = new THREE.Mesh(g, M[k]);
    mesh.receiveShadow = true;
    mesh.castShadow = k === 'concrete' || k === 'railing';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  result.group = group;
  result.colliders = colliders;
}

function buildRun(r, sl, bucket, x0, z0, F, colliders) {
  const xs = r.xs;
  const bp = xs.bp;
  const nb = bp.length;
  const rows = [];
  const vBase = Math.floor(sl[0] / 350) * 350;
  for (const s of sl) {
    frame(r, s, F);
    const row = new Array(nb);
    for (let m = 0; m < nb; m++) {
      const b = bp[m];
      const y = F.y + xsBase(xs, F.bank, b.d) + b.dy + (F.bridge && b.zone === 'verge' ? 0.06 : 0);
      row[m] = [F.x + F.nx * b.d - x0, y, F.z + F.nz * b.d - z0];
    }
    rows.push({ s, row, bridge: F.bridge });
  }
  // intervals between breakpoints
  for (let m = 0; m < nb - 1; m++) {
    const a = bp[m], b = bp[m + 1];
    const curb = Math.abs(a.d - b.d) < 1e-4;
    let zone = curb ? 'curb' : a.zone === b.zone ? a.zone : a.zone === 'road' ? b.zone : a.zone;
    if (a.zone === 'median' || b.zone === 'median') zone = (a.zone === 'median' && b.zone === 'median') ? 'median' : 'road';
    const mat = zoneMat(zone, xs);
    const bk = bucket(mat);
    const laneOf = (d) => (d - xs.travelL) / xs.w;
    let prevA = -1, prevB = -1;
    for (let k = 0; k < rows.length; k++) {
      const R = rows[k];
      const pa = R.row[m], pb = R.row[m + 1];
      const v = (R.s - vBase) / 3.5;
      const ua = curb ? pa[1] * 2 : a.d / 3.5, ub = curb ? pb[1] * 2 : b.d / 3.5;
      const ia = bk.v(pa[0], pa[1], pa[2], ua, v, laneOf(a.d));
      const ib = bk.v(pb[0], pb[1], pb[2], ub, v, laneOf(b.d));
      if (k > 0) {
        // orientation: rows advance along s, a is left of b
        bk.quad(prevA, prevB, ia, ib);
      }
      prevA = ia; prevB = ib;
    }
  }
  // outer skirts (hide gaps to terrain) – not on bridges
  for (const side of [0, nb - 1]) {
    const bk = bucket(zoneMat(bp[side].zone === 'road' ? 'verge' : bp[side].zone, xs));
    let pa = -1, pb = -1;
    for (let k = 0; k < rows.length; k++) {
      const R = rows[k];
      const p = R.row[side];
      const drop = R.bridge ? 0.02 : 1.4;
      const out = side === 0 ? -0.4 : 0.4;
      frame(r, R.s, F);
      const ia = bk.v(p[0], p[1], p[2], 0, (R.s) / 3.5);
      const ib = bk.v(p[0] + F.nx * out * (R.bridge ? 0 : 1), p[1] - drop, p[2] + F.nz * out * (R.bridge ? 0 : 1), 0.4, R.s / 3.5);
      if (k > 0) {
        if (side === 0) bk.quad(pb, pa, ib, ia); else bk.quad(pa, pb, ia, ib);
      }
      pa = ia; pb = ib;
    }
  }
}

/* ------------------------------ Bridges ------------------------------ */
function buildBridges(r, sA, sB, bucket, x0, z0, F, colliders) {
  if (!r.spans || !r.spans.length) return;
  const xs = r.xs;
  const conc = bucket('concrete');
  for (const [s0, s1, kind] of r.spans) {
    const a = Math.max(s0, sA), b = Math.min(s1, sB);
    if (b - a < 0.5) continue;
    const step = 4;
    const n = Math.max(1, Math.ceil((b - a) / step));
    const deck = r.type === 'motorway' ? 1.6 : 1.2;
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const s = a + ((b - a) * k) / n;
      frame(r, s, F);
      const yl = F.y + xsBase(xs, F.bank, xs.edgeL) + (xs.swL > 0 ? xs.curb : 0);
      const yr = F.y + xsBase(xs, F.bank, xs.edgeR) + (xs.swR > 0 ? xs.curb : 0);
      const L = [F.x + F.nx * xs.outerL - x0, F.z + F.nz * xs.outerL - z0];
      const R = [F.x + F.nx * xs.outerR - x0, F.z + F.nz * xs.outerR - z0];
      const Lp = [F.x + F.nx * (xs.outerL - 0.35) - x0, F.z + F.nz * (xs.outerL - 0.35) - z0];
      const Rp = [F.x + F.nx * (xs.outerR + 0.35) - x0, F.z + F.nz * (xs.outerR + 0.35) - z0];
      const cur = { L, R, Lp, Rp, yl, yr, s };
      if (prev) {
        const v0 = prev.s / 4, v1 = s / 4;
        // parapets (inner face, top, outer face) left & right
        for (const side of ['l', 'r']) {
          const P0 = side === 'l' ? prev.L : prev.R, P1 = side === 'l' ? cur.L : cur.R;
          const Q0 = side === 'l' ? prev.Lp : prev.Rp, Q1 = side === 'l' ? cur.Lp : cur.Rp;
          const y0 = side === 'l' ? prev.yl : prev.yr, y1 = side === 'l' ? cur.yl : cur.yr;
          const h = 0.95;
          const a0 = conc.v(P0[0], y0, P0[1], 0, v0), a1 = conc.v(P1[0], y1, P1[1], 0, v1);
          const b0 = conc.v(P0[0], y0 + h, P0[1], 0.3, v0), b1 = conc.v(P1[0], y1 + h, P1[1], 0.3, v1);
          const c0 = conc.v(Q0[0], y0 + h, Q0[1], 0.4, v0), c1 = conc.v(Q1[0], y1 + h, Q1[1], 0.4, v1);
          const d0 = conc.v(Q0[0], y0 - deck, Q0[1], 0.9, v0), d1 = conc.v(Q1[0], y1 - deck, Q1[1], 0.9, v1);
          if (side === 'l') { conc.quad(a0, b0, a1, b1); conc.quad(b0, c0, b1, c1); conc.quad(c0, d0, c1, d1); }
          else { conc.quad(b0, a0, b1, a1); conc.quad(c0, b0, c1, b1); conc.quad(d0, c0, d1, c1); }
          colliders.push({ type: 'seg', ax: P0[0] + x0, az: P0[1] + z0, bx: P1[0] + x0, bz: P1[1] + z0, y0: Math.min(y0, y1) - 0.2, y1: Math.max(y0, y1) + h, h: 'parapet' });
        }
        // underside
        const u0 = conc.v(prev.Lp[0], prev.yl - deck, prev.Lp[1], 0, v0), u1 = conc.v(prev.Rp[0], prev.yr - deck, prev.Rp[1], 1, v0);
        const u2 = conc.v(cur.Lp[0], cur.yl - deck, cur.Lp[1], 0, v1), u3 = conc.v(cur.Rp[0], cur.yr - deck, cur.Rp[1], 1, v1);
        conc.quad(u1, u0, u3, u2);
      }
      prev = cur;
    }
    // piers
    const spacing = r.type === 'motorway' || r.type === 'expressway' ? 34 : 26;
    for (let s = Math.ceil((s0 + 10) / spacing) * spacing; s < s1 - 8; s += spacing) {
      if (s < sA || s >= sB) continue;
      frame(r, s, F);
      const top = F.y - deck;
      const wo = { level: 0, kind: 0 };
      const cols = xs.halfW > 8 ? [xs.outerL * 0.55, xs.outerR * 0.55] : [0];
      for (const d of cols) {
        const px = F.x + F.nx * d, pz = F.z + F.nz * d;
        const ground = terrainWater(px, pz, wo) - 1;
        if (top - ground < 1.5) continue;
        box(conc, px - x0, pz - z0, ground, top, 0.8, 0.8, Math.atan2(F.tz, F.tx));
        colliders.push({ type: 'circle', x: px, z: pz, r: 0.9, y0: ground, y1: top, h: 'pier' });
      }
      // crossbeam
      box(conc, F.x - x0, F.z - z0, top - 0.9, top, xs.halfW * 1.2, 0.9, Math.atan2(F.tz, F.tx) + Math.PI / 2);
    }
  }
}

// axis box helper (centre px,pz; y range; half sizes hx (along rot dir), hz)
export function box(bk, px, pz, y0, y1, hx, hz, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (ax, az) => [px + ax * c - az * s, pz + ax * s + az * c];
  const corners = [P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)];
  const h = y1 - y0;
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const i0 = bk.v(a[0], y0, a[1], 0, 0), i1 = bk.v(b[0], y0, b[1], L / 4, 0);
    const i2 = bk.v(a[0], y1, a[1], 0, h / 4), i3 = bk.v(b[0], y1, b[1], L / 4, h / 4);
    bk.quad(i0, i1, i2, i3);
  }
  const t = corners.map((p) => bk.v(p[0], y1, p[1], p[0] / 4, p[1] / 4));
  bk.tri(t[0], t[2], t[1]); bk.tri(t[0], t[3], t[2]);
}

/* ------------------------------ Patches ------------------------------ */
function buildPatch(n, bucket, x0, z0, colliders, detail) {
  const P = n.patch;
  const bk = bucket('asphalt');
  const c = P.center;
  const ic = bk.v(c[0] - x0, c[1], c[2] - z0, c[0] / 3.5, c[2] / 3.5, -10);
  const ids = P.boundary.map((p) => bk.v(p[0] - x0, p[1], p[2] - z0, p[0] / 3.5, p[2] / 3.5, -10));
  for (let k = 0; k < ids.length; k++) {
    const a = ids[k], b = ids[(k + 1) % ids.length];
    // ensure upward facing
    const pa = P.boundary[k], pb = P.boundary[(k + 1) % ids.length];
    const cross = (pa[0] - c[0]) * (pb[2] - c[2]) - (pa[2] - c[2]) * (pb[0] - c[0]);
    if (cross > 0) bk.tri(ic, b, a); else bk.tri(ic, a, b);
  }
  // sidewalk corners
  for (const cr of P.corners) {
    const sw = bucket('sidewalk'), cb = bucket('curb');
    const L = Math.min(cr.inner.length, cr.outer.length);
    let pi = -1, po = -1, pc0 = -1, pc1 = -1;
    for (let q = 0; q < L; q++) {
      const I = cr.inner[q], O = cr.outer[q];
      const ii = sw.v(I[0] - x0, I[1] + cr.curb, I[2] - z0, I[0] / 2, I[2] / 2, -10);
      const oo = sw.v(O[0] - x0, O[1] + cr.curb - 0.02, O[2] - z0, O[0] / 2, O[2] / 2, -10);
      const c0 = cb.v(I[0] - x0, I[1], I[2] - z0, q * 0.3, 0, -10);
      const c1 = cb.v(I[0] - x0, I[1] + cr.curb, I[2] - z0, q * 0.3, 0.12, -10);
      if (q > 0) {
        const A = cr.inner[q - 1], Bq = cr.inner[q], Oo = cr.outer[q - 1];
        const cross = (Bq[0] - A[0]) * (Oo[2] - A[2]) - (Bq[2] - A[2]) * (Oo[0] - A[0]);
        if (cross > 0) { sw.tri(pi, oo, ii); sw.tri(pi, po, oo); cb.quad(pc0, c0, pc1, c1); }
        else { sw.tri(pi, ii, oo); sw.tri(pi, oo, po); cb.quad(c0, pc0, c1, pc1); }
      }
      pi = ii; po = oo; pc0 = c0; pc1 = c1;
    }
  }
  if (P.kind === 'roundabout') {
    const R = P.island;
    const isl = bucket('island'), cb = bucket('curb');
    const seg = 28;
    const top = [], ring0 = [], ring1 = [];
    const cy = c[1];
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * R - x0, z = c[2] + Math.sin(a) * R - z0;
      ring0.push(cb.v(x, cy - 0.05, z, k / 3, 0, -10));
      ring1.push(cb.v(x, cy + 0.18, z, k / 3, 0.2, -10));
      top.push(isl.v(x, cy + 0.18, z, x / 4, z / 4, -10));
    }
    const mid = isl.v(c[0] - x0, cy + 0.9, c[2] - z0, 0, 0, -10);
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      cb.quad(ring0[k2], ring0[k], ring1[k2], ring1[k]);
      isl.tri(mid, top[k2], top[k]);
    }
    colliders.push({ type: 'circle', x: c[0], z: c[2], r: R - 0.3, y0: cy - 1, y1: cy + 0.18, h: 'island', soft: true });
  }
  if (P.kind === 'culdesac') { /* plain asphalt bulb */ }
  if (detail >= 1) junctionMarkings(n, bucket, x0, z0);
}

/* ------------------------------ Markings ------------------------------ */
const _F = {};
function stripe(bk, r, s0, s1, d0, d1, x0, z0, lift = 0.014) {
  // a painted quad strip between lateral d0..d1 from s0 to s1
  const n = Math.max(1, Math.ceil((s1 - s0) / 4));
  let pa = -1, pb = -1;
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    frame(r, s, _F);
    const ya = _F.y + xsBase(r.xs, _F.bank, d0) + lift, yb = _F.y + xsBase(r.xs, _F.bank, d1) + lift;
    const ia = bk.v(_F.x + _F.nx * d0 - x0, ya, _F.z + _F.nz * d0 - z0, 0, 0, -10);
    const ib = bk.v(_F.x + _F.nx * d1 - x0, yb, _F.z + _F.nz * d1 - z0, 1, 0, -10);
    if (k > 0) bk.quad(pa, pb, ia, ib);
    pa = ia; pb = ib;
  }
}
function line(bk, r, sA, sB, d, w, dash, gap, x0, z0, phase = 0) {
  if (!dash) { stripe(bk, r, sA, sB, d - w / 2, d + w / 2, x0, z0); return; }
  const P = dash + gap;
  let s = Math.floor((sA - phase) / P) * P + phase;
  for (; s < sB; s += P) {
    const a = Math.max(s, sA), b = Math.min(s + dash, sB);
    if (b - a > 0.05) stripe(bk, r, a, b, d - w / 2, d + w / 2, x0, z0);
  }
}

function buildMarkings(net, r, sA, sB, bucket, x0, z0, F) {
  const xs = r.xs, T = r.T;
  if (xs.surface === 'gravel') return;
  const paint = bucket('paint');
  const c = xs.c;
  const w = xs.w;
  // centre / divider
  if (xs.divider === 'line' && T.center === 'dashed' && xs.lanesB > 0) {
    // Swedish "mittlinje" 3+9; urban 3+3
    if (T.urban) line(paint, r, sA, sB, c, 0.1, 3, 3, x0, z0);
    else line(paint, r, sA, sB, c, 0.1, 3, 9, x0, z0);
  } else if (xs.divider === 'double') {
    line(paint, r, sA, sB, c - 0.18, 0.1, 0, 0, x0, z0);
    line(paint, r, sA, sB, c + 0.18, 0.1, 0, 0, x0, z0);
  } else if (xs.divider === 'cable') {
    line(paint, r, sA, sB, c - xs.mHalf + 0.05, 0.1, 0, 0, x0, z0);
    line(paint, r, sA, sB, c + xs.mHalf - 0.05, 0.1, 0, 0, x0, z0);
  } else if (xs.divider === 'median') {
    line(paint, r, sA, sB, c - xs.mHalf + 0.12, 0.15, 0, 0, x0, z0);
    line(paint, r, sA, sB, c + xs.mHalf - 0.12, 0.15, 0, 0, x0, z0);
  }
  // lane lines
  const lanePat = T.laneLine === 'motorway' ? [3, 9] : T.urban ? [3, 3] : [3, 9];
  for (let k = 1; k < xs.lanesF; k++) line(paint, r, sA, sB, c + xs.mHalf + k * w, 0.15, lanePat[0], lanePat[1], x0, z0);
  for (let k = 1; k < xs.lanesB; k++) line(paint, r, sA, sB, c - xs.mHalf - k * w, 0.15, lanePat[0], lanePat[1], x0, z0);
  // edge lines
  if (T.edge === 'solid') {
    line(paint, r, sA, sB, xs.travelR + 0.12, 0.2, 0, 0, x0, z0);
    if (xs.lanesB > 0 || xs.oneway) line(paint, r, sA, sB, xs.travelL - 0.1, 0.15, 0, 0, x0, z0);
  } else if (T.edge === 'dashed') {
    // Swedish "kantlinje" 1+2 on rural roads
    line(paint, r, sA, sB, xs.travelR + 0.1, 0.1, 1, 2, x0, z0);
    if (xs.lanesB > 0) line(paint, r, sA, sB, xs.travelL - 0.1, 0.1, 1, 2, x0, z0);
  }
  if (xs.parkR > 0) line(paint, r, sA, sB, xs.travelR + 0.05, 0.1, 0, 0, x0, z0);
  if (xs.parkL > 0) line(paint, r, sA, sB, xs.travelL - 0.05, 0.1, 0, 0, x0, z0);
  // junction approach markings at road ends
  for (const atStart of [true, false]) {
    const node = atStart ? r.a : r.b;
    if (node.kind !== 'junction' && node.kind !== 'roundabout') continue;
    const sEnd = atStart ? r.trimA : r.len - r.trimB;
    if (sEnd < sA - 0.1 || sEnd > sB + 0.1) continue;
    const dir = atStart ? 1 : -1; // direction into the road from the end
    // incoming lanes: when atStart, backward lanes (d<0) approach the node
    const dIn0 = atStart ? xs.travelL : c + xs.mHalf, dIn1 = atStart ? c - xs.mHalf : xs.travelR;
    const e = node.ends.find((q) => q.road === r && q.atStart === atStart);
    const urban = r.T.urban && (xs.swL > 0 || xs.swR > 0);
    let off = 0.4;
    if (urban && node.kind === 'junction' && node.ends.length >= 3) {
      // zebra crossing ("övergångsställe")
      const z0s = sEnd + dir * 1.0, z1s = sEnd + dir * 4.0;
      const a = Math.min(z0s, z1s), b = Math.max(z0s, z1s);
      for (let d = xs.edgeL + 0.4; d < xs.edgeR - 0.4; d += 1.0) stripe(paint, r, a, b, d, d + 0.5, x0, z0);
      off = 5.2;
      (net.crosswalks ||= []).push({ road: r, node, s: (a + b) / 2, atStart });
    }
    const sLine = sEnd + dir * off;
    if (sLine < Math.min(sA, sB) - 1 || sLine > Math.max(sA, sB) + 1) continue;
    if (node.control === 'signal') {
      stripe(paint, r, Math.min(sLine, sLine + dir * 0.35), Math.max(sLine, sLine + dir * 0.35), dIn0, dIn1, x0, z0);
    } else if (node.kind === 'roundabout' || (node.control === 'priority' && e && !e.major)) {
      // väjningslinje: shark teeth pointing at the approaching driver
      const bk = paint;
      for (let d = dIn0 + 0.15; d < dIn1 - 0.4; d += 0.75) {
        const sb = sLine, sp = sLine + dir * 0.75;
        frame(r, sb, _F);
        const ya = _F.y + xsBase(xs, _F.bank, d) + 0.015;
        const a1 = bk.v(_F.x + _F.nx * d - x0, ya, _F.z + _F.nz * d - z0, 0, 0, -10);
        const a2 = bk.v(_F.x + _F.nx * (d + 0.5) - x0, ya, _F.z + _F.nz * (d + 0.5) - z0, 0, 0, -10);
        frame(r, sp, _F);
        const a3 = bk.v(_F.x + _F.nx * (d + 0.25) - x0, ya, _F.z + _F.nz * (d + 0.25) - z0, 0, 0, -10);
        if (dir > 0) bk.tri(a1, a3, a2); else bk.tri(a1, a2, a3);
      }
    }
  }
}

function junctionMarkings(n, bucket, x0, z0) {
  if (n.kind !== 'roundabout') return;
  const paint = bucket('paint');
  // ring edge line around the island
  const R = n.patch.island + 0.4, c = n.patch.center;
  const seg = 48;
  for (let k = 0; k < seg; k += 2) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const p = (a, rr) => [c[0] + Math.cos(a) * rr - x0, c[1] + 0.015, c[2] + Math.sin(a) * rr - z0];
    const q0 = p(a0, R), q1 = p(a0, R + 0.12), q2 = p(a1, R), q3 = p(a1, R + 0.12);
    const i0 = paint.v(...q0, 0, 0, -10), i1 = paint.v(...q1, 0, 0, -10), i2 = paint.v(...q2, 0, 0, -10), i3 = paint.v(...q3, 0, 0, -10);
    paint.quad(i1, i0, i3, i2);
  }
}
