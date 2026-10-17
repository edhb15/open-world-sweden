/* =====================================================================
   Procedural vehicle meshes. Body = extruded side profile with wheel
   arches + greenhouse with glass, lights, plates, mirrors, wheels.
   Local frame: forward = -z, right = +x, up = +y, origin at the CoM.
   ===================================================================== */
import * as THREE from 'three';
import { plateTexture } from '../render/textures.js';

const geoCache = new Map();

// Side profiles: arrays of [x (0 = front bumper .. L), y] for the lower body top line and greenhouse.
function profiles(spec) {
  const B = spec.body, L = B.L, H = B.H, cl = B.clearance;
  const s = B.shape;
  const P = {};
  // defaults (sedan)
  let hood = 0.72, belt = 0.86, deck = 0.88, nose = 0.55, tail = 0.62;
  let aBase = 0.27, rFront = 0.43, rRear = 0.72, cBase = 0.82, roof = H;
  if (s === 'wagon') { aBase = 0.27; rFront = 0.42; rRear = 0.93; cBase = 0.97; deck = 0.9; tail = 0.7; }
  if (s === 'brick') { hood = 0.78; belt = 0.88; aBase = 0.29; rFront = 0.41; rRear = 0.95; cBase = 0.985; deck = 0.92; tail = 0.84; nose = 0.66; }
  if (s === 'fastback') { aBase = 0.29; rFront = 0.45; rRear = 0.66; cBase = 0.94; deck = 0.86; tail = 0.72; }
  if (s === 'hatch') { aBase = 0.3; rFront = 0.47; rRear = 0.84; cBase = 0.96; deck = 0.9; tail = 0.75; }
  if (s === 'humpback') { hood = 0.78; belt = 0.88; nose = 0.66; aBase = 0.33; rFront = 0.46; rRear = 0.66; cBase = 0.93; deck = 0.82; tail = 0.62; }
  if (s === 'suv') { hood = 0.9; belt = 1.04; deck = 1.04; nose = 0.72; tail = 0.88; aBase = 0.28; rFront = 0.42; rRear = 0.93; cBase = 0.975; }
  if (s === 'ev') { hood = 0.7; belt = 0.86; nose = 0.5; aBase = 0.24; rFront = 0.42; rRear = 0.74; cBase = 0.92; deck = 0.86; tail = 0.68; }
  if (s === 'van') { hood = 1.05; belt = 1.12; nose = 0.8; aBase = 0.15; rFront = 0.25; rRear = 0.995; cBase = 0.998; deck = 1.1; tail = 1.0; }
  if (s === 'bus') { hood = 1.0; belt = 1.05; nose = 0.95; aBase = 0.005; rFront = 0.02; rRear = 0.995; cBase = 0.998; deck = 1.05; tail = 1.0; }
  if (s === 'truck') { hood = 1.3; belt = 1.45; nose = 1.0; aBase = 0.02; rFront = 0.06; rRear = 0.2; cBase = 0.21; deck = 1.45; tail = 1.2; }
  const y = (f) => cl + (H - cl) * (f / (s === 'bus' || s === 'van' || s === 'truck' ? 1.0 : 1.0)) * 0 + f;
  P.lower = { hood, belt, deck, nose, tail };
  P.green = { aBase: aBase * L, rFront: rFront * L, rRear: rRear * L, cBase: cBase * L, roof };
  return P;
}

function lowerShape(spec, P, arches) {
  const B = spec.body, L = B.L, cl = B.clearance;
  const { hood, belt, deck, nose, tail } = P.lower;
  const sh = new THREE.Shape();
  // start front bottom, go up the nose, along hood/belt/deck, down the tail, back along the bottom with arches
  sh.moveTo(0.06, cl + 0.08);
  sh.lineTo(0, nose * 0.55 + cl * 0.5);
  sh.quadraticCurveTo(0.0, nose, 0.12, nose + 0.03);
  sh.quadraticCurveTo(L * 0.12, hood, P.green.aBase * 0.9, hood);
  sh.lineTo(P.green.aBase, belt);
  sh.lineTo(P.green.cBase, belt);
  sh.quadraticCurveTo(L * 0.97, deck, L - 0.04, deck - 0.04);
  sh.lineTo(L, tail);
  sh.lineTo(L - 0.02, cl + 0.12);
  sh.lineTo(L - 0.12, cl);
  // bottom with wheel arches (right to left = rear to front)
  for (const a of arches.slice().reverse()) {
    const r = a.r + 0.06;
    sh.lineTo(a.x + r, cl);
    sh.absarc(a.x, a.y, r, 0, Math.PI, false);
  }
  sh.lineTo(0.16, cl);
  sh.lineTo(0.06, cl + 0.08);
  return sh;
}

function greenShape(spec, P) {
  const g = P.green, belt = P.lower.belt;
  const sh = new THREE.Shape();
  sh.moveTo(g.aBase, belt - 0.02);
  sh.lineTo(g.rFront, g.roof - 0.03);
  sh.quadraticCurveTo((g.rFront + g.rRear) / 2, g.roof + 0.02, g.rRear, g.roof - 0.03);
  sh.lineTo(g.cBase, belt - 0.02);
  sh.lineTo(g.aBase, belt - 0.02);
  return sh;
}

// Re-group an extruded geometry: side caps -> group A, walls facing up -> group B, other walls -> group C
function regroup(geo, upThreshold = 0.8) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const groupsIn = geo.groups;
  const n = pos.count / 3;
  const tri = [];
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3(), nrm = new THREE.Vector3();
  // non-indexed triangles keep their original order; map triangle -> original group
  const triGroup = new Array(n).fill(0);
  for (const gr of groupsIn) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) triGroup[t] = gr.materialIndex;
  for (let t = 0; t < n; t++) {
    pA.fromBufferAttribute(pos, t * 3); pB.fromBufferAttribute(pos, t * 3 + 1); pC.fromBufferAttribute(pos, t * 3 + 2);
    nrm.subVectors(pC, pB).cross(pA.clone().sub(pB)).normalize();
    let cls = triGroup[t] === 0 ? 0 : (Math.abs(nrm.y) > upThreshold ? 1 : 2);
    tri.push(cls);
  }
  // reorder triangles by class
  const order = [0, 1, 2];
  const attrs = Object.keys(g.attributes);
  const out = new THREE.BufferGeometry();
  for (const k of attrs) {
    const src = g.attributes[k];
    const arr = new Float32Array(src.array.length);
    let o = 0;
    for (const c of order) for (let t = 0; t < n; t++) if (tri[t] === c) { arr.set(src.array.subarray(t * 3 * src.itemSize, (t + 1) * 3 * src.itemSize), o); o += 3 * src.itemSize; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, src.itemSize));
  }
  let start = 0;
  for (const c of order) {
    const cnt = tri.filter((x) => x === c).length * 3;
    out.addGroup(start, cnt, c);
    start += cnt;
  }
  out.computeVertexNormals();
  return out;
}

export function carGeometry(spec, lite = false) {
  const ck = spec.id + (lite ? ':lite' : '');
  if (geoCache.has(ck)) return geoCache.get(ck);
  const B = spec.body;
  const P = profiles(spec);
  const overF = B.overF ?? (B.L - B.wb) * (B.shape === 'bus' ? 0.25 : B.shape === 'truck' ? 0.22 : B.shape === 'van' ? 0.45 : 0.53);
  const xF = overF, xR = overF + B.wb;
  const r = spec.tire.r;
  const W = B.W;
  const bev = Math.min(0.09, W * 0.05);
  const arches = [{ x: xF, y: r, r: r + bev }, { x: xR, y: r, r: r + bev }];
  // keep the wheel arches below the hood / deck line, otherwise the side
  // profile self-intersects and its triangulation drops whole panels
  const archTop = (a) => a.y + a.r + 0.06;
  const PL = P.lower;
  PL.hood = Math.max(PL.hood, archTop(arches[0]) + 0.05);
  PL.belt = Math.max(PL.belt, PL.hood);
  PL.deck = Math.max(PL.deck, archTop(arches[1]) + 0.05);
  const lowerSh = lowerShape(spec, P, arches);
  const lower = new THREE.ExtrudeGeometry(lowerSh, { depth: W - bev * 2, bevelEnabled: true, bevelSize: bev, bevelThickness: bev, bevelSegments: lite ? 1 : 3, curveSegments: lite ? 4 : 10 });
  lower.translate(0, 0, -(W - bev * 2) / 2);
  const tumble = B.shape === 'bus' || B.shape === 'van' || B.shape === 'truck' ? 0.98 : 0.84;
  const gw = W * tumble;
  const gb = 0.05;
  const green = new THREE.ExtrudeGeometry(greenShape(spec, P), { depth: gw - gb * 2, bevelEnabled: true, bevelSize: gb, bevelThickness: gb, bevelSegments: lite ? 1 : 2, curveSegments: lite ? 4 : 8 });
  green.translate(0, 0, -(gw - gb * 2) / 2);
  // shape x = 0 at the front -> local z: front at negative z
  const xCG = xF + B.wb * (1 - spec.weightF);
  const toLocal = (g) => {
    // shape (x, y, zExtrude) -> local (x = zExtrude, y = y - cgH, z = x - xCG)
    const m = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, -spec.cgH, 1, 0, 0, -xCG, 0, 0, 0, 1);
    g.applyMatrix4(m);
    return g;
  };
  toLocal(lower); toLocal(green);
  const greenG = regroup(green, 0.72);
  lower.computeBoundingBox();
  greenG.computeBoundingBox();
  // dark cabin volume behind the glass (so cars are not see-through)
  const gb2 = greenG.boundingBox;
  const cabin = green.clone();
  const cxm = (gb2.max.x + gb2.min.x) / 2, czm = (gb2.max.z + gb2.min.z) / 2;
  cabin.translate(-cxm, -gb2.min.y, -czm);
  cabin.scale(0.93, 0.93, 0.95);
  cabin.translate(cxm, gb2.min.y, czm);
  cabin.clearGroups();
  const res = { lower, green: greenG, cabin, P, xF, xR, xCG, overF, bb: lower.boundingBox, bev, lowerShapeDbg: lowerSh };
  geoCache.set(ck, res);
  return res;
}

/* ------------------------------ Materials ------------------------------ */
const matCache = new Map();
export function paintMaterial(color, metallic = true) {
  const k = color + ':' + metallic;
  if (matCache.has(k)) return matCache.get(k);
  const m = new THREE.MeshPhysicalMaterial({ color, metalness: metallic ? 0.35 : 0.05, roughness: metallic ? 0.36 : 0.45, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.8 });
  matCache.set(k, m);
  return m;
}
export const CAR_MATS = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1218, metalness: 0.2, roughness: 0.03, transparent: true, opacity: 0.78, clearcoat: 1, depthWrite: false }),
  cabin: new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.9 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 1, roughness: 0.15 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.85, roughness: 0.3 }),
  rimBlack: new THREE.MeshStandardMaterial({ color: 0x1b1d20, metalness: 0.6, roughness: 0.35 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8c9094, metalness: 0.7, roughness: 0.45 }),
  under: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 1 }),
};
function lightMat(color, base = 0.05) {
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: base, roughness: 0.25, metalness: 0.1 });
  return m;
}

/* ------------------------------ Vehicle ------------------------------ */
export class CarMesh {
  constructor(spec, opts = {}) {
    this.spec = spec;
    const color = opts.color ?? spec.colors[0];
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    const G = carGeometry(spec, !!opts.lite);
    this.G = G;
    const B = spec.body;
    const paint = paintMaterial(color, opts.metallic !== false && spec.cls !== 'bus' && spec.cls !== 'truck');
    this.paint = paint;
    const lower = new THREE.Mesh(G.lower, paint);
    lower.castShadow = true; lower.receiveShadow = true;
    this.body.add(lower);
    this.lowerMesh = lower;
    const green = new THREE.Mesh(G.green, [CAR_MATS.glass, paint, CAR_MATS.glass]);
    green.castShadow = true;
    this.body.add(green);
    this.greenMesh = green;
    const cabinMesh = new THREE.Mesh(G.cabin, CAR_MATS.cabin);
    this.body.add(cabinMesh);
    this.cabinMesh = cabinMesh;
    const y0 = -spec.cgH;
    const zf = G.bb.min.z + 0.02, zr = G.bb.max.z - 0.02; // actual front & rear surfaces
    const add = (geo, mat, x, y, z, cast = false) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; this.body.add(m); return m; };
    const L = G.P.lower;
    // bumpers & grille
    const bh = 0.16, bw = B.W * 0.96;
    add(new THREE.BoxGeometry(bw, bh, 0.16), spec.year < 1990 ? CAR_MATS.chrome : CAR_MATS.trim, 0, y0 + B.clearance + 0.22, zf + 0.03, true);
    add(new THREE.BoxGeometry(bw, bh, 0.16), spec.year < 1990 ? CAR_MATS.chrome : CAR_MATS.trim, 0, y0 + B.clearance + 0.24, zr - 0.03, true);
    if (spec.engine.type !== 'ev') add(new THREE.BoxGeometry(B.W * 0.5, L.nose * 0.28, 0.04), CAR_MATS.trim, 0, y0 + L.nose * 0.68, zf - 0.005);
    // lights
    const hlY = y0 + L.nose * 0.82, tlY = y0 + L.tail * 0.86;
    this.headMat = lightMat(0xfff6e0, 0.02);
    this.tailMat = lightMat(0xc4130f, 0.08);
    this.brakeMat = lightMat(0xff1a10, 0.0);
    this.indMatL = lightMat(0xff9a00, 0.0); this.indMatR = lightMat(0xff9a00, 0.0);
    this.revMat = lightMat(0xffffff, 0.0);
    const hw = B.W / 2 - 0.22;
    const hlGeo = new THREE.BoxGeometry(spec.year < 1970 ? 0.22 : 0.34, spec.year < 1990 ? 0.16 : 0.1, 0.06);
    for (const sx of [-1, 1]) {
      add(hlGeo, this.headMat, sx * hw, hlY, zf + 0.01);
      add(new THREE.BoxGeometry(0.1, 0.07, 0.05), sx < 0 ? this.indMatL : this.indMatR, sx * (B.W / 2 - 0.08), hlY - 0.1, zf + 0.02);
      add(new THREE.BoxGeometry(0.32, 0.14, 0.05), this.tailMat, sx * (B.W / 2 - 0.2), tlY, zr + 0.005);
      add(new THREE.BoxGeometry(0.14, 0.13, 0.055), this.brakeMat, sx * (B.W / 2 - 0.42), tlY, zr + 0.008);
      add(new THREE.BoxGeometry(0.1, 0.06, 0.055), sx < 0 ? this.indMatL : this.indMatR, sx * (B.W / 2 - 0.13), tlY - 0.1, zr + 0.008);
      add(new THREE.BoxGeometry(0.08, 0.05, 0.055), this.revMat, sx * (B.W / 2 - 0.55), tlY - 0.08, zr + 0.008);
      // side mirrors
      if (B.shape !== 'bus' && B.shape !== 'truck') {
        add(new THREE.BoxGeometry(0.2, 0.13, 0.09), paint, sx * (B.W / 2 + 0.07), y0 + L.belt + 0.08, -G.xCG + G.P.green.aBase + 0.18, true);
      } else {
        add(new THREE.BoxGeometry(0.06, 0.4, 0.2), CAR_MATS.trim, sx * (B.W / 2 + 0.2), y0 + L.belt + 0.4, zf + 0.3);
      }
    }
    // high mounted brake light
    if (B.shape !== 'truck' && B.shape !== 'bus') add(new THREE.BoxGeometry(0.4, 0.04, 0.04), this.brakeMat, 0, y0 + G.P.green.roof - 0.06, -G.xCG + G.P.green.cBase + 0.02);
    // B-pillar
    const midZ = -G.xCG + (G.P.green.aBase + G.P.green.cBase) / 2 - 0.1;
    if (B.shape !== 'bus') for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.03, G.P.green.roof - L.belt - 0.08, 0.1), CAR_MATS.trim, sx * B.W * 0.84 / 2 + sx * 0.005, y0 + (G.P.green.roof + L.belt) / 2, midZ);
    // roof rails for estates/SUV
    if (B.shape === 'wagon' || B.shape === 'suv' || B.shape === 'brick') for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.05, (G.P.green.rRear - G.P.green.rFront) * 0.95), CAR_MATS.trim, sx * B.W * 0.36, y0 + G.P.green.roof + 0.02, -G.xCG + (G.P.green.rRear + G.P.green.rFront) / 2);
    // license plates
    const plate = opts.plate || randomPlate(opts.seed || 1);
    this.plateText = plate;
    const pm = new THREE.MeshStandardMaterial({ map: plateTexture(plate), roughness: 0.4 });
    const pg = new THREE.PlaneGeometry(0.52, 0.11);
    const pf = add(pg, pm, 0, y0 + B.clearance + 0.32, zf - 0.07); pf.rotation.y = Math.PI;
    add(pg, pm, 0, y0 + L.tail * 0.62, zr + 0.012);
    // underside
    add(new THREE.BoxGeometry(B.W * 0.9, 0.05, B.L * 0.9), CAR_MATS.under, 0, y0 + B.clearance + 0.05, (zf + zr) / 2);
    // bus: route sign & big windows look (glass band is the greenhouse already)
    if (B.shape === 'truck') {
      // cargo box behind the cab
      const boxL = B.L - G.P.green.cBase - 0.4;
      const bx = add(new THREE.BoxGeometry(B.W, B.H - 1.0, boxL), new THREE.MeshStandardMaterial({ color: 0xe9e9e6, roughness: 0.7 }), 0, y0 + 1.0 + (B.H - 1.0) / 2, zr - boxL / 2, true);
      bx.receiveShadow = true;
    }
    // wheels
    this.wheels = [];
    const wheelStyle = opts.wheels || (spec.year < 1970 ? 'steel' : spec.year < 1995 ? 'steel' : 'alloy5');
    const wg = wheelGeometry(spec.tire.r, spec.tire.w, wheelStyle, !!opts.lite);
    const sides = [[true, true], [true, false], [false, true], [false, false]];
    for (let i = 0; i < 4; i++) {
      const [front, left] = sides[i];
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      pivot.add(spin);
      const tire = new THREE.Mesh(wg.tire, CAR_MATS.tire); tire.castShadow = true;
      const rim = new THREE.Mesh(wg.rim, wheelStyle === 'black' ? CAR_MATS.rimBlack : wheelStyle === 'steel' ? CAR_MATS.steel : CAR_MATS.rim);
      spin.add(tire, rim);
      if (left) spin.rotation.y = Math.PI;
      // twin rear wheels for heavy vehicles
      if (!front && (B.shape === 'truck' || B.shape === 'bus')) { const t2 = tire.clone(); t2.position.x = left ? 0.3 : -0.3; spin.add(t2); }
      const track = front ? B.trackF : B.trackR;
      pivot.position.set((left ? -1 : 1) * track / 2, 0, front ? -spec.body.wb * (1 - spec.weightF) : spec.body.wb * spec.weightF);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, inner: spin, front, left });
    }
    this.lights = { head: 0, brake: 0, indL: 0, indR: 0, rev: 0, high: 0 };
  }
  setColor(color, metallic = true) {
    const m = paintMaterial(color, metallic);
    this.paint = m;
    this.lowerMesh.material = m;
    this.greenMesh.material = [CAR_MATS.glass, m, CAR_MATS.glass];
    this.body.traverse((o) => { if (o.isMesh && o.material && o.material.clearcoat === 1 && o.material !== CAR_MATS.glass && o !== this.greenMesh) o.material = m; });
  }
  // Update wheel transforms from physics (or AI) state
  updateWheels(wheels, cgH) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], s = wheels[i];
      // wheel centre: attachment - compressed spring length along body up
      const len = s.rest - s.comp;
      w.pivot.position.y = s.y - len;
      w.pivot.rotation.y = -(s.steer || 0);
      w.spin.rotation.x = -(s.angle || 0);
    }
  }
  setLights(l) {
    const night = l.night ?? 0;
    this.headMat.emissiveIntensity = l.head ? (l.high ? 6 : 3.5) : l.drl ? 1.2 : 0.02;
    this.tailMat.emissiveIntensity = l.head || l.drl ? 1.6 + night : 0.1;
    this.brakeMat.emissiveIntensity = l.brake ? 5 : 0.0;
    this.indMatL.emissiveIntensity = l.indL ? 6 : 0;
    this.indMatR.emissiveIntensity = l.indR ? 6 : 0;
    this.revMat.emissiveIntensity = l.rev ? 4 : 0;
  }
}

const wheelCache = new Map();
function wheelGeometry(r, w, style, lite = false) {
  const k = r + ':' + w + ':' + style + (lite ? ':lite' : '');
  if (wheelCache.has(k)) return wheelCache.get(k);
  const tireG = new THREE.CylinderGeometry(r, r, w, lite ? 12 : 24, 1, false);
  tireG.rotateZ(Math.PI / 2);
  // tyre sidewall bulge via a torus overlay (skipped for distant instanced cars)
  let tg = tireG;
  if (!lite) {
    const tor = new THREE.TorusGeometry(r - w * 0.28, w * 0.3, 8, 24);
    tor.rotateY(Math.PI / 2);
    tg = mergeGeos([tireG, tor]);
  }
  const rr = r * 0.66;
  const parts = [];
  const disc = new THREE.CylinderGeometry(rr, rr, w * 0.5, lite ? 10 : 20);
  disc.rotateZ(Math.PI / 2); disc.translate(w * 0.06, 0, 0);
  parts.push(disc);
  if (style !== 'steel') {
    const n = style === 'multi' ? 10 : 5;
    for (let i = 0; i < n; i++) {
      const sp = new THREE.BoxGeometry(0.03, rr * 0.92, style === 'multi' ? 0.035 : 0.07);
      sp.translate(w * 0.32, rr * 0.45, 0);
      sp.rotateX((i / n) * Math.PI * 2);
      parts.push(sp);
    }
  } else {
    const cap = new THREE.CylinderGeometry(rr * 0.75, rr * 0.8, 0.04, 18);
    cap.rotateZ(Math.PI / 2); cap.translate(w * 0.34, 0, 0);
    parts.push(cap);
  }
  const hub = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 8); hub.rotateZ(Math.PI / 2); hub.translate(w * 0.36, 0, 0);
  parts.push(hub);
  const res = { tire: tg, rim: mergeGeos(parts) };
  wheelCache.set(k, res);
  return res;
}
function mergeGeos(list) {
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

const LETTERS = 'ABCDEFGHJKLMNOPRSTUWXYZ';
export function randomPlate(seed) {
  let s = seed * 9301 + 49297;
  const r = () => { s = (s * 233280 + 12345) % 2147483647; return (s % 10000) / 10000; };
  let t = '';
  for (let i = 0; i < 3; i++) t += LETTERS[Math.floor(r() * LETTERS.length)];
  t += ' ';
  t += Math.floor(r() * 10) + '' + Math.floor(r() * 10);
  // since 2019 the last character may be a letter
  t += r() < 0.3 ? LETTERS[Math.floor(r() * LETTERS.length)] : Math.floor(r() * 10);
  return t;
}

/* ---------------- Instancing support for traffic ---------------- */
// Merges a vehicle into 4 geometries: body (paint, instance-coloured), dark (glass/trim, vertex coloured),
// wheel (single wheel at origin), lights (quads with aLight attribute: 0 head, 1 tail, 2 brake, 3 indL, 4 indR, 5 rev).
const partsCache = new Map();
export function instancedParts(spec) {
  if (partsCache.has(spec.id)) return partsCache.get(spec.id);
  const mesh = new CarMesh(spec, { color: 0xffffff, plate: 'ABC 123', metallic: false, lite: true });
  mesh.group.updateMatrixWorld(true);
  const body = [], dark = [], lights = [];
  const tmpM = new THREE.Matrix4();
  const push = (arr, geo, matrix, color, light = -1) => {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (light >= 0) g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(n).fill(light), 1));
    arr.push(g);
  };
  const lightOf = (m) => m === mesh.headMat ? 0 : m === mesh.tailMat ? 1 : m === mesh.brakeMat ? 2 : m === mesh.indMatL ? 3 : m === mesh.indMatR ? 4 : m === mesh.revMat ? 5 : -1;
  mesh.body.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.matrixWorld;
    if (o === mesh.greenMesh) {
      // split groups: 0 glass, 1 roof paint, 2 glass
      for (const gr of o.geometry.groups) {
        const sub = new THREE.BufferGeometry();
        for (const k in o.geometry.attributes) {
          const a = o.geometry.attributes[k];
          sub.setAttribute(k, new THREE.BufferAttribute(a.array.slice(gr.start * a.itemSize, (gr.start + gr.count) * a.itemSize), a.itemSize));
        }
        if (gr.materialIndex === 1) push(body, sub, m, new THREE.Color(1, 1, 1));
        else push(dark, sub, m, new THREE.Color(0.03, 0.045, 0.06));
      }
      return;
    }
    const L = lightOf(o.material);
    if (L >= 0) { push(lights, o.geometry, m, new THREE.Color(1, 1, 1), L); return; }
    if (o.material === mesh.paint || (o.material && o.material.clearcoat === 1 && o.material !== CAR_MATS.glass)) { push(body, o.geometry, m, new THREE.Color(1, 1, 1)); return; }
    const c = o.material && o.material.color ? o.material.color.clone() : new THREE.Color(0.1, 0.1, 0.1);
    if (o.material && o.material.map) c.setRGB(0.85, 0.85, 0.85);
    push(dark, o.geometry, m, c);
  });
  // wheel at origin (tyre + rim)
  const w0 = mesh.wheels[1];
  const wheel = [];
  w0.spin.children.forEach((o) => { if (o.isMesh) push(wheel, o.geometry, new THREE.Matrix4(), o.material.color ? o.material.color.clone() : new THREE.Color(0.1, 0.1, 0.1)); });
  const res = {
    body: mergeColored(body), dark: mergeColored(dark), wheel: mergeColored(wheel), lights: mergeColored(lights, true),
    wheelPos: mesh.wheels.map((w) => [w.pivot.position.x, w.pivot.position.z, w.left]),
  };
  partsCache.set(spec.id, res);
  return res;
}
function mergeColored(list, withLight = false) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), lig = withLight ? new Float32Array(n) : null;
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    if (lig) lig.set(g.attributes.aLight.array, o);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (lig) out.setAttribute('aLight', new THREE.BufferAttribute(lig, 1));
  out.computeBoundingSphere();
  return out;
}
