/* =====================================================================
   Terrain chunk meshes (time-sliced generators) and the terrain material
   with seasonal colouring, snow cover and wetness.
   ===================================================================== */
import * as THREE from 'three';
import { CHUNK } from '../world/terrain.js';
import { groundInfo } from './landcover.js';
import { grassDetailTexture } from './textures.js';

export const LOD_STEP = [2, 4, 8, 16, 32];

export const envUniforms = {
  uSnow: { value: 0 },      // snow cover 0..1
  uWet: { value: 0 },       // wetness 0..1
  uAutumn: { value: 0 },    // 0..1 autumn colours
  uSpring: { value: 0 },    // 0..1 spring freshness
  uTime: { value: 0 },
  uNight: { value: 0 },
  uWind: { value: 0.3 },
};

let terrainMat = null;
export function terrainMaterial() {
  if (terrainMat) return terrainMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, envUniforms, { uDetail: { value: grassDetailTexture() } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMask;\nvarying vec4 vMask;\nvarying vec2 vDUv;\nvarying vec3 vWN;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMask = aMask;\nvDUv = uv;\nvWN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSnow, uWet, uAutumn, uSpring, uTime;
uniform sampler2D uDetail;
varying vec4 vMask; varying vec2 vDUv; varying vec3 vWN;
float tHash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float det = texture2D(uDetail, vDUv * 0.25).r * 0.6 + texture2D(uDetail, vDUv * 0.031).r * 0.4;
  vec3 c = diffuseColor.rgb * (0.78 + 0.44 * det);
  float forest = vMask.x, field = vMask.y, rock = vMask.z, crop = vMask.w;
  float veg = (1.0 - rock);
  // autumn: grass turns straw & rust, fields harvested
  vec3 autumnGrass = c * vec3(1.32, 1.02, 0.62) + vec3(0.03, 0.0, 0.0);
  c = mix(c, autumnGrass, uAutumn * veg * (0.65 + 0.35 * det));
  c = mix(c, vec3(0.42, 0.33, 0.21) * (0.8 + 0.4 * det), uAutumn * field * 0.7);
  // spring: fresh light greens, ploughed fields, rapeseed yellow
  c = mix(c, c * vec3(1.05, 1.18, 0.92), uSpring * veg * (1.0 - field));
  vec3 springField = crop > 2.5 ? vec3(0.36, 0.27, 0.18) : crop > 1.5 ? vec3(0.86, 0.8, 0.2) : vec3(0.38, 0.52, 0.2);
  c = mix(c, springField * (0.85 + 0.3 * det), uSpring * field * 0.85);
  // wetness darkens
  c *= 1.0 - 0.28 * uWet;
  // snow: lies on flat ground, thinner under trees and on rock
  float flatG = smoothstep(0.55, 0.85, vWN.y);
  float cover = uSnow * flatG * (1.0 - 0.35 * forest) * (1.0 - 0.5 * rock * (1.0 - flatG));
  float patchy = smoothstep(0.25, 0.75, det + uSnow * 0.9 - 0.25);
  cover *= mix(patchy, 1.0, smoothstep(0.6, 1.0, uSnow));
  c = mix(c, vec3(0.86, 0.89, 0.94) * (0.92 + 0.12 * det), clamp(cover, 0.0, 1.0));
  diffuseColor.rgb = c;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.55, uWet * 0.6);`);
  };
  terrainMat = m;
  return m;
}

/* Generator: builds a terrain chunk geometry. Yields between rows.
   Result object gets {geometry, field (for lod 0)}. */
export function* terrainChunkJob(terrain, cx, cz, lod, result) {
  const step = LOD_STEP[lod];
  const N = CHUNK / step + 1;
  const NB = N + 2;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const H = new Float32Array(NB * NB);
  const WL = new Float32Array(NB * NB);
  const RW = new Float32Array(NB * NB);
  const sm = { level: 0, kind: 0, road: 0 };
  for (let j = 0; j < NB; j++) {
    const z = z0 + (j - 1) * step;
    for (let i = 0; i < NB; i++) {
      const x = x0 + (i - 1) * step;
      const h = terrain.sample(x, z, sm);
      H[j * NB + i] = h;
      WL[j * NB + i] = sm.level;
      RW[j * NB + i] = sm.road;
    }
    if (j % 6 === 5) yield;
  }
  const nV = N * N;
  const pos = new Float32Array((nV + 4 * N) * 3);
  const nor = new Float32Array((nV + 4 * N) * 3);
  const col = new Float32Array((nV + 4 * N) * 3);
  const msk = new Float32Array((nV + 4 * N) * 4);
  const uv = new Float32Array((nV + 4 * N) * 2);
  const gi = new Float32Array(7);
  const field = lod === 0 ? new Float32Array(nV) : null;
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const b = (j + 1) * NB + (i + 1);
      const h = H[b];
      if (field) field[k] = h;
      const x = i * step, z = j * step;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      minY = Math.min(minY, h); maxY = Math.max(maxY, h);
      const dx = H[b + 1] - H[b - 1], dz = H[b + NB] - H[b - NB];
      let nx = -dx, ny = 2 * step, nz = -dz;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
      const wl = WL[b] > -1e8 ? WL[b] : h < 2.0 ? 0 : -1e9;
      groundInfo(x0 + x, z0 + z, h, ny, wl, RW[b], gi);
      col[k * 3] = gi[0] * gi[0] * 0.92; col[k * 3 + 1] = gi[1] * gi[1] * 0.92; col[k * 3 + 2] = gi[2] * gi[2] * 0.92; // sRGB-ish -> linear
      msk[k * 4] = gi[3]; msk[k * 4 + 1] = gi[4]; msk[k * 4 + 2] = gi[5]; msk[k * 4 + 3] = gi[6];
      uv[k * 2] = (x0 % 4096 + x) / 4; uv[k * 2 + 1] = (z0 % 4096 + z) / 4;
    }
    if (j % 16 === 15) yield;
  }
  // skirts: duplicate edge vertices pushed down
  const skirt = step * 1.2 + 1.5;
  let v = nV;
  const edgeIdx = [];
  const addSkirt = (k) => {
    pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = pos[k * 3 + 1] - skirt; pos[v * 3 + 2] = pos[k * 3 + 2];
    nor[v * 3] = nor[k * 3]; nor[v * 3 + 1] = nor[k * 3 + 1]; nor[v * 3 + 2] = nor[k * 3 + 2];
    col[v * 3] = col[k * 3]; col[v * 3 + 1] = col[k * 3 + 1]; col[v * 3 + 2] = col[k * 3 + 2];
    for (let q = 0; q < 4; q++) msk[v * 4 + q] = msk[k * 4 + q];
    uv[v * 2] = uv[k * 2]; uv[v * 2 + 1] = uv[k * 2 + 1];
    return v++;
  };
  const sides = [[], [], [], []];
  for (let i = 0; i < N; i++) {
    sides[0].push([i, addSkirt(i)]); // z = 0
    sides[1].push([(N - 1) * N + i, addSkirt((N - 1) * N + i)]); // z = max
    sides[2].push([i * N, addSkirt(i * N)]); // x = 0
    sides[3].push([i * N + N - 1, addSkirt(i * N + N - 1)]); // x = max
  }
  const nTri = (N - 1) * (N - 1) * 2 + 4 * (N - 1) * 4;
  const idx = new (v > 65535 ? Uint32Array : Uint16Array)(nTri * 3);
  let t = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[t++] = a; idx[t++] = c; idx[t++] = b;
    idx[t++] = b; idx[t++] = c; idx[t++] = d;
  }
  for (let s = 0; s < 4; s++) {
    const L = sides[s];
    for (let i = 0; i < N - 1; i++) {
      const [a, as] = L[i], [b, bs] = L[i + 1];
      // both windings so the skirt is visible from either side
      idx[t++] = a; idx[t++] = as; idx[t++] = b;
      idx[t++] = b; idx[t++] = as; idx[t++] = bs;
      idx[t++] = a; idx[t++] = b; idx[t++] = as;
      idx[t++] = b; idx[t++] = bs; idx[t++] = as;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(msk.subarray(0, v * 4), 4));
  g.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
  g.setIndex(new THREE.BufferAttribute(idx.subarray(0, t), 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY - skirt, 0), new THREE.Vector3(CHUNK, maxY, CHUNK));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, (minY + maxY) / 2, CHUNK / 2), Math.hypot(CHUNK / 2, CHUNK / 2, (maxY - minY) / 2 + skirt));
  result.geometry = g;
  result.minY = minY; result.maxY = maxY;
  if (field) result.field = { H: field, N, step, x0, z0 };
  result.heights = H; result.NB = NB; result.step = step;
}
