/* =====================================================================
   Navigation module: destinations, active route, guidance panel,
   re-routing and optional Swedish voice prompts (SpeechSynthesis).
   ===================================================================== */
import { Router } from './router.js';
import { CITIES } from '../world/geo.js';
import { settings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { clamp } from '../core/math.js';

const ICON = { left: '↰', right: '↱', straight: '↑', uturn: '↶', roundabout: '⟳', exit: '↗', arrive: '⚑' };

export function destinationsOf(world) {
  const out = [];
  for (const c of CITIES) out.push({ id: 'city:' + c.id, name: c.name, kind: 'city', x: c.x, z: c.z, sort: 0 });
  for (const v of world.villages || []) if (v.name) out.push({ id: 'vil:' + v.name, name: v.name, kind: 'village', x: v.x, z: v.z, sort: 1 });
  for (const p of world.pois || []) {
    if (!p.name) continue;
    const kind = p.type === 'landmark' ? 'landmark' : p.type;
    if (!['landmark', 'petrol', 'dealership', 'rest', 'supermarket'].includes(kind)) continue;
    out.push({ id: 'poi:' + kind + ':' + p.name, name: p.name, kind, x: p.x, z: p.z, sort: 2, poi: p });
  }
  for (const s of world.starts || []) {
    const p = world.net.pointAt(s.road, s.s, 0);
    out.push({ id: 'start:' + s.id, name: s.label, kind: 'home', x: p[0], z: p[2], sort: 0.5 });
  }
  // unique by id
  const seen = new Set();
  return out.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'sv'));
}

const ORD = (n) => (settings.lang === 'sv' ? n + (n === 1 || n === 2 ? ':a' : ':e') : n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'));

export function roadLabel(r) {
  if (!r) return '';
  if (r.ref) return (/^\d/.test(r.ref) ? (settings.lang === 'sv' ? 'väg ' : 'road ') : '') + r.ref;
  return r.name || '';
}

export function maneuverText(m, short = false) {
  if (!m) return '';
  const road = m.road ? roadLabel(m.road) : '';
  const dest = m.dest || (m.road && m.road.dest && (m.road.dest.fwd || m.road.dest.bwd)) || '';
  switch (m.type) {
    case 'left': return t('turnLeft') + (road && !short ? ' ' + t('onto') + ' ' + road : '');
    case 'right': return t('turnRight') + (road && !short ? ' ' + t('onto') + ' ' + road : '');
    case 'straight': return t('straight') + (road && !short ? ' ' + t('onto') + ' ' + road : '');
    case 'uturn': return settings.lang === 'sv' ? 'Gör en U-sväng' : 'Make a U-turn';
    case 'roundabout': return t('roundabout', { n: ORD(m.n || 1) }) + (road && !short ? ' ' + t('toward') + ' ' + road : '');
    case 'exit': return t('exit') + (dest ? ' ' + t('toward') + ' ' + dest : road ? ' ' + t('toward') + ' ' + road : '');
    case 'arrive': return t('arrive');
  }
  return '';
}

export function fmtDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', settings.lang === 'sv' ? ',' : '.') + ' km';
  if (m >= 100) return Math.round(m / 50) * 50 + ' m';
  return Math.max(0, Math.round(m / 10) * 10) + ' m';
}
function spokenDist(m) {
  const sv = settings.lang === 'sv';
  if (m >= 1000) { const k = Math.round(m / 500) / 2; return (sv ? 'Om ' : 'In ') + String(k).replace('.', sv ? ',' : '.') + (sv ? ' kilometer' : ' kilometres'); }
  return (sv ? 'Om ' : 'In ') + Math.round(m / 50) * 50 + (sv ? ' meter' : ' metres');
}

export class Navigation {
  constructor(game) {
    this.game = game;
    this.router = null;
    this.route = null;
    this.dest = null;
    this.list = null;
    this.offT = 0; this.recalcCool = 0;
    this.announced = new Map();
    const el = document.createElement('div');
    el.id = 'hud-nav';
    el.className = 'hidden';
    el.innerHTML = '<div class="arrow"></div><div class="body"><div class="dist"></div><div class="text"></div></div><div class="foot"><span class="rem"></span><span class="eta"></span></div>';
    document.body.appendChild(el);
    this.el = el;
    game.on('gps', () => this.toggleQuick());
  }
  ensure() {
    if (!this.router) this.router = new Router(this.game.world);
    if (!this.list) this.list = destinationsOf(this.game.world);
    return this.router;
  }
  destinations() { this.ensure(); return this.list; }
  setDestination(d) {
    if (!d) { this.clear(); return; }
    this.ensure();
    this.dest = d;
    this.announced.clear();
    const ok = this.recompute(true);
    const hud = this.game.app && this.game.app.hud;
    if (hud) hud.flash(ok ? t('gpsSet', { dest: d.name }) : (settings.lang === 'sv' ? 'Ingen rutt hittades' : 'No route found'), 2.6, ok ? 'good' : 'warn');
    if (ok && settings.voice) this.say(t('gpsSet', { dest: d.name }));
    this.game.emit('route', this.route);
  }
  clear() {
    this.dest = null; this.route = null;
    this.el.classList.add('hidden');
    this.game.emit('route', null);
  }
  recompute(first = false) {
    const P = this.game.player;
    if (!P || !this.dest) return false;
    const ph = P.phys, f = ph.forward;
    const r = this.router.route({ x: ph.p[0], z: ph.p[2], hx: f[0], hz: f[2] }, { x: this.dest.x, z: this.dest.z });
    if (!r) return false;
    this.route = r;
    this.offT = 0;
    if (!first) { this.announced.clear(); this.game.emit('route', r); }
    return true;
  }
  /* G key: route home, or cancel */
  toggleQuick() {
    if (this.route) { this.clear(); this.game.app && this.game.app.hud && this.game.app.hud.flash(t('gpsCleared')); return; }
    const list = this.destinations();
    const home = list.find((d) => d.id === 'start:' + (this.game.homeStart || 'bromma'));
    // nearest petrol station when the tank is low, else home
    const P = this.game.player;
    if (P && P.phys.fuel / P.spec.fuel.tank < 0.2) {
      const kind = P.phys.ev ? 'petrol' : 'petrol';
      let best = null, bd = Infinity;
      for (const d of list) if (d.kind === kind) { const dd = Math.hypot(d.x - P.phys.p[0], d.z - P.phys.p[2]); if (dd < bd) { bd = dd; best = d; } }
      if (best) { this.setDestination(best); return; }
    }
    if (home) this.setDestination(home);
  }
  say(text) {
    if (!settings.voice || typeof speechSynthesis === 'undefined' || /[?&]shot=/.test(location.search)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = settings.lang === 'sv' ? 'sv-SE' : 'en-GB';
      const v = speechSynthesis.getVoices().find((q) => q.lang && q.lang.toLowerCase().startsWith(settings.lang === 'sv' ? 'sv' : 'en'));
      if (v) u.voice = v;
      u.rate = 1.02; u.volume = clamp(settings.volume, 0, 1);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* speech not available */ }
  }
  update(dt, game) {
    const R = this.route;
    if (!R || !game.player) { this.el.classList.add('hidden'); return; }
    const ph = game.player.phys;
    const off = R.track(ph.p[0], ph.p[2]);
    // re-route when clearly off the route
    this.recalcCool -= dt;
    if (off > 30) this.offT += dt; else this.offT = Math.max(0, this.offT - dt);
    if (this.offT > 2.5 && this.recalcCool <= 0) {
      this.recalcCool = 6;
      game.app && game.app.hud && game.app.hud.flash(t('recalc'), 1.6);
      if (settings.voice) this.say(t('recalc'));
      this.recompute();
      return;
    }
    const m = R.nextManeuver();
    const dist = m ? m.d - R.progress : 0;
    if (m && m.type === 'arrive' && dist < 25) {
      game.app && game.app.hud && game.app.hud.flash(t('arrive') + ' – ' + this.dest.name, 3.5, 'good');
      if (settings.voice) this.say(t('arrive'));
      game.emit('arrived', this.dest);
      this.clear();
      return;
    }
    // panel
    this.el.classList.toggle('hidden', !settings.hud);
    this.el.querySelector('.arrow').textContent = m ? ICON[m.type] || '↑' : '↑';
    this.el.querySelector('.arrow').dataset.n = m && m.type === 'roundabout' ? m.n : '';
    this.el.querySelector('.dist').textContent = fmtDist(dist);
    this.el.querySelector('.text').textContent = maneuverText(m);
    this.el.querySelector('.rem').textContent = fmtDist(R.remaining);
    const eta = R.eta();
    const c = (game.env.clock + eta / 3600) % 24;
    this.el.querySelector('.eta').textContent = `${t('eta')} ${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60)).padStart(2, '0')}`;
    // voice prompts: early (speed dependent) and at the turn
    if (m && settings.voice) {
      const v = Math.max(8, Math.abs(ph.fwdSpeed));
      const early = clamp(v * 22, 250, 1600), late = clamp(v * 4.5, 40, 300);
      const st = this.announced.get(m) || 0;
      if (st < 1 && dist < early && dist > late * 1.8 && m.type !== 'arrive') { this.say(spokenDist(dist) + ', ' + maneuverText(m).toLowerCase()); this.announced.set(m, 1); }
      else if (st < 2 && dist < late) { this.say(maneuverText(m, m.type !== 'exit')); this.announced.set(m, 2); }
    }
  }
}
