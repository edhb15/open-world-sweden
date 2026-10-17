/* =====================================================================
   Menus (DOM): main menu, start setup, garage & customisation,
   settings (incl. wheel binding), controls help and pause menu.
   ===================================================================== */
import { settings, save, saveSettings, saveGame } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { VEHICLES, VEHICLE, UPGRADES } from '../vehicle/specs.js';
import { formatKr, clamp } from '../core/math.js';
import { DEFAULT_KEYS } from '../input/input.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const L = (o) => (o ? (settings.lang === 'sv' ? o.sv : o.en) || o.en || o.sv : '');

export const SEASON_DAY = { spring: 128, summer: 190, autumn: 283, winter: 22 };
export const TIME_OF = { morning: 8, noon: 13, evening: 19.2, night: 23.4 };
const PALETTE = [0xf2f2f2, 0x0f0f10, 0x8a9aa8, 0x2c3e50, 0x1d4f91, 0x6d1f23, 0xb3121b, 0x2e4d3a, 0x6b8f3a, 0xe0b000, 0xd96a1d, 0x5a3e8a, 0x7a6a58, 0xc8b89a];

export function enginePower(spec) {
  const E = spec.engine;
  if (E.type === 'ev') return E.maxPower;
  let p = 0;
  for (const [rpm, tq] of E.torque) p = Math.max(p, tq * rpm / 9549);
  return Math.round(p * (1 + (E.turbo || 0) * 0)); // torque curve already includes boost
}
export function carCfg(id) {
  save.cars ||= {};
  const c = (save.cars[id] ||= { color: null, plate: null, wheels: null, tires: 'summer', tune: 'stock', susp: 'comfort', bought: { tires: ['summer'], tune: ['stock'], susp: ['comfort'], wheels: ['std'] } });
  c.bought ||= { tires: ['summer'], tune: ['stock'], susp: ['comfort'], wheels: ['std'] };
  return c;
}

export class Menu {
  constructor(app) {
    this.app = app;
    this.game = app.game;
    this.root = h('div', { id: 'ui', class: 'hidden' });
    document.body.appendChild(this.root);
    this.stack = [];
    this.setup = { start: save.home || 'bromma', dest: '', car: save.car.model, season: 'now', time: 'now', weather: 'dynamic' };
    addEventListener('keydown', (e) => {
      if (this.root.classList.contains('hidden')) return;
      if (e.code === 'Escape' && this.stack.length > 1) { e.stopPropagation(); this.back(); }
    }, true);
  }
  get open() { return !this.root.classList.contains('hidden'); }
  show(screen, ...args) {
    this.stack.push([screen, args]);
    this.render();
  }
  replace(screen, ...args) { this.stack.pop(); this.show(screen, ...args); }
  back() {
    this.stack.pop();
    if (!this.stack.length) { this.close(); return; }
    this.render();
  }
  close() {
    this.stack = [];
    this.root.classList.add('hidden');
    this.root.textContent = '';
    this.app.onMenuClosed();
  }
  render() {
    const [screen, args] = this.stack[this.stack.length - 1];
    this.root.textContent = '';
    this.root.className = 'screen-' + screen;
    const body = this['s_' + screen](...args);
    this.root.append(body);
    const first = this.root.querySelector('button.primary') || this.root.querySelector('button');
    if (first && !('ontouchstart' in window)) first.focus({ preventScroll: true });
  }
  panel(title, ...kids) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, this.stack.length > 1 ? h('button', { class: 'back', onclick: () => this.back(), 'aria-label': t('back') }, '‹') : null, h('h2', { text: title })),
      h('div', { class: 'panel-body' }, ...kids));
  }

  /* ---------------- main ---------------- */
  s_main() {
    const live = this.app.sessionActive && !this.app.menuSession;
    return h('div', { class: 'main' },
      h('div', { class: 'brand' },
        h('div', { class: 'flag' }),
        h('h1', { text: t('title') }),
        h('p', { text: t('subtitle') })),
      h('div', { class: 'main-buttons' },
        live ? h('button', { class: 'primary', onclick: () => this.app.resume() }, t('continue')) : null,
        h('button', { class: live ? '' : 'primary', onclick: () => this.show('setup') }, live ? t('newGame') : t('drive')),
        h('button', { onclick: () => this.show('garage', {}) }, t('garage')),
        h('button', { onclick: () => this.show('settings') }, t('settings')),
        h('button', { onclick: () => this.show('controls') }, t('controls'))),
      h('div', { class: 'main-foot' },
        h('span', { text: `${t('money')}: ${formatKr(save.money)}` }),
        h('span', { text: `${t('odo')}: ${Math.round(save.odo).toLocaleString('sv-SE')} km` }),
        h('span', { class: 'tip', text: t('tips') })));
  }

  /* ---------------- start setup ---------------- */
  s_setup() {
    const S = this.setup;
    const world = this.game.world;
    const sel = (key, options, onchange) => h('select', { onchange: (e) => { S[key] = e.target.value; if (onchange) onchange(); } },
      ...options.map(([v, label]) => { const o = h('option', { value: v }, label); if (String(S[key]) === String(v)) o.selected = true; return o; }));
    const starts = world.starts.map((s) => [s.id, s.label + (s.id === save.home ? ' – ' + t('home') : '')]);
    const dests = [['', t('none')], ...this.game.nav.destinations().filter((d) => d.kind === 'city' || d.kind === 'home' || d.kind === 'landmark').map((d) => [d.id, d.name])];
    const owned = VEHICLES.filter((v) => save.owned.includes(v.id));
    const card = h('div', { class: 'car-preview' });
    const showCar = () => {
      const v = VEHICLE[S.car];
      card.textContent = '';
      card.append(h('b', { text: `${v.brand} ${v.model}` }), h('span', { text: ` · ${v.year} · ${enginePower(v)} kW · ${v.drive} · ${v.gearbox.type === 'manual' ? t('manual') : t('automatic')}` }), h('p', { text: L(v.desc) }));
    };
    showCar();
    const row = (label, ctl) => h('label', { class: 'row' }, h('span', { text: label }), ctl);
    return this.panel(t('drive'),
      row(t('startLoc'), sel('start', starts)),
      row(t('destination'), sel('dest', dests)),
      row(t('vehicle'), sel('car', owned.map((v) => [v.id, `${v.brand} ${v.model} (${v.year})`]), showCar)),
      card,
      row(t('season'), sel('season', [['now', t('now')], ['spring', t('spring')], ['summer', t('summer')], ['autumn', t('autumn')], ['winter', t('winter')]])),
      row(t('time'), sel('time', [['now', t('now')], ['morning', t('morning')], ['noon', t('noon')], ['evening', t('evening')], ['night', t('night')]])),
      row(t('weather'), sel('weather', [['dynamic', t('dynamic')], ['clear', t('clear')], ['cloudy', t('cloudy')], ['overcast', t('overcast')], ['rain', t('rain')], ['storm', t('storm')], ['snow', t('snow')], ['fog', t('fog')]])),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => this.app.startFromSetup(S) }, t('start'))));
  }

  /* ---------------- garage ---------------- */
  s_garage(opts = {}) {
    const dealer = !!opts.dealer;
    this.gsel ||= this.game.player ? this.game.player.spec.id : save.car.model;
    const list = h('div', { class: 'car-list' });
    const detail = h('div', { class: 'car-detail' });
    const money = h('div', { class: 'wallet' });
    const refreshMoney = () => { money.textContent = `${t('money')}: ${formatKr(save.money)}`; money.classList.toggle('neg', save.money < 0); };
    const draw = () => {
      refreshMoney();
      list.textContent = '';
      for (const v of VEHICLES) {
        const own = save.owned.includes(v.id);
        list.append(h('button', { class: 'car-item' + (v.id === this.gsel ? ' sel' : '') + (own ? ' own' : ''), onclick: () => { this.gsel = v.id; draw(); } },
          h('b', { text: `${v.brand} ${v.model}` }),
          h('small', { text: own ? t('owned') + (v.id === save.car.model ? ' ✓' : '') : formatKr(v.price) })));
      }
      detail.textContent = '';
      const v = VEHICLE[this.gsel];
      const own = save.owned.includes(v.id);
      const cfg = carCfg(v.id);
      detail.append(
        h('h3', { text: `${v.brand} ${v.model}` }),
        h('p', { class: 'muted', text: `${v.year} · ${({ wagon: 'Kombi', hatch: 'Halvkombi', suv: 'SUV', ev: settings.lang === 'sv' ? 'Elbil' : 'EV', lux: settings.lang === 'sv' ? 'Lyx' : 'Luxury', classic: settings.lang === 'sv' ? 'Klassiker' : 'Classic', van: settings.lang === 'sv' ? 'Skåpbil' : 'Van', old: settings.lang === 'sv' ? 'Veteran' : 'Vintage', sedan: 'Sedan', bus: 'Buss', truck: settings.lang === 'sv' ? 'Lastbil' : 'Truck' })[v.cls] || v.cls}` }),
        h('p', { text: L(v.desc) }),
        h('div', { class: 'stats' },
          stat(settings.lang === 'sv' ? 'Effekt' : 'Power', `${enginePower(v)} kW (${Math.round(enginePower(v) * 1.36)} hk)`),
          stat(settings.lang === 'sv' ? 'Drivning' : 'Drive', v.drive === 'AWD' ? (settings.lang === 'sv' ? 'Fyrhjulsdrift' : 'All-wheel') : v.drive === 'RWD' ? (settings.lang === 'sv' ? 'Bakhjulsdrift' : 'Rear-wheel') : (settings.lang === 'sv' ? 'Framhjulsdrift' : 'Front-wheel')),
          stat(t('transmission'), v.gearbox.type === 'manual' ? `${t('manual')} ${v.gearbox.ratios.length}` : v.gearbox.type === 'ev' ? '1' : `${t('automatic')} ${v.gearbox.ratios.length}`),
          stat(settings.lang === 'sv' ? 'Vikt' : 'Weight', `${v.mass} kg`),
          stat(v.engine.type === 'ev' ? t('battery') : t('fuel'), v.engine.type === 'ev' ? `${v.fuel.tank} kWh` : `${v.fuel.tank} l ${v.engine.type === 'diesel' ? 'diesel' : (settings.lang === 'sv' ? 'bensin' : 'petrol')}`),
          stat('ABS', v.brakes.abs ? t('on') : t('off'))));
      if (!own) {
        const can = save.money >= v.price;
        detail.append(h('div', { class: 'actions' }, h('button', { class: 'primary', disabled: !can, onclick: () => {
          if (save.money < v.price) return;
          save.money -= v.price; save.owned.push(v.id); saveGame(); draw();
        } }, `${t('buy')} · ${formatKr(v.price)}`), !can ? h('span', { class: 'muted', text: settings.lang === 'sv' ? 'Inte tillräckligt med pengar' : 'Not enough money' }) : null));
        return;
      }
      // customisation
      const opt = (group, key, label, price) => {
        const has = cfg.bought[group] && cfg.bought[group].includes(key);
        const cur = (cfg[group] || (group === 'wheels' ? 'std' : null)) === key;
        return h('button', { class: 'chip' + (cur ? ' sel' : ''), onclick: () => {
          if (!has) { if (save.money < price) return; save.money -= price; (cfg.bought[group] ||= []).push(key); }
          cfg[group] = key; saveGame(); draw(); this.app.carChanged(v.id, dealer);
        } }, label, h('small', { text: has ? '' : ' ' + formatKr(price) }));
      };
      const sect = (title, ...kids) => h('div', { class: 'sect' }, h('h4', { text: title }), h('div', { class: 'chips' }, ...kids));
      const colors = [...new Set([...v.colors, ...PALETTE])];
      const curColor = cfg.color ?? v.colors[0];
      detail.append(
        sect(t('paint') + ' · ' + formatKr(4500), ...colors.map((c) => h('button', { class: 'swatch' + (c === curColor ? ' sel' : ''), style: `background:#${c.toString(16).padStart(6, '0')}`, 'aria-label': '#' + c.toString(16), onclick: () => {
          if (c === curColor) return;
          const free = v.colors.includes(c) && cfg.paintFree !== false && !cfg.painted;
          if (!free) { if (save.money < 4500) return; save.money -= 4500; cfg.painted = true; }
          cfg.color = c; saveGame(); draw(); this.app.carChanged(v.id, dealer);
        } }))),
        sect(t('wheels'), ...Object.entries(UPGRADES.wheels).map(([k, u]) => opt('wheels', k, L(u), u.price))),
        sect(t('tires'), ...Object.entries(UPGRADES.tires).map(([k, u]) => opt('tires', k, L(u), u.price))),
        sect(t('tune'), ...Object.entries(UPGRADES.tune).filter(([k]) => v.engine.type !== 'ev' || k === 'stock').map(([k, u]) => opt('tune', k, L(u), u.price))),
        sect(t('suspension'), ...Object.entries(UPGRADES.susp).map(([k, u]) => opt('susp', k, L(u), u.price))));
      const plateIn = h('input', { type: 'text', maxlength: 7, value: cfg.plate || '', placeholder: 'ABC 12D', spellcheck: 'false', autocomplete: 'off' });
      detail.append(h('div', { class: 'sect' }, h('h4', { text: t('plate') + ' · ' + formatKr(1500) }), h('div', { class: 'row' }, plateIn, h('button', { onclick: () => {
        const p = plateIn.value.toUpperCase().replace(/[^A-ZÅÄÖ0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const ok = /^[A-HJ-PR-UW-Z]{3} ?\d{2}[A-HJ-PR-UW-Z0-9]$/.test(p) || /^[A-ZÅÄÖ0-9 ]{2,7}$/.test(p);
        if (!ok || p === cfg.plate) return;
        if (save.money < 1500) return;
        save.money -= 1500; cfg.plate = p.length === 6 && !p.includes(' ') ? p.slice(0, 3) + ' ' + p.slice(3) : p; saveGame(); draw(); this.app.carChanged(v.id, dealer);
      } }, t('apply')))));
      const actions = h('div', { class: 'actions' });
      if (v.id !== (this.game.player ? this.game.player.spec.id : save.car.model)) actions.append(h('button', { class: 'primary', onclick: () => { save.car.model = v.id; saveGame(); this.app.carChanged(v.id, dealer, true); draw(); } }, t('select')));
      if (dealer && this.game.gameplay) {
        const cost = this.game.gameplay.repairCost();
        if (cost > 0) actions.append(h('button', { onclick: () => { this.game.gameplay.repair(); draw(); } }, `${t('repair')} · ${formatKr(cost)}`));
      }
      detail.append(actions);
    };
    const stat = (k, v) => h('div', { class: 'stat' }, h('span', { text: k }), h('b', { text: v }));
    draw();
    return this.panel(dealer ? `${t('dealership')} – ${opts.dealer.name || ''}` : t('garage'), money, h('div', { class: 'garage' }, list, detail));
  }

  /* ---------------- settings ---------------- */
  s_settings() {
    const S = settings;
    const changed = () => { saveSettings(); this.app.applySettings(); };
    const sel = (key, options, cb) => h('select', { onchange: (e) => { const v = e.target.value; S[key] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) || v === '' ? v : +v; changed(); if (cb) cb(); } },
      ...options.map(([v, label]) => { const o = h('option', { value: v }, label); if (String(S[key]) === String(v)) o.selected = true; return o; }));
    const range = (key, min, max, step, fmt) => {
      const out = h('output', { text: fmt(S[key]) });
      return h('span', { class: 'range' }, h('input', { type: 'range', min, max, step, value: S[key], oninput: (e) => { S[key] = +e.target.value; out.textContent = fmt(S[key]); changed(); } }), out);
    };
    const onoff = (key) => sel(key, [['true', t('on')], ['false', t('off')]]);
    const row = (label, ctl, note) => h('label', { class: 'row' }, h('span', { text: label }), ctl, note ? h('small', { class: 'muted', text: note }) : null);
    const restart = settings.lang === 'sv' ? 'kräver omstart' : 'needs restart';
    return this.panel(t('settings'),
      h('div', { class: 'cols' },
        h('div', {},
          h('h4', { text: settings.lang === 'sv' ? 'Allmänt' : 'General' }),
          row(t('language'), sel('lang', [['sv', 'Svenska'], ['en', 'English']], () => this.render())),
          row(t('quality'), sel('quality', [['auto', t('auto')], ['low', t('low')], ['medium', t('medium')], ['high', t('high')], ['ultra', t('ultra')]]), restart),
          row(t('volume'), range('volume', 0, 1, 0.05, (v) => Math.round(v * 100) + ' %')),
          row(settings.lang === 'sv' ? 'Motorljud' : 'Engine volume', range('engineVol', 0, 1.5, 0.05, (v) => Math.round(v * 100) + ' %')),
          row(t('voice'), onoff('voice')),
          row(t('traffic'), range('traffic', 0, 1.6, 0.1, (v) => Math.round(v * 100) + ' %')),
          row(t('pedestrians'), onoff('pedestrians')),
          row(t('fines'), onoff('fines')),
          row('HUD', onoff('hud')),
          row(settings.lang === 'sv' ? 'Minikarta' : 'Minimap', onoff('minimap')),
          row(settings.lang === 'sv' ? 'Visa hastighetsgräns' : 'Show speed limit', onoff('speedLimitHint')),
          row('FPS', onoff('showFps'))),
        h('div', {},
          h('h4', { text: t('assists') }),
          row(t('transmission'), sel('trans', [['auto', t('automatic')], ['manual', t('manual')]])),
          row(t('autoClutch'), onoff('autoClutch')),
          row('ABS', onoff('abs')), row(settings.lang === 'sv' ? 'Antispinn (TCS)' : 'Traction control', onoff('tcs')), row(settings.lang === 'sv' ? 'Antisladd (ESC)' : 'Stability control', onoff('esc')),
          row(settings.lang === 'sv' ? 'Styrhjälp' : 'Steering assist', onoff('steerAssist')),
          h('h4', { text: t('camera') }),
          row(t('camera'), sel('camera', [['cockpit', t('cockpit')], ['hood', t('hood')], ['chase', t('chase')], ['cinematic', t('cinematic')]])),
          row(t('fov'), range('fov', 50, 90, 1, (v) => v + '°')),
          h('div', { class: 'actions' }, h('button', { onclick: () => this.show('wheel') }, t('wheelSetup'))))));
  }

  /* ---------------- wheel binding ---------------- */
  s_wheel() {
    const input = this.game.input;
    const pads = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
    const status = h('p', { class: 'muted', text: pads.length ? pads.map((p) => p.id).join(', ') : (settings.lang === 'sv' ? 'Ingen ratt eller handkontroll hittades. Anslut och tryck på en knapp.' : 'No wheel or gamepad found. Connect one and press a button.') });
    const W = (settings.wheel ||= { id: pads[0] ? pads[0].id : null });
    const describe = (b) => (b ? (b.axis != null ? `${settings.lang === 'sv' ? 'axel' : 'axis'} ${b.axis}` : '') : '–');
    const rows = h('div', {});
    const bindAxis = (key, label, isSteer = false) => {
      const val = h('b', { text: describe(W[key]) });
      const btn = h('button', { onclick: () => {
        const gp = [...navigator.getGamepads()].filter(Boolean)[0];
        if (!gp) return;
        W.id = gp.id;
        btn.textContent = t('bindPrompt');
        const base = [...gp.axes];
        input.binding = {
          gpId: gp.id,
          sample: (g) => {
            let bi = -1, bd = 0.35;
            g.axes.forEach((a, i) => { const d = Math.abs(a - base[i]); if (d > bd) { bd = d; bi = i; } });
            if (bi < 0) return;
            input.binding = null;
            const rest = base[bi], moved = g.axes[bi];
            W[key] = isSteer ? { axis: bi, center: 0, gain: 1, invert: false } : { axis: bi, min: rest, max: moved > rest ? 1 : -1 };
            settings.wheel = W; saveSettings();
            val.textContent = describe(W[key]); btn.textContent = t('select');
          },
        };
      } }, t('select'));
      rows.append(h('div', { class: 'row' }, h('span', { text: label }), val, btn));
    };
    bindAxis('steer', t('bindSteer'), true); bindAxis('throttle', t('bindThrottle')); bindAxis('brake', t('bindBrake')); bindAxis('clutch', t('bindClutch'));
    const bindBtn = (key, label) => {
      const val = h('b', { text: W[key] != null ? `#${W[key]}` : '–' });
      const btn = h('button', { onclick: () => {
        btn.textContent = t('bindPrompt');
        const t0 = performance.now();
        const poll = () => {
          const gp = [...navigator.getGamepads()].filter(Boolean)[0];
          if (gp) { const i = gp.buttons.findIndex((b) => b.pressed); if (i >= 0) { W.id = gp.id; W[key] = i; settings.wheel = W; saveSettings(); val.textContent = '#' + i; btn.textContent = t('select'); return; } }
          if (performance.now() - t0 < 8000) requestAnimationFrame(poll); else btn.textContent = t('select');
        };
        poll();
      } }, t('select'));
      rows.append(h('div', { class: 'row' }, h('span', { text: label }), val, btn));
    };
    bindBtn('btnUp', t('bindUp')); bindBtn('btnDown', t('bindDown'));
    return this.panel(t('wheelSetup'), status, rows,
      h('div', { class: 'actions' }, h('button', { onclick: () => { settings.wheel = null; saveSettings(); this.back(); } }, settings.lang === 'sv' ? 'Rensa ratt' : 'Clear wheel')));
  }

  /* ---------------- controls ---------------- */
  s_controls() {
    const sv = settings.lang === 'sv';
    const names = sv
      ? { throttle: 'Gas', brake: 'Broms / back', left: 'Styr vänster', right: 'Styr höger', handbrake: 'Handbroms', clutch: 'Koppling', shiftUp: 'Växla upp', shiftDown: 'Växla ner', ignition: 'Tändning', indLeft: 'Blinkers vänster', indRight: 'Blinkers höger', hazard: 'Varningsblinkers', lights: 'Strålkastare', highBeam: 'Helljus', wipers: 'Vindrutetorkare', horn: 'Signalhorn', camera: 'Byt kamera', lookBack: 'Titta bakåt', map: 'Karta', pause: 'Paus', interact: 'Interagera (tanka, bilhall)', reset: 'Återställ till väg', cruise: 'Farthållare', gps: 'GPS hem / avbryt', lookLeft: 'Titta vänster', lookRight: 'Titta höger', park: 'P', reverse: 'R', neutral: 'N', drive: 'D' }
      : { throttle: 'Throttle', brake: 'Brake / reverse', left: 'Steer left', right: 'Steer right', handbrake: 'Handbrake', clutch: 'Clutch', shiftUp: 'Shift up', shiftDown: 'Shift down', ignition: 'Ignition', indLeft: 'Indicator left', indRight: 'Indicator right', hazard: 'Hazard lights', lights: 'Headlights', highBeam: 'High beam', wipers: 'Wipers', horn: 'Horn', camera: 'Change camera', lookBack: 'Look back', map: 'Map', pause: 'Pause', interact: 'Interact (refuel, dealer)', reset: 'Reset to road', cruise: 'Cruise control', gps: 'GPS home / cancel', lookLeft: 'Look left', lookRight: 'Look right', park: 'P', reverse: 'R', neutral: 'N', drive: 'D' };
    const keyName = (c) => c.replace(/^Key/, '').replace(/^Digit/, '').replace('Left', ' V').replace('Arrow', '').replace('Control', 'Ctrl').replace('Escape', 'Esc').replace('Comma', ',').replace('Period', '.');
    const tbl = h('table', { class: 'keys' });
    for (const k in names) {
      const keys = (settings.keys && settings.keys[k]) || DEFAULT_KEYS[k] || [];
      tbl.append(h('tr', {}, h('td', { text: names[k] }), h('td', {}, ...keys.map((c) => h('kbd', { text: keyName(c) })))));
    }
    const pad = sv
      ? 'Handkontroll: vänster spak styr, RT gas, LT broms, A handbroms, B titta bakåt, X signalhorn, Y kamera, LB/RB växla, Start paus, Back karta, vänster spakknapp tändning, höger spakknapp ljus, styrkors: torkare, farthållare, blinkers.'
      : 'Gamepad: left stick steers, RT throttle, LT brake, A handbrake, B look back, X horn, Y camera, LB/RB shift, Start pause, Back map, left stick press ignition, right stick press lights, d-pad: wipers, cruise, indicators.';
    const wheel = sv ? 'Ratt och pedaler: koppla in under Inställningar → Ratt & pedaler.' : 'Steering wheel and pedals: bind them under Settings → Wheel & pedals.';
    const touch = sv ? 'Pekskärm: dra i ratten till vänster, gas och broms till höger.' : 'Touch: drag the wheel on the left, throttle and brake on the right.';
    const rules = sv
      ? ['Högertrafik. Håll till höger och kör om till vänster.', 'Halvljus ska alltid vara på.', 'Högerregeln gäller i korsningar utan skyltar.', 'I rondeller lämnar du företräde åt trafiken i rondellen.', 'Stanna för gående vid obevakade övergångsställen.', 'Vinterdäck krävs vid vinterväglag (1 dec–31 mars).']
      : ['Right-hand traffic. Keep right, overtake on the left.', 'Dipped headlights must always be on.', 'Give way to the right at unmarked junctions.', 'At roundabouts give way to traffic already on the ring.', 'Stop for pedestrians at zebra crossings.', 'Winter tyres are required in winter conditions (1 Dec–31 Mar).'];
    return this.panel(t('controls'), h('div', { class: 'cols' }, h('div', {}, tbl), h('div', {}, h('p', { text: pad }), h('p', { text: wheel }), h('p', { text: touch }), h('h4', { text: sv ? 'Svenska trafikregler' : 'Swedish traffic rules' }), h('ul', {}, ...rules.map((r) => h('li', { text: r }))))));
  }

  /* ---------------- pause ---------------- */
  s_pause() {
    return h('div', { class: 'pause' },
      h('h2', { text: t('pause') }),
      h('div', { class: 'main-buttons' },
        h('button', { class: 'primary', onclick: () => this.app.resume() }, t('resume')),
        h('button', { onclick: () => { this.close(); this.app.openMap(); } }, t('map')),
        h('button', { onclick: () => this.show('world') }, t('world')),
        h('button', { onclick: () => { this.app.resume(); this.game.emit('reset-request'); } }, t('reset')),
        h('button', { onclick: () => this.show('garage', {}) }, t('garage')),
        h('button', { onclick: () => this.show('settings') }, t('settings')),
        h('button', { onclick: () => this.show('controls') }, t('controls')),
        h('button', { onclick: () => this.app.quitToMenu() }, t('quit'))),
      h('div', { class: 'main-foot' }, h('span', { text: `${t('money')}: ${formatKr(save.money)}` }), h('span', { text: `${t('fineList')}: ${save.fines.length ? save.fines.length + ' (' + formatKr(save.fines.reduce((a, f) => a + f.kr, 0)) + ')' : t('noFines')}` })));
  }

  /* ---------------- weather & time ---------------- */
  s_world() {
    const g = this.game, env = g.env;
    const clockOut = h('output', { text: fmtClock(env.clock) });
    const dayOut = h('output', { text: fmtDay(env.day) });
    const wsel = h('select', { onchange: (e) => g.weather.set(e.target.value, env.day) },
      ...['dynamic', 'clear', 'cloudy', 'overcast', 'rain', 'storm', 'snow', 'fog'].map((k) => { const o = h('option', { value: k }, t(k)); if ((g.weather.mode === 'auto' ? 'dynamic' : g.weather.mode) === k) o.selected = true; return o; }));
    const ts = h('select', { onchange: (e) => { g.clockScale = +e.target.value; } },
      ...[[1, t('realtime')], [10, '×10'], [60, '×60'], [360, '×360']].map(([v, l]) => { const o = h('option', { value: v }, l); if ((g.clockScale ?? 1) === v) o.selected = true; return o; }));
    return this.panel(t('world'),
      h('label', { class: 'row' }, h('span', { text: t('time') }), h('input', { type: 'range', min: 0, max: 23.95, step: 0.05, value: env.clock, oninput: (e) => { g.setDateTime(env.day, +e.target.value); clockOut.textContent = fmtClock(+e.target.value); } }), clockOut),
      h('label', { class: 'row' }, h('span', { text: settings.lang === 'sv' ? 'Datum' : 'Date' }), h('input', { type: 'range', min: 1, max: 365, step: 1, value: env.day, oninput: (e) => { g.setDateTime(+e.target.value, env.clock); dayOut.textContent = fmtDay(+e.target.value); } }), dayOut),
      h('label', { class: 'row' }, h('span', { text: t('weather') }), wsel),
      h('label', { class: 'row' }, h('span', { text: t('timeSpeed') }), ts));
  }
}

const MONTHS = { sv: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'], en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
function fmtDay(d) { const dt = new Date(2026, 0, d); return `${dt.getDate()} ${MONTHS[settings.lang === 'sv' ? 'sv' : 'en'][dt.getMonth()]}`; }
function fmtClock(c) { return `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60)).padStart(2, '0')}`; }
export { h, clamp };
