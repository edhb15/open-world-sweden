/* =====================================================================
   Buildings, parking lots, petrol stations and other POI structures,
   generated per chunk and merged by material.
   ===================================================================== */
import * as THREE from 'three';
import { RNG, hashStr, lerp, clamp } from '../core/math.js';
import { CHUNK } from '../world/terrain.js';
import { facadeTexture, facadeLightTexture, roofTexture, textTexture, roundRect, concreteTexture, asphaltTexture } from './textures.js';
import { envUniforms } from './terrainmesh.js';

/* ------------------------------ Materials ------------------------------ */
const MATS = {};
export const buildingEmissive = { value: 0 };
function tintShader(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNightLights = buildingEmissive;
    sh.uniforms.uSnow = envUniforms.uSnow;
    sh.uniforms.uMask = { value: m.userData.mask || null };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTint;\nvarying vec3 vTint;\nvarying float vUp;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTint = aTint;\nvUp = normal.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nvarying float vUp;\nuniform float uNightLights;\nuniform float uSnow;\n' + (m.userData.mask ? 'uniform sampler2D uMask;' : ''))
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  ${m.userData.mask ? 'diffuseColor.rgb *= mix(vec3(1.0), vTint, texture2D(uMask, vMapUv).r);' : 'diffuseColor.rgb *= vTint;'}
  diffuseColor.a = opacity;
#else
  diffuseColor.rgb *= vTint;
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.96), uSnow * smoothstep(0.35, 0.8, vUp));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance *= uNightLights;`);
  };
  return m;
}
export function buildingMaterial(key) {
  if (MATS[key]) return MATS[key];
  let m;
  if (key.startsWith('wall_')) {
    const style = key.slice(5);
    const ft = facadeTexture(style);
    m = new THREE.MeshStandardMaterial({ map: ft, roughness: style === 'glass' ? 0.25 : 0.88, metalness: style === 'glass' ? 0.3 : 0,
      emissiveMap: facadeLightTexture(style), emissive: 0xffffff, emissiveIntensity: 1.25 });
    m.userData.mask = ft.userData.mask;
  } else if (key === 'roof_tile') m = new THREE.MeshStandardMaterial({ map: roofTexture('tile'), roughness: 0.8, side: THREE.DoubleSide });
  else if (key === 'roof_sheet') m = new THREE.MeshStandardMaterial({ map: roofTexture('sheet'), roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
  else if (key === 'roof_flat') m = new THREE.MeshStandardMaterial({ map: roofTexture('flat'), roughness: 0.95 });
  else if (key === 'trim') m = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  else if (key === 'plain') m = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  else if (key === 'metal') m = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.7 });
  else if (key === 'glass') m = new THREE.MeshStandardMaterial({ color: 0x334452, roughness: 0.08, metalness: 0.4 });
  else if (key === 'lot') m = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  else if (key === 'paint') m = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  else if (key === 'glow') m = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 1.0, roughness: 0.4 });
  else if (key.startsWith('sign_')) {
    m = new THREE.MeshStandardMaterial({ map: brandTexture(key.slice(5)), roughness: 0.5, emissive: 0xffffff, emissiveMap: brandTexture(key.slice(5)), emissiveIntensity: 0.6, side: THREE.DoubleSide });
    MATS[key] = m;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNightLights = buildingEmissive;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNightLights;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.15 + uNightLights;');
    };
    return m;
  }
  if (!m) m = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  tintShader(m);
  MATS[key] = m;
  return m;
}

const BRANDS = {
  'MATKÖP': { bg: '#c8102e', fg: '#ffffff' },
  'LIVS': { bg: '#1f5f3a', fg: '#ffffff' },
  'BILHALLEN': { bg: '#0d2d5c', fg: '#ffffff' },
  'POLAR': { bg: '#0b6e6e', fg: '#ffffff' },
  'RASTPLATS': { bg: '#1a4fa0', fg: '#ffffff' },
};
function brandTexture(name) {
  const b = BRANDS[name] || { bg: '#333', fg: '#fff' };
  return textTexture('brand_' + name, 512, 128, (ctx, w, h) => {
    ctx.fillStyle = b.bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = b.fg; ctx.font = 'bold 84px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2 + 4);
  });
}

/* ------------------------------ Geometry ------------------------------ */
class Bk {
  constructor() { this.p = []; this.n = []; this.uv = []; this.t = []; this.i = []; }
  vert(x, y, z, nx, ny, nz, u, v, tint) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v); this.t.push(tint[0], tint[1], tint[2]); return this.p.length / 3 - 1; }
  // quad with explicit corners (counter-clockwise when viewed from the outside)
  quad(a, b, c, d, uvs, tint) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const i0 = this.vert(...a, nx, ny, nz, uvs[0], uvs[1], tint);
    const i1 = this.vert(...b, nx, ny, nz, uvs[2], uvs[3], tint);
    const i2 = this.vert(...c, nx, ny, nz, uvs[4], uvs[5], tint);
    const i3 = this.vert(...d, nx, ny, nz, uvs[6], uvs[7], tint);
    this.i.push(i0, i1, i2, i0, i2, i3);
  }
  tri(a, b, c, uvs, tint) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const i0 = this.vert(...a, nx, ny, nz, uvs[0], uvs[1], tint);
    const i1 = this.vert(...b, nx, ny, nz, uvs[2], uvs[3], tint);
    const i2 = this.vert(...c, nx, ny, nz, uvs[4], uvs[5], tint);
    this.i.push(i0, i1, i2);
  }
  geometry() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.t, 3));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    return g;
  }
}
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }; // THREE.Color(hex) converts sRGB -> linear
const WHITE = [1, 1, 1];

// Box (walls + top) in local frame: centre (x,z), half sizes hw (along dir u), hd (along v), y0..y1
function prism(bk, x, z, rot, hw, hd, y0, y1, tint, uvScale = [4, 4], top = true, sides = true) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (a, b) => [x + a * c - b * s, z + a * s + b * c];
  const C = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)];
  if (sides) for (let k = 0; k < 4; k++) {
    const a = C[k], b = C[(k + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // outward winding: corners go CCW in (x,z) as seen from above with these signs -> walls face out
    bk.quad([a[0], y0, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]], [b[0], y0, b[1]], [0, 0, 0, (y1 - y0) / uvScale[1], L / uvScale[0], (y1 - y0) / uvScale[1], L / uvScale[0], 0], tint);
  }
  if (top) bk.quad([C[0][0], y1, C[0][1]], [C[3][0], y1, C[3][1]], [C[2][0], y1, C[2][1]], [C[1][0], y1, C[1][1]], [0, 0, 0, hd / 2, hw / 2, hd / 2, hw / 2, 0], tint);
  return C;
}

/* One building. g = ground height function. */
function building(B, l, ground, x0, z0) {
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  const hw = l.w / 2, hd = l.d / 2;
  const P = (a, b) => [l.x + a * c - b * s, l.z + a * s + b * c];
  const corners = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)];
  let gmin = Infinity, gmax = -Infinity;
  for (const p of corners) { const h = ground(p[0], p[1]); gmin = Math.min(gmin, h); gmax = Math.max(gmax, h); }
  const h0 = ground(l.x, l.z);
  gmin = Math.min(gmin, h0); gmax = Math.max(gmax, h0);
  const base = gmin - 0.6;
  const floor0 = gmax + (l.kind === 'house' || l.kind === 'barn' ? 0.45 : 0.15);
  const floors = l.floors || 1;
  const fh = l.floorH || 3;
  const top = floor0 + floors * fh;
  const style = l.style || 'plaster';
  const tint = lin(l.color || 0xdddddd);
  const wall = B('wall_' + style);
  const texFloors = style === 'falu' || style === 'wood' || style === 'shop' ? 2 : 4;
  const texBays = style === 'metal' ? 8 : 4;
  const bayW = style === 'metal' ? 1.5 : style === 'old' ? 2.4 : 3;
  const uOff = (hashStr(l.x.toFixed(1) + l.z.toFixed(1)) % 97) * 0.25 * bayW;
  // walls with facade UVs in metres
  const lc = corners.map((p) => [p[0] - x0, p[1] - z0]);
  for (let k = 0; k < 4; k++) {
    const a = lc[k], b = lc[(k + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u0 = uOff / (bayW * texBays), u1 = (uOff + L) / (bayW * texBays);
    // v: texture rows are floors (top of texture = top floor). ground floor starts at floor0
    const vb = (base - floor0) / (fh * texFloors), vt = (top - floor0) / (fh * texFloors);
    wall.quad([a[0], base, a[1]], [a[0], top, a[1]], [b[0], top, b[1]], [b[0], base, b[1]], [u0, vb, u0, vt, u1, vt, u1, vb], tint);
  }
  const roofTint = lin(l.roofColor || 0x444444);
  const lx = l.x - x0, lz = l.z - z0;
  const roof = l.roof || 'flat';
  if (roof === 'flat') {
    prism(B('roof_flat'), lx, lz, l.rot, hw - 0.01, hd - 0.01, top, top + 0.02, [0.55, 0.55, 0.55], [4, 4], true, false);
    // parapet
    const pt = B('plain');
    for (const [a, b, ww, dd] of [[0, hd - 0.2, hw, 0.2], [0, -hd + 0.2, hw, 0.2], [hw - 0.2, 0, 0.2, hd], [-hw + 0.2, 0, 0.2, hd]]) {
      prism(pt, lx + a * c - b * s, lz + a * s + b * c, l.rot, ww, dd, top, top + 0.6, lin(0x9a9a96));
    }
    if (l.floors >= 3 && (hashStr(l.x + 'r') % 3 === 0)) prism(B('plain'), lx + 2, lz - 1, l.rot, 2, 1.6, top, top + 2.2, lin(0x8f8f8a));
  } else if (roof === 'gable' || roof === 'low') {
    const pitch = roof === 'low' ? 0.18 : l.kind === 'barn' ? 0.62 : 0.78; // rise per run
    const ov = roof === 'low' ? 0.3 : 0.45;
    const rh = hd * pitch;
    const rt = B(roof === 'low' ? 'roof_sheet' : 'roof_tile');
    // ridge along the long side (w)
    const Pl = (a, b) => [lx + a * c - b * s, lz + a * s + b * c];
    const e0 = Pl(-hw - ov, -hd - ov), e1 = Pl(hw + ov, -hd - ov), e2 = Pl(hw + ov, hd + ov), e3 = Pl(-hw - ov, hd + ov);
    const r0 = Pl(-hw - ov, 0), r1 = Pl(hw + ov, 0);
    const yE = top - ov * pitch, yR = top + rh;
    const sl = Math.hypot(hd + ov, rh + ov * pitch) / 2.5;
    rt.quad([e0[0], yE, e0[1]], [r0[0], yR, r0[1]], [r1[0], yR, r1[1]], [e1[0], yE, e1[1]], [0, 0, 0, sl, (l.w + 2 * ov) / 2.5, sl, (l.w + 2 * ov) / 2.5, 0], roofTint);
    rt.quad([e2[0], yE, e2[1]], [r1[0], yR, r1[1]], [r0[0], yR, r0[1]], [e3[0], yE, e3[1]], [0, 0, 0, sl, (l.w + 2 * ov) / 2.5, sl, (l.w + 2 * ov) / 2.5, 0], roofTint);
    // gable triangles (wall material)
    const g0 = Pl(-hw, -hd), g1 = Pl(-hw, hd), g2 = Pl(hw, -hd), g3 = Pl(hw, hd), m0 = Pl(-hw, 0), m1 = Pl(hw, 0);
    const vt = (top - floor0) / (fh * texFloors), vr = (yR - floor0) / (fh * texFloors);
    const uw = l.d / (bayW * texBays);
    wall.tri([g1[0], top, g1[1]], [m0[0], yR, m0[1]], [g0[0], top, g0[1]], [0, vt, uw / 2, vr, uw, vt], tint);
    wall.tri([g2[0], top, g2[1]], [m1[0], yR, m1[1]], [g3[0], top, g3[1]], [0, vt, uw / 2, vr, uw, vt], tint);
    // chimney & white corner boards on wooden houses
    if (l.kind === 'house') {
      const ch = Pl(hw * 0.35, -hd * 0.15);
      prism(B('plain'), ch[0], ch[1], l.rot, 0.35, 0.35, top + rh * 0.5, yR + 0.8, lin(l.style === 'falu' ? 0x7a3a2c : 0x6d6d6d));
    }
    if (l.style === 'falu' || l.style === 'wood') {
      const tr = B('trim');
      for (const [a, b] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
        const q = Pl(a, b);
        prism(tr, q[0], q[1], l.rot, 0.09, 0.09, base + 0.3, top, WHITE, [4, 4], false);
      }
      // white fascia boards along eaves
      for (const b of [-hd - ov, hd + ov]) {
        const q = Pl(0, b);
        prism(tr, q[0], q[1], l.rot, hw + ov, 0.05, yE - 0.18, yE, WHITE, [4, 4], false);
      }
    }
  } else if (roof === 'mansard') {
    const rt = B('roof_tile');
    const ins = 1.6, rh = 2.9;
    const Pl = (a, b) => [lx + a * c - b * s, lz + a * s + b * c];
    const o = [Pl(-hw, -hd), Pl(hw, -hd), Pl(hw, hd), Pl(-hw, hd)];
    const iw = Math.max(0.5, hw - ins * 0.4), id = Math.max(0.5, hd - ins);
    const i = [Pl(-iw, -id), Pl(iw, -id), Pl(iw, id), Pl(-iw, id)];
    for (let k = 0; k < 4; k++) {
      const a = o[k], b = o[(k + 1) % 4], ia = i[k], ib = i[(k + 1) % 4];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.5;
      rt.quad([a[0], top, a[1]], [ia[0], top + rh, ia[1]], [ib[0], top + rh, ib[1]], [b[0], top, b[1]], [0, 0, 0, 1.2, L, 1.2, L, 0], roofTint);
    }
    rt.quad([i[0][0], top + rh, i[0][1]], [i[3][0], top + rh, i[3][1]], [i[2][0], top + rh, i[2][1]], [i[1][0], top + rh, i[1][1]], [0, 0, 0, 1, 1, 1, 1, 0], roofTint);
    // dormers
    const dormers = Math.floor(l.w / 7);
    for (let k = 0; k < dormers; k++) {
      const a = -hw + (k + 0.5) * (l.w / dormers);
      const q = Pl(a, (l.fz != null ? -1 : -1) * (hd - 0.9));
      prism(B('plain'), q[0], q[1], l.rot, 0.8, 0.6, top + 0.8, top + 2.2, lin(0xe7e1d2));
    }
  }
  // shop / brand sign
  if (l.brand) {
    const fn = [-s, c]; // local +b direction
    let side = 1;
    if (l.fx != null) side = (l.fx * -fn[0] + l.fz * -fn[1]) > 0 ? -1 : 1;
    const q = [lx - fn[0] * side * (hd + 0.06), lz - fn[1] * side * (hd + 0.06)];
    const sw = Math.min(l.w * 0.6, 12), sh = sw / 4;
    const y = top - sh - 0.4;
    const a = [q[0] - c * sw / 2, q[1] - s * sw / 2], b = [q[0] + c * sw / 2, q[1] + s * sw / 2];
    const sg = B('sign_' + l.brand);
    if (side > 0) sg.quad([b[0], y, b[1]], [b[0], y + sh, b[1]], [a[0], y + sh, a[1]], [a[0], y, a[1]], [0, 0, 0, 1, 1, 1, 1, 0], WHITE);
    else sg.quad([a[0], y, a[1]], [a[0], y + sh, a[1]], [b[0], y + sh, b[1]], [b[0], y, b[1]], [0, 0, 0, 1, 1, 1, 1, 0], WHITE);
  }
  if (l.garage) {
    const q = [l.x + c * (hw + 3.6) - x0, l.z + s * (hw + 3.6) - z0];
    const g2 = ground(q[0] + x0, q[1] + z0);
    prism(B('wall_wood'), q[0], q[1], l.rot, 2.8, 3.2, g2 - 0.4, g2 + 2.5, lin(0xe9e4d8));
    prism(B('roof_flat'), q[0], q[1], l.rot, 3.0, 3.4, g2 + 2.5, g2 + 2.6, lin(0x555555));
  }
  return { base, top, corners };
}

/* ------------------------------ Parking ------------------------------ */
function parkingLot(B, p, ground, x0, z0, carSpots) {
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  const hw = p.w / 2, hd = p.d / 2;
  const P = (a, b) => [p.x + a * c - b * s, p.z + a * s + b * c];
  const h = ground(p.x, p.z);
  const lot = B('lot');
  const C = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)].map((q) => [q[0] - x0, Math.max(h, ground(q[0], q[1])) + 0.06, q[1] - z0]);
  lot.quad(C[0], C[3], C[2], C[1], [0, 0, 0, p.d / 4, p.w / 4, p.d / 4, p.w / 4, 0], WHITE);
  // space markings & cars
  const paint = B('paint');
  const rows = p.d > 30 ? [[-hd + 2.6, 1], [hd - 2.6, -1], [-1.2, -1], [1.2, 1]] : [[-hd + 2.6, 1], [hd - 2.6, -1]];
  const rng = new RNG(hashStr('pk' + p.x + p.z));
  for (const [b0, dir] of rows) {
    for (let a = -hw + 1.25; a < hw - 1.25; a += 2.5) {
      const q0 = P(a - 1.25, b0 - 2.6 * dir * 0 - 2.5), q1 = P(a - 1.25, b0 + 2.5);
      const yy = h + 0.075;
      const w = 0.06;
      const ql = [q0, q1].map((q) => [q[0] - x0, yy, q[1] - z0]);
      const nx = c * w, nz = s * w;
      paint.quad([ql[0][0] - nx, yy, ql[0][2] - nz], [ql[1][0] - nx, yy, ql[1][2] - nz], [ql[1][0] + nx, yy, ql[1][2] + nz], [ql[0][0] + nx, yy, ql[0][2] + nz], [0, 0, 0, 1, 1, 1, 1, 0], WHITE);
      if (rng.chance(p.cars ?? 0.5)) {
        const q = P(a, b0);
        carSpots.push({ x: q[0], z: q[1], y: h + 0.06, rot: p.rot + (dir > 0 ? Math.PI / 2 : -Math.PI / 2) + rng.float(-0.05, 0.05), seed: rng.int(0, 1e6), truck: p.trucks && rng.chance(0.25), showroom: p.showroom });
      }
    }
  }
}

/* --------------------------- Petrol station --------------------------- */
function petrolStation(B, poi, ground, x0, z0, colliders) {
  const c = Math.cos(poi.rot), s = Math.sin(poi.rot);
  const P = (a, b) => [poi.x + a * c - b * s - x0, poi.z + a * s + b * c - z0];
  const h = ground(poi.x, poi.z);
  // forecourt
  const lot = B('lot');
  const hw = 18, hd = 13;
  const C = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)].map((q) => [q[0], h + 0.07, q[1]]);
  lot.quad(C[0], C[3], C[2], C[1], [0, 0, 0, 6, 9, 6, 9, 0], WHITE);
  // canopy on pillars
  const teal = lin(0x0b6e6e);
  for (const [a, b] of [[-8, -3.5], [8, -3.5], [-8, 3.5], [8, 3.5]]) { const q = P(a, b); prism(B('plain'), q[0], q[1], poi.rot, 0.25, 0.25, h, h + 5, lin(0xdedede)); colliders.push({ type: 'circle', x: q[0] + x0, z: q[1] + z0, r: 0.35, y0: h, y1: h + 5 }); }
  const q0 = P(0, 0);
  prism(B('plain'), q0[0], q0[1], poi.rot, 11, 5.5, h + 5, h + 5.9, WHITE);
  prism(B('plain'), q0[0], q0[1], poi.rot, 11.05, 5.55, h + 5.25, h + 5.65, teal, [4, 4], false);
  prism(B('glow'), q0[0], q0[1], poi.rot, 10.5, 5, h + 4.96, h + 5.0, WHITE, [4, 4], true, false);
  // pumps
  for (const a of [-4, 4]) for (const b of [-3.5, 3.5]) {
    const q = P(a, b);
    prism(B('plain'), q[0], q[1], poi.rot, 0.45, 0.3, h, h + 1.8, lin(0xe8e8e8));
    prism(B('plain'), q[0], q[1], poi.rot, 0.47, 0.32, h + 1.5, h + 1.8, teal, [4, 4], false);
    colliders.push({ type: 'obb', x: q[0] + x0, z: q[1] + z0, hw: 0.5, hd: 0.35, rot: poi.rot, y0: h, y1: h + 1.8 });
  }
  // shop
  const sq = P(0, 10.5);
  building(B, { x: sq[0] + x0, z: sq[1] + z0, w: 16, d: 8, rot: poi.rot, floors: 1, floorH: 4, color: 0xf0f0ec, style: 'shop', roof: 'flat', brand: 'POLAR', fx: -s * -1, fz: c * -1 }, ground, x0, z0);
  colliders.push({ type: 'obb', x: sq[0] + x0, z: sq[1] + z0, hw: 8, hd: 4, rot: poi.rot, y0: h, y1: h + 4 });
  // price pylon
  const pq = P(-15, -10);
  prism(B('plain'), pq[0], pq[1], poi.rot, 0.9, 0.25, h, h + 6.5, teal);
  const sg = B('sign_POLAR');
  const a = [pq[0] - c * 0.9, pq[1] - s * 0.9], b2 = [pq[0] + c * 0.9, pq[1] + s * 0.9];
  for (const off of [-0.27, 0.27]) {
    const ox = -s * off, oz = c * off;
    if (off < 0) sg.quad([b2[0] + ox, h + 5, b2[1] + oz], [b2[0] + ox, h + 6.2, b2[1] + oz], [a[0] + ox, h + 6.2, a[1] + oz], [a[0] + ox, h + 5, a[1] + oz], [0, 0, 0, 1, 1, 1, 1, 0], WHITE);
    else sg.quad([a[0] + ox, h + 5, a[1] + oz], [a[0] + ox, h + 6.2, a[1] + oz], [b2[0] + ox, h + 6.2, b2[1] + oz], [b2[0] + ox, h + 5, b2[1] + oz], [0, 0, 0, 1, 1, 1, 1, 0], WHITE);
  }
  colliders.push({ type: 'circle', x: pq[0] + x0, z: pq[1] + z0, r: 0.6, y0: h, y1: h + 6.5 });
}

function restArea(B, poi, ground, x0, z0, colliders) {
  const c = Math.cos(poi.rot), s = Math.sin(poi.rot);
  const P = (a, b) => [poi.x + a * c - b * s - x0, poi.z + a * s + b * c - z0];
  const h = ground(poi.x, poi.z);
  const q = P(30, 14);
  building(B, { x: q[0] + x0, z: q[1] + z0, w: 7, d: 4.5, rot: poi.rot, floors: 1, floorH: 2.8, color: 0x8e2a1f, style: 'falu', roof: 'gable', roofColor: 0x333333 }, ground, x0, z0);
  colliders.push({ type: 'obb', x: q[0] + x0, z: q[1] + z0, hw: 3.5, hd: 2.3, rot: poi.rot, y0: h, y1: h + 3 });
  // picnic tables
  for (const a of [-25, -15, 15]) {
    const t = P(a, 16);
    const g = ground(t[0] + x0, t[1] + z0);
    prism(B('plain'), t[0], t[1], poi.rot, 1.0, 0.4, g + 0.7, g + 0.78, lin(0x7a5a3a));
    prism(B('plain'), t[0], t[1] + 0.0, poi.rot, 1.0, 0.15, g, g + 0.7, lin(0x6a4a2a));
  }
}

/* ------------------------------ Chunk job ------------------------------ */
export function* buildingChunkJob(world, cx, cz, lod, result) {
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const buckets = new Map();
  const B = (k) => { let b = buckets.get(k); if (!b) { b = new Bk(); buckets.set(k, b); } return b; };
  const ground = (x, z) => world.terrain.height(x, z);
  const colliders = [];
  const carSpots = [];
  const idx = world.lotIndex.get(cx * 100003 + cz) || [];
  let n = 0;
  for (const l of idx) {
    if (lod > 0 && l.kind === 'house' && (n % 2)) { n++; continue; }
    const r = building(B, l, ground, x0, z0);
    colliders.push({ type: 'obb', x: l.x, z: l.z, hw: l.w / 2, hd: l.d / 2, rot: l.rot, y0: r.base, y1: r.top, bld: true });
    if (++n % 12 === 0) yield;
  }
  const pk = world.parkIndex.get(cx * 100003 + cz) || [];
  for (const p of pk) parkingLot(B, p, ground, x0, z0, carSpots);
  const pois = world.poiIndex.get(cx * 100003 + cz) || [];
  for (const p of pois) {
    if (p.type === 'petrol') petrolStation(B, p, ground, x0, z0, colliders);
    if (p.type === 'rest') restArea(B, p, ground, x0, z0, colliders);
  }
  yield;
  const group = new THREE.Group();
  for (const [k, b] of buckets) {
    const g = b.geometry();
    if (!g) continue;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, buildingMaterial(k));
    m.castShadow = lod === 0 && k !== 'lot' && k !== 'paint' && k !== 'glow';
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  result.group = group;
  result.colliders = colliders;
  result.carSpots = carSpots;
}

// Index lots/parkings/pois per chunk once.
export function indexWorldContent(world) {
  const add = (map, x, z, v) => {
    const k = Math.floor(x / CHUNK) * 100003 + Math.floor(z / CHUNK);
    let l = map.get(k); if (!l) { l = []; map.set(k, l); } l.push(v);
  };
  world.lotIndex = new Map(); world.parkIndex = new Map(); world.poiIndex = new Map();
  for (const l of world.lots) add(world.lotIndex, l.x, l.z, l);
  for (const p of world.parkings) add(world.parkIndex, p.x, p.z, p);
  for (const p of world.pois) add(world.poiIndex, p.x, p.z, p);
}
export { prism, Bk, lin };
