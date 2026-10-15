/* =====================================================================
   App controller: boot, menus, sessions, HUD wiring.
   ===================================================================== */
import { settings, save, saveGame } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { HUD } from './hud.js';
import { VEHICLE } from '../vehicle/specs.js';
import { clamp, lerp, KMH } from '../core/math.js';

export class App {
  constructor(game, params) {
    this.game = game;
    this.params = params;
    this.hud = null;
  }
  async boot(progress) {
    const p = this.params;
    if (p.get('autostart') || p.get('shot') || !this.menu) {
      await this.startSession({
        start: p.get('start') || save.home || 'bromma',
        car: { ...save.car, model: p.get('car') || save.car.model },
        day: p.get('day') ? +p.get('day') : null, clock: p.get('t') ? +p.get('t') : null,
        weather: p.get('w') || null,
      }, progress);
    }
  }
  async startSession(cfg, progress = () => {}) {
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
    if (carCfg.trans == null) carCfg.trans = settings.trans === 'manual' && spec.gearbox.type !== 'ev' && spec.gearbox.type !== 'auto' ? 'manual' : spec.gearbox.type === 'manual' && settings.trans === 'manual' ? 'manual' : spec.gearbox.type === 'manual' ? 'manual' : 'auto';
    carCfg.autoClutch = settings.autoClutch; carCfg.abs = settings.abs; carCfg.tcs = settings.tcs; carCfg.esc = settings.esc;
    const pos = game.startPosition(start);
    progress(0.1, t('loadingArea'));
    await game.preloadAround(pos.x, pos.z, (n) => progress(clamp(1 - n / 120, 0.1, 0.99), t('loadingArea') + ' ' + n));
    game.spawnPlayer(carCfg, start);
    if (!this.hud) this.hud = game.addModule(new HUD(game));
    this.setupTestHooks();
    document.getElementById('loading').classList.add('hidden');
    if (this.params.get('shot')) {
      // deterministic screenshot mode: warm up then render
      for (let i = 0; i < 4; i++) game.frame(1 / 30);
      window.__shotReady = true;
      return;
    }
    game.start();
  }
  setupTestHooks() {
    const game = this.game;
    window.__step = (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) game.frame(dt); };
    if (this.params.get('autopilot')) game.inputOverride = autopilot(game, +this.params.get('autopilot'));
    if (this.params.get('cam')) game.rig.setMode(this.params.get('cam'));
    if (this.params.get('view')) game.rig.fixedView = this.params.get('view').split(',').map(Number);
    if (this.params.get('orbit')) { game.rig.orbitMode = true; game.rig.orbitAuto = false; game.rig.orbit.yaw = +this.params.get('orbit') * Math.PI / 180; game.rig.orbit.dist = +(this.params.get('dist') || 7); game.rig.orbit.pitch = +(this.params.get('opitch') || 10) * Math.PI / 180; }
    if (this.params.get('engine')) game.player.phys.startEngineNow();
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
