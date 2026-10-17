/* =====================================================================
   Procedural audio (Web Audio). Nothing is sampled: engines are
   synthesised in an AudioWorklet, everything else from noise and
   oscillators. Spatialised with PannerNodes around the camera.
     - player: engine, turbo, EV motor, starter, tyres, road surface,
       wind, rain on roof, wipers, indicator relay, horn, impacts, gears
     - traffic: nearest vehicles get an engine + tyre voice with doppler
     - world: thunder, birds, city hum, wind
   Interior views muffle exterior sounds through a cabin filter.
   ===================================================================== */
import { clamp, lerp } from '../core/math.js';
import { settings } from '../core/settings.js';

export const ENGINE_KINDS = {
  i4small: { cyl: 4, f1: 150, f2: 720, g2: 0.5, decay: 1000, idleAmp: 0.3, lp0: 800, lp1: 2800, intake: 0.22, mech: 0.12, level: 0.55 },
  i4old: { cyl: 4, f1: 115, f2: 540, q2: 3, g2: 0.55, decay: 760, jitter: 0.12, idleAmp: 0.4, lp0: 650, lp1: 2200, intake: 0.3, mech: 0.22, level: 0.6 },
  i4turbo: { cyl: 4, f1: 125, f2: 610, g2: 0.42, decay: 950, jitter: 0.05, idleAmp: 0.3, lp0: 700, lp1: 2400, intake: 0.35, intakeF: 1900, mech: 0.08, crackle: 0.2, level: 0.55 },
  diesel: { cyl: 4, f1: 95, f2: 430, g2: 0.5, decay: 1250, jitter: 0.08, idleAmp: 0.45, lp0: 500, lp1: 1700, clatter: 0.5, mech: 0.3, intake: 0.2, level: 0.6 },
  v8: { cyl: 8, pattern: [1, 0.68, 0.92, 0.6, 1, 0.74, 0.86, 0.63], f1: 72, q1: 2.5, g1: 1.3, f2: 330, g2: 0.55, g0: 0.35, decay: 620, jitter: 0.07, idleAmp: 0.42, lp0: 450, lp1: 2300, lpR: 0.25, intake: 0.3, crackle: 0.9, level: 0.62 },
  old: { cyl: 4, f1: 100, f2: 470, g2: 0.6, decay: 700, jitter: 0.16, idleAmp: 0.45, lp0: 550, lp1: 1800, mech: 0.32, intake: 0.25, level: 0.62 },
  truck: { cyl: 6, f1: 58, q1: 2.5, f2: 270, g2: 0.6, g0: 0.35, decay: 900, jitter: 0.06, idleAmp: 0.5, lp0: 380, lp1: 1300, lpR: 0.2, clatter: 0.35, mech: 0.25, intake: 0.3, intakeF: 900, level: 0.7 },
  moto: { cyl: 2, offsets: [0, 0.375], pattern: [1, 0.85], f1: 170, f2: 950, g2: 0.5, decay: 850, jitter: 0.1, idleAmp: 0.35, lp0: 900, lp1: 3600, lpR: 0.4, intake: 0.3, crackle: 0.5, level: 0.6 },
  tractor: { cyl: 4, f1: 62, f2: 300, g2: 0.6, g0: 0.4, decay: 750, jitter: 0.1, idleAmp: 0.55, lp0: 350, lp1: 1100, clatter: 0.55, mech: 0.35, intake: 0.15, level: 0.65 },
};

const AI_GEARS = {
  car: { idle: 800, top: [0, 4, 9, 15, 22, 30], shift: 3000 },
  moto: { idle: 1200, top: [0, 6, 12, 19, 27, 36], shift: 6500 },
  truck: { idle: 600, top: [0, 2, 4, 6.5, 9, 12, 15.5, 19, 22], shift: 1700 },
  tractor: { idle: 800, top: [0, 2, 4, 6, 8.5], shift: 2000 },
};

function noiseBuffer(ctx, seconds, color) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else d[i] = w * 0.5;
  }
  // crossfade the loop seam
  const f = Math.min(2048, n >> 3);
  for (let i = 0; i < f; i++) { const a = i / f; d[i] = d[i] * a + d[n - f + i] * (1 - a); }
  return buf;
}

export class Audio {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.voices = [];
    this.prev = { blink: false, wiper: 0, thr: 0, lightning: 0 };
    this.birdT = 3;
    this.muted = /[?&](shot|mute)=/.test(location.search);
    const unlock = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { passive: true });
    game.on('lightning', (delay) => this.thunder(delay));
    game.on('player', () => this.configurePlayer());
  }

  async unlock() {
    if (this.muted || this.failed) return;
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.failed = true; return; }
      this.ctx = new AC({ latencyHint: 'interactive' });
      await this.build();
      this.ready = true;
      this.configurePlayer();
    } catch (e) {
      console.warn('audio unavailable', e);
      this.failed = true;
    }
  }

  async build() {
    const ctx = this.ctx;
    this.hasWorklet = !!(ctx.audioWorklet);
    if (this.hasWorklet) {
      try { await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url)); }
      catch (e) { this.hasWorklet = false; console.warn('engine worklet failed', e); }
    }
    this.noise = { white: noiseBuffer(ctx, 4, 'white'), pink: noiseBuffer(ctx, 4, 'pink'), brown: noiseBuffer(ctx, 5, 'brown') };
    // master chain
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 4; this.comp.attack.value = 0.005; this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.comp).connect(ctx.destination);
    // exterior bus: muffled when inside the cabin
    this.cabin = ctx.createBiquadFilter(); this.cabin.type = 'lowpass'; this.cabin.frequency.value = 20000; this.cabin.Q.value = 0.5;
    this.extGain = ctx.createGain();
    this.ext = ctx.createGain();
    this.ext.connect(this.cabin).connect(this.extGain).connect(this.master);
    // interior bus (always clear)
    this.inner = ctx.createGain();
    this.inner.connect(this.master);
    const P = (model = 'HRTF') => {
      const p = ctx.createPanner();
      p.panningModel = this.game.qualityName === 'low' ? 'equalpower' : model;
      p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = 1.1; p.maxDistance = 2000;
      return p;
    };
    this.makePanner = P;
    const src = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, Math.random() * buf.duration); return s; };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.src = src; this.filt = filt; this.gainNode = gain;

    /* ---------- player ---------- */
    this.pl = {};
    const pl = this.pl;
    pl.enginePan = P(); pl.engineLP = filt('lowpass', 12000, 0.5); pl.engineGain = gain(1);
    pl.engineGain.connect(pl.engineLP).connect(pl.enginePan).connect(this.master);
    if (this.hasWorklet) {
      pl.engine = new AudioWorkletNode(ctx, 'engine', { numberOfOutputs: 1, outputChannelCount: [1] });
      pl.engine.connect(pl.engineGain);
    } else {
      // fallback: saw + square at the firing frequency through a low-pass
      pl.oscA = ctx.createOscillator(); pl.oscA.type = 'sawtooth';
      pl.oscB = ctx.createOscillator(); pl.oscB.type = 'square';
      pl.oscLP = filt('lowpass', 600, 2); pl.oscG = gain(0);
      pl.oscA.connect(pl.oscLP); pl.oscB.connect(pl.oscLP); pl.oscLP.connect(pl.oscG).connect(pl.engineGain);
      pl.oscA.start(); pl.oscB.start();
    }
    // turbo whistle and blow-off
    pl.turbo = ctx.createOscillator(); pl.turbo.type = 'sine'; pl.turboG = gain(0);
    pl.turbo2 = ctx.createOscillator(); pl.turbo2.type = 'triangle';
    pl.turbo.connect(pl.turboG); pl.turbo2.connect(pl.turboG); pl.turboG.connect(pl.engineGain);
    pl.turbo.start(); pl.turbo2.start();
    // EV motor & inverter
    pl.ev1 = ctx.createOscillator(); pl.ev1.type = 'sine';
    pl.ev2 = ctx.createOscillator(); pl.ev2.type = 'triangle';
    pl.ev3 = ctx.createOscillator(); pl.ev3.type = 'sine';
    pl.evG = gain(0); pl.evInvG = gain(0);
    pl.ev1.connect(pl.evG); pl.ev2.connect(pl.evG); pl.ev3.connect(pl.evInvG);
    pl.evG.connect(pl.engineGain); pl.evInvG.connect(this.inner);
    pl.ev1.start(); pl.ev2.start(); pl.ev3.start();
    // starter motor
    pl.starter = ctx.createOscillator(); pl.starter.type = 'sawtooth'; pl.starter.frequency.value = 150;
    pl.starterAM = ctx.createOscillator(); pl.starterAM.frequency.value = 8;
    pl.starterAMG = gain(0.5); pl.starterG = gain(0); pl.starterLP = filt('lowpass', 900, 1);
    pl.starterAM.connect(pl.starterAMG).connect(pl.starterG.gain);
    pl.starter.connect(pl.starterLP).connect(pl.starterG).connect(pl.engineGain);
    pl.starter.start(); pl.starterAM.start();
    // tyres: squeal (tarmac) and scrub
    pl.tyrePan = P();
    pl.tyrePan.connect(this.ext);
    pl.squeal = src(this.noise.white); pl.sqBP = filt('bandpass', 950, 9); pl.sqBP2 = filt('bandpass', 1500, 7); pl.sqG = gain(0);
    pl.squeal.connect(pl.sqBP).connect(pl.sqG); pl.squeal.connect(pl.sqBP2).connect(pl.sqG); pl.sqG.connect(pl.tyrePan);
    // road: tyre roll rumble (structure-borne, heard inside), gravel crunch, wet hiss, cobbles
    pl.road = src(this.noise.brown); pl.roadLP = filt('lowpass', 200, 0.7); pl.roadG = gain(0);
    pl.road.connect(pl.roadLP).connect(pl.roadG).connect(this.master);
    pl.roll = src(this.noise.pink); pl.rollBP = filt('bandpass', 600, 0.8); pl.rollG = gain(0);
    pl.roll.connect(pl.rollBP).connect(pl.rollG).connect(this.ext);
    pl.gravel = src(this.noise.white); pl.gravBP = filt('bandpass', 2200, 0.9); pl.gravG = gain(0);
    pl.gravel.connect(pl.gravBP).connect(pl.gravG).connect(this.ext);
    pl.wet = src(this.noise.white, 0.9); pl.wetHP = filt('highpass', 2600, 0.6); pl.wetG = gain(0);
    pl.wet.connect(pl.wetHP).connect(pl.wetG).connect(this.ext);
    // wind
    pl.wind = src(this.noise.pink); pl.windBP = filt('bandpass', 500, 0.6); pl.windG = gain(0);
    pl.wind.connect(pl.windBP).connect(pl.windG).connect(this.master);
    // rain: outside hiss + roof drumming in the cabin
    pl.rain = src(this.noise.white, 0.8); pl.rainBP = filt('bandpass', 3800, 0.4); pl.rainG = gain(0);
    pl.rain.connect(pl.rainBP).connect(pl.rainG).connect(this.ext);
    pl.roof = src(this.noise.pink, 1.2); pl.roofBP = filt('bandpass', 900, 0.8); pl.roofG = gain(0);
    pl.roof.connect(pl.roofBP).connect(pl.roofG).connect(this.inner);
    // wipers: motor + rubber swish
    pl.wipM = ctx.createOscillator(); pl.wipM.type = 'sawtooth'; pl.wipM.frequency.value = 95;
    pl.wipMLP = filt('lowpass', 300, 1); pl.wipMG = gain(0);
    pl.wipM.connect(pl.wipMLP).connect(pl.wipMG).connect(this.inner); pl.wipM.start();
    pl.swish = src(this.noise.white); pl.swishBP = filt('bandpass', 1600, 1.5); pl.swishG = gain(0);
    pl.swish.connect(pl.swishBP).connect(pl.swishG).connect(this.inner);
    // horn: two detuned notes, typical European dual horn
    pl.hornPan = P();
    pl.hornG = gain(0);
    pl.hornF = filt('peaking', 2400, 1); pl.hornF.gain.value = 8;
    for (const f of [415, 495]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(pl.hornF); o.start(); }
    pl.hornF.connect(pl.hornG).connect(pl.hornPan).connect(this.master);
    pl.hornLevel = 0;
    // ambience
    this.amb = {};
    this.amb.city = src(this.noise.brown, 0.7); this.amb.cityLP = filt('lowpass', 320, 0.7); this.amb.cityG = gain(0);
    this.amb.city.connect(this.amb.cityLP).connect(this.amb.cityG).connect(this.ext);
    this.amb.wind = src(this.noise.pink, 0.5); this.amb.windBP = filt('bandpass', 380, 0.5); this.amb.windG = gain(0);
    this.amb.wind.connect(this.amb.windBP).connect(this.amb.windG).connect(this.ext);

    /* ---------- traffic voices ---------- */
    const nv = this.game.qualityName === 'low' ? 3 : this.game.qualityName === 'medium' ? 5 : 7;
    for (let i = 0; i < nv; i++) {
      const v = { car: null, kind: null, gain: 0 };
      v.pan = P(); v.pan.refDistance = 7;
      v.out = gain(1);
      v.out.connect(v.pan).connect(this.ext);
      if (this.hasWorklet) { v.engine = new AudioWorkletNode(ctx, 'engine', { numberOfOutputs: 1, outputChannelCount: [1] }); v.engine.connect(v.out); }
      v.tyre = src(this.noise.pink); v.tyreBP = filt('bandpass', 500, 0.6); v.tyreG = gain(0);
      v.tyre.connect(v.tyreBP).connect(v.tyreG).connect(v.out);
      v.whine = ctx.createOscillator(); v.whine.type = 'sine'; v.whineG = gain(0); v.whine.connect(v.whineG).connect(v.out); v.whine.start();
      this.voices.push(v);
    }
    this.voiceT = 0;
    this.master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.4);
  }

  configurePlayer() {
    if (!this.ready || !this.game.player) return;
    const spec = this.game.player.spec;
    const kind = spec.sound ? spec.sound.kind : 'i4small';
    this.playerKind = kind;
    const cfg = ENGINE_KINDS[kind];
    if (this.pl.engine && cfg) this.pl.engine.port.postMessage({ cfg: { ...cfg, cyl: cfg.cyl || spec.engine.cyl } });
  }

  /* ---------- one-shots ---------- */
  oneShot(buildFn, dest = this.master, pos = null) {
    const ctx = this.ctx;
    let out = dest;
    if (pos) { const p = this.makePanner(); p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; p.connect(dest); out = p; }
    buildFn(ctx, out, ctx.currentTime);
  }
  burst(out, t, { dur = 0.2, f = 800, type = 'lowpass', q = 0.7, vol = 0.5, color = 'white', attack = 0.003 } = {}) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise[color];
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(b).connect(g).connect(out);
    s.start(t, Math.random() * 3); s.stop(t + dur + 0.05);
  }
  tone(out, t, f, dur, vol, type = 'sine', f2 = null) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
  }
  click(on) {
    this.oneShot((ctx, out, t) => {
      this.burst(out, t, { dur: 0.025, f: on ? 3200 : 2400, type: 'bandpass', q: 2, vol: 0.35 });
      this.tone(out, t, on ? 1900 : 1500, 0.02, 0.08, 'square');
    }, this.inner);
  }
  impact(speed, pos, kind) {
    const v = clamp(speed / 14, 0.05, 1.4);
    this.oneShot((ctx, out, t) => {
      this.burst(out, t, { dur: 0.25 + v * 0.5, f: 300 + v * 900, vol: 0.5 * v, color: 'brown' });
      this.burst(out, t, { dur: 0.12 + v * 0.3, f: 1200 + v * 2000, type: 'bandpass', q: 0.8, vol: 0.35 * v });
      if (kind !== 'tree') for (let i = 0; i < 3; i++) this.tone(out, t, 260 + Math.random() * 900, 0.25 + v * 0.4, 0.08 * v, 'triangle');
      if (speed > 9) for (let i = 0; i < 6; i++) this.burst(out, t + Math.random() * 0.25, { dur: 0.08, f: 5000 + Math.random() * 3000, type: 'highpass', vol: 0.15 * v });
    }, this.master, pos);
  }
  thunder(delay) {
    if (!this.ready) return;
    const near = delay < 1.5;
    this.oneShot((ctx, out, t0) => {
      const t = t0 + delay;
      const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8; pan.connect(out);
      if (near) this.burst(pan, t, { dur: 0.6, f: 2500, vol: 0.5, color: 'white', attack: 0.002 });
      const n = 4 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) this.burst(pan, t + i * (0.3 + Math.random() * 0.6), { dur: 2 + Math.random() * 2.5, f: near ? 400 : 180, vol: (near ? 0.9 : 0.5) * (1 - i / (n + 2)), color: 'brown', attack: 0.15 + Math.random() * 0.3 });
    }, this.ext);
  }
  chirp(pos) {
    this.oneShot((ctx, out, t) => {
      const species = Math.floor(Math.random() * 4);
      const n = 2 + Math.floor(Math.random() * 6);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const base = [3200, 4200, 2600, 5200][species] * (0.9 + Math.random() * 0.2);
        const d = [0.09, 0.05, 0.16, 0.04][species];
        const f2 = species === 2 ? base * 0.7 : base * (1.1 + Math.random() * 0.3);
        this.tone(out, tt, base, d, 0.05 + Math.random() * 0.04, 'sine', f2);
        tt += d + 0.03 + Math.random() * 0.08;
      }
    }, this.ext, pos);
  }
  beep(f = 1800, dur = 0.07, vol = 0.18) { if (this.ready) this.oneShot((ctx, out, t) => this.tone(out, t, f, dur, vol, 'sine'), this.inner); }
  chime() { if (this.ready) this.oneShot((ctx, out, t) => { this.tone(out, t, 880, 0.5, 0.15); this.tone(out, t + 0.18, 660, 0.7, 0.15); }, this.inner); }

  /* ---------- per-frame update ---------- */
  update(dt, game) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const S = (param, v, tc = 0.05) => param.setTargetAtTime(v, now, tc);
    // master volume & pause
    S(this.master.gain, game.paused ? 0 : settings.volume, 0.1);
    if (game.paused) return;
    // listener follows the camera
    const cam = game.camera, L = ctx.listener;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const cx = e[12], cy = e[13], cz = e[14];
    if (L.positionX) {
      L.positionX.value = cx; L.positionY.value = cy; L.positionZ.value = cz;
      L.forwardX.value = -e[8]; L.forwardY.value = -e[9]; L.forwardZ.value = -e[10];
      L.upX.value = e[4]; L.upY.value = e[5]; L.upZ.value = e[6];
    } else { L.setPosition(cx, cy, cz); L.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]); }
    const inside = game.rig.mode === 'cockpit' && !game.rig.orbitMode && !game.rig.fixedView;
    const hood = game.rig.mode === 'hood';
    S(this.cabin.frequency, inside ? 1100 : hood ? 5000 : 20000, 0.08);
    S(this.extGain.gain, inside ? 0.55 : 1, 0.08);
    const W = game.env.weather;
    const C = game.conditions || {};
    const pc = game.player;
    if (pc) this.updatePlayer(dt, game, pc, inside, S, W, C);
    this.updateTraffic(dt, game, S, cx, cy, cz);
    // ambience
    const day = game.env.daylight;
    const city = game.placeKind === 'city' ? 1 : game.placeKind === 'village' ? 0.3 : 0;
    S(this.amb.cityG.gain, city * (0.05 + 0.07 * day), 1);
    S(this.amb.windG.gain, 0.02 + (W.wind || 0) * 0.12 + (W.storm || 0) * 0.2, 1);
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 1.5 + Math.random() * 5;
      const warm = (game.season === 'spring' || game.season === 'summer') && day > 0.5 && (W.rain || 0) < 0.3 && (C.temp ?? 10) > 4;
      if (warm && Math.random() < (city ? 0.35 : 0.8)) {
        const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 35;
        this.chirp([cx + Math.cos(a) * r, cy + 6 + Math.random() * 8, cz + Math.sin(a) * r]);
      }
    }
  }

  updatePlayer(dt, game, pc, inside, S, W, C) {
    const pl = this.pl, P = pc.phys, spec = pc.spec;
    const speed = Math.abs(P.speed);
    // positions: engine at the front (or rear for rear-engined), tyres at the centre
    const ef = P.pointWorld(0, 0.2, -spec.body.L * 0.32);
    const setPos = (p, a) => { p.positionX.value = a[0]; p.positionY.value = a[1]; p.positionZ.value = a[2]; };
    setPos(pl.enginePan, ef); setPos(pl.hornPan, ef);
    setPos(pl.tyrePan, P.pointWorld(0, -0.3, 0));
    S(pl.engineLP.frequency, inside ? 2600 : 14000, 0.08);
    const vol = settings.engineVol ?? 1;
    // engine
    const ev = !!P.ev;
    const rpm = P.rpm || 0;
    const running = P.running && !ev;
    const load = P.load || 0;
    const thr = P.pedalThrottle || 0;
    if (pl.engine) {
      const g = (running ? 1 : P.starter > 0 ? 0.6 : 0) * vol * (inside ? 1.1 : 1.3);
      pl.engine.port.postMessage({ rpm: running || P.starter > 0 ? rpm : 0, load: running ? load : 0, thr: running ? thr : 0, gain: g });
    } else if (pl.oscA) {
      const cyl = spec.engine.cyl || 4, f = rpm / 120 * cyl;
      S(pl.oscA.frequency, Math.max(f, 1), 0.03); S(pl.oscB.frequency, Math.max(f * 0.5, 1), 0.03);
      S(pl.oscLP.frequency, 300 + load * 1800 + rpm * 0.2, 0.05);
      S(pl.oscG.gain, running ? (0.12 + 0.18 * load) * vol : 0, 0.05);
    }
    // starter motor whirr
    S(pl.starterG.gain, P.starter > 0 && !ev ? 0.18 * vol : 0, 0.02);
    // turbo
    const tb = spec.engine.turbo || 0;
    const boost = P.boost || 0;
    if (tb > 0 && running) {
      const f = 2200 + rpm * 0.9 * (0.5 + boost);
      S(pl.turbo.frequency, f, 0.08); S(pl.turbo2.frequency, f * 1.51, 0.08);
      S(pl.turboG.gain, boost * boost * 0.022 * tb * vol, 0.08);
      if (this.prev.thr > 0.6 && thr < 0.15 && boost > 0.45) {
        this.oneShot((ctx, out, t) => this.burst(out, t, { dur: 0.35, f: 2600, type: 'bandpass', q: 0.9, vol: 0.18 * boost * tb, color: 'white', attack: 0.01 }), pl.engineGain);
      }
    } else S(pl.turboG.gain, 0, 0.1);
    this.prev.thr = thr;
    // EV motor whine: rpm here is motor speed
    if (ev && P.running) {
      const f = Math.max(30, Math.abs(rpm) / 60 * 4);
      S(pl.ev1.frequency, f, 0.05); S(pl.ev2.frequency, f * 2.02, 0.05); S(pl.ev3.frequency, 7400 + Math.abs(rpm) * 0.05, 0.1);
      S(pl.evG.gain, (0.012 + 0.05 * load) * clamp(speed / 3, 0, 1) * vol, 0.06);
      S(pl.evInvG.gain, 0.004 * clamp(speed / 5, 0, 1) * (0.3 + load), 0.1);
    } else { S(pl.evG.gain, 0, 0.1); S(pl.evInvG.gain, 0, 0.1); }
    // surfaces under the wheels
    let skid = 0, gravel = 0, snow = 0, cobble = 0, grass = 0, contact = 0;
    for (const w of P.wheels) {
      if (!w.contact) continue;
      contact++;
      const s = w.surface;
      if (s === 'gravel' || s === 'dirt' || s === 'verge' || s === 'sand') gravel++; else if (s === 'snow' || (w.snow || 0) > 0.4) snow++; else if (s === 'cobble') cobble++; else if (s === 'grass' || s === 'rock') grass++;
      if (s === 'asphalt' || s === 'concrete' || s === 'cobble') skid = Math.max(skid, (w.skid || 0) * (1 - (w.wet || 0) * 0.6) * (1 - (w.ice || 0)));
    }
    const nW = Math.max(1, P.wheels.length);
    gravel /= nW; snow /= nW; cobble /= nW; grass /= nW;
    const vk = clamp(speed / 30, 0, 1.6);
    S(pl.sqG.gain, Math.pow(skid, 1.4) * 0.35, 0.04);
    S(pl.sqBP.frequency, 850 + skid * 250 + speed * 3, 0.1);
    S(pl.roadLP.frequency, 120 + speed * 9 + cobble * 300, 0.1);
    S(pl.roadG.gain, contact ? (0.05 + vk * 0.32 + cobble * vk * 0.4) * (inside ? 1 : 0.6) : 0, 0.08);
    S(pl.rollBP.frequency, 450 + speed * 12, 0.2);
    S(pl.rollG.gain, contact ? vk * 0.12 * (1 - gravel - snow * 0.5) : 0, 0.1);
    // gravel crunch is grainy: jitter its level
    const grain = 0.6 + Math.random() * 0.8;
    S(pl.gravG.gain, contact ? (gravel * 0.5 + snow * 0.22 + grass * 0.18) * clamp(speed / 10, 0, 1.3) * grain : 0, 0.02);
    S(pl.gravBP.frequency, snow > gravel ? 1300 : grass > gravel ? 900 : 2200, 0.2);
    S(pl.wetG.gain, (C.wet || 0) * vk * 0.28, 0.1);
    // wind rises with the square of speed
    const wk = clamp(speed / 35, 0, 1.8);
    S(pl.windG.gain, wk * wk * (inside ? 0.12 : 0.35) + (inside ? 0 : (W.wind || 0) * 0.04), 0.1);
    S(pl.windBP.frequency, 350 + speed * 14, 0.2);
    // rain
    const rain = W.rain || 0;
    S(pl.rainG.gain, rain * 0.22, 0.4);
    S(pl.roofG.gain, inside ? rain * (0.16 + Math.random() * 0.1) + (W.storm || 0) * 0.05 : 0, 0.05);
    // wipers
    const wp = pc.wiperPhase || 0;
    S(pl.wipMG.gain, wp > 0 && inside ? 0.035 : 0, 0.05);
    S(pl.swishG.gain, wp > 0 && inside ? Math.abs(Math.sin(wp * Math.PI * 2)) * (0.05 + (1 - (C.wet || 0)) * 0.05) : 0, 0.03);
    // indicator relay
    if (pc.blinkOn !== this.prev.blink) { this.prev.blink = pc.blinkOn; if (pc.indicator !== 0) this.click(pc.blinkOn); }
    // horn
    pl.hornLevel = pc.horn ? 1 : 0;
    S(pl.hornG.gain, pl.hornLevel * 0.16, 0.012);
    // events from the physics step
    for (const e of pc.events || []) {
      if (e === 'shift' && !P.autoMode) this.oneShot((ctx, out, t) => this.burst(out, t, { dur: 0.06, f: 500, vol: 0.12, color: 'brown' }), this.inner);
      else if (e === 'grind') this.oneShot((ctx, out, t) => { for (let i = 0; i < 6; i++) this.burst(out, t + i * 0.05, { dur: 0.06, f: 3200, type: 'bandpass', q: 3, vol: 0.2 }); }, this.inner);
      else if (e === 'stall' || e === 'stop') this.oneShot((ctx, out, t) => this.burst(out, t, { dur: 0.3, f: 160, vol: 0.25, color: 'brown' }), this.inner);
      else if (e === 'scrape') this.oneShot((ctx, out, t) => this.burst(out, t, { dur: 0.4, f: 1800, type: 'bandpass', q: 1.5, vol: 0.3 }), this.master);
      else if (e === 'ready') this.chime();
    }
    for (const im of pc.impacts || []) if (im.speed > 1) this.impact(im.speed, [im.x, P.p[1], im.z], im.kind);
  }

  updateTraffic(dt, game, S, cx, cy, cz) {
    const T = game.traffic;
    if (!T || !this.voices.length) return;
    this.voiceT -= dt;
    if (this.voiceT <= 0) {
      this.voiceT = 0.25;
      // nearest vehicles get voices; keep existing assignments when possible
      const cand = [];
      for (const c of T.cars) {
        const d = Math.hypot(c.x - cx, c.z - cz);
        if (d < 160) cand.push({ c, d });
      }
      cand.sort((a, b) => a.d - b.d);
      const want = new Set(cand.slice(0, this.voices.length).map((o) => o.c));
      for (const v of this.voices) if (v.car && !want.has(v.car)) v.car = null;
      const taken = new Set(this.voices.map((v) => v.car).filter(Boolean));
      for (const c of want) {
        if (taken.has(c)) continue;
        const v = this.voices.find((q) => !q.car);
        if (!v) break;
        v.car = c; v.prevD = null;
        const kind = c.kind === 'moto' ? 'moto' : c.kind === 'tractor' ? 'tractor' : c.kind === 'truck' || c.kind === 'plough' || c.kind === 'bus' ? 'truck' : (c.spec.sound && c.spec.sound.kind) || 'i4small';
        if (kind !== v.kind) { v.kind = kind; if (v.engine && ENGINE_KINDS[kind]) v.engine.port.postMessage({ cfg: ENGINE_KINDS[kind], snap: true }); }
        v.ev = kind === 'ev';
      }
    }
    const P = game.player ? game.player.phys : null;
    for (const v of this.voices) {
      const c = v.car;
      if (!c || !T.cars.includes(c)) {
        v.car = null;
        if (v.engine) v.engine.port.postMessage({ gain: 0 });
        S(v.tyreG.gain, 0, 0.1); S(v.whineG.gain, 0, 0.1);
        continue;
      }
      v.pan.positionX.value = c.x; v.pan.positionY.value = c.y + 0.6; v.pan.positionZ.value = c.z;
      // doppler from closing speed
      const dx = c.x - cx, dz = c.z - cz, d = Math.max(1, Math.hypot(dx, dz));
      const pvx = P ? P.v[0] : 0, pvz = P ? P.v[2] : 0;
      const vr = ((c.vx - pvx) * dx + (c.vz - pvz) * dz) / d; // + = receding
      const dop = clamp(343 / (343 + vr), 0.8, 1.25);
      const sp = Math.abs(c.v);
      const kind = c.kind === 'moto' ? 'moto' : c.kind === 'tractor' ? 'tractor' : (c.kind === 'truck' || c.kind === 'bus' || c.kind === 'plough') ? 'truck' : 'car';
      const G = AI_GEARS[kind];
      let gi = 1; while (gi < G.top.length - 1 && sp > G.top[gi]) gi++;
      const lo = G.top[gi - 1], hi = G.top[gi];
      const frac = clamp((sp - lo) / Math.max(1, hi - lo), 0, 1);
      const rpm = (sp < 0.5 ? G.idle : G.idle * 1.2 + frac * (G.shift - G.idle * 1.2) + (gi > 2 ? G.shift * 0.12 : 0)) * dop;
      const load = clamp(0.2 + (c.acc || 0) * 0.5, 0, 1);
      const crashed = c.state === 'crashed';
      if (v.engine) v.engine.port.postMessage({ rpm, load, thr: load, gain: v.ev || crashed ? 0 : (kind === 'truck' ? 1.4 : kind === 'moto' ? 1.5 : 1) });
      S(v.tyreG.gain, clamp(sp / 25, 0, 1.3) * (kind === 'truck' ? 0.5 : 0.3), 0.1);
      S(v.tyreBP.frequency, 300 + sp * 14, 0.2);
      if (v.ev) { S(v.whine.frequency, Math.max(40, sp * 55) * dop, 0.05); S(v.whineG.gain, sp > 0.3 ? 0.03 : 0, 0.1); }
      else S(v.whineG.gain, 0, 0.1);
    }
  }
}
