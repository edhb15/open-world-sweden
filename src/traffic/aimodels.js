/* =====================================================================
   AI-only vehicles with hand-built geometry: motorcycle, tractor and a
   snow plough truck (orange, with a plough blade and beacons).
   ===================================================================== */
import * as THREE from 'three';
import { VEHICLE } from '../vehicle/specs.js';
import { instancedParts } from '../vehicle/carmesh.js';

function colored(g, c, light = -1) {
  g = g.index ? g.toNonIndexed() : g;
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const C = new THREE.Color(c);
  for (let i = 0; i < n; i++) { col[i * 3] = C.r; col[i * 3 + 1] = C.g; col[i * 3 + 2] = C.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (light >= 0) g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(n).fill(light), 1));
  return g;
}
function box(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; }
function merge(list, light = false) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), lig = light ? new Float32Array(n) : null;
  let o = 0;
  for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); if (lig) lig.set(g.attributes.aLight.array, o); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (lig) out.setAttribute('aLight', new THREE.BufferAttribute(lig, 1));
  out.computeBoundingSphere();
  return out;
}
function wheelGeo(r, w) {
  const t = new THREE.CylinderGeometry(r, r, w, 16); t.rotateZ(Math.PI / 2);
  const h = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.05, 10); h.rotateZ(Math.PI / 2);
  return merge([colored(t, 0x151515), colored(h, 0x9a9da0)]);
}

let cache = null;
export function extraSpecs() {
  if (cache) return cache;
  // motorcycle
  const mcg = 0.55;
  const moto = {
    id: 'moto', cls: 'moto', body: { L: 2.15, W: 0.8, H: 1.45, wb: 1.45, trackF: 0, trackR: 0, clearance: 0.15 }, mass: 280, cgH: mcg, tire: { r: 0.31, w: 0.14 }, colors: [0xc0141c],
  };
  const y = (v) => v - mcg;
  moto.parts = {
    body: merge([colored(box(0.32, 0.22, 0.6, 0, y(0.95), -0.1), 0xffffff), colored(box(0.42, 0.4, 0.3, 0, y(1.0), -0.62), 0xffffff)]),
    dark: merge([
      colored(box(0.12, 0.35, 1.3, 0, y(0.62), 0), 0x2a2a2a), colored(box(0.3, 0.1, 0.55, 0, y(0.9), 0.32), 0x111111),
      // rider
      colored(box(0.38, 0.55, 0.3, 0, y(1.3), 0.22), 0x1d2633), colored(new THREE.SphereGeometry(0.15, 10, 8).translate(0, y(1.68), 0.12), 0x222222),
      colored(box(0.14, 0.45, 0.14, -0.16, y(0.85), 0.05), 0x1d2633), colored(box(0.14, 0.45, 0.14, 0.16, y(0.85), 0.05), 0x1d2633),
      colored(box(0.1, 0.1, 0.45, -0.2, y(1.25), -0.15), 0x1d2633), colored(box(0.1, 0.1, 0.45, 0.2, y(1.25), -0.15), 0x1d2633),
    ]),
    wheel: wheelGeo(0.31, 0.14),
    lights: merge([colored(box(0.16, 0.12, 0.04, 0, y(1.05), -0.79), 0xffffff, 0), colored(box(0.14, 0.06, 0.04, 0, y(0.95), 0.62), 0xffffff, 1), colored(box(0.12, 0.05, 0.045, 0, y(0.9), 0.62), 0xffffff, 2)], true),
    wheelPos: [[0, -0.72, false], [0, -0.72, false], [0, 0.72, false], [0, 0.72, false]],
  };
  moto.tire = { r: 0.31, w: 0.14 };
  // tractor
  const tcg = 1.0;
  const ty = (v) => v - tcg;
  const tractor = {
    id: 'tractor', cls: 'tractor', body: { L: 4.2, W: 2.2, H: 2.9, wb: 2.4, trackF: 1.8, trackR: 1.9, clearance: 0.5 }, mass: 5200, cgH: tcg, tire: { r: 0.8, w: 0.45 }, colors: [0x2b7a3b],
  };
  tractor.parts = {
    body: merge([colored(box(1.0, 0.9, 2.0, 0, ty(1.35), -1.0), 0xffffff), colored(box(1.9, 0.12, 1.6, 0, ty(2.85), 0.5), 0xffffff), colored(box(2.0, 0.4, 0.9, 0, ty(1.5), 0.5), 0xffffff)]),
    dark: merge([colored(box(1.6, 1.2, 1.4, 0, ty(2.2), 0.5), 0x2e3a40), colored(box(0.6, 0.6, 1.8, 0, ty(0.9), -0.3), 0x222222), colored(box(0.08, 0.6, 0.08, 0.3, ty(2.4), -1.6), 0x222222)]),
    wheel: wheelGeo(0.55, 0.35),
    lights: merge([colored(box(0.2, 0.12, 0.04, -0.35, ty(1.6), -2.02), 0xffffff, 0), colored(box(0.2, 0.12, 0.04, 0.35, ty(1.6), -2.02), 0xffffff, 0), colored(box(0.15, 0.1, 0.04, -0.85, ty(1.4), 0.98), 0xffffff, 1), colored(box(0.15, 0.1, 0.04, 0.85, ty(1.4), 0.98), 0xffffff, 1), colored(box(0.15, 0.1, 0.045, -0.85, ty(1.3), 0.98), 0xffffff, 3), colored(box(0.15, 0.1, 0.045, 0.85, ty(1.3), 0.98), 0xffffff, 4)], true),
    wheelPos: [[-0.85, -1.4, true], [0.85, -1.4, false], [-0.95, 0.6, true], [0.95, 0.6, false]],
  };
  // snow plough: the distribution truck with a blade and amber beacons
  const truck = VEHICLE.truck;
  const base = instancedParts(truck);
  const plough = { ...truck, id: 'plough', cls: 'plough', colors: [0xff8a00] };
  const blade = colored(box(3.2, 1.1, 0.25, 0, -truck.cgH + 0.65, -truck.body.L / 2 - 1.0), 0x3b3f44);
  blade.rotateY(0.35);
  const beacons = [colored(box(0.25, 0.2, 0.25, -0.8, -truck.cgH + 3.0, -truck.body.L / 2 + 0.9), 0xffffff, 3), colored(box(0.25, 0.2, 0.25, 0.8, -truck.cgH + 3.0, -truck.body.L / 2 + 0.9), 0xffffff, 4)];
  plough.parts = {
    body: base.body,
    dark: merge([toFlat(base.dark), blade]),
    wheel: base.wheel,
    lights: merge([toFlat(base.lights, true), ...beacons], true),
    wheelPos: base.wheelPos,
  };
  cache = { moto, tractor, plough };
  return cache;
}
function toFlat(g, light = false) { return g; }
