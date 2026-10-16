/* =====================================================================
   Gameplay: refuelling & charging, dealership/garage, repairs, rest
   areas, speed cameras and red-light fines (Swedish amounts), parking,
   reverse sensors, earnings, odometer and saving.
   ===================================================================== */
import { settings, save, saveGame } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { clamp, formatKr } from '../core/math.js';

export const PRICES = { petrol: 18.89, diesel: 19.49, kwh: 5.95 }; // kr per litre / kWh
const REPAIR_PER_UNIT = 9000; // kr per unit of summed damage

/* Ordningsbot for speeding (approximate, kr). Over the limit by km/h. */
export function speedingFine(limit, over) {
  if (over <= 0) return 0;
  const low = limit <= 50;
  const steps = low ? [[10, 2000], [15, 2400], [20, 2800], [25, 3200], [30, 3600]] : [[10, 1500], [15, 2000], [20, 2400], [25, 2800], [30, 3200], [35, 3600], [40, 4000]];
  for (const [o, kr] of steps) if (over <= o) return kr;
  return low ? 4000 : 4400; // beyond the bot range: prosecuted, licence revoked
}
export function revokes(limit, over) { return limit <= 50 ? over > 30 : over > 40; }

function pointColliderDist(x, z, c) {
  if (c.type === 'circle') return Math.hypot(x - c.x, z - c.z) - c.r;
  if (c.type === 'obb') {
    const cs = c.cs ?? Math.cos(c.rot), sn = c.sn ?? Math.sin(c.rot);
    const dx = x - c.x, dz = z - c.z;
    const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
    const ex = Math.max(0, Math.abs(lx) - c.hw), ez = Math.max(0, Math.abs(lz) - c.hd);
    return Math.hypot(ex, ez);
  }
  if (c.type === 'seg') {
    const sx = c.bx - c.ax, sz = c.bz - c.az, L2 = sx * sx + sz * sz || 1;
    const tt = clamp(((x - c.ax) * sx + (z - c.az) * sz) / L2, 0, 1);
    return Math.hypot(x - c.ax - sx * tt, z - c.az - sz * tt) - (c.r || 0.25);
  }
  return Infinity;
}

export class Gameplay {
  constructor(game) {
    this.game = game;
    this.near = null; // current interaction target
    this.refuel = null;
    this.camCool = new Map();
    this.lastPath = null;
    this.sensorT = 0;
    this.parkedShown = false;
    this.odoAcc = 0; this.payAcc = 0;
    this.saveT = 20;
    this.flashEl = document.createElement('div');
    this.flashEl.id = 'cam-flash';
    document.body.appendChild(this.flashEl);
    game.on('interact', () => this.interact());
    game.on('reset-request', () => this.resetCar());
    game.on('arrived', (d) => this.arrived(d));
    game.on('route', (r) => { this.routeLen = r ? r.length : 0; this.routeFines = save.fines.length; });
  }
  get hud() { return this.game.app && this.game.app.hud; }
  msg(text, dur = 2.6, cls = '') { if (this.hud) this.hud.flash(text, dur, cls); }

  /* ---------------- money ---------------- */
  pay(kr, what) {
    save.money = Math.round(save.money - kr);
    saveGame();
    this.game.emit('money', save.money, what);
  }
  earn(kr) { save.money = Math.round(save.money + kr); this.game.emit('money', save.money); }

  /* ---------------- interactions ---------------- */
  findTarget(P) {
    const ph = P.phys, x = ph.p[0], z = ph.p[2];
    let best = null, bd = Infinity;
    for (const p of this.game.world.pois) {
      const d0 = Math.hypot(p.x - x, p.z - z);
      if (d0 > 60) continue;
      if (p.type === 'petrol') {
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        for (const [a, b] of [[-4, -3.5], [4, -3.5], [-4, 3.5], [4, 3.5]]) {
          const px = p.x + a * c - b * s, pz = p.z + a * s + b * c;
          const d = Math.hypot(px - x, pz - z);
          if (d < 4.2 && d < bd) { bd = d; best = { kind: 'petrol', poi: p }; }
        }
      } else if (p.type === 'dealership' && d0 < 40 && d0 < bd) { bd = d0; best = { kind: 'dealer', poi: p }; }
      else if (p.type === 'rest' && d0 < 55 && d0 < bd) { bd = d0; best = { kind: 'rest', poi: p }; }
    }
    // rest areas along motorways are also listed in world.restAreas
    for (const r of this.game.world.restAreas || []) {
      const d = Math.hypot(r.x - x, r.z - z);
      if (d < 55 && d < bd) { bd = d; best = { kind: 'rest', poi: r }; }
    }
    return best;
  }
  promptFor(target, P) {
    const ph = P.phys;
    if (!target) return null;
    if (target.kind === 'petrol') {
      if (this.refuel) return null;
      const full = ph.fuel >= P.spec.fuel.tank - 0.3;
      if (full) return null;
      const ev = !!ph.ev;
      const price = ev ? PRICES.kwh : P.spec.engine.type === 'diesel' ? PRICES.diesel : PRICES.petrol;
      const what = (ev ? t('charge') : t('refuel')) + ` (${price.toFixed(2).replace('.', ',')} kr/${ev ? 'kWh' : 'l'})`;
      return t('interact', { key: 'F', what });
    }
    if (target.kind === 'dealer') return t('interact', { key: 'F', what: t('enterDealer') });
    if (target.kind === 'rest') return t('interact', { key: 'F', what: settings.lang === 'sv' ? 'Ta en paus och spara' : 'Take a break and save' });
    return null;
  }
  interact() {
    const P = this.game.player;
    if (!P) return;
    if (this.refuel) { this.stopRefuel(); return; }
    const tg = this.near;
    if (!tg || Math.abs(P.phys.speed) > 1) return;
    if (tg.kind === 'petrol') this.startRefuel(tg);
    else if (tg.kind === 'dealer') this.game.emit('open-garage', { dealer: tg.poi });
    else if (tg.kind === 'rest') {
      this.game.setDateTime(this.game.env.day, (this.game.env.clock + 0.5) % 24);
      save.odo = Math.round(save.odo);
      saveGame();
      this.msg(settings.lang === 'sv' ? 'Du vilade en halvtimme. Spelet är sparat.' : 'You rested for half an hour. Game saved.', 3, 'good');
    }
  }
  startRefuel(tg) {
    const P = this.game.player, ph = P.phys;
    if (ph.running && !ph.ev) { this.msg(settings.lang === 'sv' ? 'Stäng av motorn innan du tankar (I)' : 'Switch off the engine before refuelling (I)', 2.8, 'warn'); return; }
    const ev = !!ph.ev;
    const price = ev ? PRICES.kwh : P.spec.engine.type === 'diesel' ? PRICES.diesel : PRICES.petrol;
    this.refuel = { price, amount: 0, cost: 0, ev, poi: tg.poi };
    this.msg(ev ? (settings.lang === 'sv' ? 'Laddar…' : 'Charging…') : t('refueling'), 1.8);
  }
  stopRefuel() {
    const R = this.refuel;
    if (!R) return;
    this.refuel = null;
    if (this.hud) this.hud.setPrompt(null, 'gp');
    if (R.amount > 0.05) {
      this.pay(R.cost, 'fuel');
      const unit = R.ev ? 'kWh' : 'l';
      this.msg(`${t('refuelDone')}: ${R.amount.toFixed(1).replace('.', ',')} ${unit} · ${formatKr(R.cost)}`, 3.5, 'good');
    }
  }
  updateRefuel(dt, P) {
    const R = this.refuel, ph = P.phys;
    if (!R) return;
    if (Math.abs(ph.speed) > 0.5 || (ph.running && !R.ev)) { this.stopRefuel(); return; }
    const rate = R.ev ? P.spec.fuel.tank / 40 : 2.2; // charge in ~40 s from empty, pump 2.2 l/s (time compressed)
    const add = Math.min(rate * dt, P.spec.fuel.tank - ph.fuel);
    ph.fuel += add; R.amount += add; R.cost = R.amount * R.price;
    if (this.hud) this.hud.setPrompt(`${R.ev ? '⚡' : '⛽'} ${R.amount.toFixed(1).replace('.', ',')} ${R.ev ? 'kWh' : 'l'} · ${formatKr(R.cost)} — F: stopp`, 'gp');
    if (ph.fuel >= P.spec.fuel.tank - 0.01 || save.money - R.cost < -2000) { if (this.hud) this.hud.setPrompt(null, 'gp'); this.stopRefuel(); }
  }

  /* ---------------- repairs ---------------- */
  repairCost(P = this.game.player) {
    if (!P) return 0;
    const D = P.phys.damage;
    let s = 0; for (const k in D) s += D[k];
    return Math.round(s * REPAIR_PER_UNIT / 50) * 50;
  }
  repair() {
    const P = this.game.player;
    const cost = this.repairCost(P);
    if (cost <= 0) return false;
    this.pay(cost, 'repair');
    const D = P.phys.damage; for (const k in D) D[k] = 0;
    P.phys.flooded = false;
    if (P.mesh.resetDamage) P.mesh.resetDamage();
    this.msg(t('repairDone') + ' · ' + formatKr(cost), 3, 'good');
    return true;
  }

  /* ---------------- reset to road ---------------- */
  resetCar() {
    const g = this.game;
    if (!g.player) return;
    g.resetToRoad();
    this.msg(t('reset'), 1.5);
  }

  /* ---------------- fines ---------------- */
  fine(kind, kr, extra = '') {
    if (!settings.fines) return;
    save.fines.push({ kind, kr, at: Date.now(), place: this.game.placeName || '' });
    if (save.fines.length > 200) save.fines.shift();
    this.pay(kr, 'fine');
    const what = kind === 'speed' ? t('speeding') + extra : t('redLight');
    this.msg(`${t('fine')}! ${t('fineText', { what, amount: formatKr(kr) })}`, 4.5, 'warn');
    this.game.emit('fine', kind, kr);
  }
  checkCameras(P) {
    const g = this.game, ph = P.phys;
    const cams = g.world.speedCameras || [];
    const x = ph.p[0], z = ph.p[2];
    for (const c of cams) {
      if (!c.pos) { const p = g.net.pointAt(c.road, c.s, 0); const i = Math.min(c.road.n - 2, Math.max(0, Math.round(c.s / 4))); c.pos = [p[0], p[2]]; c.t = [c.road.TX[i], c.road.TZ[i]]; }
      const dx = x - c.pos[0], dz = z - c.pos[1];
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) continue;
      const along = dx * c.t[0] + dz * c.t[1], lat = -dx * c.t[1] + dz * c.t[0];
      if (Math.abs(lat) > 14 || Math.abs(along) > 6) continue;
      const cool = this.camCool.get(c) || 0;
      if (performance.now() - cool < 8000) continue;
      // direction of travel must match the camera direction
      const vAlong = ph.v[0] * c.t[0] + ph.v[2] * c.t[1];
      if (Math.sign(vAlong) !== c.dir) continue;
      this.camCool.set(c, performance.now());
      const kmh = Math.abs(vAlong) * 3.6;
      const limit = c.road.speed;
      // ATK tolerance: 3 km/h below 100, 3 % above
      const measured = kmh - (kmh < 100 ? 3 : kmh * 0.03);
      const over = Math.floor(measured - limit);
      if (over > 0) {
        this.flash();
        const kr = speedingFine(limit, over);
        this.fine('speed', kr, ` (${Math.round(kmh)} km/h, ${limit})`);
        if (revokes(limit, over)) this.msg(t('licenseRevoked'), 5, 'warn');
      }
    }
  }
  checkRedLight() {
    const T = this.game.traffic;
    if (!T || !T.player) return;
    const p = T.player.path;
    const prev = this.lastPath;
    if (p !== prev) {
      if (prev && prev.kind === 'lane' && prev.control && prev.control.type === 'signal' && p && p.kind === 'conn' && p.node === prev.control.node && prev.control.node.signal) {
        const st = prev.control.node.signal.state(prev.control.group);
        if (st === 'red') { this.flash(); this.fine('red', 3000); }
      }
      this.lastPath = p;
    }
  }
  flash() {
    const el = this.flashEl;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }

  /* ---------------- reverse sensors & parking ---------------- */
  updateSensors(dt, P) {
    const g = this.game, ph = P.phys;
    const reversing = ph.gear === -1 || (ph.autoMode && ph.sel === 'R');
    if (!reversing || Math.abs(ph.speed) > 4 || !g.audio) { this.sensorT = 0; return; }
    const L = P.spec.body.L / 2, W = P.spec.body.W / 2;
    let dmin = Infinity;
    const cand = g.collision.query(ph.p[0], ph.p[2], L + 3, []);
    const ai = g.traffic ? g.traffic.boxesNear(ph.p[0], ph.p[2], 12) : [];
    for (const lx of [-W * 0.8, 0, W * 0.8]) {
      const q = ph.pointWorld(lx, 0, L + 0.05);
      for (const c of cand) { if (c.y1 != null && c.y1 < ph.p[1] - 0.8) continue; dmin = Math.min(dmin, pointColliderDist(q[0], q[2], c)); }
      for (const b of ai) dmin = Math.min(dmin, pointColliderDist(q[0], q[2], { type: 'obb', x: b.x, z: b.z, hw: b.hw ?? b.width / 2, hd: b.hd ?? b.len / 2, rot: b.rot }));
    }
    if (dmin > 1.8) { this.sensorT = 0; return; }
    const interval = dmin < 0.3 ? 0.09 : 0.12 + dmin * 0.32;
    this.sensorT -= dt;
    if (this.sensorT <= 0) { this.sensorT = interval; g.audio.beep(dmin < 0.3 ? 2400 : 2000, dmin < 0.3 ? 0.09 : 0.06, 0.12); }
  }
  checkParked(P) {
    const ph = P.phys;
    const still = Math.abs(ph.speed) < 0.2 && !ph.running;
    if (!still) { this.parkedShown = false; return; }
    if (this.parkedShown) return;
    for (const pk of this.game.world.parkings) {
      const dx = ph.p[0] - pk.x, dz = ph.p[2] - pk.z;
      const c = Math.cos(pk.rot), s = Math.sin(pk.rot);
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      if (Math.abs(lx) < pk.w / 2 && Math.abs(lz) < pk.d / 2) {
        this.parkedShown = true;
        this.msg('🅿 ' + t('parked'), 2.5, 'good');
        saveGame();
        return;
      }
    }
  }

  /* ---------------- destinations ---------------- */
  arrived(d) {
    // reward for completing a trip: 12 kr per route kilometre, about double if no fines on the way
    const km = (this.routeLen || 0) / 1000;
    if (km < 0.8) return;
    const clean = save.fines.length === (this.routeFines ?? save.fines.length);
    const kr = Math.round(km * (clean ? 25 : 12) / 10) * 10 + 100;
    this.earn(kr);
    saveGame();
    this.msg((settings.lang === 'sv' ? 'Resa klar: +' : 'Trip complete: +') + formatKr(kr) + (clean ? (settings.lang === 'sv' ? ' (felfri körning)' : ' (clean driving)') : ''), 4, 'good');
  }

  update(dt, game) {
    const P = game.player;
    if (!P || game.paused || game.inMenu) return;
    const ph = P.phys;
    // odometer & persistent fuel per car
    const d = Math.abs(ph.fwdSpeed) * dt;
    save.odo += d / 1000;
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 30; save.fuel[P.spec.id] = ph.fuel; saveGame(); }
    // interactions
    if (!this.refuel) {
      this.scanT = (this.scanT || 0) - dt;
      if (this.scanT <= 0) { this.scanT = 0.3; this.near = Math.abs(ph.speed) < 3 ? this.findTarget(P) : null; }
      const pr = Math.abs(ph.speed) < 1 ? this.promptFor(this.near, P) : null;
      if (this.hud) this.hud.setPrompt(pr, 'gp');
    } else this.updateRefuel(dt, P);
    this.checkCameras(P);
    this.checkRedLight();
    this.updateSensors(dt, P);
    this.checkParked(P);
  }
}
