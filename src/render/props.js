/* =====================================================================
   Roadside props per chunk: street lights, reflector posts, snow poles,
   guard rails, cable barriers, traffic lights, bus stops and signs.
   ===================================================================== */
import * as THREE from 'three';
import { CHUNK } from '../world/terrain.js';
import { sIndex, xsBase } from '../world/network.js';
import { lerp, clamp, hash2i, hashStr } from '../core/math.js';
import { speedSign, mooseSign, curveSign, yieldSign, priorityRoadSign, crossingSign, roundaboutSign, motorwaySign, cameraSign, restSign, fuelSign, placeSign, streetSign, directionSign } from './signs.js';
import { envUniforms } from './terrainmesh.js';
import { buildingEmissive } from './buildings.js';

const M = {};
const LAMP_OFF = new THREE.Color(0.03, 0.03, 0.03), LAMP_RED = new THREE.Color(5, 0.25, 0.12), LAMP_AMBER = new THREE.Color(5, 2.2, 0.05), LAMP_GREEN = new THREE.Color(0.15, 5, 1.4);
function mats() {
  if (M.pole) return M;
  M.pole = new THREE.MeshStandardMaterial({ color: 0x8c9196, roughness: 0.5, metalness: 0.6 });
  M.darkPole = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.55, metalness: 0.5 });
  M.white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 });
  M.black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
  M.reflector = new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffd27a, emissiveIntensity: 0.2, roughness: 0.3 });
  M.orange = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 });
  M.rail = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.8, side: THREE.DoubleSide });
  M.cable = new THREE.MeshStandardMaterial({ color: 0x9ea3a8, roughness: 0.4, metalness: 0.8 });
  M.lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 0, roughness: 0.3 });
  M.signBack = new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.6, metalness: 0.4 });
  M.lightOff = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.4 });
  M.red = new THREE.MeshStandardMaterial({ color: 0xff2010, emissive: 0xff2010, emissiveIntensity: 4 });
  M.amber = new THREE.MeshStandardMaterial({ color: 0xffa000, emissive: 0xffa000, emissiveIntensity: 4 });
  M.green = new THREE.MeshStandardMaterial({ color: 0x20ff70, emissive: 0x20ff70, emissiveIntensity: 4 });
  M.housing = new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.6 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x9fb7c4, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35 });
  M.lens = new THREE.MeshBasicMaterial({ color: 0xffffff });
  M.signs = new Map();
  return M;
}
function signMat(tex) {
  let m = M.signs.get(tex);
  if (!m) { m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, transparent: true, alphaTest: 0.3, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.05 }); M.signs.set(tex, m); }
  return m;
}

// geometries (shared)
const G = {};
function geos() {
  if (G.pole) return G;
  G.pole = new THREE.CylinderGeometry(0.06, 0.08, 1, 6); G.pole.translate(0, 0.5, 0);
  G.thinPole = new THREE.CylinderGeometry(0.035, 0.035, 1, 5); G.thinPole.translate(0, 0.5, 0);
  G.box = new THREE.BoxGeometry(1, 1, 1);
  G.post = new THREE.BoxGeometry(0.1, 1.05, 0.1); G.post.translate(0, 0.52, 0);
  G.band = new THREE.BoxGeometry(0.106, 0.18, 0.106); G.band.translate(0, 0.78, 0);
  G.refl = new THREE.BoxGeometry(0.11, 0.07, 0.04); G.refl.translate(0, 0.9, 0);
  G.snowPole = new THREE.CylinderGeometry(0.02, 0.02, 2.2, 4); G.snowPole.translate(0, 1.1, 0);
  G.arm = new THREE.BoxGeometry(0.08, 0.08, 1); G.arm.translate(0, 0, 0.5);
  G.head = new THREE.BoxGeometry(0.35, 0.12, 0.6);
  G.lampGlow = new THREE.BoxGeometry(0.28, 0.04, 0.5);
  G.plane = new THREE.PlaneGeometry(1, 1);
  G.lens = new THREE.CircleGeometry(0.1, 10);
  return G;
}

class Inst {
  // collects instance transforms for one geometry+material
  constructor(geo, mat, shadow = false) { this.geo = geo; this.mat = mat; this.m = []; this.shadow = shadow; this.colors = null; }
  add(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) { this.m.push([x, y, z, ry, sx, sy, sz]); }
  build() {
    if (!this.m.length) return null;
    const im = new THREE.InstancedMesh(this.geo, this.mat, this.m.length);
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    this.m.forEach((t, i) => { Q.setFromAxisAngle(Y, t[3]); M4.compose(P.set(t[0], t[1], t[2]), Q, S.set(t[4], t[5], t[6])); im.setMatrixAt(i, M4); });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = this.shadow; im.receiveShadow = false;
    im.computeBoundingSphere();
    im.userData.shared = true;
    return im;
  }
}

const _F = {};
function frame(r, s) {
  const i = sIndex(r, s);
  const t = (s - r.S[i]) / Math.max(1e-6, r.S[i + 1] - r.S[i]);
  _F.x = lerp(r.X[i], r.X[i + 1], t); _F.z = lerp(r.Z[i], r.Z[i + 1], t); _F.y = lerp(r.Y[i], r.Y[i + 1], t);
  let tx = lerp(r.TX[i], r.TX[i + 1], t), tz = lerp(r.TZ[i], r.TZ[i + 1], t);
  const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  _F.tx = tx; _F.tz = tz; _F.nx = -tz; _F.nz = tx; _F.bank = lerp(r.BANK[i], r.BANK[i + 1], t); _F.bridge = r.bridge[Math.min(i, r.n - 2)];
  _F.yaw = Math.atan2(-tx, -tz);
  return _F;
}

export class Props {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.signals = new Map(); // chunk key -> [{node, end, lamps}]
    mats(); geos();
    // speed camera locations (deterministic): on 2+1 and primary roads every ~6 km
    this.cameras = [];
    for (const r of this.world.net.roads) {
      if (!(r.type === 'expressway' || r.type === 'primary' || r.type === 'secondary') || r.len < 600) continue;
      const h = hashStr('atk' + r.id) % 1000 / 1000;
      if (h < 0.22) this.cameras.push({ road: r, s: r.len * (0.3 + 0.4 * h / 0.22), dir: hashStr('d' + r.id) % 2 ? 1 : -1 });
    }
    this.world.speedCameras = this.cameras;
  }

  *job(ch, lod, res) {
    const world = this.world;
    const net = world.net;
    const x0 = ch.cx * CHUNK, z0 = ch.cz * CHUNK;
    const I = {
      pole: new Inst(G.pole, M.pole, true), darkPole: new Inst(G.pole, M.darkPole, true), arm: new Inst(G.arm, M.pole), head: new Inst(G.head, M.darkPole), glow: new Inst(G.lampGlow, M.lamp),
      post: new Inst(G.post, M.white), band: new Inst(G.band, M.black), refl: new Inst(G.refl, M.reflector), snow: new Inst(G.snowPole, M.orange),
      railPost: new Inst(G.box, M.rail), cablePost: new Inst(G.box, M.cable), signPole: new Inst(G.thinPole, M.pole),
    };
    const strips = { rail: [], cable: [] };
    const signs = new Map(); // material -> quads
    const colliders = [];
    const signalHeads = [];
    const addSign = (tex, x, y, z, yaw, w, h) => {
      const mat = signMat(tex);
      let l = signs.get(mat); if (!l) { l = []; signs.set(mat, l); }
      l.push([x - x0, y, z - z0, yaw, w, h]);
      // grey back face
      let lb = signs.get(M.signBack); if (!lb) { lb = []; signs.set(M.signBack, lb); }
      lb.push([x - x0 - Math.sin(yaw) * 0.015 * -1, y, z - z0, yaw + Math.PI, w * 0.98, h * 0.98]);
    };
    const postSign = (r, s, d, tex, faceDir, w = 0.9, h = 0.9, top = 2.6) => {
      // faceDir: +1 = faces traffic travelling in +s direction (i.e. sign normal points -s)
      const F = frame(r, s);
      const x = F.x + F.nx * d, z = F.z + F.nz * d;
      const gy = world.terrain.height(x, z);
      const y = Math.max(gy, F.y - 0.3);
      I.signPole.add(x - x0, y, z - z0, 0, 1, top + h / 2, 1);
      const yaw = faceDir > 0 ? F.yaw + Math.PI : F.yaw;
      addSign(tex, x + (faceDir > 0 ? -F.tx : F.tx) * 0.05, y + top, z + (faceDir > 0 ? -F.tz : F.tz) * 0.05, yaw, w, h);
      colliders.push({ type: 'circle', x, z, r: 0.08, y0: y, y1: y + top });
      return { x, z, y };
    };
    // collect road segments in chunk
    const segs = new Map();
    const C = net.cell;
    for (let gx = Math.floor(x0 / C); gx < Math.floor((x0 + CHUNK) / C); gx++)
      for (let gz = Math.floor(z0 / C); gz < Math.floor((z0 + CHUNK) / C); gz++) {
        const l = net.grid.get(gx * 1000003 + gz);
        if (!l) continue;
        for (const enc of l) {
          const r = net.roads[(enc / 65536) | 0], i = enc & 65535;
          const mx = (r.X[i] + r.X[i + 1]) / 2, mz = (r.Z[i] + r.Z[i + 1]) / 2;
          if (mx < x0 || mx >= x0 + CHUNK || mz < z0 || mz >= z0 + CHUNK) continue;
          let set = segs.get(r); if (!set) { set = []; segs.set(r, set); }
          set.push(i);
        }
      }
    const winter = this.game.season === 'winter';
    const north = -(z0 / 1000) > 9;
    let n = 0;
    for (const [r, list] of segs) {
      list.sort((a, b) => a - b);
      const sMin = Math.max(r.S[list[0]], r.trimA + 1), sMax = Math.min(r.S[list[list.length - 1] + 1], r.len - r.trimB - 1);
      if (sMax <= sMin) continue;
      const xs = r.xs, T = r.T;
      const within = (s) => s >= sMin && s < sMax;
      // ---- street lights (urban)
      if (T.lights) {
        const sp = T.lights;
        for (let s = Math.ceil(sMin / sp) * sp; s < sMax; s += sp) {
          const k = Math.round(s / sp);
          const sides = r.type === 'avenue' ? [1, -1] : [k % 2 ? 1 : -1];
          for (const side of sides) {
            if (side > 0 && xs.swR <= 0) continue;
            if (side < 0 && xs.swL <= 0) continue;
            const F = frame(r, s);
            if (F.bridge) continue;
            const d = side > 0 ? xs.outerR - 0.45 : xs.outerL + 0.45;
            const x = F.x + F.nx * d, z = F.z + F.nz * d;
            const y = F.y + xsBase(xs, F.bank, d) + xs.curb;
            const hgt = r.type === 'avenue' ? 9 : 7;
            I.pole.add(x - x0, y, z - z0, 0, 1, hgt, 1);
            const armYaw = Math.atan2(-F.nx * side, -F.nz * side) + Math.PI;
            I.arm.add(x - x0, y + hgt - 0.1, z - z0, armYaw, 1, 1, 1.6);
            const hx = x - F.nx * side * 1.5, hz = z - F.nz * side * 1.5;
            I.head.add(hx - x0, y + hgt - 0.12, hz - z0, armYaw);
            I.glow.add(hx - x0, y + hgt - 0.19, hz - z0, armYaw);
            colliders.push({ type: 'circle', x, z, r: 0.13, y0: y, y1: y + hgt });
          }
        }
      }
      // ---- reflector posts & snow poles (rural)
      if (!T.urban && r.type !== 'ramp' && r.type !== 'rest' && r.type !== 'gravel' && r.type !== 'service') {
        const sp = r.type === 'motorway' ? 50 : 50;
        for (let s = Math.ceil(sMin / sp) * sp; s < sMax; s += sp) {
          const F = frame(r, s);
          if (F.bridge) continue;
          for (const side of r.type === 'motorway' ? [1] : [1, -1]) {
            const d = side > 0 ? xs.outerR + 0.35 : xs.outerL - 0.35;
            const x = F.x + F.nx * d, z = F.z + F.nz * d;
            const y = world.terrain.height(x, z);
            I.post.add(x - x0, y, z - z0, F.yaw); I.band.add(x - x0, y, z - z0, F.yaw); I.refl.add(x - x0, y, z - z0, F.yaw);
            if (winter && north) I.snow.add(x - x0 + F.nx * side * 0.3, y, z - z0 + F.nz * side * 0.3, 0);
          }
        }
      }
      // ---- motorway median barrier & guard rails on high embankments
      if (xs.divider === 'median') railStrip(strips.rail, I.railPost, r, sMin, sMax, xs.c, x0, z0, colliders, 0.75);
      if (xs.divider === 'cable') cableBarrier(strips.cable, I.cablePost, r, sMin, sMax, x0, z0, colliders, net);
      if (!T.urban && r.type !== 'gravel') {
        // embankment rails where the drop beside the road is large
        for (const side of [1, -1]) {
          let run0 = -1;
          for (let s = sMin; s <= sMax; s += 4) {
            const F = frame(r, s);
            const d = side > 0 ? xs.outerR + 0.4 : xs.outerL - 0.4;
            const x = F.x + F.nx * (d + side * 4), z = F.z + F.nz * (d + side * 4);
            const drop = F.y - world.terrain.height(x, z);
            const need = drop > 2.6 && !F.bridge;
            if (need && run0 < 0) run0 = s;
            if ((!need || s + 4 > sMax) && run0 >= 0) {
              if (s - run0 > 12) railStrip(strips.rail, I.railPost, r, run0, s, d, x0, z0, colliders, 0.75, true);
              run0 = -1;
            }
          }
        }
      }
      // ---- signs at road starts (speed limits) and special signs
      for (const dir of [1, -1]) {
        if (dir > 0 && xs.lanesF === 0) continue;
        if (dir < 0 && xs.lanesB === 0) continue;
        const sStart = dir > 0 ? r.trimA + 18 : r.len - r.trimB - 18;
        const fromNode = dir > 0 ? r.a : r.b;
        if (!within(sStart)) continue;
        if (r.len < 70) continue;
        // speed limit when leaving a junction or when the limit changes
        const prev = fromNode.ends.find((e) => e.road !== r);
        const changes = fromNode.kind !== 'continuation' || !prev || prev.road.speed !== r.speed;
        const dRight = dir > 0 ? xs.outerR + 0.6 : xs.outerL - 0.6;
        if (changes && (r.speed !== 50 || !T.urban || fromNode.kind === 'continuation') && r.type !== 'ramp') {
          postSign(r, sStart, dRight, speedSign(r.speed), dir, 0.75, 0.75, 2.0);
        }
        // motorway begins
        if (r.type === 'motorway' && fromNode.kind !== 'continuation' && fromNode.kind !== 'split') postSign(r, sStart + 30 * dir, dRight, motorwaySign(false), dir, 0.9, 0.9, 2.2);
        // place-name sign when entering a village zone (speed drops to 50 on rural road)
        if (!T.urban && r.speed <= 50 && prev && prev.road.speed > 50) {
          const v = world.villages.find((q) => Math.hypot(q.x - r.X[r.n >> 1], q.z - r.Z[r.n >> 1]) < 900);
          if (v) postSign(r, sStart + 6 * dir, dRight + dir * 0, placeSign(v.name), dir, 2.4, 0.75, 1.9);
        }
        // moose warning in forest on rural roads
        if (!T.urban && (r.type === 'primary' || r.type === 'secondary' || r.type === 'expressway' || r.type === 'local') && (hashStr('m' + r.id + dir) % 5 === 0) && r.len > 500) {
          postSign(r, sStart + 120 * dir, dRight, mooseSign(), dir, 1.1, 1.0, 1.9);
        }
        // roundabout ahead / yield at the far end
        const toNode = dir > 0 ? r.b : r.a;
        const sEnd = dir > 0 ? r.len - r.trimB - 4 : r.trimA + 4;
        if (within(sEnd) && r.len > 40) {
          if (toNode.kind === 'roundabout') { postSign(r, sEnd, dRight, yieldSign(), dir, 0.9, 0.8, 1.8); postSign(r, sEnd - 3 * dir, dRight, roundaboutSign(), dir, 0.7, 0.7, 2.0); }
          else if (toNode.kind === 'junction' && toNode.control === 'priority') {
            const e = toNode.ends.find((q) => q.road === r && q.atStart === (dir < 0));
            if (e && !e.major) postSign(r, sEnd, dRight, yieldSign(), dir, 0.9, 0.8, 1.8);
            else if (e && e.major && !T.urban && hashStr('p' + r.id) % 3 === 0) postSign(r, sEnd - 60 * dir, dRight, priorityRoadSign(), dir, 0.8, 0.8, 2.0);
          }
        }
        // curve warning before sharp bends on rural roads
        if (!T.urban && r.speed >= 70) {
          for (let s = sMin; s < sMax; s += 8) {
            const i = sIndex(r, s);
            const k = r.K[i];
            if (Math.abs(k) > 1 / 180 && hash2i(r.id, Math.round(s / 300), 1) < 0.9) {
              const sSign = s - 110 * dir;
              if (within(sSign) && Math.abs(r.K[sIndex(r, sSign)]) < 1 / 400) { postSign(r, sSign, dRight, curveSign(Math.sign(k) * dir), dir, 1.0, 0.9, 1.9); break; }
            }
          }
        }
      }
      // ---- direction signs before junctions on rural main roads
      if (!T.urban && (r.type === 'primary' || r.type === 'expressway' || r.type === 'secondary')) {
        for (const dir of [1, -1]) {
          const toNode = dir > 0 ? r.b : r.a;
          if (toNode.kind !== 'junction' && toNode.kind !== 'roundabout') continue;
          const s = dir > 0 ? r.len - r.trimB - 160 : r.trimA + 160;
          if (!within(s) || r.len < 260) continue;
          const lines = [];
          for (const e of toNode.ends) {
            if (e.road === r) continue;
            const dst = e.atStart ? e.road.dest?.fwd : e.road.dest?.bwd;
            const name = dst || e.road.name;
            if (!name) continue;
            const inx = -(dir > 0 ? r.TX[r.n - 1] : -r.TX[0]), inz = -(dir > 0 ? r.TZ[r.n - 1] : -r.TZ[0]);
            const cross = -inx * e.uz + inz * e.ux;
            const dot = -inx * e.ux - inz * e.uz;
            const arrow = dot > 0.7 ? 0 : cross > 0 ? 1 : -1;
            lines.push({ text: name, ref: e.road.ref || null, arrow });
            if (lines.length >= 3) break;
          }
          if (!lines.length) continue;
          const key = r.id + ':' + dir;
          const dRight = dir > 0 ? xs.outerR + 1.2 : xs.outerL - 1.2;
          const tex = directionSign(key, lines, r.type === 'secondary' ? 'white' : 'blue');
          const h = 0.42 * lines.length + 0.25;
          const p = postSign(r, s, dRight, tex, dir, 2.6, h, 1.6);
          I.signPole.add(p.x - x0 + 1.0, p.y, p.z - z0, 0, 1, 1.6 + h / 2, 1);
        }
      }
      // ---- motorway exit signs before diverges
      if (r.type === 'motorway') {
        for (const dir of [1, -1]) {
          const toNode = dir > 0 ? r.b : r.a;
          if (toNode.kind !== 'split') continue;
          const ramp = toNode.ends.find((e) => e.road.type === 'ramp' && e.atStart);
          if (!ramp) continue;
          // only for the carriageway that diverges here (ramp on its right)
          const vx = dir > 0 ? r.TX[r.n - 1] : -r.TX[0], vz = dir > 0 ? r.TZ[r.n - 1] : -r.TZ[0];
          const ox = ramp.px - toNode.x, oz = ramp.pz - toNode.z;
          if (vx * oz - vz * ox <= 0) continue;
          const s = dir > 0 ? r.len - 350 : 350;
          if (!within(s)) continue;
          const term = ramp.road.otherNode(toNode);
          const names = [];
          for (const e of term.ends) { const nm = e.road.dest?.fwd || e.road.name; if (e.road !== ramp.road && e.road.type !== 'ramp' && nm && !names.includes(nm)) names.push(nm); }
          const lines = [{ text: (this.game.lang === 'en' ? 'Exit ' : 'Avfart ') + (names[0] || ''), arrow: 1 }];
          if (names[1]) lines.push({ text: names[1] });
          const tex = directionSign('exit' + r.id + dir, lines, 'blue');
          postSign(r, s, dir > 0 ? xs.outerR + 1.0 : xs.outerL - 1.0, tex, dir, 3.2, 0.42 * lines.length + 0.25, 2.2);
        }
      }
      // ---- bus stops on city streets
      if ((r.type === 'avenue' || r.type === 'street') && r.len > 90 && hashStr('bus' + r.id) % 4 === 0) {
        const s = r.len * 0.5;
        if (within(s) && xs.swR > 0) {
          const F = frame(r, s);
          const d = xs.outerR - 1.0;
          const x = F.x + F.nx * d, z = F.z + F.nz * d, y = F.y + xs.curb + xsBase(xs, F.bank, xs.edgeR);
          I.darkPole.add(x - x0, y, z - z0, 0, 0.8, 2.5, 0.8);
          const sx = x + F.tx * 2.5, sz = z + F.tz * 2.5;
          shelter(I, sx, y, sz, F.yaw, x0, z0, colliders);
        }
      }
      // ---- speed cameras
      for (const cam of this.cameras) {
        if (cam.road !== r || !within(cam.s)) continue;
        const dRight = cam.dir > 0 ? xs.outerR + 1.0 : xs.outerL - 1.0;
        const p = postSign(r, cam.s, dRight, cameraSign(), cam.dir, 0.8, 0.8, 2.0);
        const F = frame(r, cam.s + 250 * cam.dir);
        if (cam.s + 250 * cam.dir > 0 && cam.s + 250 * cam.dir < r.len) {
          const x = F.x + F.nx * (dRight + 1 * cam.dir), z = F.z + F.nz * (dRight + 1 * cam.dir);
          const y = world.terrain.height(x, z);
          I.darkPole.add(x - x0, y, z - z0, 0, 1.4, 3.2, 1.4);
          const box = new Inst(G.box, M.housing, true);
          I.camBox = I.camBox || box;
          I.camBox.add(x - x0, y + 3.5, z - z0, F.yaw, 0.6, 0.7, 0.5);
          cam.x = x; cam.z = z;
        }
      }
      if (++n % 4 === 0) yield;
    }
    // ---- traffic lights & crossing signs at junction nodes in chunk
    for (const node of net.nodes) {
      if (node.x < x0 || node.x >= x0 + CHUNK || node.z < z0 || node.z >= z0 + CHUNK) continue;
      if (node.kind !== 'junction') continue;
      node.ends.forEach((e, k) => {
        const r = e.road, xs = r.xs;
        const sb = node.setbacks.get(e) || 0;
        const s = e.atStart ? sb - 0.5 : r.len - sb + 0.5;
        if (s < 0 || s > r.len) return;
        const F = frame(r, s);
        const dir = e.atStart ? -1 : 1; // direction of travel of incoming traffic
        const incomingCount = e.atStart ? xs.lanesB : xs.lanesF;
        if (!incomingCount) return;
        const d = dir > 0 ? xs.outerR - 0.6 : xs.outerL + 0.6;
        const x = F.x + F.nx * d, z = F.z + F.nz * d;
        const y = F.y + (xs.curb || 0) + xsBase(xs, F.bank, dir > 0 ? xs.edgeR : xs.edgeL);
        if (node.control === 'signal') {
          I.darkPole.add(x - x0, y, z - z0, 0, 0.9, 3.4, 0.9);
          const yaw = dir > 0 ? F.yaw + Math.PI : F.yaw;
          const head = { node, group: node.signal.groupOf[k], x, y: y + 2.9, z, yaw, lamps: null };
          signalHeads.push(head);
          colliders.push({ type: 'circle', x, z, r: 0.12, y0: y, y1: y + 3.4 });
          // pedestrian crossing sign on urban junctions
        } else if (r.T.urban && (xs.swL > 0 || xs.swR > 0) && node.ends.length >= 3) {
          const p = { x: x + F.tx * dir * -4.5, z: z + F.tz * dir * -4.5 };
          I.signPole.add(p.x - x0, y, p.z - z0, 0, 1, 2.6, 1);
          addSign(crossingSign(), p.x - F.tx * dir * 0.05, y + 2.3, p.z - F.tz * dir * 0.05, dir > 0 ? F.yaw + Math.PI : F.yaw, 0.65, 0.65);
        }
        // street name sign at urban corners
        if (r.T.urban && r.name && k % 2 === 0 && node.ends.length >= 3) {
          const p = { x: x + F.nx * dir * 0.4, z: z + F.nz * dir * 0.4 };
          I.signPole.add(p.x - x0, y, p.z - z0, 0, 1, 2.9, 1);
          const sy = F.yaw + Math.PI / 2;
          addSign(streetSign(r.name), p.x, y + 2.75, p.z, sy, 1.3, 0.25);
          addSign(streetSign(r.name), p.x, y + 2.75, p.z, sy + Math.PI, 1.3, 0.25);
        }
      });
    }
    yield;
    // build meshes
    const group = new THREE.Group();
    for (const k in I) { const m = I[k].build(); if (m) group.add(m); }
    for (const [mat, list] of signs) {
      const pos = [], uv = [], idx = [];
      for (const [x, y, z, yaw, w, h] of list) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        // plane facing +z rotated by yaw: right = (c, 0, -s)
        const rx = c * w / 2, rz = -s * w / 2;
        const b = pos.length / 3;
        pos.push(x - rx, y - h / 2, z - rz, x + rx, y - h / 2, z + rz, x + rx, y + h / 2, z + rz, x - rx, y + h / 2, z - rz);
        uv.push(0, 0, 1, 0, 1, 1, 0, 1);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      group.add(m);
    }
    for (const kind of ['rail', 'cable']) {
      const S = strips[kind];
      if (!S.length) continue;
      const pos = [], idx = [];
      for (const q of S) { const b = pos.length / 3; pos.push(...q[0], ...q[1], ...q[2], ...q[3]); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, kind === 'rail' ? M.rail : M.cable);
      m.castShadow = kind === 'rail';
      group.add(m);
    }
    // traffic light heads: one instanced housing + one instanced lens set per chunk;
    // lamp states are written as instance colours every frame
    if (signalHeads.length) {
      const n = signalHeads.length;
      const housing = new THREE.InstancedMesh(G.box, M.housing, n);
      const lenses = new THREE.InstancedMesh(G.lens, M.lens, n * 3);
      const mH = new THREE.Matrix4(), mL = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      signalHeads.forEach((h, k) => {
        q.setFromAxisAngle(up, h.yaw);
        mH.compose(v.set(h.x - x0, h.y, h.z - z0), q, new THREE.Vector3(0.32, 0.95, 0.22));
        housing.setMatrixAt(k, mH);
        for (let j = 0; j < 3; j++) {
          const off = new THREE.Vector3(0, 0.3 - j * 0.3, 0.115).applyQuaternion(q);
          mL.compose(v.set(h.x - x0 + off.x, h.y + off.y, h.z - z0 + off.z), q, new THREE.Vector3(1, 1, 1));
          lenses.setMatrixAt(k * 3 + j, mL);
          lenses.setColorAt(k * 3 + j, LAMP_OFF);
        }
        h.lampIdx = k * 3;
      });
      housing.castShadow = true;
      lenses.userData.heads = signalHeads;
      group.add(housing, lenses);
      res.lenses = lenses;
    }
    group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    res.group = group;
    res.colliders = colliders;
    res.signalHeads = signalHeads;
  }

  // per-frame: traffic light states and lamp glow
  update(dt, game) {
    const night = game.env.night;
    M.lamp.emissiveIntensity = night > 0.15 || game.env.daylight < 0.4 ? 3.5 : 0;
    M.reflector.emissiveIntensity = 0.1 + night * 0.6;
    for (const m of M.signs.values()) m.emissiveIntensity = 0.03 + night * 0.25;
    for (const ch of game.chunks.chunks.values()) {
      const st = ch.layers.props;
      if (!st || !st.signalHeads) continue;
      for (const h of st.signalHeads) {
        const s = h.node.signal.state(h.group);
        const L = st.lenses, i = h.lampIdx;
        L.setColorAt(i, s === 'red' || s === 'redamber' ? LAMP_RED : LAMP_OFF);
        L.setColorAt(i + 1, s === 'amber' || s === 'redamber' ? LAMP_AMBER : LAMP_OFF);
        L.setColorAt(i + 2, s === 'green' ? LAMP_GREEN : LAMP_OFF);
      }
      if (st.lenses) st.lenses.instanceColor.needsUpdate = true;
    }
  }
}

function railStrip(out, posts, r, s0, s1, d, x0, z0, colliders, h = 0.75, edge = false) {
  const step = 4;
  let prev = null;
  for (let s = s0; s <= s1 + 0.01; s += step) {
    const F = frame(r, Math.min(s, s1));
    const y = F.y + xsBase(r.xs, F.bank, clamp(d, r.xs.edgeL, r.xs.edgeR)) + (edge ? -0.05 : 0);
    const x = F.x + F.nx * d - x0, z = F.z + F.nz * d - z0;
    posts.add(x, y + h / 2, z, F.yaw, 0.1, h, 0.1);
    const cur = [x, y, z];
    if (prev) {
      out.push([[prev[0], prev[1] + h - 0.32, prev[2]], [cur[0], cur[1] + h - 0.32, cur[2]], [cur[0], cur[1] + h, cur[2]], [prev[0], prev[1] + h, prev[2]]]);
      colliders.push({ type: 'seg', ax: prev[0] + x0, az: prev[2] + z0, bx: cur[0] + x0, bz: cur[2] + z0, r: 0.22, y0: Math.min(prev[1], cur[1]) - 0.5, y1: Math.max(prev[1], cur[1]) + h });
    }
    prev = cur;
  }
}
function cableBarrier(out, posts, r, s0, s1, x0, z0, colliders, net) {
  const step = 3;
  let prev = null;
  for (let s = s0; s <= s1 + 0.01; s += step) {
    const ss = Math.min(s, s1);
    const F = frame(r, ss);
    // the barrier crosses over near lane-switch nodes
    let d = r.xs.c;
    const nb = 70;
    if (ss < nb && r.a.kind === 'continuation') { const o = r.a.ends.find((e) => e.road !== r); if (o && o.road.xs.c !== r.xs.c) d = lerp(o.road.xs.c, r.xs.c, 0.5 + 0.5 * ss / nb); }
    if (r.len - ss < nb && r.b.kind === 'continuation') { const o = r.b.ends.find((e) => e.road !== r); if (o && o.road.xs.c !== r.xs.c) d = lerp(o.road.xs.c, r.xs.c, 0.5 + 0.5 * (r.len - ss) / nb); }
    const y = F.y + xsBase(r.xs, F.bank, d);
    const x = F.x + F.nx * d - x0, z = F.z + F.nz * d - z0;
    posts.add(x, y + 0.45, z, F.yaw, 0.06, 0.9, 0.06);
    const cur = [x, y, z];
    if (prev) {
      for (const hh of [0.5, 0.65, 0.8]) out.push([[prev[0], prev[1] + hh - 0.012, prev[2]], [cur[0], cur[1] + hh - 0.012, cur[2]], [cur[0], cur[1] + hh + 0.012, cur[2]], [prev[0], prev[1] + hh + 0.012, prev[2]]]);
      colliders.push({ type: 'seg', ax: prev[0] + x0, az: prev[2] + z0, bx: cur[0] + x0, bz: cur[2] + z0, r: 0.12, y0: Math.min(prev[1], cur[1]) - 0.3, y1: Math.max(prev[1], cur[1]) + 0.9, soft: true });
    }
    prev = cur;
  }
}
function shelter(I, x, y, z, yaw, x0, z0, colliders) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (a, b) => [x + a * c + b * s, z - a * s + b * c];
  for (const [a, b] of [[-1.6, -0.6], [1.6, -0.6], [-1.6, 0.6], [1.6, 0.6]]) { const p = P(a, b); I.darkPole.add(p[0] - x0, y, p[1] - z0, 0, 0.6, 2.4, 0.6); }
  I.glass = I.glass || new Inst(G.box, M.glass);
  const back = P(0, 0.62);
  I.glass.add(back[0] - x0, y + 1.25, back[1] - z0, yaw, 3.3, 2.1, 0.04);
  I.roof = I.roof || new Inst(G.box, M.darkPole, true);
  const ro = P(0, 0);
  I.roof.add(ro[0] - x0, y + 2.45, ro[1] - z0, yaw, 3.6, 0.1, 1.5);
  colliders.push({ type: 'obb', x: ro[0], z: ro[1], hw: 1.7, hd: 0.7, rot: -yaw, y0: y, y1: y + 2.4 });
}
