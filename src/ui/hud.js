/* =====================================================================
   Heads-up display (DOM overlay): speed, gear, rev bar, speed limit,
   road name, fuel, clock, temperature, messages and prompts.
   ===================================================================== */
import { t } from '../core/i18n.js';
import { settings, save } from '../core/settings.js';
import { clamp, formatKr } from '../core/math.js';

const html = `
<div id="hud">
  <div id="hud-road"><span class="ref"></span><span class="name"></span><span class="place"></span></div>
  <div id="hud-limit" class="hidden"><span></span></div>
  <div id="hud-msg"></div>
  <div id="hud-prompt" class="hidden"></div>
  <div id="hud-dash">
    <div class="speed"><span id="hud-speed">0</span><small>km/h</small></div>
    <div class="gear" id="hud-gear">N</div>
    <div class="rpm"><div id="hud-rpm"></div></div>
    <div class="icons"><span id="i-indl">◀</span><span id="i-head">◐</span><span id="i-high">≣</span><span id="i-abs">ABS</span><span id="i-esc">ESC</span><span id="i-cruise">⟳</span><span id="i-indr">▶</span></div>
    <div class="row"><span id="hud-fuel"></span><span id="hud-temp"></span><span id="hud-clock"></span></div>
  </div>
  <div id="hud-money"></div>
  <div id="hud-fps" class="hidden"></div>
</div>`;

export class HUD {
  constructor(game) {
    this.game = game;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    this.el = document.getElementById('hud');
    this.$ = (id) => document.getElementById(id);
    this.msgs = [];
    this.timer = 0;
    this.prompt = null;
    game.on('indicator', (v) => {});
    game.on('lights', (m) => this.flash(m === 'auto' ? t('lightsAuto') : m === 'low' ? t('lightsLow') : m === 'high' ? t('lightsHigh') : t('lightsOff')));
    game.on('wipers', (w) => this.flash([t('wipersOff'), t('wipersInt'), t('wipersLow'), t('wipersHigh')][w]));
    game.on('cruise', (c) => this.flash(c != null ? t('cruiseOn', { v: Math.round(c * 3.6) }) : t('cruiseOff')));
    game.on('camera', (m) => this.flash(t(m)));
  }
  flash(text, dur = 2.2, cls = '') {
    const box = this.$('hud-msg');
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    box.appendChild(d);
    setTimeout(() => d.classList.add('out'), dur * 1000);
    setTimeout(() => d.remove(), dur * 1000 + 600);
    while (box.children.length > 4) box.firstChild.remove();
  }
  /* prompts have an owner so gameplay prompts are not overwritten by the HUD's own */
  setPrompt(text, owner = 'hud') {
    const el = this.$('hud-prompt');
    if (!text) {
      if (this.promptOwner && this.promptOwner !== owner) return;
      this.promptOwner = null;
    } else {
      if (this.promptOwner && this.promptOwner !== owner && owner === 'hud') return;
      this.promptOwner = owner;
    }
    if (text === this.prompt) return;
    this.prompt = text;
    if (!text) el.classList.add('hidden'); else { el.textContent = text; el.classList.remove('hidden'); }
  }
  update(dt, game) {
    const P = game.player;
    if (!P) return;
    this.el.classList.toggle('hidden', !settings.hud || !!game.inMenu);
    this.timer -= dt;
    const ph = P.phys;
    const kmh = Math.abs(ph.fwdSpeed) * 3.6;
    this.$('hud-speed').textContent = Math.round(kmh);
    this.$('hud-gear').textContent = ph.gearLabel();
    const E = P.spec.engine;
    const rp = ph.ev ? clamp(ph.load, 0, 1) : clamp(ph.rpm / E.limiter, 0, 1);
    const rpm = this.$('hud-rpm');
    rpm.style.width = (rp * 100).toFixed(1) + '%';
    rpm.classList.toggle('red', !ph.ev && ph.rpm > E.redline * 0.97);
    const on = (id, v) => this.$(id).classList.toggle('on', !!v);
    on('i-indl', (P.indicator === -1 || P.indicator === 2) && P.blinkOn);
    on('i-indr', (P.indicator === 1 || P.indicator === 2) && P.blinkOn);
    on('i-head', P.headOn); on('i-high', P.highOn && P.headOn);
    on('i-abs', ph.absActive); on('i-esc', ph.esc || ph.tcsActive); on('i-cruise', P.cruise != null);
    if (this.timer <= 0) {
      this.timer = 0.25;
      const fuelTxt = ph.ev ? `⚡ ${Math.round(ph.fuel / P.spec.fuel.tank * 100)} %` : `⛽ ${ph.fuel.toFixed(1)} L`;
      this.$('hud-fuel').textContent = fuelTxt;
      const temp = game.conditions.temp;
      this.$('hud-temp').textContent = `${temp.toFixed(0)}°C${temp < 3 ? ' ❄' : ''}`;
      const c = game.env.clock;
      this.$('hud-clock').textContent = `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60)).padStart(2, '0')}`;
      this.$('hud-money').textContent = formatKr(save.money);
      this.$('hud-money').classList.toggle('neg', save.money < 0);
      const ri = P.roadInfo;
      const road = this.$('hud-road');
      if (ri && ri.road) {
        const r = ri.road;
        road.querySelector('.ref').textContent = r.ref || '';
        road.querySelector('.ref').className = 'ref ' + (r.ref ? (r.ref.startsWith('E') ? 'eroad' : 'nroad') : 'none');
        road.querySelector('.name').textContent = r.ref ? '' : (r.name || '');
        this.limit(r.speed);
      } else { road.querySelector('.ref').textContent = ''; road.querySelector('.ref').className = 'ref none'; road.querySelector('.name').textContent = ''; this.limit(null); }
      road.querySelector('.place').textContent = game.placeName || '';
      const fps = this.$('hud-fps');
      fps.classList.toggle('hidden', !settings.showFps);
      if (settings.showFps) fps.textContent = `${game.fps.toFixed(0)} fps · ${game.frameMs.toFixed(1)} ms · ${game.renderer.info.render.calls} dc · ${(game.renderer.info.render.triangles / 1000).toFixed(0)}k tri`;
    }
    if (!ph.running && !(ph.starter > 0) && !game.inMenu) {
      // say why the engine will not start instead of just asking for the key again
      const why = ph.flooded ? t('floodedEngine') : ph.damage.engine >= 1 ? t('brokenEngine') : ph.fuel <= 0.05 ? t('noFuel')
        : !ph.autoMode && ph.gear !== 0 && !ph.opts.autoClutch ? t('pressIgnition', { key: 'I' }) + ' · ' + t('needClutch') : null;
      this.setPrompt(why || t('pressIgnition', { key: 'I' }));
    } else if (this.promptOwner === 'hud') this.setPrompt(null);
    for (const e of P.events || []) {
      if (e === 'stall') this.flash(ph.opts.autoClutch ? t('engineStalled') : t('stallHint'), 3, 'warn');
      if (e === 'needclutch') this.flash(t('needClutch'), 3.5, 'warn');
      if (e === 'nostart') this.flash(ph.noStartReason === 'water' ? t('floodedEngine') : ph.noStartReason === 'engine' ? t('brokenEngine') : t('noFuel'), 4, 'warn');
      if (e === 'dead') this.flash(t('engineDead'), 4, 'warn');
      if (e === 'empty') this.flash(t('fuelEmpty'), 4, 'warn');
    }
  }
  limit(v) {
    const el = this.$('hud-limit');
    if (!v || !settings.speedLimitHint) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.firstElementChild.textContent = v;
  }
}
