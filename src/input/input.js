/* =====================================================================
   Input: keyboard, gamepads (standard mapping), steering wheels and
   pedals (bindable axes), mouse look and touch controls.
   ===================================================================== */
import { clamp } from '../core/math.js';

export const DEFAULT_KEYS = {
  throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'], clutch: ['KeyC'], shiftUp: ['ShiftLeft', 'KeyE'], shiftDown: ['ControlLeft', 'KeyQ'],
  ignition: ['KeyI'], indLeft: ['KeyZ', 'Comma'], indRight: ['KeyX', 'Period'], hazard: ['KeyJ'], lights: ['KeyL'], highBeam: ['KeyK'],
  wipers: ['KeyU'], horn: ['KeyH'], camera: ['KeyV'], lookBack: ['KeyB'], map: ['KeyM'], pause: ['Escape', 'KeyP'], interact: ['KeyF'],
  reset: ['KeyR'], cruise: ['KeyO'], gps: ['KeyG'], help: ['F1'], lookLeft: ['Digit1'], lookRight: ['Digit3'], cam1: ['F2'], cam2: ['F3'], cam3: ['F4'], cam4: ['F5'],
  park: ['Digit7'], reverse: ['Digit8'], neutral: ['Digit9'], drive: ['Digit0'],
};
const EDGE = ['shiftUp', 'shiftDown', 'ignition', 'indLeft', 'indRight', 'hazard', 'lights', 'highBeam', 'wipers', 'camera', 'map', 'pause', 'interact', 'reset', 'cruise', 'gps', 'help', 'cam1', 'cam2', 'cam3', 'cam4', 'park', 'reverse', 'neutral', 'drive'];

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.keys = new Set();
    this.pressed = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, horn: false, lookBack: false, lookYaw: 0, lookPitch: 0 };
    this.actions = {};
    this.kbSteer = 0; this.kbThr = 0; this.kbBrk = 0;
    this.device = 'keyboard';
    this.mouseLook = { dx: 0, dy: 0, held: false };
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: 0, active: false, buttons: new Set() };
    this.padPrev = [];
    this.binding = null; // when capturing a wheel axis
    this.enabled = true;
    addEventListener('keydown', (e) => {
      if (this.captureKey) { this.captureKey(e.code); this.captureKey = null; e.preventDefault(); return; }
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.device = 'keyboard';
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F3', 'F4', 'F5', 'Tab'].includes(e.code) && !(e.target && e.target.tagName === 'INPUT')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  bound(action) { return (this.settings.keys && this.settings.keys[action]) || DEFAULT_KEYS[action] || []; }
  down(action) { for (const k of this.bound(action)) if (this.keys.has(k)) return true; return false; }
  hit(action) { for (const k of this.bound(action)) if (this.pressed.has(k)) return true; return false; }

  update(dt) {
    const S = this.state, A = this.actions;
    for (const k of EDGE) A[k] = false;
    if (!this.enabled) { this.pressed.clear(); S.throttle = S.brake = 0; return; }
    // keyboard analog smoothing
    const l = this.down('left'), r = this.down('right');
    const target = (r ? 1 : 0) - (l ? 1 : 0);
    const rate = target === 0 ? 4.2 : Math.sign(target) !== Math.sign(this.kbSteer) && this.kbSteer !== 0 ? 6 : 2.4;
    this.kbSteer += clamp(target - this.kbSteer, -rate * dt, rate * dt);
    this.kbThr += clamp((this.down('throttle') ? 1 : 0) - this.kbThr, -6 * dt, 4 * dt);
    this.kbBrk += clamp((this.down('brake') ? 1 : 0) - this.kbBrk, -8 * dt, 6 * dt);
    let steer = this.kbSteer, thr = this.kbThr, brk = this.kbBrk;
    let hb = this.down('handbrake') ? 1 : 0, clutch = this.down('clutch') ? 1 : 0;
    let horn = this.down('horn'), lookBack = this.down('lookBack');
    let analog = false, direct = false;
    for (const a of EDGE) if (this.hit(a)) A[a] = true;
    // look left/right keys
    S.lookKey = this.down('lookLeft') ? -1 : this.down('lookRight') ? 1 : 0;
    // gamepads / wheels
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const prev = this.padPrev[gp.index] || [];
      const btn = (i) => gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
      const edge = (i) => btn(i) && !prev[i];
      const wheel = this.settings.wheel && this.settings.wheel.id === gp.id;
      if (wheel) {
        const W = this.settings.wheel;
        const ax = (b) => (b && b.axis >= 0 && gp.axes[b.axis] != null ? gp.axes[b.axis] : null);
        const norm = (v, b) => { if (v == null) return 0; let t = (v - b.min) / (b.max - b.min); return clamp(t, 0, 1); };
        const sv = ax(W.steer);
        if (sv != null) { steer = clamp((sv - (W.steer.center || 0)) * (W.steer.invert ? -1 : 1) * (W.steer.gain || 1), -1, 1); direct = true; }
        if (W.throttle) thr = Math.max(thr, norm(ax(W.throttle), W.throttle));
        if (W.brake) brk = Math.max(brk, norm(ax(W.brake), W.brake));
        if (W.clutch) clutch = Math.max(clutch, norm(ax(W.clutch), W.clutch));
        if (W.btnUp != null && edge(W.btnUp)) A.shiftUp = true;
        if (W.btnDown != null && edge(W.btnDown)) A.shiftDown = true;
        analog = true;
        this.device = 'wheel';
      } else if (gp.mapping === 'standard') {
        const dz = (v, d = 0.08) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
        const sx = dz(gp.axes[0] || 0);
        if (Math.abs(sx) > 0.01 || gp.buttons[7]?.value > 0.02 || gp.buttons[6]?.value > 0.02) this.device = 'gamepad';
        if (this.device === 'gamepad') {
          steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.6);
          thr = Math.max(thr, gp.buttons[7]?.value || 0);
          brk = Math.max(brk, gp.buttons[6]?.value || 0);
          analog = true;
        }
        if (btn(0)) hb = 1;
        if (btn(1)) lookBack = true;
        if (btn(2)) horn = true;
        if (edge(3)) A.camera = true;
        if (edge(4)) A.shiftDown = true;
        if (edge(5)) A.shiftUp = true;
        if (edge(8)) A.map = true;
        if (edge(9)) A.pause = true;
        if (edge(10)) A.ignition = true;
        if (edge(11)) A.lights = true;
        if (edge(12)) A.wipers = true;
        if (edge(13)) A.cruise = true;
        if (edge(14)) A.indLeft = true;
        if (edge(15)) A.indRight = true;
        const rx = dz(gp.axes[2] || 0, 0.15), ry = dz(gp.axes[3] || 0, 0.15);
        if (Math.abs(rx) > 0 || Math.abs(ry) > 0) { S.padLook = [rx, ry]; } else S.padLook = null;
      }
      this.padPrev[gp.index] = gp.buttons.map((b) => b.pressed || b.value > 0.5);
      // axis capture for wheel binding
      if (this.binding && this.binding.gpId === gp.id) this.binding.sample(gp);
    }
    // touch
    const T = this.touch;
    if (T.active) {
      steer = T.steer; thr = Math.max(thr, T.throttle); brk = Math.max(brk, T.brake); hb = Math.max(hb, T.handbrake);
      for (const b of T.buttons) A[b] = true;
      T.buttons.clear();
      analog = true;
      this.device = 'touch';
    }
    S.steer = clamp(steer, -1, 1);
    S.throttle = clamp(thr, 0, 1); S.brake = clamp(brk, 0, 1);
    S.handbrake = hb; S.clutch = clutch; S.horn = horn; S.lookBack = lookBack;
    S.steerAssist = !direct;
    S.directSteer = direct;
    S.analog = analog;
    this.pressed.clear();
  }
}
