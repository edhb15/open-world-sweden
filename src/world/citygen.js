/* =====================================================================
   Procedural Swedish towns: warped street grid, districts, bridges,
   gateways, building lots, parks and points of interest.
   ===================================================================== */
import { RNG, clamp, lerp, smoothstep, noiseA, noiseB, noiseD, hashStr, hash2i, distToSeg } from '../core/math.js';
import { isWater, terrainWater } from './geo.js';

const STREET_NAMES = [
  'Storgatan', 'Kungsgatan', 'Drottninggatan', 'Järnvägsgatan', 'Skolgatan', 'Kyrkogatan', 'Torggatan', 'Nygatan', 'Hamngatan',
  'Sveavägen', 'Vasagatan', 'Fabriksgatan', 'Prästgatan', 'Östra Långgatan', 'Västra Vägen', 'Parkvägen', 'Strandvägen',
  'Björkvägen', 'Tallvägen', 'Granvägen', 'Ekvägen', 'Lönnvägen', 'Rönnvägen', 'Aspvägen', 'Lindvägen', 'Hasselvägen',
  'Sjövägen', 'Ängsvägen', 'Backvägen', 'Solvägen', 'Industrivägen', 'Verkstadsgatan', 'Bruksgatan', 'Ringvägen',
  'Klostergatan', 'Slottsgatan', 'Repslagargatan', 'Malmgatan', 'Bergsgatan', 'Odengatan', 'Karlavägen', 'Götgatan',
  'Hornsgatan', 'Folkungagatan', 'Linnégatan', 'Vallgatan', 'Regementsgatan', 'Södra Förstadsgatan', 'Lilla Torget',
  'Smedjegatan', 'Bryggargatan', 'Tullgatan', 'Postgatan', 'Stationsvägen', 'Idrottsvägen', 'Gamla Landsvägen',
];

export const ROOF_COLORS = { tile: 0x9b3b2a, darkTile: 0x6e2c22, black: 0x2f3236, copper: 0x5f9a85, metal: 0x5b6066, sheet: 0x3a3d40, slate: 0x4a4f57, green: 0x3f5f4a };

export function generateCity(net, city, gateways, world) {
  const rng = new RNG(hashStr(city.id));
  const big = city.size === 3;
  const sp = big ? 112 : city.size === 2 ? 118 : 124;
  const theta = rng.float(-0.5, 0.5) + (city.id === 'stockholm' ? 0.12 : 0);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const R = city.r;
  const N = Math.ceil(R / sp) + 1;
  const toWorld = (u, v) => [city.x + u * cs - v * sn, city.z + u * sn + v * cs];
  const nodeGrid = new Map();
  const key = (i, j) => i * 1000 + j;
  const majorStep = big ? 4 : 3;
  const isArterial = (i, j, axis) => (axis === 0 ? j % majorStep === 0 : i % majorStep === 0);
  const shapeR = (ang) => R * (0.9 + 0.12 * Math.sin(ang * 3 + rng.next() * 0) + 0.1 * noiseA(Math.cos(ang) * 1.3 + city.x * 0.001, Math.sin(ang) * 1.3));
  const oldTown = city.oldTown || null;

  // ---- lattice nodes
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    const arterialish = i % majorStep === 0 || j % majorStep === 0;
    const jit = arterialish ? 0.05 : 0.16;
    let u = i * sp + (hash2i(i, j, 11) - 0.5) * sp * jit;
    let v = j * sp + (hash2i(i, j, 12) - 0.5) * sp * jit;
    u += 18 * noiseB(u / 700 + city.x, v / 700);
    v += 18 * noiseB(v / 700 - city.z, u / 700);
    const [x, z] = toWorld(u, v);
    const d = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    if (d > shapeR(ang)) continue;
    if (isWater(x, z)) continue;
    // keep away from water edge a little
    if (isWater(x + 14, z) || isWater(x - 14, z) || isWater(x, z + 14) || isWater(x, z - 14)) continue;
    nodeGrid.set(key(i, j), { i, j, x, z, u, v, d, node: null });
  }
  const dist = (gn) => gn.d / R;
  const districtOf = (u, v, x, z) => {
    const d = Math.hypot(u, v) / R;
    if (oldTown && Math.hypot(x - oldTown.x, z - oldTown.z) < oldTown.r) return 'old';
    if (d < (big ? 0.33 : 0.25)) return 'core';
    if (d < (big ? 0.62 : 0.52)) return 'inner';
    // industrial sector
    const a = Math.atan2(v, u);
    const ia = city.industrialAngle ?? (hashStr(city.id + 'ind') % 628) / 100;
    let da = Math.abs(((a - ia + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (da < 0.55 && d > 0.6) return 'industrial';
    return 'villa';
  };

  // ---- edges
  const edges = [];
  const addEdge = (a, b, axis, forceBridge = false) => {
    const art = isArterial(a.i, a.j, axis) || forceBridge;
    // water check along the edge
    let wetRun = 0, wet = 0;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(L / 8);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (isWater(lerp(a.x, b.x, t), lerp(a.z, b.z, t))) { wet++; }
    }
    wetRun = wet * 8;
    if (wetRun > 0) {
      const allowed = art ? 420 : big ? 160 : 90;
      const p = art ? 1 : big ? 0.45 : 0.25;
      if (wetRun > allowed || hash2i(a.i * 3 + axis, a.j, 77) > p) return;
    }
    const dmid = (dist(a) + dist(b)) / 2;
    if (!art && dmid > 0.55 && hash2i(a.i, a.j * 7 + axis, 91) < 0.1) return; // irregular outskirts
    edges.push({ a, b, axis, art, wet: wetRun > 0 });
  };
  // nodes that were dropped because they were in water (not outside the town shape)
  const wetGap = (i, j) => {
    let u = i * sp, v = j * sp;
    const [x, z] = toWorld(u, v);
    return Math.hypot(u, v) < R * 1.05 && isWater(x, z);
  };
  for (const gn of nodeGrid.values()) {
    for (const axis of [0, 1]) {
      const di = axis === 0 ? 1 : 0, dj = axis === 0 ? 0 : 1;
      const nb = nodeGrid.get(key(gn.i + di, gn.j + dj));
      if (nb) { addEdge(gn, nb, axis); continue; }
      // bridge over water along arterials (and some streets in big cities)
      const art = isArterial(gn.i, gn.j, axis);
      if (!art && !(big && hash2i(gn.i * 5 + axis, gn.j, 33) < 0.35)) continue;
      for (let k = 2; k <= 5; k++) {
        const far = nodeGrid.get(key(gn.i + di * k, gn.j + dj * k));
        let ok = true;
        for (let q = 1; q < k; q++) if (!wetGap(gn.i + di * q, gn.j + dj * q) && !nodeGrid.has(key(gn.i + di * q, gn.j + dj * q))) { ok = false; break; }
        if (!ok) break;
        if (far) { addEdge(gn, far, axis, true); break; }
      }
    }
  }
  // keep largest connected component
  const adj = new Map();
  for (const e of edges) {
    (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a);
  }
  let bestComp = null;
  const seen = new Set();
  for (const gn of adj.keys()) {
    if (seen.has(gn)) continue;
    const comp = new Set([gn]);
    const st = [gn];
    seen.add(gn);
    while (st.length) {
      const c = st.pop();
      for (const nb of adj.get(c) || []) if (!seen.has(nb)) { seen.add(nb); comp.add(nb); st.push(nb); }
    }
    if (!bestComp || comp.size > bestComp.size) bestComp = comp;
  }
  const keepEdges = edges.filter((e) => bestComp && bestComp.has(e.a) && bestComp.has(e.b));

  // ---- nodes
  const nodeOf = (gn) => {
    if (!gn.node) gn.node = net.addNode(gn.x, gn.z, { city: city.id });
    return gn.node;
  };
  // names per grid line
  const lineName = (axis, idx) => STREET_NAMES[(hashStr(city.id) + axis * 31 + idx * 7 + 1000) % STREET_NAMES.length];
  const roadsOut = [];
  for (const e of keepEdges) {
    const a = nodeOf(e.a), b = nodeOf(e.b);
    const um = (e.a.u + e.b.u) / 2, vm = (e.a.v + e.b.v) / 2;
    const xm = (e.a.x + e.b.x) / 2, zm = (e.a.z + e.b.z) / 2;
    const dist0 = districtOf(um, vm, xm, zm);
    let type;
    if (e.art) type = 'avenue';
    else if (dist0 === 'old') type = 'oldtown';
    else if (dist0 === 'core' || dist0 === 'inner') type = 'street';
    else if (dist0 === 'industrial') type = 'access';
    else type = 'residential';
    if (e.art && dist0 === 'old') type = 'street';
    if (e.art && !big && Math.hypot(um, vm) > R * 0.7) type = 'street';
    const lineIdx = e.axis === 0 ? e.a.j : e.a.i;
    const speed = type === 'avenue' ? 50 : type === 'street' ? 40 : 30;
    const r = net.addRoad(a, b, type, {
      city: city.id, district: dist0, speed,
      name: lineName(e.axis, lineIdx), route: city.id + ':' + e.axis + ':' + lineIdx,
    });
    if (type === 'street' && dist0 === 'core' && hash2i(e.a.i, e.a.j, 5 + e.axis) < 0.4) r.xs = (r.xs, r.xs); // keep
    roadsOut.push(r);
  }

  // ---- junction control & roundabouts
  for (const gn of bestComp || []) {
    if (!gn.node) continue;
    const n = gn.node;
    const deg = n.ends.length;
    const artCount = n.ends.filter((e) => e.road.type === 'avenue').length;
    const dd = dist(gn);
    if (artCount >= 3 && deg >= 3) {
      if (dd > 0.5 && hash2i(gn.i, gn.j, 3) < 0.65) { n.kind = 'roundabout'; n.roundabout = { r: 17 }; }
      else n.control = 'signal';
    }
  }

  // ---- gateways
  const gws = [];
  for (const g of gateways) {
    const dirx = Math.sin(g.bearing), dirz = -Math.cos(g.bearing); // bearing: radians clockwise from north
    const gx = city.x + dirx * (R + 70), gz = city.z + dirz * (R + 70);
    // best boundary node: far along direction, close to the ray
    let best = null, bs = -Infinity;
    for (const gn of bestComp || []) {
      if (!gn.node) continue;
      const rx = gn.x - city.x, rz = gn.z - city.z;
      const along = rx * dirx + rz * dirz;
      const perp = Math.abs(rx * dirz - rz * dirx);
      const isArt = gn.node.ends.some((e) => e.road.type === 'avenue');
      const sc = along - perp * 1.4 + (isArt ? 60 : 0) - (gn.node.kind === 'roundabout' ? 80 : 0);
      if (sc > bs) { bs = sc; best = gn; }
    }
    if (!best) continue;
    const gwNode = net.addNode(gx, gz, { city: city.id, name: city.name, kind: g.roundabout ? 'roundabout' : null, roundabout: g.roundabout ? { r: 16 } : null });
    const ctrl = [[best.x, best.z], [lerp(best.x, gx, 0.5) + dirz * 10, lerp(best.z, gz, 0.5) - dirx * 10], [gx, gz]];
    const L = Math.hypot(gx - best.x, gz - best.z);
    if (L < 40) ctrl.splice(1, 1);
    net.addRoad(best.node, gwNode, g.type || 'avenue', { city: city.id, speed: 50, name: g.name || null, ref: g.ref || null, ctrl, district: 'gateway' });
    gws.push({ ...g, node: gwNode, x: gx, z: gz });
  }

  // ---- lots & features
  const lots = [], parks = [], parkings = [], pois = [];
  const cells = [];
  for (const gn of bestComp || []) {
    const b = nodeGrid.get(key(gn.i + 1, gn.j)), c = nodeGrid.get(key(gn.i + 1, gn.j + 1)), d = nodeGrid.get(key(gn.i, gn.j + 1));
    if (!b || !c || !d || !b.node || !c.node || !d.node) continue;
    cells.push({ i: gn.i, j: gn.j, P: [gn, b, c, d] });
  }
  // reserve special blocks
  const special = (city.features || []).slice();
  const reserved = new Map();
  for (const f of special) {
    // nearest cell to requested position
    let best = null, bd = Infinity;
    for (const cell of cells) {
      if (reserved.has(cell)) continue;
      const cx = (cell.P[0].x + cell.P[2].x) / 2, cz = (cell.P[0].z + cell.P[2].z) / 2;
      const fx = city.x + (f.e || 0) * 1000, fz = city.z - (f.n || 0) * 1000;
      const dd = Math.hypot(cx - fx, cz - fz);
      if (dd < bd) { bd = dd; best = cell; }
    }
    if (best) reserved.set(best, f);
  }
  // commercial: supermarket near a gateway, petrol stations at gateways
  for (const g of gws.slice(0, 2)) {
    let best = null, bd = Infinity;
    for (const cell of cells) {
      if (reserved.has(cell)) continue;
      const cx = (cell.P[0].x + cell.P[2].x) / 2, cz = (cell.P[0].z + cell.P[2].z) / 2;
      const dd = Math.hypot(cx - g.x, cz - g.z);
      if (dd < bd) { bd = dd; best = cell; }
    }
    if (best) reserved.set(best, { type: reserved.size % 2 ? 'petrol' : 'supermarket' });
  }
  if (cells.length > 20) {
    // a car dealership on an outer block, a park in the inner city
    const outer = cells.filter((c) => !reserved.has(c) && Math.hypot(c.P[0].u, c.P[0].v) > R * 0.55);
    if (outer.length) reserved.set(outer[Math.floor(rng.next() * outer.length)], { type: 'dealership' });
    const outer2 = cells.filter((c) => !reserved.has(c) && Math.hypot(c.P[0].u, c.P[0].v) > R * 0.45);
    if (outer2.length) reserved.set(outer2[Math.floor(rng.next() * outer2.length)], { type: 'petrol' });
  }

  const roadAlong = (A, B) => {
    for (const e of A.node.ends) if (e.road.otherNode(A.node) === B.node) return e.road;
    return null;
  };
  for (const cell of cells) {
    const P = cell.P;
    const cu = (P[0].u + P[2].u) / 2, cv = (P[0].v + P[2].v) / 2;
    const cx = (P[0].x + P[1].x + P[2].x + P[3].x) / 4, cz = (P[0].z + P[1].z + P[2].z + P[3].z) / 4;
    const district = districtOf(cu, cv, cx, cz);
    // inset polygon from streets
    const sides = [];
    for (let k = 0; k < 4; k++) {
      const A = P[k], B = P[(k + 1) % 4];
      const r = roadAlong(A, B);
      const hw = r ? Math.max(r.xs.outerR, -r.xs.outerL) : 0;
      sides.push({ A, B, road: r, inset: hw + (district === 'villa' ? 4 : district === 'industrial' ? 6 : 1.2) });
    }
    const poly = insetQuad(P, sides);
    if (!poly) continue;
    if (polyArea(poly) < 600) continue;
    // water inside block?
    if (isWater(cx, cz)) continue;
    const feat = reserved.get(cell);
    const rr = new RNG(hash2i(cell.i, cell.j, hashStr(city.id)));
    const ctx = { city, district, rr, lots, parks, parkings, pois, sides, P, big };
    if (feat) { fillFeature(ctx, poly, feat); continue; }
    const parkChance = district === 'core' ? 0.08 : district === 'inner' ? 0.14 : district === 'villa' ? 0.04 : 0;
    if (rr.chance(parkChance)) { parks.push({ poly, kind: 'park' }); continue; }
    if (district === 'core' || district === 'old') perimeterBlock(ctx, poly, district === 'old');
    else if (district === 'inner') (rr.chance(0.5) ? slabBlock(ctx, poly) : perimeterBlock(ctx, poly, false));
    else if (district === 'industrial') industrialBlock(ctx, poly);
    else villaBlock(ctx, poly);
  }

  // start spots (residential streets) for player spawn
  const resRoads = net.roads.filter((r) => r.city === city.id && r.type === 'residential' && r.len > 70);
  return { city, gateways: gws, lots, parks, parkings, pois, residential: resRoads, roads: roadsOut, theta };
}

/* ------------------------------ Geometry ------------------------------ */
function insetQuad(P, sides) {
  // offset each side line inward by its inset, then intersect consecutive lines
  const cx = (P[0].x + P[1].x + P[2].x + P[3].x) / 4, cz = (P[0].z + P[1].z + P[2].z + P[3].z) / 4;
  const lines = sides.map((s) => {
    let dx = s.B.x - s.A.x, dz = s.B.z - s.A.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let nx = -dz, nz = dx;
    // point normal toward centre
    if ((cx - s.A.x) * nx + (cz - s.A.z) * nz < 0) { nx = -nx; nz = -nz; }
    return { px: s.A.x + nx * s.inset, pz: s.A.z + nz * s.inset, dx, dz };
  });
  const out = [];
  for (let k = 0; k < 4; k++) {
    const a = lines[(k + 3) % 4], b = lines[k];
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-3) return null;
    const t = ((b.px - a.px) * b.dz - (b.pz - a.pz) * b.dx) / den;
    out.push([a.px + a.dx * t, a.pz + a.dz * t]);
  }
  // sanity: inset must not flip
  if (polyArea(out) <= 0 && polyArea(out.slice().reverse()) <= 0) return null;
  return out;
}
export function polyArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] * p[i][1] - p[i][0] * p[j][1]);
  return Math.abs(a / 2);
}

// Lot helper: rectangle centred at (x,z) with width w (along frontage), depth d, rotation (angle of frontage dir)
function lot(ctx, o) { ctx.lots.push({ city: ctx.city.id, district: ctx.district, ...o }); }

const PLASTER = [0xe9d8b4, 0xd9a66c, 0xe2c08d, 0xc9805e, 0xb85c43, 0xd4b48c, 0xe8e0cc, 0xc6b49a, 0xa9a28f, 0xd99a7a, 0xf0e4c4, 0xbfa37a];
const BRICK = [0x8f4a36, 0x9d5a43, 0x7a3e2f, 0xa56b52];
const FALU = 0x8e2a1f;
const VILLA_COLORS = [FALU, FALU, FALU, 0xf2efe6, 0xe8cf7a, 0xd9d4c4, 0x9fb3bd, 0x7d8f69, 0xc9b28c, 0xb24a32];

// iterate along each side of the inset polygon, placing frontage buildings
function frontage(ctx, poly, fn) {
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < 8) continue;
    dx /= L; dz /= L;
    // inward normal
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    let nx = -dz, nz = dx;
    if ((cx - a[0]) * nx + (cz - a[1]) * nz < 0) { nx = -nx; nz = -nz; }
    fn({ a, b, dx, dz, nx, nz, L, k });
  }
}

function perimeterBlock(ctx, poly, old) {
  const rr = ctx.rr;
  const depth = old ? rr.float(10, 13) : rr.float(12, 15);
  frontage(ctx, poly, ({ a, dx, dz, nx, nz, L, k }) => {
    // corners are handled by letting side 0/2 run full length, side 1/3 shortened by depth
    const shrink = k % 2 === 1 ? depth : 0;
    let t = shrink;
    const end = L - shrink;
    while (t < end - 6) {
      const w = Math.min(end - t, old ? rr.float(8, 15) : rr.float(14, 26));
      if (w < 6) break;
      const floors = old ? rr.int(4, 5) : ctx.big ? rr.int(5, 7) : ctx.district === 'core' ? rr.int(3, 5) : rr.int(3, 5);
      const cxl = a[0] + dx * (t + w / 2) + nx * depth / 2, czl = a[1] + dz * (t + w / 2) + nz * depth / 2;
      const brick = !old && rr.chance(0.25);
      lot(ctx, {
        kind: 'block', x: cxl, z: czl, w, d: depth, rot: Math.atan2(dz, dx), floors, floorH: old ? 3.2 : 3.1,
        color: brick ? rr.pick(BRICK) : rr.pick(PLASTER), style: old ? 'old' : brick ? 'brick' : 'plaster',
        roof: rr.chance(old ? 0.9 : 0.6) ? 'mansard' : 'flat', roofColor: rr.chance(0.5) ? ROOF_COLORS.copper : rr.chance(0.5) ? ROOF_COLORS.black : ROOF_COLORS.tile,
        shop: ctx.district === 'core' || old ? rr.chance(0.75) : rr.chance(0.25), fx: -nx, fz: -nz,
      });
      t += w;
    }
  });
  // courtyard is green
  const inner = shrinkPoly(poly, depth + 1);
  if (inner) ctx.parks.push({ poly: inner, kind: 'yard' });
}

function slabBlock(ctx, poly) {
  const rr = ctx.rr;
  // long axis of the block
  const a = poly[0], b = poly[1], d = poly[3];
  const ux = b[0] - a[0], uz = b[1] - a[1], vx = d[0] - a[0], vz = d[1] - a[1];
  const Lu = Math.hypot(ux, uz), Lv = Math.hypot(vx, vz);
  const long = Lu > Lv;
  const LL = long ? Lu : Lv, SS = long ? Lv : Lu;
  const dir = long ? [ux / Lu, uz / Lu] : [vx / Lv, vz / Lv];
  const perp = long ? [vx / Lv, vz / Lv] : [ux / Lu, uz / Lu];
  const nSlabs = Math.max(1, Math.floor((SS - 10) / 34));
  const floors = rr.chance(0.3) ? rr.int(7, 9) : rr.int(3, 4);
  const slabW = Math.min(LL - 14, rr.float(50, 85));
  const color = rr.pick([0xd8d2c4, 0xc9bfa9, 0xb9b6ad, 0xe3dccb, 0xa59a86, 0xcfb79a, 0x9c5b45]);
  for (let s = 0; s < nSlabs; s++) {
    const off = (s + 0.5) * (SS / nSlabs);
    const cx = a[0] + dir[0] * (LL / 2) + perp[0] * off, cz = a[1] + dir[1] * (LL / 2) + perp[1] * off;
    lot(ctx, { kind: 'slab', x: cx, z: cz, w: slabW, d: 11.5, rot: Math.atan2(dir[1], dir[0]), floors, floorH: 2.9, color, style: floors > 5 ? 'concrete' : 'lamell', roof: floors > 5 ? 'flat' : 'low', roofColor: ROOF_COLORS.sheet, balconies: true });
  }
  // parking strip
  if (SS > 60) {
    const cx = a[0] + dir[0] * (LL / 2) + perp[0] * (SS - 9), cz = a[1] + dir[1] * (LL / 2) + perp[1] * (SS - 9);
    ctx.parkings.push({ x: cx, z: cz, w: Math.min(LL - 16, 60), d: 14, rot: Math.atan2(dir[1], dir[0]), cars: 0.6 });
  }
  ctx.parks.push({ poly, kind: 'yard' });
}

function villaBlock(ctx, poly) {
  const rr = ctx.rr;
  frontage(ctx, poly, ({ a, dx, dz, nx, nz, L, k }) => {
    if (k % 2 === 1 && L < 80) return; // short sides: fewer houses
    let t = 6;
    while (t < L - 18) {
      const plotW = rr.float(21, 28);
      if (t + plotW > L - 6) break;
      const hw = rr.float(8.5, 11), hd = rr.float(7.5, 9.5);
      const setback = rr.float(6, 10);
      const cx = a[0] + dx * (t + plotW / 2) + nx * (setback + hd / 2), cz = a[1] + dz * (t + plotW / 2) + nz * (setback + hd / 2);
      const color = rr.pick(VILLA_COLORS);
      const floors = rr.chance(0.55) ? 2 : 1;
      lot(ctx, {
        kind: 'house', x: cx, z: cz, w: hw, d: hd, rot: Math.atan2(dz, dx), floors, floorH: 2.8, color,
        style: color === FALU ? 'falu' : 'wood', roof: 'gable', roofColor: rr.pick([ROOF_COLORS.tile, ROOF_COLORS.black, ROOF_COLORS.darkTile, ROOF_COLORS.slate]),
        trim: 0xf4f1ea, fx: -nx, fz: -nz, garden: true, plotW, plotD: setback + hd + 10, plotX: a[0] + dx * (t + plotW / 2), plotZ: a[1] + dz * (t + plotW / 2),
        garage: rr.chance(0.5),
      });
      t += plotW;
    }
  });
  ctx.parks.push({ poly, kind: 'garden' });
}

function industrialBlock(ctx, poly) {
  const rr = ctx.rr;
  const c = centroid(poly);
  const a = poly[0], b = poly[1];
  const rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const area = polyArea(poly);
  const sz = Math.sqrt(area);
  const w = Math.min(sz * 0.8, rr.float(40, 80)), d = Math.min(sz * 0.6, rr.float(28, 50));
  lot(ctx, { kind: 'warehouse', x: c[0], z: c[1], w, d, rot, floors: 1, floorH: rr.float(8, 12), color: rr.pick([0x9aa3a8, 0x7f8c8d, 0xb7b09c, 0x8a3b2e, 0x4f6a7a, 0xc7c2b4]), style: 'metal', roof: 'flat', roofColor: ROOF_COLORS.metal });
  ctx.parkings.push({ x: c[0] + Math.cos(rot + Math.PI / 2) * (d / 2 + 10), z: c[1] + Math.sin(rot + Math.PI / 2) * (d / 2 + 10), w: w * 0.8, d: 14, rot, cars: 0.3, trucks: true });
}

function fillFeature(ctx, poly, f) {
  const c = centroid(poly);
  const a = poly[0], b = poly[1];
  const rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const rr = ctx.rr;
  if (f.type === 'supermarket') {
    lot(ctx, { kind: 'shop', x: c[0] + Math.cos(rot) * 12, z: c[1] + Math.sin(rot) * 12, w: 48, d: 32, rot, floors: 1, floorH: 6.5, color: 0xd9d4c8, style: 'shop', roof: 'flat', roofColor: ROOF_COLORS.metal, brand: 'MATKÖP' });
    ctx.parkings.push({ x: c[0] - Math.cos(rot) * 30, z: c[1] - Math.sin(rot) * 30, w: 40, d: 44, rot, cars: 0.55, lot: true });
    ctx.pois.push({ type: 'supermarket', x: c[0], z: c[1], name: 'Matköp ' + ctx.city.name, rot });
  } else if (f.type === 'petrol') {
    ctx.pois.push({ type: 'petrol', x: c[0], z: c[1], rot, name: 'Polar ' + ctx.city.name, poly });
  } else if (f.type === 'dealership') {
    lot(ctx, { kind: 'shop', x: c[0] + Math.cos(rot) * 14, z: c[1] + Math.sin(rot) * 14, w: 36, d: 22, rot, floors: 1, floorH: 7, color: 0xe8ecef, style: 'glass', roof: 'flat', roofColor: ROOF_COLORS.metal, brand: 'BILHALLEN' });
    ctx.parkings.push({ x: c[0] - Math.cos(rot) * 18, z: c[1] - Math.sin(rot) * 18, w: 34, d: 28, rot, cars: 0.9, lot: true, showroom: true });
    ctx.pois.push({ type: 'dealership', x: c[0], z: c[1], rot, name: 'Bilhallen ' + ctx.city.name });
  } else if (f.type === 'landmark') {
    ctx.pois.push({ type: 'landmark', x: c[0], z: c[1], rot, landmark: f.landmark, name: f.name });
    ctx.parks.push({ poly, kind: 'square' });
  } else if (f.type === 'church') {
    ctx.pois.push({ type: 'landmark', x: c[0], z: c[1], rot, landmark: 'church', name: f.name || ctx.city.name + ' kyrka' });
    ctx.parks.push({ poly, kind: 'churchyard' });
  } else if (f.type === 'park') {
    ctx.parks.push({ poly, kind: 'park' });
  } else if (f.type === 'square') {
    ctx.parks.push({ poly, kind: 'square' });
    if (f.landmark) ctx.pois.push({ type: 'landmark', x: c[0], z: c[1], rot, landmark: f.landmark, name: f.name });
  } else {
    perimeterBlock(ctx, poly, false);
  }
}

export function centroid(p) {
  let x = 0, z = 0;
  for (const q of p) { x += q[0]; z += q[1]; }
  return [x / p.length, z / p.length];
}
function shrinkPoly(p, d) {
  const c = centroid(p);
  const out = p.map((q) => {
    const dx = q[0] - c[0], dz = q[1] - c[1];
    const l = Math.hypot(dx, dz);
    if (l < d * 1.5) return null;
    return [c[0] + dx * (1 - (d * 1.3) / l), c[1] + dz * (1 - (d * 1.3) / l)];
  });
  return out.includes(null) ? null : out;
}

/* ------------------------------ Villages ------------------------------ */
// A small village around a junction node on a rural road.
export function generateVillage(net, v, world) {
  const rng = new RNG(hashStr(v.name));
  const lots = [], parks = [], parkings = [], pois = [];
  const { x, z, dirx, dirz } = v; // dirx/dirz = main road direction
  const nx = -dirz, nz = dirx; // right of road
  const side = v.side || 1;
  // a short village street loop on one side
  const n0 = v.node;
  const L1 = rng.float(140, 220), L2 = rng.float(160, 260);
  const p1 = [x + nx * side * L1, z + nz * side * L1];
  const p2 = [p1[0] + dirx * L2, p1[1] + dirz * L2];
  const p3 = [x + dirx * L2 + nx * side * 8, z + dirz * L2 + nz * side * 8];
  const ok = (p) => !isWater(p[0], p[1]);
  const vroads = [];
  if (ok(p1) && ok(p2)) {
    const a = net.addNode(p1[0], p1[1], {});
    const b = net.addNode(p2[0], p2[1], {});
    vroads.push(net.addRoad(n0, a, 'residential', { name: 'Byvägen', speed: 30, ctrl: [[x, z], [lerp(x, p1[0], 0.5) + dirx * 10, lerp(z, p1[1], 0.5) + dirz * 10], p1], tags: { village: v.name } }));
    vroads.push(net.addRoad(a, b, 'residential', { name: 'Skolvägen', speed: 30, ctrl: [p1, [lerp(p1[0], p2[0], 0.5) + nx * side * 12, lerp(p1[1], p2[1], 0.5) + nz * side * 12], p2], tags: { village: v.name } }));
    if (v.node2) {
      vroads.push(net.addRoad(b, v.node2, 'residential', { name: 'Kyrkvägen', speed: 30, ctrl: [p2, [lerp(p2[0], v.node2.x, 0.5), lerp(p2[1], v.node2.z, 0.5)], [v.node2.x, v.node2.z]], tags: { village: v.name } }));
    }
  }
  // houses along village roads (both sides) and along the main road
  const placeAlong = (pts, both, gap = 26) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz);
      dx /= L; dz /= L;
      for (let t = 18; t < L - 14; t += rng.float(gap * 0.85, gap * 1.4)) {
        for (const sgn of both ? [1, -1] : [1]) {
          if (rng.chance(0.22)) continue;
          const off = 15 + rng.float(0, 6);
          const cx = a[0] + dx * t + -dz * sgn * off, cz = a[1] + dz * t + dx * sgn * off;
          if (isWater(cx, cz)) continue;
          const color = rng.chance(0.62) ? FALU : rng.pick(VILLA_COLORS);
          const big = rng.chance(0.15);
          lots.push({
            kind: big ? 'barn' : 'house', x: cx, z: cz, w: big ? rng.float(16, 24) : rng.float(8, 11), d: big ? rng.float(10, 14) : rng.float(7, 9),
            rot: Math.atan2(dz, dx), floors: big ? 1 : rng.chance(0.5) ? 2 : 1, floorH: big ? 5 : 2.8, color: big ? FALU : color,
            style: color === FALU || big ? 'falu' : 'wood', roof: 'gable', roofColor: rng.pick([ROOF_COLORS.tile, ROOF_COLORS.black, ROOF_COLORS.darkTile]), trim: 0xf4f1ea,
            fx: dz * sgn, fz: -dx * sgn, garden: !big, village: v.name, needsClear: 7,
          });
        }
      }
    }
  };
  for (const r of vroads) placeAlong(r.ctrl, true);
  // church on the other side of the main road
  const cside = -side;
  const chx = x + nx * cside * 45 + dirx * rng.float(-60, 60), chz = z + nz * cside * 45 + dirz * rng.float(-60, 60);
  if (!isWater(chx, chz)) pois.push({ type: 'landmark', landmark: 'village_church', x: chx, z: chz, rot: Math.atan2(dirz, dirx), name: v.name + ' kyrka' });
  // a shop
  const shx = x + nx * cside * 24 - dirx * 70, shz = z + nz * cside * 24 - dirz * 70;
  if (!isWater(shx, shz)) {
    lots.push({ kind: 'shop', x: shx, z: shz, w: 18, d: 12, rot: Math.atan2(dirz, dirx), floors: 1, floorH: 4.2, color: 0xd8cfb8, style: 'shop', roof: 'gable', roofColor: ROOF_COLORS.black, brand: 'LIVS', fx: -nx * cside, fz: -nz * cside, needsClear: 6 });
    pois.push({ type: 'shop', x: shx, z: shz, name: v.name + ' Livs' });
  }
  if (v.petrol) pois.push({ type: 'petrol', x: x - nx * cside * 0 + dirx * 120 + nx * cside * 26, z: z + dirz * 120 + nz * cside * 26, rot: Math.atan2(dirz, dirx), name: 'Polar ' + v.name, roadside: true });
  return { lots, parks, parkings, pois, village: v };
}
