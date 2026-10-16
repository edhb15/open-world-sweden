/* =====================================================================
   Full-screen map: pan / zoom (mouse, wheel, touch), destination search,
   click to set a destination, route overview.
   ===================================================================== */
import { drawMap } from './minimap.js';
import { settings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { clamp } from '../core/math.js';
import { fmtDist, maneuverText } from '../nav/nav.js';
import { h } from './menu.js';

const KIND_LABEL = {
  sv: { city: 'Stad', village: 'Ort', landmark: 'Sevärdhet', petrol: 'Bensinstation', dealership: 'Bilhall', rest: 'Rastplats', supermarket: 'Butik', home: 'Startplats' },
  en: { city: 'City', village: 'Town', landmark: 'Landmark', petrol: 'Petrol station', dealership: 'Car dealer', rest: 'Rest area', supermarket: 'Shop', home: 'Start location' },
};

export class MapView {
  constructor(app) {
    this.app = app;
    this.game = app.game;
    this.el = h('div', { id: 'mapview', class: 'hidden' });
    this.canvas = h('canvas', {});
    this.search = h('input', { type: 'search', placeholder: t('search'), autocomplete: 'off', spellcheck: 'false', oninput: () => this.fillList() });
    this.list = h('div', { class: 'dest-list' });
    this.info = h('div', { class: 'route-info' });
    const side = h('div', { class: 'map-side' },
      h('div', { class: 'map-head' }, h('h2', { text: t('map') }), h('button', { class: 'close', onclick: () => this.close(), 'aria-label': t('back') }, '✕')),
      this.search, this.list, this.info,
      h('div', { class: 'actions' },
        h('button', { onclick: () => this.center() }, settings.lang === 'sv' ? 'Centrera' : 'Centre'),
        h('button', { onclick: () => { this.game.nav.clear(); this.drawInfo(); this.dirty = true; } }, settings.lang === 'sv' ? 'Rensa rutt' : 'Clear route')),
      h('p', { class: 'muted small', text: settings.lang === 'sv' ? 'Dra för att panorera, scrolla för att zooma, dubbelklicka för att sätta mål.' : 'Drag to pan, scroll to zoom, double-click to set a destination.' }));
    this.el.append(this.canvas, side);
    document.body.appendChild(this.el);
    this.view = { cx: 0, cz: 0, mpp: 20 };
    this.dirty = true;
    this.bindPointer();
    addEventListener('resize', () => { if (this.open) this.resize(); });
  }
  get open() { return !this.el.classList.contains('hidden'); }
  show() {
    this.el.classList.remove('hidden');
    this.search.placeholder = t('search');
    this.resize();
    this.center();
    this.fillList();
    this.drawInfo();
    const loop = () => { if (!this.open) return; this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  close() { this.el.classList.add('hidden'); this.app.onMapClosed(); }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr);
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    this.dirty = true;
  }
  center() {
    const P = this.game.player;
    if (P) { this.view.cx = P.phys.p[0]; this.view.cz = P.phys.p[2]; }
    this.view.mpp = this.game.nav.route ? clamp(this.game.nav.route.length / Math.max(300, this.w) * 0.9, 2, 80) : 6;
    if (this.game.nav.route) { const R = this.game.nav.route, a = R.pts[0], b = R.pts[R.pts.length - 1]; this.view.cx = (a[0] + b[0]) / 2; this.view.cz = (a[1] + b[1]) / 2; }
    this.dirty = true;
  }
  toWorld(sx, sy) { return [this.view.cx + (sx - this.w / 2) * this.view.mpp, this.view.cz + (sy - this.h / 2) * this.view.mpp]; }
  bindPointer() {
    const c = this.canvas;
    const pts = new Map();
    let pinch0 = null;
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.offsetX, e.offsetY]); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mpp: this.view.mpp }; } });
    c.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      if (pts.size === 1) { this.view.cx -= (e.offsetX - p[0]) * this.view.mpp; this.view.cz -= (e.offsetY - p[1]) * this.view.mpp; this.dirty = true; }
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); this.view.mpp = clamp(pinch0.mpp * pinch0.d / Math.max(d, 1), 0.6, 120); this.dirty = true; }
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e.offsetX, e.offsetY);
      this.view.mpp = clamp(this.view.mpp * Math.exp(e.deltaY * 0.0015), 0.6, 120);
      const after = this.toWorld(e.offsetX, e.offsetY);
      this.view.cx += before[0] - after[0]; this.view.cz += before[1] - after[1];
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const [x, z] = this.toWorld(e.offsetX, e.offsetY);
      this.setDest({ id: 'pt', name: settings.lang === 'sv' ? 'Vald plats' : 'Map point', kind: 'point', x, z });
    });
    let lastTap = 0;
    c.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      const now = performance.now();
      if (now - lastTap < 320) { const [x, z] = this.toWorld(e.offsetX, e.offsetY); this.setDest({ id: 'pt', name: settings.lang === 'sv' ? 'Vald plats' : 'Map point', kind: 'point', x, z }); }
      lastTap = now;
    });
  }
  setDest(d) {
    this.game.nav.setDestination(d);
    this.drawInfo();
    this.dirty = true;
  }
  fillList() {
    const q = this.search.value.trim().toLowerCase();
    const all = this.game.nav.destinations();
    const P = this.game.player;
    const px = P ? P.phys.p[0] : 0, pz = P ? P.phys.p[2] : 0;
    let items = q ? all.filter((d) => d.name.toLowerCase().includes(q)) : all.filter((d) => d.kind === 'city' || d.kind === 'home');
    if (!q) items = items.slice().sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    this.list.textContent = '';
    const KL = KIND_LABEL[settings.lang === 'sv' ? 'sv' : 'en'];
    for (const d of items.slice(0, 40)) {
      const dist = Math.hypot(d.x - px, d.z - pz);
      this.list.append(h('button', { class: 'dest', onclick: () => { this.setDest(d); this.view.cx = d.x; this.view.cz = d.z; } },
        h('b', { text: d.name }), h('small', { text: `${KL[d.kind] || ''} · ${fmtDist(dist)}` })));
    }
  }
  drawInfo() {
    const R = this.game.nav.route;
    this.info.textContent = '';
    if (!R) return;
    const eta = R.eta();
    this.info.append(h('div', { class: 'route-sum' }, h('b', { text: this.game.nav.dest.name }), h('span', { text: ` · ${fmtDist(R.remaining)} · ${Math.max(1, Math.round(eta / 60))} min` })));
    const ol = h('ol', {});
    for (const m of R.maneuvers) if (m.d >= R.progress - 2) ol.append(h('li', {}, h('span', { text: fmtDist(Math.max(0, m.d - R.progress)) }), ' ', maneuverText(m)));
    this.info.append(ol);
  }
  draw() {
    const g = this.game;
    g.minimap.ensure();
    if (!g.minimap.base.done) { g.minimap.base.build(12); this.dirty = true; }
    const P = g.player;
    if (!this.dirty && !(P && Math.abs(P.phys.speed) > 0.5)) return;
    this.dirty = false;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawMap(ctx, g.minimap.base, g.minimap.roads, {
      cx: this.view.cx, cz: this.view.cz, rot: 0, mpp: this.view.mpp, w: this.w, h: this.h,
      route: g.nav.route, player: P ? { x: P.phys.p[0], z: P.phys.p[2], hx: P.phys.forward[0], hz: P.phys.forward[2] } : null,
      pois: g.world.pois, labels: true, villages: g.world.villages,
    });
    // scale bar
    const m = [50, 100, 200, 500, 1000, 2000, 5000, 10000].find((v) => v / this.view.mpp > 70) || 10000;
    const px = m / this.view.mpp;
    ctx.fillStyle = 'rgba(10,14,20,.7)'; ctx.fillRect(14, this.h - 34, px + 16, 22);
    ctx.fillStyle = '#fff'; ctx.fillRect(22, this.h - 18, px, 3);
    ctx.font = '600 11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(fmtDist(m), 22, this.h - 23);
  }
}
