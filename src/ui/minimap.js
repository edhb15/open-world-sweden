/* =====================================================================
   Map rendering shared by the HUD minimap, the cockpit nav screen and
   the full-screen map: a raster base map (land / water / towns) built
   in time slices, with roads, route, POIs and the player drawn on top.
   ===================================================================== */
import { LAND, CITIES, waterDistance, riverAt, cityMask } from '../world/geo.js';
import { settings } from '../core/settings.js';
import { clamp } from '../core/math.js';

const MPP = 40; // base map metres per pixel
const SEA = '#1d3b5c';

export const ROAD_STYLE = {
  motorway: { w: 7, c: '#f0a830', o: '#5a3a08', z: 5 },
  expressway: { w: 6, c: '#f3bd4f', o: '#5a3a08', z: 5 },
  primary: { w: 5.5, c: '#f7d774', o: '#4a3d12', z: 4 },
  secondary: { w: 4.5, c: '#f2ead0', o: '#3a3424', z: 3 },
  ramp: { w: 3.5, c: '#f3bd4f', o: '#5a3a08', z: 3 },
  avenue: { w: 4.5, c: '#ffffff', o: '#3a3f46', z: 3 },
  street: { w: 3.5, c: '#d8dde3', o: '#30353c', z: 2 },
  residential: { w: 3, c: '#c9ced4', o: '#2b3036', z: 1 },
  local: { w: 3.2, c: '#d8d2bf', o: '#2e2a20', z: 2 },
  gravel: { w: 2.6, c: '#b9a27a', o: '#2a2418', z: 1, dash: true },
};
const st = (type) => ROAD_STYLE[type] || ROAD_STYLE.street;
const POI_ICON = { petrol: ['P', '#0b8f8f'], dealership: ['B', '#b03636'], rest: ['R', '#2f6fd0'], supermarket: ['M', '#d0782f'], landmark: ['★', '#8a5cc8'] };

export class BaseMap {
  constructor() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of LAND) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const pad = 3000;
    this.x0 = x0 - pad; this.z0 = z0 - pad;
    this.W = Math.ceil((x1 - x0 + pad * 2) / MPP); this.H = Math.ceil((z1 - z0 + pad * 2) / MPP);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(this.W, 1);
    this.row = 0;
    this.order = null;
    this.done = false;
    this.ctx.fillStyle = '#334535'; this.ctx.fillRect(0, 0, this.W, this.H); // land until built
  }
  /* rows are built outward from a focus point (usually the player) */
  focus(z) {
    if (this.order) return;
    const fr = clamp(Math.round((z - this.z0) / MPP), 0, this.H - 1);
    this.order = Array.from({ length: this.H }, (_, i) => i).sort((a, b) => Math.abs(a - fr) - Math.abs(b - fr));
  }
  /* build some rows within a time budget (ms); returns true when complete */
  build(budget = 4) {
    if (this.done) return true;
    if (!this.order) this.focus(0);
    const t0 = performance.now();
    const d = this.img.data;
    while (this.row < this.H && performance.now() - t0 < budget) {
      const row = this.order[this.row];
      const z = this.z0 + (row + 0.5) * MPP;
      for (let i = 0; i < this.W; i++) {
        const x = this.x0 + (i + 0.5) * MPP;
        const wd = waterDistance(x, z);
        let water = wd < 0;
        if (!water && wd < 4000) { const rv = riverAt(x, z); if (rv && rv.d < rv.w / 2 + 12) water = true; }
        let r, g, b;
        if (water) { const deep = clamp(-wd / 1500, 0, 1); r = 34 - deep * 8; g = 74 - deep * 14; b = 112 - deep * 12; }
        else {
          const cm = cityMask(x, z);
          const shore = clamp(1 - wd / 120, 0, 1);
          r = 50 + cm * 30 + shore * 14; g = 68 + cm * 10 + shore * 10; b = 50 + cm * 30 + shore * 6;
        }
        const k = i * 4; d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
      }
      this.ctx.putImageData(this.img, 0, row);
      this.row++;
    }
    if (this.row >= this.H) this.done = true;
    return this.done;
  }
}

/* Roads bucketed in coarse cells for fast map drawing. */
export class RoadIndex {
  constructor(net) {
    this.net = net;
    this.cell = 600;
    this.map = new Map();
    for (const r of net.roads) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < r.n; i++) { x0 = Math.min(x0, r.X[i]); x1 = Math.max(x1, r.X[i]); z0 = Math.min(z0, r.Z[i]); z1 = Math.max(z1, r.Z[i]); }
      r.bbox = [x0, z0, x1, z1];
      for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++) for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) {
        const k = i * 100003 + j; let L = this.map.get(k); if (!L) this.map.set(k, L = []); L.push(r);
      }
    }
    this.major = net.roads.filter((r) => ['motorway', 'expressway', 'primary', 'secondary'].includes(r.type));
  }
  near(x0, z0, x1, z1) {
    const out = new Set();
    for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++) for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) {
      const L = this.map.get(i * 100003 + j); if (L) for (const r of L) out.add(r);
    }
    return out;
  }
}

/* Draw a map view. view = {cx, cz, rot, mpp, w, h, route, player, pois, labels, all} */
export function drawMap(ctx, base, roads, view) {
  const { cx, cz, rot = 0, mpp, w, h } = view;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const ox = view.ox ?? w / 2, oy = view.oy ?? h / 2;
  // world -> screen: rotate so that heading points up
  const S = (x, z) => { const dx = (x - cx) / mpp, dz = (z - cz) / mpp; return [ox + dx * cs - dz * sn, oy + dx * sn + dz * cs]; };
  ctx.save();
  ctx.fillStyle = SEA; ctx.fillRect(0, 0, w, h);
  // base raster
  ctx.save();
  ctx.translate(ox, oy); ctx.rotate(rot);
  const k = MPP / mpp;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base.canvas, (base.x0 - cx) / mpp, (base.z0 - cz) / mpp, base.W * k, base.H * k);
  ctx.restore();
  // visible world box
  const R = Math.hypot(w, h) * 0.5 * mpp + 50;
  const set = mpp > 30 ? roads.major : roads.near(cx - R, cz - R, cx + R, cz + R);
  const list = [...set].filter((r) => !r.bbox || !(r.bbox[2] < cx - R || r.bbox[0] > cx + R || r.bbox[3] < cz - R || r.bbox[1] > cz + R));
  list.sort((a, b) => st(a.type).z - st(b.type).z);
  const scale = clamp(3.2 / Math.sqrt(mpp), 0.35, 1.6);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const step = mpp > 10 ? 4 : mpp > 4 ? 2 : 1;
  const strokeRoad = (r) => {
    ctx.beginPath();
    for (let i = 0; i < r.n; i += step) { const p = S(r.X[i], r.Z[i]); if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
    const p = S(r.X[r.n - 1], r.Z[r.n - 1]); ctx.lineTo(p[0], p[1]);
  };
  for (const pass of [0, 1]) {
    for (const r of list) {
      const s = st(r.type);
      if (mpp > 12 && s.z < 2) continue;
      strokeRoad(r);
      ctx.setLineDash(pass === 1 && s.dash ? [4, 3] : []);
      ctx.strokeStyle = pass === 0 ? s.o : s.c;
      ctx.lineWidth = Math.max(1, (s.w + (pass === 0 ? 2 : 0)) * scale);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // route
  const route = view.route;
  if (route) {
    ctx.beginPath();
    const P = route.pts;
    const i0 = view.fromProgress ? Math.max(0, route.cursor) : 0;
    const stepR = mpp > 20 ? 6 : 1;
    for (let i = i0; i < P.length; i += stepR) { const p = S(P[i][0], P[i][1]); if (i === i0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
    const pl = S(P[P.length - 1][0], P[P.length - 1][1]); ctx.lineTo(pl[0], pl[1]);
    ctx.strokeStyle = '#0d3f86'; ctx.lineWidth = Math.max(3, 7 * scale) + 2; ctx.stroke();
    ctx.strokeStyle = '#3aa0ff'; ctx.lineWidth = Math.max(3, 7 * scale); ctx.stroke();
    const d = S(route.dest.x, route.dest.z);
    ctx.fillStyle = '#e8343a'; ctx.beginPath(); ctx.arc(d[0], d[1], 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
  // POIs
  if (view.pois) {
    ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of view.pois) {
      if (mpp > 25 && p.type !== 'landmark') continue;
      const ic = POI_ICON[p.type]; if (!ic) continue;
      const q = S(p.x, p.z);
      if (q[0] < -10 || q[1] < -10 || q[0] > w + 10 || q[1] > h + 10) continue;
      ctx.fillStyle = ic[1]; ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(ic[0], q[0], q[1] + 0.5);
    }
  }
  // labels
  if (view.labels) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of CITIES) {
      const q = S(c.x, c.z);
      if (q[0] < -60 || q[1] < -20 || q[0] > w + 60 || q[1] > h + 20) continue;
      const big = c.size === 'large' || c.r > 1500;
      if (mpp > 60 && !big) continue;
      ctx.font = `${big ? 700 : 600} ${big ? 15 : 12}px system-ui, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,20,.85)'; ctx.strokeText(c.name, q[0], q[1]);
      ctx.fillStyle = '#fff'; ctx.fillText(c.name, q[0], q[1]);
    }
    if (view.villages && mpp < 30) {
      ctx.font = '500 11px system-ui, sans-serif';
      for (const v of view.villages) {
        const q = S(v.x, v.z);
        if (q[0] < -40 || q[1] < -20 || q[0] > w + 40 || q[1] > h + 20) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,20,.8)'; ctx.strokeText(v.name, q[0], q[1] - 10);
        ctx.fillStyle = '#dfe6ee'; ctx.fillText(v.name, q[0], q[1] - 10);
      }
    }
  }
  // player arrow
  if (view.player) {
    const pl = view.player;
    const q = S(pl.x, pl.z);
    const a = Math.atan2(pl.hx, -pl.hz); // heading angle from north (screen up)
    ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(a + rot);
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0d3f86'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/* HUD minimap (heading-up), also used for the cockpit centre screen. */
export class Minimap {
  constructor(game) {
    this.game = game;
    this.base = new BaseMap();
    this.roads = null;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud-minimap';
    this.size = 0;
    document.body.appendChild(this.canvas);
    this.t = 0;
    this.mpp = 2.5;
    this.resize();
    game.on('resize', () => this.resize());
  }
  resize() {
    const s = Math.round(clamp(Math.min(innerWidth, innerHeight) * 0.26, 120, 230));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = s;
    this.canvas.width = s * dpr; this.canvas.height = s * dpr;
    this.canvas.style.width = s + 'px'; this.canvas.style.height = s + 'px';
    this.dpr = dpr;
  }
  ensure() { if (!this.roads) this.roads = new RoadIndex(this.game.net); }
  viewFor(w, h, rotated = true) {
    const g = this.game, P = g.player.phys, f = P.forward;
    const v = Math.abs(P.fwdSpeed);
    const target = clamp(1.6 + v * 0.09, 1.6, 5);
    this.mpp += (target - this.mpp) * 0.05;
    const heading = Math.atan2(f[0], -f[2]);
    const rot = rotated ? -heading : 0;
    return {
      cx: P.p[0], cz: P.p[2], rot, mpp: this.mpp * (200 / Math.max(w, 1)), w, h, oy: h * (rotated ? 0.66 : 0.5),
      route: g.nav ? g.nav.route : null, fromProgress: true,
      player: { x: P.p[0], z: P.p[2], hx: f[0], hz: f[2] }, pois: g.world.pois, labels: false,
    };
  }
  drawTo(ctx, w, h, rotated = true) {
    if (!this.game.player) return;
    this.ensure();
    drawMap(ctx, this.base, this.roads, this.viewFor(w, h, rotated));
  }
  update(dt, game) {
    if (game.player) this.base.focus(game.player.phys.p[2]);
    this.base.build(this.base.done ? 0 : 3);
    const show = settings.hud && settings.minimap && game.player && !game.mapOpen && !game.inMenu;
    this.canvas.classList.toggle('hidden', !show);
    if (!show) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 1 / 15;
    const c = this.canvas.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = this.size;
    c.save();
    c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2); c.clip();
    this.drawTo(c, s, s, true);
    c.restore();
    // north marker
    const P = game.player.phys, f = P.forward;
    const heading = Math.atan2(f[0], -f[2]);
    const a = -heading - Math.PI / 2, r = s / 2 - 11;
    c.fillStyle = 'rgba(10,14,20,.8)'; c.beginPath(); c.arc(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 8, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ff5a4f'; c.font = 'bold 11px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r + 0.5);
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2); c.stroke();
  }
}
