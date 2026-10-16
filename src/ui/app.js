/* =====================================================================
   App controller: boot, menus, sessions, HUD wiring.
   ===================================================================== */
import { settings, save, saveGame, saveSettings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { HUD } from './hud.js';
import { Menu, carCfg, SEASON_DAY, TIME_OF } from './menu.js';
import { MapView } from './mapview.js';
import { Minimap } from './minimap.js';
import { Navigation } from '../nav/nav.js';
import { Gameplay } from '../gameplay/gameplay.js';
import { TouchControls } from '../input/touch.js';
import { VEHICLE } from '../vehicle/specs.js';
import { clamp, lerp, KMH } from '../core/math.js';

// manual-gearbox cars are always manual (with optional auto clutch); automatics can be driven in manual mode
const transFor = (spec) => (spec.gearbox.type === 'manual' ? 'manual' : spec.gearbox.type === 'auto' && settings.trans === 'manual' ? 'manual' : 'auto');

export class App {
  constructor(game, params) {
    this.game = game;
    this.params = params;
    game.app = this;
    this.hud = null;
    this.sessionActive = false;
    this.menuSession = false;
    this.current = null; // {start, car}
    game.nav = game.addModule(new Navigation(game));
    game.minimap = game.addModule(new Minimap(game));
    game.gameplay = game.addModule(new Gameplay(game));
    game.touch = game.addModule(new TouchControls(game));
    this.menu = new Menu(this);
    this.map = new MapView(this);
    game.on('pause-toggle', () => this.togglePause());
    game.on('map-toggle', () => (this.map.open ? this.map.close() : this.openMap()));
    game.on('help', () => { if (!this.menu.open) { this.pause(); this.menu.show('pause'); } this.menu.show('controls'); });
    game.on('open-garage', (o) => { this.pause(); this.menu.show('garage', o); });
    game.on('place', (name, kind) => { if (this.hud && !game.inMenu && kind !== 'rural') this.hud.flash(t('welcomeTo', { place: name }), 2.6); });
    addEventListener('keydown', (e) => {
      if (this.map.open && (e.code === 'Escape' || e.code === 'KeyM') && e.target.tagName !== 'INPUT') { e.preventDefault(); this.map.close(); }
      else if (this.menu.open && e.code === 'Escape' && this.menu.stack.length === 1 && this.menu.stack[0][0] === 'pause') { e.preventDefault(); this.resume(); }
    });
  }
  async boot(progress) {
    const p = this.params;
    const direct = p.get('autostart') || p.get('shot') || p.get('autopilot') || p.get('at');
    await this.startSession({
      start: p.get('start') || save.home || 'bromma',
      car: this.fullCarCfg(p.get('car') || save.car.model),
      day: p.get('day') ? +p.get('day') : null, clock: p.get('t') ? +p.get('t') : null,
      weather: p.get('w') || null,
    }, progress, !direct);
    if (!direct) this.enterMenuMode();
  }
  fullCarCfg(model) {
    const spec = VEHICLE[model] || VEHICLE.v7;
    const c = carCfg(spec.id);
    return { model: spec.id, color: c.color, plate: c.plate || (save.plates && save.plates[spec.id]) || null, wheels: c.wheels && c.wheels !== 'std' ? c.wheels : null, tires: c.tires || 'summer', tune: c.tune || 'stock', susp: c.susp || 'comfort' };
  }
  async startSession(cfg, progress = () => {}, menuMode = false) {
    const game = this.game;
    const world = game.world;
    const start = world.starts.find((s) => s.id === cfg.start) || world.starts[0];
    // date & time
    const now = new Date();
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
    game.setDateTime(cfg.day ?? doy, cfg.clock ?? (now.getHours() + now.getMinutes() / 60));
    if (game.weather) game.weather.set(cfg.weather || 'auto', game.env.day);
    const carCfg = { ...cfg.car };
    const spec = VEHICLE[carCfg.model] || VEHICLE.v7;
    carCfg.model = spec.id;
    carCfg.trans = transFor(spec);
    carCfg.autoClutch = settings.autoClutch; carCfg.abs = settings.abs; carCfg.tcs = settings.tcs; carCfg.esc = settings.esc;
    let pos = game.startPosition(start);
    const at = this.params.get('at');
    if (at && !this.sessionActive) { const [ax, az] = at.split(',').map((v) => +v * 1000); pos = { x: ax, z: -az, y: 0, yaw: 0 }; }
    progress(0.1, t('loadingArea'));
    await game.preloadAround(pos.x, pos.z, (n) => progress(clamp(1 - n / 120, 0.1, 0.99), t('loadingArea') + ' ' + n));
    game.spawnPlayer(carCfg, start);
    if (save.fuel && save.fuel[spec.id] != null) game.player.phys.fuel = clamp(save.fuel[spec.id], 0, spec.fuel.tank);
    if (at && !this.sessionActive) game.resetToRoad([pos.x, 0, pos.z]);
    game.homeStart = start.id;
    if (game.traffic && game.traffic.clear) game.traffic.clear();
    if (!this.hud) this.hud = game.addModule(new HUD(game));
    this.current = { start: start.id, car: carCfg.model };
    this.sessionActive = true;
    this.menuSession = menuMode;
    this.setupTestHooks();
    document.getElementById('loading').classList.add('hidden');
    if (this.params.get('shot')) {
      // deterministic screenshot mode: warm up then render
      for (let i = 0; i < 4; i++) game.frame(1 / 30);
      window.__shotReady = true;
      return;
    }
    if (!game.running) game.start();
  }
  /* --- modes --- */
  enterMenuMode() {
    const g = this.game;
    g.inMenu = true; g.paused = false;
    g.rig.orbitMode = true; g.rig.orbitAuto = true;
    g.rig.orbit.dist = 7.5; g.rig.orbit.pitch = 0.16; g.rig.orbit.yaw = 2.3;
    g.input.enabled = false;
    this.menu.stack = [];
    this.menu.show('main');
  }
  leaveMenuMode() {
    const g = this.game;
    g.inMenu = false;
    g.rig.orbitMode = false;
    g.rig.setMode(settings.camera || 'cockpit');
    g.rig.fovBase = settings.fov;
    this.menuSession = false;
  }
  async startFromSetup(S) {
    const g = this.game;
    const cfgCar = this.fullCarCfg(S.car);
    save.car.model = S.car; saveGame();
    const day = S.season === 'now' ? null : SEASON_DAY[S.season];
    const clock = S.time === 'now' ? null : TIME_OF[S.time];
    const sameSpot = this.current && this.current.start === S.start && this.current.car === S.car;
    this.menu.close();
    if (!sameSpot) {
      const ld = document.getElementById('loading');
      ld.classList.remove('hidden');
      const fill = document.getElementById('ld-fill'), txt = document.getElementById('ld-text');
      await new Promise((r) => setTimeout(r, 30));
      await this.startSession({ start: S.start, car: cfgCar, day, clock, weather: S.weather === 'dynamic' ? 'auto' : S.weather }, (f, tx) => { fill.style.width = Math.round(f * 100) + '%'; if (tx) txt.textContent = tx; });
    } else {
      const now = new Date();
      const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
      g.setDateTime(day ?? doy, clock ?? (now.getHours() + now.getMinutes() / 60));
      g.weather.set(S.weather === 'dynamic' ? 'auto' : S.weather, g.env.day);
    }
    save.home = S.start; saveGame();
    this.leaveMenuMode();
    g.input.enabled = true; g.input.pressed.clear();
    g.paused = false;
    if (S.dest) {
      const d = g.nav.destinations().find((q) => q.id === S.dest);
      if (d) g.nav.setDestination(d);
    } else g.nav.clear();
  }
  pause() {
    const g = this.game;
    if (g.inMenu) return;
    g.paused = true; g.input.enabled = false;
  }
  resume() {
    const g = this.game;
    this.menu.stack = [];
    this.menu.root.classList.add('hidden');
    this.menu.root.textContent = '';
    if (g.inMenu) { this.leaveMenuMode(); }
    g.paused = false; g.input.enabled = true; g.input.pressed.clear();
    g.clock.getDelta();
  }
  togglePause() {
    const g = this.game;
    if (g.inMenu) return;
    if (this.map.open) { this.map.close(); return; }
    if (this.menu.open) { this.resume(); return; }
    this.pause();
    this.menu.show('pause');
  }
  quitToMenu() {
    saveGame();
    this.game.nav.clear();
    this.enterMenuMode();
  }
  openMap() {
    const g = this.game;
    if (g.inMenu) return;
    this.pause();
    g.mapOpen = true;
    this.map.show();
  }
  onMapClosed() {
    this.game.mapOpen = false;
    if (!this.menu.open) { this.game.paused = false; this.game.input.enabled = true; this.game.input.pressed.clear(); this.game.clock.getDelta(); }
  }
  onMenuClosed() {
    const g = this.game;
    if (!g.inMenu && !g.mapOpen) { g.paused = false; g.input.enabled = true; g.input.pressed.clear(); g.clock.getDelta(); }
  }
  /* garage changes: rebuild the player's car in place */
  carChanged(id, dealer, select = false) {
    const g = this.game;
    const P = g.player;
    if (!P) return;
    if (P.spec.id !== id && !select) return;
    if (select && !dealer && !g.inMenu) return; // switching cars only at a dealer or from the menu
    const ph = P.phys;
    const x = ph.p[0], z = ph.p[2], yaw = ph.yaw ? ph.yaw() : 0, y = ph.p[1] - ph.cgH;
    const fuel = P.spec.id === id ? ph.fuel : null;
    const damage = P.spec.id === id ? { ...ph.damage } : null;
    save.fuel[P.spec.id] = ph.fuel;
    const cfg = this.fullCarCfg(id);
    const spec = VEHICLE[id];
    cfg.trans = transFor(spec);
    cfg.autoClutch = settings.autoClutch; cfg.abs = settings.abs; cfg.tcs = settings.tcs; cfg.esc = settings.esc;
    const start = g.world.starts.find((s) => s.id === (this.current && this.current.start)) || g.world.starts[0];
    g.spawnPlayer(cfg, start);
    g.player.place(x, z, yaw, null);
    if (fuel != null) g.player.phys.fuel = fuel; else if (save.fuel[id] != null) g.player.phys.fuel = save.fuel[id];
    if (damage) Object.assign(g.player.phys.damage, damage);
    this.current.car = id;
    save.car.model = id; saveGame();
  }
  applySettings() {
    const g = this.game;
    g.rig.fovBase = settings.fov;
    const P = g.player;
    if (P) {
      const o = P.phys.opts;
      o.abs = settings.abs && P.spec.brakes.abs !== false; o.tcs = settings.tcs; o.esc = settings.esc; o.autoClutch = settings.autoClutch;
    }
    document.documentElement.lang = settings.lang;
  }
  setupTestHooks() {
    const game = this.game;
    window.__step = (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) game.frame(dt); };
    if (this.params.get('autopilot')) game.inputOverride = autopilot(game, +this.params.get('autopilot'));
    if (this.params.get('cam')) game.rig.setMode(this.params.get('cam'));
    if (this.params.get('view')) game.rig.fixedView = this.params.get('view').split(',').map(Number);
    if (this.params.get('orbit')) { game.rig.orbitMode = true; game.rig.orbitAuto = false; game.rig.orbit.yaw = +this.params.get('orbit') * Math.PI / 180; game.rig.orbit.dist = +(this.params.get('dist') || 7); game.rig.orbit.pitch = +(this.params.get('opitch') || 10) * Math.PI / 180; }
    if (this.params.get('engine')) game.player.phys.startEngineNow();
    if (this.params.get('dest')) { const d = game.nav.destinations().find((q) => q.id === this.params.get('dest') || q.name === this.params.get('dest')); if (d) game.nav.setDestination(d); }
    const m = this.params.get('menu');
    if (m === 'map') this.openMap();
    else if (m === 'pause') { this.pause(); this.menu.show('pause'); }
    else if (m) { this.enterMenuMode(); if (m !== 'main') this.menu.show(m, {}); }
  }
}

/* A simple pure-pursuit autopilot along the lane graph (used for tests & demos). */
export function autopilot(game, targetKmh = 50) {
  let path = null, s = 0;
  const tmp = {};
  return (dt, g) => {
    const P = g.player.phys;
    if (!P.running) { P.startEngineNow(); if (P.autoMode) P.selectAuto('D'); else P.gear = 1; }
    const x = P.p[0], z = P.p[2];
    if (!path) {
      // nearest lane path heading our way
      let best = null, bd = Infinity;
      for (const lp of g.world.paths) {
        if (lp.kind !== 'lane') continue;
        for (let i = 0; i < lp.n; i += 2) {
          const d = Math.hypot(lp.P[i * 3] - x, lp.P[i * 3 + 2] - z);
          if (d < bd) { const f = P.forward; const hx = lp.P[Math.min(lp.n - 1, i + 1) * 3] - lp.P[i * 3], hz = lp.P[Math.min(lp.n - 1, i + 1) * 3 + 2] - lp.P[i * 3 + 2]; if (hx * f[0] + hz * f[2] >= 0) { bd = d; best = lp; s = lp.S[i]; } }
        }
      }
      path = best;
    }
    if (!path) return { throttle: 0, brake: 1 };
    // advance s to closest
    for (let k = 0; k < 40; k++) { path.at(s + 1, tmp); if (Math.hypot(tmp.x - x, tmp.z - z) < Math.hypot((path.at(s, {}).x) - x, path.at(s, {}).z - z)) s += 1; else break; }
    const look = 6 + P.speed * 0.9;
    let ls = s + look, lp = path;
    while (ls > lp.len && lp.exits.length) {
      ls -= lp.len;
      const ex = lp.exits.filter((e) => e.atS >= lp.len - 0.5);
      const pick = ex.length ? ex[Math.floor(((lp.id * 7) % 13) / 13 * ex.length)] : lp.exits[0];
      if (lp === path) { /* entering next */ }
      lp = pick.to; ls += pick.toS || 0;
    }
    if (s > path.len - 0.5 && path.exits.length) { const ex = path.exits.filter((e) => e.atS >= path.len - 0.5); const pick = ex.length ? ex[Math.floor(((path.id * 7) % 13) / 13 * ex.length)] : path.exits[0]; s = (pick.toS || 0) + (s - path.len); path = pick.to; }
    lp.at(ls, tmp);
    const f = P.forward, r = P.right;
    const dx = tmp.x - x, dz = tmp.z - z;
    const lat = dx * r[0] + dz * r[2], lon = dx * f[0] + dz * f[2];
    const curv = 2 * lat / (lat * lat + lon * lon);
    const steerAng = Math.atan(curv * P.spec.body.wb);
    const steer = clamp(steerAng / (P.spec.steer.max * Math.PI / 180), -1, 1);
    let vT = Math.min(targetKmh * KMH, path.speed * 1.05, Math.sqrt(3.5 / Math.max(Math.abs(curv), 1e-3)));
    const lg = g.traffic && g.traffic.leaderGap(g.player);
    if (lg && lg.dist < 60) vT = Math.min(vT, Math.max(0, lg.speed + (lg.dist - 8 - P.fwdSpeed * 1.2) * 0.4));
    const err = vT - P.fwdSpeed;
    return { throttle: clamp(err * 0.35, 0, 1), brake: clamp(-err * 0.2, 0, 1), steer, steerAssist: false, directSteer: true, shiftUp: !P.autoMode && P.rpm > P.spec.engine.redline * 0.8 && P.shiftT <= 0, shiftDown: !P.autoMode && P.gear > 1 && P.rpm < P.spec.engine.idle * 1.6 && P.shiftT <= 0 };
  };
}
