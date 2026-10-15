/* =====================================================================
   Vegetation: instanced spruce, pine, birch and broadleaf trees with
   seasonal foliage, snow on conifers and wind sway.
   ===================================================================== */
import * as THREE from 'three';
import { RNG, hash2i, clamp, lerp } from '../core/math.js';
import { CHUNK } from '../world/terrain.js';
import { forestDensity, speciesMix } from './landcover.js';
import { envUniforms } from './terrainmesh.js';
import { pointInPoly, cityMask } from '../world/geo.js';

export const vegUniforms = {
  uLeaf: { value: 1 },                                   // 0 = bare (winter), 1 = full
  uBirchCol: { value: new THREE.Color(0.2, 0.36, 0.08) },
  uBroadCol: { value: new THREE.Color(0.14, 0.28, 0.06) },
  uConiferCol: { value: new THREE.Color(0.055, 0.11, 0.045) },
  uPineCol: { value: new THREE.Color(0.07, 0.12, 0.05) },
};

function colorize(g, rgb) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function merge(geos) {
  const g = new THREE.BufferGeometry();
  let n = 0, ni = 0;
  for (const q of geos) { n += q.attributes.position.count; ni += q.index ? q.index.count : q.attributes.position.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), idx = new Uint16Array(ni);
  let o = 0, oi = 0;
  for (const q of geos) {
    const c = q.attributes.position.count;
    pos.set(q.attributes.position.array, o * 3);
    nor.set(q.attributes.normal.array, o * 3);
    col.set(q.attributes.color.array, o * 3);
    if (q.index) { for (let k = 0; k < q.index.count; k++) idx[oi + k] = q.index.array[k] + o; oi += q.index.count; }
    else { for (let k = 0; k < c; k++) idx[oi + k] = o + k; oi += c; }
    o += c;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
function cone(r, h, y, seg, rgb) { const g = new THREE.ConeGeometry(r, h, seg, 1, false); g.translate(0, y + h / 2, 0); return colorize(g, rgb); }
function cyl(r0, r1, h, y, seg, rgb) { const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, true); g.translate(0, y + h / 2, 0); return colorize(g, rgb); }
function blob(rx, ry, y, detail, rgb, seed) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const rnd = new RNG(seed);
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + rnd.float(0, 0.3);
    p.setXYZ(i, p.getX(i) * rx * k, p.getY(i) * ry * k + y, p.getZ(i) * rx * k);
  }
  g.computeVertexNormals();
  return colorize(g.toNonIndexed ? g : g, rgb);
}

// Geometries in unit height (scaled per instance). Each species: {trunk, foliage}
function buildSpecies(lod) {
  const seg = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  const bark = [0.13, 0.08, 0.05], pinebark = [0.36, 0.2, 0.1], birchbark = [0.82, 0.8, 0.76];
  const S = {};
  // spruce (gran)
  const sprF = lod === 0 ? [cone(0.24, 0.42, 0.12, seg, [1, 1, 1]), cone(0.19, 0.36, 0.36, seg, [1, 1, 1]), cone(0.14, 0.3, 0.58, seg, [1, 1, 1]), cone(0.08, 0.24, 0.78, seg, [1, 1, 1])]
    : lod === 1 ? [cone(0.23, 0.55, 0.12, seg, [1, 1, 1]), cone(0.14, 0.45, 0.55, seg, [1, 1, 1])] : [cone(0.22, 0.9, 0.1, seg, [1, 1, 1])];
  S.spruce = { trunk: merge([cyl(0.025, 0.012, 0.3, 0, 4, bark)]), foliage: merge(sprF), kind: 'conifer' };
  // pine (tall, crown on top)
  S.pine = {
    trunk: merge([cyl(0.028, 0.016, 0.82, 0, lod === 0 ? 5 : 4, pinebark)]),
    foliage: merge(lod === 0 ? [blob(0.17, 0.11, 0.8, 1, [1, 1, 1], 3), blob(0.12, 0.08, 0.68, 1, [1, 1, 1], 4), blob(0.1, 0.07, 0.92, 0, [1, 1, 1], 5)] : [blob(0.16, 0.13, 0.8, 0, [1, 1, 1], 3)]),
    kind: 'pine',
  };
  // birch (björk)
  S.birch = {
    trunk: merge([cyl(0.022, 0.01, 0.7, 0, lod === 0 ? 5 : 4, birchbark)]),
    foliage: merge(lod === 0 ? [blob(0.2, 0.3, 0.62, 1, [1, 1, 1], 7), blob(0.13, 0.16, 0.86, 0, [1, 1, 1], 8)] : [blob(0.2, 0.3, 0.65, 0, [1, 1, 1], 7)]),
    kind: 'birch',
  };
  // broadleaf (ek/bok/lönn)
  S.broad = {
    trunk: merge([cyl(0.045, 0.025, 0.48, 0, lod === 0 ? 6 : 4, bark)]),
    foliage: merge(lod === 0 ? [blob(0.34, 0.27, 0.62, 1, [1, 1, 1], 11), blob(0.22, 0.2, 0.8, 1, [1, 1, 1], 12), blob(0.2, 0.18, 0.55, 0, [1, 1, 1], 13)] : [blob(0.34, 0.3, 0.64, 0, [1, 1, 1], 11)]),
    kind: 'broad',
  };
  return S;
}
const SPECIES = [null, null, null];
function species(lod) { return SPECIES[lod] || (SPECIES[lod] = buildSpecies(lod)); }

/* ------------------------------ Materials ------------------------------ */
const MAT = {};
function foliageMaterial(kind) {
  if (MAT[kind]) return MAT[kind];
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, envUniforms, vegUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uWind, uLeaf;\nvarying float vSnowUp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  ${kind === 'birch' || kind === 'broad' ? 'transformed *= mix(0.0, 1.0, uLeaf);' : ''}
  #ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
  float sway = sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.5 + sin(uTime * 2.7 + ip.x * 0.3) * 0.2;
  transformed.x += sway * uWind * 0.035 * max(0.0, position.y - 0.25);
  transformed.z += sway * uWind * 0.02 * max(0.0, position.y - 0.25);
  #endif
  vSnowUp = normal.y;`);
    const col = kind === 'birch' ? 'uBirchCol' : kind === 'broad' ? 'uBroadCol' : kind === 'pine' ? 'uPineCol' : 'uConiferCol';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uSnow;\nuniform vec3 uBirchCol, uBroadCol, uConiferCol, uPineCol;\nvarying float vSnowUp;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb = ${col} * vColor.rgb * 1.0;
  ${kind === 'conifer' || kind === 'pine' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.85, 0.9), uSnow * smoothstep(0.1, 0.6, vSnowUp) * 0.85);' : ''}`);
  };
  MAT[kind] = m;
  return m;
}
function trunkMaterial() {
  if (MAT.trunk) return MAT.trunk;
  MAT.trunk = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  return MAT.trunk;
}

/* ------------------------------ Placement ------------------------------ */
const _s = { level: 0, kind: 0, road: 0 };

export function* vegetationChunkJob(world, cx, cz, lod, result) {
  const terrain = world.terrain;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const spacing = lod === 0 ? 5.6 : lod === 1 ? 7.2 : 11;
  const N = Math.floor(CHUNK / spacing);
  const lists = { spruce: [], pine: [], birch: [], broad: [] };
  const colliders = [];
  // nearby building footprints (circles)
  const blockers = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const l = world.lotIndex.get((cx + dx) * 100003 + (cz + dz));
    if (l) for (const b of l) blockers.push([b.x, b.z, Math.hypot(b.w, b.d) / 2 + 2.5]);
    const p = world.parkIndex.get((cx + dx) * 100003 + (cz + dz));
    if (p) for (const b of p) blockers.push([b.x, b.z, Math.hypot(b.w, b.d) / 2 + 1]);
    const q = world.poiIndex.get((cx + dx) * 100003 + (cz + dz));
    if (q) for (const b of q) if (b.type === 'petrol' || b.type === 'rest' || b.type === 'landmark') blockers.push([b.x, b.z, b.type === 'landmark' ? 45 : 32]);
  }
  const blocked = (x, z) => { for (const b of blockers) if ((x - b[0]) ** 2 + (z - b[1]) ** 2 < b[2] * b[2]) return true; return false; };
  const ground = (x, z) => terrain.sample(x, z, _s);
  let count = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const hx = hash2i(cx * 64 + i, cz * 64 + j, 41 + lod), hz = hash2i(cx * 64 + i, cz * 64 + j, 43 + lod);
      const x = x0 + (i + 0.15 + 0.7 * hx) * spacing, z = z0 + (j + 0.15 + 0.7 * hz) * spacing;
      const pick = hash2i(cx * 64 + i, cz * 64 + j, 47 + lod);
      // cheap early-out with forest density before terrain sampling
      const fd = forestDensity(x, z, null);
      const sparse = 0.025 * (1 - cityMask(x, z));
      if (pick > Math.max(fd * (lod === 2 ? 0.85 : 0.92), sparse)) continue;
      const h = ground(x, z);
      if (_s.road > 0.02) continue;
      if (_s.level > h - 0.6) continue;
      const fd2 = forestDensity(x, z, h);
      if (pick > Math.max(fd2 * 0.92, sparse * (h < 450 ? 1 : 0))) continue;
      if (blocked(x, z)) continue;
      // slope check via neighbours
      const mix = speciesMix(x, z, h);
      const r = hash2i(i, j, cx * 7 + cz * 13);
      const tot = mix.spruce + mix.pine + mix.birch + mix.broad;
      let sp, acc = r * tot;
      if ((acc -= mix.spruce) < 0) sp = 'spruce'; else if ((acc -= mix.pine) < 0) sp = 'pine'; else if ((acc -= mix.birch) < 0) sp = 'birch'; else sp = 'broad';
      const hs = hash2i(i * 3, j * 5, cx + cz);
      const height = sp === 'spruce' ? 11 + hs * 15 : sp === 'pine' ? 12 + hs * 12 : sp === 'birch' ? 8 + hs * 9 : 9 + hs * 10;
      lists[sp].push(x - x0, h - 0.2, z - z0, height, hs);
      if (lod === 0) colliders.push({ type: 'circle', x, z, r: sp === 'broad' ? 0.45 : 0.3, y0: h - 1, y1: h + height * 0.6, tree: true });
      if (++count % 200 === 0) yield;
    }
    if (j % 4 === 3) yield;
  }
  // urban trees: parks, gardens, avenues
  if (lod <= 1) {
    const parks = world.parkChunkIndex.get(cx * 100003 + cz) || [];
    for (const pk of parks) {
      const rng = new RNG(Math.floor(pk.poly[0][0] * 7 + pk.poly[0][1]));
      let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
      for (const p of pk.poly) { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); zmin = Math.min(zmin, p[1]); zmax = Math.max(zmax, p[1]); }
      const area = (xmax - xmin) * (zmax - zmin);
      const n = Math.floor(area / (pk.kind === 'park' ? 140 : pk.kind === 'garden' ? 420 : pk.kind === 'churchyard' ? 220 : 900));
      for (let k = 0; k < n; k++) {
        const x = rng.float(xmin, xmax), z = rng.float(zmin, zmax);
        if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
        if (!pointInPoly(x, z, pk.poly) || blocked(x, z)) continue;
        const h = ground(x, z);
        if (_s.road > 0.02 || _s.level > h - 0.5) continue;
        const sp = pk.kind === 'garden' ? (rng.chance(0.5) ? 'birch' : 'broad') : rng.chance(0.65) ? 'broad' : 'birch';
        const height = sp === 'broad' ? rng.float(7, 15) : rng.float(8, 14);
        lists[sp].push(x - x0, h - 0.2, z - z0, height, rng.next());
        if (lod === 0) colliders.push({ type: 'circle', x, z, r: 0.4, y0: h - 1, y1: h + 6, tree: true });
      }
    }
    yield;
  }
  // instanced meshes
  const S = species(lod);
  const group = new THREE.Group();
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), Yax = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  for (const sp in lists) {
    const L = lists[sp];
    const n = L.length / 5;
    if (!n) continue;
    const def = S[sp];
    const kind = def.kind;
    const trunk = new THREE.InstancedMesh(def.trunk, trunkMaterial(), n);
    const fol = new THREE.InstancedMesh(def.foliage, foliageMaterial(kind), n);
    for (let k = 0; k < n; k++) {
      const x = L[k * 5], y = L[k * 5 + 1], z = L[k * 5 + 2], hgt = L[k * 5 + 3], r = L[k * 5 + 4];
      Q.setFromAxisAngle(Yax, r * 6.283);
      const wscale = sp === 'pine' ? 0.9 + r * 0.25 : 0.85 + r * 0.35;
      SC.set(hgt * wscale, hgt, hgt * wscale);
      M.compose(V.set(x, y, z), Q, SC);
      trunk.setMatrixAt(k, M);
      fol.setMatrixAt(k, M);
      const v = 0.82 + r * 0.32;
      col.setRGB(v * (sp === 'birch' ? 0.95 + r * 0.1 : 1), v, v * (0.9 + r * 0.15));
      fol.setColorAt(k, col);
    }
    trunk.instanceMatrix.needsUpdate = true;
    fol.instanceMatrix.needsUpdate = true;
    if (fol.instanceColor) fol.instanceColor.needsUpdate = true;
    for (const m of [trunk, fol]) {
      m.castShadow = lod === 0;
      m.receiveShadow = lod === 0;
      m.matrixAutoUpdate = false;
      m.computeBoundingSphere();
      group.add(m);
    }
  }
  result.group = group;
  result.colliders = colliders;
  result.count = count;
}

export function indexParks(world) {
  world.parkChunkIndex = new Map();
  for (const p of world.parks) {
    let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (const q of p.poly) { xmin = Math.min(xmin, q[0]); xmax = Math.max(xmax, q[0]); zmin = Math.min(zmin, q[1]); zmax = Math.max(zmax, q[1]); }
    for (let cx = Math.floor(xmin / CHUNK); cx <= Math.floor(xmax / CHUNK); cx++)
      for (let cz = Math.floor(zmin / CHUNK); cz <= Math.floor(zmax / CHUNK); cz++) {
        const k = cx * 100003 + cz;
        let l = world.parkChunkIndex.get(k); if (!l) { l = []; world.parkChunkIndex.set(k, l); }
        l.push(p);
      }
  }
}
