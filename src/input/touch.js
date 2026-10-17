/* =====================================================================
   On-screen controls for phones and tablets: steering wheel (drag),
   analog throttle / brake pedals, handbrake, horn and quick buttons.
   ===================================================================== */
import { clamp } from '../core/math.js';
import { settings } from '../core/settings.js';

export const isTouchDevice = () => (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches));

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.T = game.input.touch;
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-steer"><div class="t-wheel"><i></i></div></div>
      <div class="t-pedals"><div class="t-pedal brake" data-p="brake"><span>BROMS</span></div><div class="t-pedal gas" data-p="throttle"><span>GAS</span></div></div>
      <div class="t-btns left">
        <button data-a="indLeft">◀</button><button data-a="hazard">⚠</button><button data-a="indRight">▶</button>
      </div>
      <div class="t-btns top">
        <button data-a="ignition">⏻</button><button data-a="lights">◐</button><button data-a="wipers">⌇</button><button data-a="camera">🎥</button><button data-a="map">🗺</button><button data-a="pause">⏸</button>
      </div>
      <div class="t-btns gear">
        <button data-a="shiftUp" class="g-up">＋</button><button data-a="gearToggle" class="g-dr">D/R</button><button data-a="shiftDown" class="g-dn">－</button>
      </div>
      <div class="t-btns hold">
        <button data-h="handbrake">Ⓟ</button><button data-h="horn">📯</button>
      </div>
      <div class="t-rotate">↻ Vrid enheten / Rotate your device</div>`;
    document.body.appendChild(root);
    this.root = root;
    this.wheel = root.querySelector('.t-wheel');
    const T = this.T;
    // steering: drag horizontally anywhere in the steering zone
    const zone = root.querySelector('.t-steer');
    let sid = null, sx0 = 0;
    zone.addEventListener('pointerdown', (e) => { sid = e.pointerId; sx0 = e.clientX - T.steer * this.range(); zone.setPointerCapture(sid); T.active = true; e.preventDefault(); });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId !== sid) return; T.steer = clamp((e.clientX - sx0) / this.range(), -1, 1); });
    const release = (e) => { if (e.pointerId === sid) { sid = null; this.recenter = true; } };
    zone.addEventListener('pointerup', release); zone.addEventListener('pointercancel', release);
    // pedals: analog by finger position (lower = more)
    for (const el of root.querySelectorAll('.t-pedal')) {
      const key = el.dataset.p;
      const set = (e) => { const r = el.getBoundingClientRect(); T[key] = clamp(0.35 + 0.65 * (e.clientY - r.top) / r.height, 0.35, 1); };
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); T.active = true; set(e); el.classList.add('on'); e.preventDefault(); });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(e); });
      const off = () => { T[key] = 0; el.classList.remove('on'); };
      el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off);
    }
    // momentary actions
    for (const b of root.querySelectorAll('button[data-a]')) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); T.active = true;
        const a = b.dataset.a;
        if (a === 'gearToggle') {
          const P = game.player && game.player.phys;
          if (P && P.autoMode) T.buttons.add(P.sel === 'D' ? 'reverse' : 'drive');
          else if (P) T.buttons.add(P.gear === -1 ? 'shiftUp' : 'shiftDown');
        } else T.buttons.add(a);
      });
    }
    for (const b of root.querySelectorAll('button[data-h]')) {
      const k = b.dataset.h;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); T.active = true; if (k === 'horn') T.horn = true; else T[k] = 1; b.classList.add('on'); });
      const off = () => { if (k === 'horn') T.horn = false; else T[k] = 0; b.classList.remove('on'); };
      b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    }
    this.visible = false;
  }
  range() { return Math.min(innerWidth * 0.22, 170); }
  update(dt, game) {
    const show = isTouchDevice() && !!game.player && !game.inMenu && !game.paused && !game.mapOpen && settings.hud !== false;
    if (show !== this.visible) { this.visible = show; this.root.classList.toggle('on', show); document.body.classList.toggle('touch-ui', show); }
    if (!show) return;
    const T = this.T;
    if (this.recenter) { T.steer += -Math.sign(T.steer) * Math.min(Math.abs(T.steer), dt * 3.5); if (Math.abs(T.steer) < 0.01) { T.steer = 0; this.recenter = false; } }
    this.wheel.style.transform = `rotate(${T.steer * 135}deg)`;
    const P = game.player.phys;
    const g = this.root.querySelector('.g-dr');
    if (P.autoMode) g.textContent = P.sel === 'D' ? 'D→R' : 'R→D'; else g.textContent = P.gear === -1 ? 'R' : 'N/R';
  }
}
