/* =====================================================================
   Static & dynamic collision for vehicles (2D footprints with height
   ranges): circles (trees, poles), oriented boxes (buildings, cars) and
   segments (guard rails, parapets, cable barriers).
   ===================================================================== */

export class CollisionWorld {
  constructor(cell = 16) {
    this.cell = cell;
    this.grid = new Map();
    this.owners = new Map(); // owner key -> list of colliders
  }
  key(i, j) { return i * 100003 + j; }
  add(owner, list) {
    if (!list || !list.length) return;
    const C = this.cell;
    const reg = [];
    for (const c of list) {
      let x0, x1, z0, z1;
      if (c.type === 'circle') { x0 = c.x - c.r; x1 = c.x + c.r; z0 = c.z - c.r; z1 = c.z + c.r; }
      else if (c.type === 'obb') { const r = Math.hypot(c.hw, c.hd); x0 = c.x - r; x1 = c.x + r; z0 = c.z - r; z1 = c.z + r; c.cs = Math.cos(c.rot); c.sn = Math.sin(c.rot); }
      else { x0 = Math.min(c.ax, c.bx) - 0.5; x1 = Math.max(c.ax, c.bx) + 0.5; z0 = Math.min(c.az, c.bz) - 0.5; z1 = Math.max(c.az, c.bz) + 0.5; }
      for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const k = this.key(i, j);
        let l = this.grid.get(k); if (!l) { l = []; this.grid.set(k, l); }
        l.push(c); reg.push(k);
      }
    }
    this.owners.set(owner, { list, reg });
  }
  remove(owner) {
    const o = this.owners.get(owner);
    if (!o) return;
    const set = new Set(o.list);
    for (const k of new Set(o.reg)) {
      const l = this.grid.get(k);
      if (!l) continue;
      const nl = l.filter((c) => !set.has(c));
      if (nl.length) this.grid.set(k, nl); else this.grid.delete(k);
    }
    this.owners.delete(owner);
  }
  query(x, z, r, out = []) {
    out.length = 0;
    const C = this.cell;
    const seen = new Set();
    for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++) for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++) {
      const l = this.grid.get(this.key(i, j));
      if (!l) continue;
      for (const c of l) if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  }
}

/* Car footprint vs collider. Returns contacts [{nx, nz, pen, px, pz}] with n pointing
   from the obstacle toward the car. box = {x, z, ax, az (right axis), bx, bz (forward axis), hw, hl, y0, y1} */
export function collideBox(box, c, contacts) {
  if (c.y1 != null && (c.y1 < box.y0 || c.y0 > box.y1)) return;
  if (c.type === 'circle') {
    const dx = c.x - box.x, dz = c.z - box.z;
    const lx = dx * box.ax + dz * box.az, lz = dx * box.bx + dz * box.bz;
    const cx = Math.max(-box.hw, Math.min(box.hw, lx)), cz = Math.max(-box.hl, Math.min(box.hl, lz));
    let ex = lx - cx, ez = lz - cz;
    let d = Math.hypot(ex, ez);
    if (d > c.r) return;
    let nlx, nlz, pen;
    if (d < 1e-6) {
      // centre inside the box: push along least overlap
      const ox = box.hw - Math.abs(lx), oz = box.hl - Math.abs(lz);
      if (ox < oz) { nlx = lx > 0 ? -1 : 1; nlz = 0; pen = ox + c.r; } else { nlx = 0; nlz = lz > 0 ? -1 : 1; pen = oz + c.r; }
    } else { nlx = -ex / d; nlz = -ez / d; pen = c.r - d; }
    const px = box.x + cx * box.ax + cz * box.bx, pz = box.z + cx * box.az + cz * box.bz;
    contacts.push({ nx: nlx * box.ax + nlz * box.bx, nz: nlx * box.az + nlz * box.bz, pen, px, pz, c });
  } else if (c.type === 'obb') {
    obbObb(box, c, contacts);
  } else if (c.type === 'seg') {
    const R = c.r || 0.25;
    // test the car's corners and edge midpoints against the capsule
    const pts = boxPoints(box);
    const sx = c.bx - c.ax, sz = c.bz - c.az;
    const L2 = sx * sx + sz * sz || 1;
    for (const [px, pz] of pts) {
      let t = ((px - c.ax) * sx + (pz - c.az) * sz) / L2;
      t = Math.max(0, Math.min(1, t));
      const qx = c.ax + sx * t, qz = c.az + sz * t;
      const dx = px - qx, dz = pz - qz;
      const d = Math.hypot(dx, dz);
      if (d < R) {
        let nx, nz;
        if (d > 1e-5) { nx = dx / d; nz = dz / d; } else { nx = -sz; nz = sx; const l = Math.hypot(nx, nz); nx /= l; nz /= l; if ((box.x - qx) * nx + (box.z - qz) * nz < 0) { nx = -nx; nz = -nz; } }
        // make sure normal points toward the car centre side
        if ((box.x - qx) * nx + (box.z - qz) * nz < 0) { nx = -nx; nz = -nz; }
        contacts.push({ nx, nz, pen: R - d, px, pz, c });
      }
    }
    // the segment's end points inside the box (car driving into the end of a rail)
    for (const [ex, ez] of [[c.ax, c.az], [c.bx, c.bz]]) collideBox(box, { type: 'circle', x: ex, z: ez, r: R, y0: c.y0, y1: c.y1 }, contacts);
  }
}
function boxPoints(b) {
  const pts = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -0.5], [1, -0.5], [-1, 0.5], [1, 0.5]]) {
    pts.push([b.x + b.ax * b.hw * u + b.bx * b.hl * v, b.z + b.az * b.hw * u + b.bz * b.hl * v]);
  }
  return pts;
}
function obbObb(a, c, contacts) {
  // c: {x,z,hw,hd,cs,sn}; its axes: u = (cs, sn) along width (hw), v = (-sn, cs) along depth (hd)
  if (c.cs == null) { c.cs = Math.cos(c.rot); c.sn = Math.sin(c.rot); }
  const cu = [c.cs, c.sn], cv = [-c.sn, c.cs];
  const axes = [[a.ax, a.az], [a.bx, a.bz], cu, cv];
  const dx = c.x - a.x, dz = c.z - a.z;
  let best = Infinity, bn = null;
  for (const ax of axes) {
    const ra = a.hw * Math.abs(a.ax * ax[0] + a.az * ax[1]) + a.hl * Math.abs(a.bx * ax[0] + a.bz * ax[1]);
    const rc = c.hw * Math.abs(cu[0] * ax[0] + cu[1] * ax[1]) + c.hd * Math.abs(cv[0] * ax[0] + cv[1] * ax[1]);
    const dist = dx * ax[0] + dz * ax[1];
    const ov = ra + rc - Math.abs(dist);
    if (ov <= 0) return;
    if (ov < best) { best = ov; bn = dist > 0 ? [-ax[0], -ax[1]] : [ax[0], ax[1]]; }
  }
  // contact point: deepest car corner inside c, else c corner inside car, else midpoint
  let px = a.x, pz = a.z, found = false, depth = -Infinity;
  for (const [x, z] of boxPoints(a).slice(0, 4)) {
    const lx = (x - c.x) * cu[0] + (z - c.z) * cu[1], lz = (x - c.x) * cv[0] + (z - c.z) * cv[1];
    if (Math.abs(lx) <= c.hw && Math.abs(lz) <= c.hd) { const dd = -(x * bn[0] + z * bn[1]); if (dd > depth) { depth = dd; px = x; pz = z; found = true; } }
  }
  if (!found) {
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = c.x + cu[0] * c.hw * u + cv[0] * c.hd * v, z = c.z + cu[1] * c.hw * u + cv[1] * c.hd * v;
      const lx = (x - a.x) * a.ax + (z - a.z) * a.az, lz = (x - a.x) * a.bx + (z - a.z) * a.bz;
      if (Math.abs(lx) <= a.hw && Math.abs(lz) <= a.hl) { px = x; pz = z; found = true; break; }
    }
  }
  if (!found) { px = (a.x + c.x) / 2; pz = (a.z + c.z) / 2; }
  contacts.push({ nx: bn[0], nz: bn[1], pen: best, px, pz, c });
}
