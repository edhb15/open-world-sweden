/* =====================================================================
   Landmarks: simplified, recognisable silhouettes of well-known Swedish
   buildings (inspired by, not replicas of): Stadshuset, Globen,
   Kaknästornet, Uppsala domkyrka & slott, Läppstiftet, Eriksbergskranen,
   Gothia Towers, Turning Torso, Kiruna kyrka & stadshus, the mine,
   Gävlebocken (December), Örebro slott, Svampen, Skrapan, Kärnan,
   Sergels torg's glass obelisk and generic town churches.
   Geometry goes into the building buckets so it shares materials.
   ===================================================================== */
import * as THREE from 'three';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const W = [1, 1, 1];
const COPPER = lin(0x5f9a82), GOLD = lin(0xd8aa3a), STONE = lin(0xb9b3a8), DARK = lin(0x2c2f33), STRAW = lin(0xd9b46a), RED = lin(0xb3262a);
export const seasonal = new Set(); // meshes only shown at certain times of year
export const seasonState = { xmas: false };
export function updateSeasonal(day) {
  seasonState.xmas = day >= 333 || day <= 6; // Gävlebocken stands from Advent until early January
  for (const m of seasonal) { if (!m.parent) { seasonal.delete(m); continue; } m.visible = seasonState.xmas; }
}

function face(bk, pts, hint, tint, uvs) {
  // orient so the face normal points along `hint` (outward)
  const [a, b] = [pts[0], pts[1]], c = pts[pts.length - 1];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
  if (pts.length === 4) {
    const P = flip ? [pts[0], pts[3], pts[2], pts[1]] : pts;
    bk.quad(P[0], P[1], P[2], P[3], uvs || [0, 0, 0, 1, 1, 1, 1, 0], tint);
  } else {
    const P = flip ? [pts[0], pts[2], pts[1]] : pts;
    bk.tri(P[0], P[1], P[2], uvs || [0, 0, 0.5, 1, 1, 0], tint);
  }
}
const centre = (pts) => { const c = [0, 0, 0]; for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return c.map((v) => v / pts.length); };
const out = (pts, o) => { const c = centre(pts); return [c[0] - o[0], c[1] - o[1], c[2] - o[2]]; };

// facade textures repeat every 4 bays x 4 floors (about 12 x 12.8 m); brick needs its colour as tint
const BRICK = lin(0x9a4632), FALU = lin(0x7e2620);
function facade(key, tint, uv) {
  if (!key.startsWith('wall_')) return [tint, uv];
  const style = key.slice(5);
  const bay = style === 'old' ? 2.4 : style === 'metal' ? 1.5 : 3, bays = style === 'metal' ? 8 : 4, floors = style === 'falu' || style === 'wood' ? 2 : 4;
  const t = tint !== W ? tint : style === 'brick' ? BRICK : style === 'falu' ? FALU : tint;
  return [t, [bay * bays, 3.2 * floors]];
}

/* Builder bound to a local frame (x, z, rot) with ground y */
class LB {
  constructor(B, x, z, rot, y, colliders, x0, z0) {
    this.B = B; this.x = x; this.z = z; this.c = Math.cos(rot); this.s = Math.sin(rot); this.rot = rot; this.y = y;
    this.col = colliders; this.x0 = x0; this.z0 = z0;
  }
  P(a, b, h) { return [this.x + a * this.c - b * this.s, this.y + h, this.z + a * this.s + b * this.c]; }
  box(key, a, b, hw, hd, h0, h1, tint = W, uv = [4, 4], collide = false) {
    [tint, uv] = facade(key, tint, uv);
    const q = this.P(a, b, 0);
    const C = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [q[0] + u * this.c - v * this.s, q[2] + u * this.s + v * this.c]);
    const o = [q[0], this.y + (h0 + h1) / 2, q[2]];
    const bk = this.B(key);
    for (let k = 0; k < 4; k++) {
      const p = C[k], r = C[(k + 1) % 4];
      const L = Math.hypot(r[0] - p[0], r[1] - p[1]);
      const pts = [[p[0], this.y + h0, p[1]], [p[0], this.y + h1, p[1]], [r[0], this.y + h1, r[1]], [r[0], this.y + h0, r[1]]];
      face(bk, pts, out(pts, o), tint, [0, 0, 0, (h1 - h0) / uv[1], L / uv[0], (h1 - h0) / uv[1], L / uv[0], 0]);
    }
    const top = C.map((p) => [p[0], this.y + h1, p[1]]);
    face(bk, top, [0, 1, 0], tint, [0, 0, 0, hd / 2, hw / 2, hd / 2, hw / 2, 0]);
    if (collide) this.col.push({ type: 'obb', x: q[0] + this.x0, z: q[2] + this.z0, hw, hd, rot: this.rot, y0: this.y + h0 - 1, y1: this.y + h1, bld: true });
  }
  /* rotated box (extra yaw) for twisted towers */
  boxR(key, a, b, hw, hd, h0, h1, yaw, tint = W, uv = [4, 4]) {
    const save = [this.c, this.s, this.rot];
    const q = this.P(a, b, 0);
    const ox = this.x, oz = this.z;
    this.x = q[0]; this.z = q[2]; this.rot += yaw; this.c = Math.cos(this.rot); this.s = Math.sin(this.rot);
    this.box(key, 0, 0, hw, hd, h0, h1, tint, uv);
    this.x = ox; this.z = oz; [this.c, this.s, this.rot] = save;
  }
  cyl(key, a, b, r0, r1, h0, h1, seg = 16, tint = W, uv = [4, 4], cap = true, collide = false) {
    [tint, uv] = facade(key, tint, uv);
    const q = this.P(a, b, 0), bk = this.B(key);
    const o = [q[0], this.y + (h0 + h1) / 2, q[2]];
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let k = 0; k < seg; k++) {
      const t0 = (k / seg) * Math.PI * 2, t1 = ((k + 1) / seg) * Math.PI * 2;
      const pts = [[q[0] + Math.cos(t0) * r0, this.y + h0, q[2] + Math.sin(t0) * r0], [q[0] + Math.cos(t0) * r1, this.y + h1, q[2] + Math.sin(t0) * r1],
        [q[0] + Math.cos(t1) * r1, this.y + h1, q[2] + Math.sin(t1) * r1], [q[0] + Math.cos(t1) * r0, this.y + h0, q[2] + Math.sin(t1) * r0]];
      const hint = [Math.cos((t0 + t1) / 2), (r0 - r1) / Math.max(1, h1 - h0), Math.sin((t0 + t1) / 2)];
      const u0 = (k / seg) * circ / uv[0], u1 = ((k + 1) / seg) * circ / uv[0];
      if (r1 < 0.01) face(bk, [pts[0], pts[1], pts[3]], hint, tint, [u0, 0, (u0 + u1) / 2, (h1 - h0) / uv[1], u1, 0]);
      else face(bk, pts, hint, tint, [u0, 0, u0, (h1 - h0) / uv[1], u1, (h1 - h0) / uv[1], u1, 0]);
      if (cap && r1 > 0.01) face(bk, [[q[0], this.y + h1, q[2]], pts[1], pts[2]], [0, 1, 0], tint, [0.5, 0.5, 0.5 + Math.cos(t0) * 0.5, 0.5 + Math.sin(t0) * 0.5, 0.5 + Math.cos(t1) * 0.5, 0.5 + Math.sin(t1) * 0.5]);
    }
    if (collide) this.col.push({ type: 'circle', x: q[0] + this.x0, z: q[2] + this.z0, r: Math.max(r0, r1), y0: this.y + h0 - 1, y1: this.y + h1, bld: true });
  }
  sphere(key, a, b, hc, r, segU = 24, segV = 14, tint = W, minH = -Infinity) {
    const q = this.P(a, b, 0), bk = this.B(key);
    const cy = this.y + hc;
    for (let j = 0; j < segV; j++) {
      const p0 = -Math.PI / 2 + (j / segV) * Math.PI, p1 = -Math.PI / 2 + ((j + 1) / segV) * Math.PI;
      const y0 = cy + Math.sin(p0) * r, y1 = cy + Math.sin(p1) * r;
      if (y1 < this.y + minH) continue;
      const c0 = Math.cos(p0) * r, c1 = Math.cos(p1) * r;
      for (let k = 0; k < segU; k++) {
        const t0 = (k / segU) * Math.PI * 2, t1 = ((k + 1) / segU) * Math.PI * 2;
        const pts = [[q[0] + Math.cos(t0) * c0, y0, q[2] + Math.sin(t0) * c0], [q[0] + Math.cos(t0) * c1, y1, q[2] + Math.sin(t0) * c1],
          [q[0] + Math.cos(t1) * c1, y1, q[2] + Math.sin(t1) * c1], [q[0] + Math.cos(t1) * c0, y0, q[2] + Math.sin(t1) * c0]];
        const hint = out(pts, [q[0], cy, q[2]]);
        if (c0 < 0.01) face(bk, [pts[0], pts[1], pts[2]], hint, tint);
        else if (c1 < 0.01) face(bk, [pts[0], pts[1], pts[3]], hint, tint);
        else face(bk, pts, hint, tint, [k / segU * 6, j / segV * 3, k / segU * 6, (j + 1) / segV * 3, (k + 1) / segU * 6, (j + 1) / segV * 3, (k + 1) / segU * 6, j / segV * 3]);
      }
    }
  }
  /* four-sided spire (ridge = 0) or hip roof (ridge > 0, along the local a axis) */
  spire(key, a, b, hw, hd, h0, h1, tint, ridge = 0) {
    const bk = this.B(key);
    const C = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => this.P(a + u, b + v, h0));
    const R0 = this.P(a - ridge, b, h1), R1 = this.P(a + ridge, b, h1);
    const o = this.P(a, b, h0);
    if (ridge > 0) {
      face(bk, [C[0], R0, R1, C[1]], out([C[0], C[1]], o), tint);
      face(bk, [C[2], R1, R0, C[3]], out([C[2], C[3]], o), tint);
    } else {
      face(bk, [C[0], R0, C[1]], out([C[0], C[1]], o), tint);
      face(bk, [C[2], R0, C[3]], out([C[2], C[3]], o), tint);
    }
    face(bk, [C[1], R1, C[2]], out([C[1], C[2]], o), tint);
    face(bk, [C[3], R0, C[0]], out([C[3], C[0]], o), tint);
  }
  /* gable roof along the local a axis */
  gable(key, a, b, hw, hd, h0, rh, tint) {
    const bk = this.B(key);
    const C = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => this.P(a + u, b + v, h0));
    const R0 = this.P(a - hw, b, h0 + rh), R1 = this.P(a + hw, b, h0 + rh);
    const o = this.P(a, b, h0);
    face(bk, [C[0], R0, R1, C[1]], out([C[0], C[1], R0, R1], o), tint, [0, 0, 0, 2, hw / 2, 2, hw / 2, 0]);
    face(bk, [C[2], R1, R0, C[3]], out([C[2], C[3], R0, R1], o), tint, [0, 0, 0, 2, hw / 2, 2, hw / 2, 0]);
    face(this.B('plain'), [C[1], R1, C[2]], out([C[1], C[2]], o), tint);
    face(this.B('plain'), [C[3], R0, C[0]], out([C[3], C[0]], o), tint);
  }
}

/* Generic church with a west tower */
function church(L, s, wall, wallTint, roofKey, roofTint, spireTint, towerH, spireH) {
  const len = 34 * s, wid = 13 * s, h = 11 * s;
  L.box(wall, 0, 0, len / 2, wid / 2, -1, h, wallTint, [4, 6], true);
  L.gable(roofKey, 0, 0, len / 2 + 0.4, wid / 2 + 0.6, h, wid * 0.62, roofTint);
  L.box(wall, len / 2 - 0.6, wid * 0.35, 6 * s, 4.5 * s, h - 2, h + 2.5 * s, wallTint, [4, 6]);
  const tw = 4.2 * s;
  L.box(wall, -len / 2 - tw + 0.5, 0, tw, tw, -1, towerH * s, wallTint, [4, 6], true);
  L.spire(roofKey === 'plain' ? 'plain' : 'metal', -len / 2 - tw + 0.5, 0, tw + 0.2, tw + 0.2, towerH * s, (towerH + spireH) * s, spireTint);
}

export function buildLandmark(B, poi, ground, x0, z0, colliders, avail) {
  const h = ground(poi.x, poi.z);
  const L = new LB(B, poi.x - x0, poi.z - z0, poi.rot || 0, h, colliders, x0, z0);
  const s = Math.max(0.45, Math.min(1, avail / 55));
  switch (poi.landmark) {
    case 'cityhall': {
      // Stadshuset: brick wings round a courtyard, tall tower with a copper lantern and three crowns
      const lw = 46 * s, ld = 30 * s, wing = 12 * s, hh = 22;
      L.box('wall_brick', 0, -ld + wing / 2, lw, wing / 2, -1, hh, W, [4, 4], true);
      L.box('wall_brick', 0, ld - wing / 2, lw, wing / 2, -1, hh, W, [4, 4], true);
      L.box('wall_brick', -lw + wing / 2, 0, wing / 2, ld, -1, hh, W, [4, 4], true);
      L.box('wall_brick', lw - wing / 2, 0, wing / 2, ld, -1, hh - 6, W, [4, 4], true);
      L.gable('plain', 0, -ld + wing / 2, lw, wing / 2 + 0.3, hh, 5, COPPER);
      L.gable('plain', 0, ld - wing / 2, lw, wing / 2 + 0.3, hh, 5, COPPER);
      const tx = lw - 9 * s, tz = -ld + 9 * s;
      L.box('wall_brick', tx, tz, 8 * s, 8 * s, -1, 24, W, [4, 5], true);
      L.box('plain', tx, tz, 8 * s, 8 * s, 24, 78, BRICK);
      for (const [a, b, hw, hd] of [[0, -8 * s - 0.05, 0.7, 0.05], [0, 8 * s + 0.05, 0.7, 0.05], [-8 * s - 0.05, 0, 0.05, 0.7], [8 * s + 0.05, 0, 0.05, 0.7]]) L.box('plain', tx + a, tz + b, hw, hd, 40, 70, DARK);
      L.box('plain', tx, tz, 6 * s, 6 * s, 78, 88, COPPER);
      L.spire('plain', tx, tz, 6.2 * s, 6.2 * s, 88, 96, COPPER);
      L.cyl('metal', tx, tz, 0.6, 0.35, 96, 103, 8, GOLD);
      for (const k of [0, 1, 2]) L.cyl('metal', tx + (k - 1) * 0.9, tz, 0.45, 0.6, 103 + k * 0.4, 104.2 + k * 0.4, 8, GOLD);
      break;
    }
    case 'globe': {
      const r = 55 * Math.max(0.6, s);
      L.sphere('plain', 0, 0, r * 0.55, r, 32, 18, lin(0xf2f2ee), -1);
      L.cyl('wall_concrete', 0, 0, r * 0.86, r * 0.86, -1, 2.5, 32, W);
      colliders.push({ type: 'circle', x: poi.x, z: poi.z, r: r * 0.95, y0: h - 1, y1: h + r * 1.5, bld: true });
      break;
    }
    case 'tvtower': {
      L.box('wall_concrete', 0, 0, 7, 7, -1, 128, W, [3, 3.4], true);
      for (const [a, b] of [[-7.4, 0], [7.4, 0], [0, -7.4], [0, 7.4]]) L.box('wall_concrete', a, b, Math.abs(a) > 0 ? 0.4 : 2.2, Math.abs(b) > 0 ? 0.4 : 2.2, -1, 128, lin(0xd8d8d4));
      L.box('wall_glass', 0, 0, 9.5, 9.5, 128, 146, W, [3, 3]);
      L.box('wall_concrete', 0, 0, 10, 10, 146, 149, W);
      L.cyl('metal', 0, 0, 1.6, 0.6, 149, 172, 8, lin(0xd0d0d0));
      L.box('wall_concrete', 0, 0, 14, 12, -1, 6, W, [4, 4], true);
      break;
    }
    case 'cathedral': {
      // Uppsala-style brick cathedral: long nave, transept, two tall west towers with slender spires
      const len = 46 * s, wid = 12 * s, nh = 27;
      L.box('wall_brick', 0, 0, len, wid, -1, nh, W, [4, 6], true);
      L.gable('plain', 0, 0, len, wid + 0.6, nh, 14, lin(0x3c4a44));
      L.box('wall_brick', len * 0.25, 0, wid, len * 0.42, -1, nh, W, [4, 6], true);
      L.gable('plain', len * 0.25, 0, wid, len * 0.42, nh, 14, lin(0x3c4a44));
      for (const b of [-wid + 5 * s, wid - 5 * s]) {
        L.box('wall_brick', -len - 5 * s, b, 6 * s, 6 * s, -1, 62, W, [4, 6], true);
        L.spire('plain', -len - 5 * s, b, 6.2 * s, 6.2 * s, 62, 116, COPPER);
        L.cyl('metal', -len - 5 * s, b, 0.3, 0.1, 116, 120, 6, GOLD);
      }
      break;
    }
    case 'church_big':
      church(L, 1.5 * s + 0.3, 'wall_old', lin(0xd8c8a8), 'plain', COPPER, COPPER, 40, 34);
      break;
    case 'church_red': {
      const len = 40 * s, wid = 14 * s;
      L.box('wall_brick', 0, 0, len / 2, wid / 2, -1, 18, W, [4, 6], true);
      L.gable('roof_tile', 0, 0, len / 2 + 0.4, wid / 2 + 0.6, 18, 8, W);
      for (const b of [-wid / 2 + 3, wid / 2 - 3]) {
        L.box('wall_brick', -len / 2 - 3, b, 3.6, 3.6, -1, 66, W, [4, 6], true);
        L.cyl('plain', -len / 2 - 3, b, 3.8, 0.2, 66, 82, 12, COPPER);
      }
      break;
    }
    case 'church': case 'village_church':
      church(L, 1, 'wall_plaster', lin(0xf4f1ea), 'roof_sheet', lin(0x3a3d42), DARK, 17, 15);
      break;
    case 'castle_pink': {
      const len = 55 * s, wid = 11 * s, hh = 21;
      const pink = lin(0xdc9a8c);
      L.box('wall_plaster', 0, 0, len, wid, -1, hh, pink, [4, 4], true);
      L.gable('roof_sheet', 0, 0, len, wid + 0.5, hh, 8, lin(0x3d4146));
      for (const a of [-len, len]) {
        L.cyl('wall_plaster', a, 0, 11 * s, 11 * s, -1, hh + 6, 20, pink, [4, 4], true, true);
        L.cyl('plain', a, 0, 11.4 * s, 4 * s, hh + 6, hh + 13, 20, lin(0x3d4146));
        L.cyl('plain', a, 0, 3 * s, 0.3, hh + 13, hh + 20, 12, lin(0x3d4146));
      }
      break;
    }
    case 'castle': {
      const half = 20 * s, wing = 9 * s, hh = 20, stone = lin(0xcfc6b4);
      for (const [a, b, hw, hd] of [[0, -half + wing / 2, half, wing / 2], [0, half - wing / 2, half, wing / 2], [-half + wing / 2, 0, wing / 2, half], [half - wing / 2, 0, wing / 2, half]]) {
        L.box('wall_old', a, b, hw, hd, -1, hh, stone, [4, 4], true);
        L.gable('roof_sheet', a, b, hw, hd + 0.4, hh, 6, lin(0x3a3d40));
      }
      for (const [a, b] of [[-half, -half], [half, -half], [half, half], [-half, half]]) {
        L.cyl('wall_old', a, b, 8 * s, 8 * s, -1, hh + 6, 18, stone, [4, 4], true, true);
        L.cyl('plain', a, b, 8.3 * s, 0.3, hh + 6, hh + 18, 18, COPPER);
      }
      break;
    }
    case 'lipstick': {
      const red = lin(0xc4282b);
      L.box('wall_plaster', 0, 0, 10, 11, -1, 62, lin(0xf0eeea), [3.5, 3.3], true);
      L.box('wall_plaster', 0, 0, 10, 11, 62, 86, red, [3.5, 3.3]);
      L.box('plain', 0, 0, 10.3, 11.3, 86, 87.2, red);
      break;
    }
    case 'crane': {
      const green = lin(0x3f7d55);
      for (const a of [-16, 16]) {
        for (const b of [-6, 6]) L.box('metal', a, b, 1.2, 1.2, -1, 58, green, [4, 4], true);
        L.box('metal', a, 0, 1.2, 6, 52, 55, green);
      }
      L.box('metal', 6, 0, 52, 2.4, 58, 66, green);
      L.box('metal', 6, 0, 52, 0.4, 66, 72, green);
      L.box('plain', -40, 0, 5, 4, 50, 58, lin(0xe8e8e2));
      break;
    }
    case 'tower':
      for (const [a, b, hh] of [[-16, -6, 98], [6, 10, 82], [18, -12, 110]]) L.box('wall_glass', a * s, b * s, 10, 10, -1, hh, W, [3.2, 3.3], true);
      L.box('wall_glass', 0, 0, 30 * s, 22 * s, -1, 14, W, [4, 4], true);
      break;
    case 'torso': {
      // nine stacked cubes, each turned a little more: 90 degrees over the full height
      for (let k = 0; k < 9; k++) {
        const y0 = k * 20.5, yaw = (k / 8) * Math.PI / 2;
        L.boxR('wall_plaster', 0, 0, 12, 11, y0 - (k ? 0 : 1), y0 + 19, yaw, lin(0xf2f2f0), [3.2, 3.1]);
        L.boxR('metal', 0, 0, 12.3, 11.3, y0 + 19, y0 + 20.5, yaw, lin(0x9aa0a6));
      }
      L.cyl('metal', -13, 0, 1.2, 1.2, -1, 190, 8, lin(0xc8ccd0));
      colliders.push({ type: 'circle', x: poi.x, z: poi.z, r: 15, y0: h - 1, y1: h + 190, bld: true });
      break;
    }
    case 'kiruna_church': {
      // dark red timber church shaped like a Sami goahti: walls almost hidden under a huge steep roof
      const red = lin(0x7a2a24);
      L.box('wall_falu', 0, 0, 22 * s, 16 * s, -1, 4, W, [4, 4], true);
      L.spire('roof_sheet', 0, 0, 23 * s, 17 * s, 4, 30, lin(0x5a2420), 9 * s);
      L.box('wall_falu', 0, 0, 2.4, 2.4, 28, 34, W);
      L.spire('roof_sheet', 0, 0, 2.6, 2.6, 34, 40, red);
      L.box('wall_falu', 28 * s, 10 * s, 3, 3, -1, 16, W, [4, 4], true);
      L.spire('roof_sheet', 28 * s, 10 * s, 3.3, 3.3, 16, 24, red);
      break;
    }
    case 'clocktower': {
      L.box('wall_brick', 0, 0, 20 * s, 14 * s, -1, 12, W, [4, 4], true);
      L.box('wall_brick', -12 * s, 0, 4, 4, -1, 30, W, [4, 4], true);
      for (const [a, b] of [[-3.6, -3.6], [3.6, -3.6], [3.6, 3.6], [-3.6, 3.6]]) L.box('metal', -12 * s + a, b, 0.25, 0.25, 30, 42, DARK);
      for (const y of [33, 36, 39, 42]) L.box('metal', -12 * s, 0, 3.8, 3.8, y, y + 0.25, DARK);
      L.spire('metal', -12 * s, 0, 4, 4, 42, 47, DARK);
      break;
    }
    case 'mine': {
      const grey = lin(0x5c5852), rust = lin(0x7d4a32);
      // terraced spoil heap
      for (let k = 0; k < 6; k++) L.cyl('plain', 20 * s, 20 * s, (42 - k * 6.5) * s, (39 - k * 6.5) * s, k * 7 - 1, k * 7 + 7, 20, grey, [4, 4], true);
      colliders.push({ type: 'circle', x: poi.x + 20 * s, z: poi.z + 20 * s, r: 40 * s, y0: h - 1, y1: h + 42, bld: true });
      // headframe and plant
      L.box('metal', -20 * s, -15 * s, 4, 4, -1, 52, rust, [4, 4], true);
      L.box('wall_metal', -20 * s, -15 * s, 6, 6, 52, 60, rust);
      L.box('wall_metal', -32 * s, -22 * s, 14, 9, -1, 20, lin(0x8a8f94), [4, 4], true);
      L.box('metal', -8 * s, -4 * s, 1.4, 22, 18, 21, rust);
      break;
    }
    case 'goat': {
      // Gävlebocken: giant straw goat with red ribbons (put up for Advent, gone after New Year)
      const parts = [];
      const G = (k) => { const bk = B('goat_' + k); parts.push(bk); return bk; };
      const L2 = new LB((k) => G(k === 'plain' ? 'straw' : k), poi.x - x0, poi.z - z0, poi.rot || 0, h, colliders, x0, z0);
      for (const [a, b] of [[-3.2, -1.6], [3.2, -1.6], [-3.2, 1.6], [3.2, 1.6]]) L2.box('plain', a, b, 0.6, 0.6, -0.5, 5.2, STRAW);
      L2.box('plain', 0, 0, 4.4, 2.0, 5.0, 8.4, STRAW, [4, 4]);
      L2.box('plain', 4.6, 0, 0.9, 0.9, 7.5, 11.5, STRAW);
      L2.box('plain', 5.6, 0, 1.6, 0.9, 10.8, 12.4, STRAW);
      L2.box('plain', 4.4, -0.7, 0.25, 0.25, 12.2, 14.6, STRAW); L2.box('plain', 4.4, 0.7, 0.25, 0.25, 12.2, 14.6, STRAW);
      L2.box('plain', -4.8, 0, 0.5, 0.4, 7.4, 9.4, STRAW);
      const L3 = new LB((k) => G('ribbon'), poi.x - x0, poi.z - z0, poi.rot || 0, h, colliders, x0, z0);
      L3.box('plain', 0, 0, 4.5, 2.1, 6.4, 6.9, RED); L3.box('plain', 4.6, 0, 0.95, 0.95, 9.0, 9.4, RED);
      for (const [a, b] of [[-3.2, -1.6], [3.2, -1.6], [-3.2, 1.6], [3.2, 1.6]]) L3.box('plain', a, b, 0.65, 0.65, 2.2, 2.6, RED);
      if (seasonState.xmas) colliders.push({ type: 'obb', x: poi.x, z: poi.z, hw: 6, hd: 2.5, rot: poi.rot || 0, y0: h - 1, y1: h + 14, bld: true });
      break;
    }
    case 'svampen': {
      L.cyl('wall_concrete', 0, 0, 5.5, 4.8, -1, 40, 16, W, [4, 4], true, true);
      L.cyl('wall_concrete', 0, 0, 6, 26, 40, 50, 28, lin(0xe4e2dc), [4, 4], false);
      L.cyl('wall_glass', 0, 0, 26, 26, 50, 55, 28, W, [3, 3], true);
      L.cyl('plain', 0, 0, 26.5, 24, 55, 56.5, 28, lin(0xd8d6d0));
      break;
    }
    case 'skrapan':
      L.box('wall_concrete', 0, 0, 11, 11, -1, 78, lin(0xd8d4cc), [3.2, 3.2], true);
      L.box('wall_glass', 0, 0, 9, 9, 78, 84, W, [3, 3]);
      L.box('plain', 0, 0, 9.5, 9.5, 84, 85, lin(0x6a6e72));
      break;
    case 'karnan': {
      L.box('wall_brick', 0, 0, 7.5, 7.5, -1, 33, W, [4, 5], true);
      for (let k = 0; k < 4; k++) for (let j = -2; j <= 2; j++) {
        const a = k % 2 === 0 ? j * 3 : (k === 1 ? 7 : -7), b = k % 2 === 0 ? (k === 0 ? -7 : 7) : j * 3;
        L.box('wall_brick', a, b, 0.6, 0.6, 33, 35, W);
      }
      break;
    }
    case 'fountain': {
      L.cyl('wall_concrete', 0, 0, 14, 14, -0.5, 0.5, 28, lin(0x9a9a96));
      L.cyl('glass', 0, 0, 12.8, 12.8, 0.4, 0.45, 28, lin(0x6a8aa0));
      L.box('glass', 0, 0, 1.8, 1.8, 0.5, 37, lin(0xb8d4e6));
      L.box('glow', 0, 0, 1.2, 1.2, 0.5, 36.5, W);
      colliders.push({ type: 'circle', x: poi.x, z: poi.z, r: 2.6, y0: h - 1, y1: h + 37, bld: true });
      break;
    }
    default:
      break;
  }
}
