/* =====================================================================
   Engine sound synthesiser (AudioWorklet).
   Each cylinder firing injects a decaying pressure pulse that excites
   exhaust/body resonators; the result is low-passed by load and rpm.
   Firing order, pulse pattern, clatter (diesel), overrun crackle and
   jitter give each engine its own character.
   ===================================================================== */

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  bandpass(f, q) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - al) / a0;
  }
  lowpass(f, q = 0.707) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  highpass(f, q = 0.707) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const DEFAULT = {
  cyl: 4, offsets: null, pattern: [1, 0.92, 0.97, 0.9], jitter: 0.06,
  f1: 120, q1: 3, g1: 1, f2: 600, q2: 4, g2: 0.45, g0: 0.25,
  decay: 900, idleAmp: 0.35, lp0: 700, lp1: 2600, lpR: 0.35,
  clatter: 0, mech: 0.08, intake: 0.25, crackle: 0, level: 0.5,
};

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.cfg = { ...DEFAULT };
    this.rpm = 0; this.rpmT = 0; this.load = 0; this.loadT = 0; this.thr = 0; this.thrT = 0;
    this.gain = 0; this.gainT = 0;
    this.phase = 0; this.k = 0;
    this.ex = 0; this.clat = 0; this.pop = 0;
    this.seed = (Math.random() * 1e9) | 0;
    this.r1 = new Biquad(); this.r2 = new Biquad(); this.lp = new Biquad(); this.hp = new Biquad(); this.ib = new Biquad(); this.dc = new Biquad();
    this.hp.highpass(2500, 0.8); this.dc.highpass(25, 0.7);
    this.setCfg({});
    this.alive = true;
    this.port.onmessage = (e) => this.apply(e.data);
    if (options && options.processorOptions) this.apply({ ...options.processorOptions, snap: true });
  }
  apply(d) {
    if (d.cfg) this.setCfg(d.cfg);
    if (d.rpm !== undefined) this.rpmT = d.rpm;
    if (d.load !== undefined) this.loadT = d.load;
    if (d.thr !== undefined) this.thrT = d.thr;
    if (d.gain !== undefined) this.gainT = d.gain;
    if (d.snap) { this.rpm = this.rpmT; this.load = this.loadT; this.thr = this.thrT; this.gain = this.gainT; }
    if (d.kill) this.alive = false;
  }
  setCfg(c) {
    const C = this.cfg = { ...DEFAULT, ...c };
    const n = C.cyl;
    C.offs = C.offsets || Array.from({ length: n }, (_, i) => i / n);
    C.pat = C.pattern.length >= n ? C.pattern : Array.from({ length: n }, (_, i) => C.pattern[i % C.pattern.length]);
    this.r1.bandpass(C.f1, C.q1); this.r2.bandpass(C.f2, C.q2); this.ib.bandpass(C.intakeF || 1400, 1.2);
    this.k = 0;
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) | 0; return ((this.seed >>> 8) & 0xffff) / 65536; }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return this.alive;
    const N = out.length, C = this.cfg;
    const kb = 1 - Math.exp(-N / sampleRate / 0.04), kg = 1 - Math.exp(-N / sampleRate / 0.12);
    this.rpm += (this.rpmT - this.rpm) * kb;
    this.load += (this.loadT - this.load) * kb;
    this.thr += (this.thrT - this.thr) * kb;
    const g0 = this.gain;
    this.gain += (this.gainT - this.gain) * kg;
    if (g0 < 1e-4 && this.gain < 1e-4) { out.fill(0); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].fill(0); return this.alive; }
    const rpm = Math.max(this.rpm, 0), load = this.load;
    // filters follow load & rpm
    this.lp.lowpass(C.lp0 + C.lp1 * load + rpm * C.lpR, 0.8);
    const dphi = rpm / 120 / sampleRate; // 4-stroke: one cycle per two revs
    const decay = Math.exp(-(C.decay * (0.55 + rpm / 5000)) / sampleRate);
    const cdec = Math.exp(-5500 / sampleRate), pdec = Math.exp(-140 / sampleRate);
    const offs = C.offs, pat = C.pat, n = offs.length;
    const amp0 = C.idleAmp + (1 - C.idleAmp) * load;
    const overrun = load < 0.04 && rpm > 2400 && C.crackle > 0;
    for (let i = 0; i < N; i++) {
      const g = g0 + (this.gain - g0) * (i / N);
      this.phase += dphi;
      if (this.phase >= 1) { this.phase -= 1; this.k = 0; }
      while (this.k < n && this.phase >= offs[this.k]) {
        const a = amp0 * pat[this.k] * (1 + C.jitter * (this.rnd() * 2 - 1));
        this.ex += a;
        this.clat += C.clatter * (0.6 + 0.4 * load);
        if (overrun && this.rnd() < C.crackle * 0.06) this.pop = 0.8 + this.rnd();
        this.k++;
      }
      const w = this.rnd() * 2 - 1;
      const x = this.ex * (0.85 + 0.15 * w);
      this.ex *= decay;
      let s = this.r1.run(x) * C.g1 + this.r2.run(x) * C.g2 + x * C.g0;
      s = this.lp.run(s);
      // diesel clatter & valvetrain: high-passed noise bursts at each firing
      s += this.hp.run(w * (this.clat + C.mech * amp0 * 0.15));
      this.clat *= cdec;
      // intake roar with throttle
      s += this.ib.run(w) * C.intake * this.thr * (0.2 + rpm / 6000);
      // overrun crackle
      if (this.pop > 0.01) { s += w * this.pop * 0.9; this.pop *= pdec * 0.995; }
      s = this.dc.run(s) * C.level * g * 3.5;
      out[i] = s / (1 + Math.abs(s)); // soft clip
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return this.alive;
  }
}

registerProcessor('engine', EngineProcessor);
