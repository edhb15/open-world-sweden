/* =====================================================================
   Procedural canvas textures (no image files).
   ===================================================================== */
import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

const cache = new Map();
let maxAniso = 4;
export function setMaxAnisotropy(a) { maxAniso = a; }

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function tex(c, { repeat = true, srgb = true, aniso = true, mip = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso ? maxAniso : 1;
  if (!mip) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  return t;
}
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}
function noiseFill(ctx, w, h, base, amp, rnd, size = 1) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = (rnd() - 0.5) * amp;
    d[i * 4] = Math.max(0, Math.min(255, base[0] + v));
    d[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + v));
    d[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + v));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
// value noise blobs
function blobs(ctx, w, h, count, rmin, rmax, color, alpha, rnd) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, r = rmin + rnd() * (rmax - rmin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${color},${alpha * (0.5 + rnd() * 0.5)})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
      ctx.save(); ctx.translate(ox, oy); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }
}

/* ------------------------------ Surfaces ------------------------------ */
export function asphaltTexture() {
  return cached('asphalt', () => {
    const S = 512, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(11);
    noiseFill(ctx, S, S, [92, 92, 94], 34, rnd);
    blobs(ctx, S, S, 60, 20, 90, '60,60,62', 0.25, rnd);
    blobs(ctx, S, S, 40, 10, 50, '120,120,118', 0.18, rnd);
    // aggregate speckles
    for (let i = 0; i < 9000; i++) {
      const v = 70 + rnd() * 110;
      ctx.fillStyle = `rgb(${v},${v},${v - 2})`;
      ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
    }
    // patch repairs & cracks
    ctx.strokeStyle = 'rgba(30,30,30,0.35)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      let x = rnd() * S, y = rnd() * S;
      ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    return tex(c);
  });
}
export function gravelTexture() {
  return cached('gravel', () => {
    const S = 512, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(12);
    noiseFill(ctx, S, S, [128, 118, 102], 40, rnd);
    blobs(ctx, S, S, 80, 15, 70, '95,86,72', 0.3, rnd);
    for (let i = 0; i < 14000; i++) {
      const v = 90 + rnd() * 120;
      ctx.fillStyle = `rgb(${v},${v * 0.94},${v * 0.84})`;
      const s = 1 + rnd() * 3;
      ctx.fillRect(rnd() * S, rnd() * S, s, s);
    }
    return tex(c);
  });
}
export function cobbleTexture() {
  return cached('cobble', () => {
    const S = 512, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(13);
    ctx.fillStyle = '#4a4744'; ctx.fillRect(0, 0, S, S);
    const st = 32;
    for (let y = 0; y < S; y += st * 0.8) {
      const off = (Math.round(y / (st * 0.8)) % 2) * st / 2;
      for (let x = -st; x < S + st; x += st) {
        const v = 95 + rnd() * 60;
        ctx.fillStyle = `rgb(${v},${v * 0.96},${v * 0.92})`;
        ctx.beginPath();
        const w = st * (0.8 + rnd() * 0.12), h = st * 0.66;
        const cx = x + off + st / 2, cy = y + st * 0.4;
        ctx.ellipse(cx, cy, w / 2, h / 2, (rnd() - 0.5) * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.ellipse(cx - 2, cy - 3, w / 3, h / 4, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    return tex(c);
  });
}
export function concreteTexture() {
  return cached('concrete', () => {
    const S = 512, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(14);
    noiseFill(ctx, S, S, [158, 156, 150], 22, rnd);
    blobs(ctx, S, S, 30, 20, 80, '120,118,112', 0.2, rnd);
    // paving slabs 0.35 m (texture = 2m)
    ctx.strokeStyle = 'rgba(80,78,74,0.45)';
    ctx.lineWidth = 2;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.moveTo(0, (i * S) / n); ctx.lineTo(S, (i * S) / n); ctx.stroke();
      ctx.beginPath(); ctx.moveTo((i * S) / n, 0); ctx.lineTo((i * S) / n, S); ctx.stroke();
    }
    return tex(c);
  });
}
export function grassDetailTexture() {
  return cached('grassdetail', () => {
    const S = 256, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(15);
    noiseFill(ctx, S, S, [128, 128, 128], 70, rnd);
    blobs(ctx, S, S, 50, 8, 40, '90,90,90', 0.35, rnd);
    blobs(ctx, S, S, 50, 8, 40, '175,175,175', 0.3, rnd);
    return tex(c, { srgb: false });
  });
}
export function stoneTexture() {
  return cached('stone', () => {
    const S = 256, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(16);
    noiseFill(ctx, S, S, [150, 148, 144], 30, rnd);
    ctx.strokeStyle = 'rgba(70,70,70,0.6)';
    for (let y = 0; y < S; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
    for (let y = 0; y < S; y += 32) for (let x = ((y / 32) % 2) * 32; x < S; x += 64) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 32); ctx.stroke(); }
    return tex(c);
  });
}

/* ------------------------------ Facades ------------------------------ */
// Facade textures: RGB = detail, A = tint mask (1 = wall gets tinted by building colour).
// One texture tile = 1 bay (3 m) x 1 floor (3 m) unless noted.
function facadeCanvas(drawBay, bw = 128, bh = 128, bays = 4, floors = 4) {
  const c = canvas(bw * bays, bh * floors), ctx = c.getContext('2d');
  for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) {
    ctx.save(); ctx.translate(b * bw, f * bh); drawBay(ctx, bw, bh, f, b); ctx.restore();
  }
  return c;
}
// helper: set alpha mask: tinted wall = alpha 255, untinted details = alpha 0
function paintWall(ctx, w, h, rnd, base = 210, amp = 18) {
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = base + (rnd() - 0.5) * amp;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function windowPane(ctx, x, y, w, h, frame = '#efece4', bars = true, glass = '#28343e') {
  ctx.fillStyle = frame;
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, glass); g.addColorStop(0.55, '#3d4e5c'); g.addColorStop(1, '#1d262e');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  if (bars) {
    ctx.fillStyle = frame;
    ctx.fillRect(x + w / 2 - 1.5, y, 3, h);
    ctx.fillRect(x, y + h * 0.38, w, 3);
  }
}
// The window rectangles of each facade style are recorded so we can draw a matching night-light map.
const WINDOWS = {};

let UNTINT = null, UNTINT_OFF = [0, 0];
function facade(key, bw, bh, bays, floors, draw) {
  return cached('facade_' + key, () => {
    const rects = [];
    UNTINT = [];
    const c = facadeCanvas((ctx, w, h, f, b) => {
      UNTINT_OFF = [b * bw, f * bh];
      draw(ctx, w, h, f, b, (x, y, ww, hh) => rects.push([b * bw + x, f * bh + y, ww, hh]));
    }, bw, bh, bays, floors);
    WINDOWS[key] = { rects, w: bw * bays, h: bh * floors };
    // tint mask: white = wall (gets the building colour), black = windows/trim
    const m = canvas(c.width, c.height), mctx = m.getContext('2d');
    mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, m.width, m.height);
    mctx.fillStyle = '#000';
    for (const [x, y, w, h] of UNTINT) mctx.fillRect(x, y, w, h);
    UNTINT = null;
    const t = tex(c);
    t.userData = { key, bays, floors, mask: tex(m, { srgb: false }) };
    return t;
  });
}

export function facadeTexture(style) {
  const rnd = mulberry32(100 + style.length * 7);
  switch (style) {
    case 'plaster': return facade('plaster', 128, 128, 4, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 232, 14);
      // cornice line
      ctx.fillStyle = 'rgba(255,255,255,0)';
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgb(232,228,220)'; ctx.fillRect(0, h - 6, w, 6);
      windowPane(ctx, w * 0.3, h * 0.2, w * 0.4, h * 0.58); win(w * 0.3, h * 0.2, w * 0.4, h * 0.58);
      // window surround keeps tint off
      untint(ctx, w * 0.3 - 3, h * 0.2 - 3, w * 0.4 + 6, h * 0.58 + 6);
      untint(ctx, 0, h - 6, w, 6);
    });
    case 'old': return facade('old', 96, 128, 4, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 205, 30);
      windowPane(ctx, w * 0.32, h * 0.18, w * 0.36, h * 0.62, '#f2eee2'); win(w * 0.32, h * 0.18, w * 0.36, h * 0.62);
      untint(ctx, w * 0.32 - 3, h * 0.18 - 3, w * 0.36 + 6, h * 0.62 + 6);
    });
    case 'brick': return facade('brick', 128, 128, 4, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 200, 26);
      ctx.strokeStyle = 'rgba(235,230,220,0.9)'; ctx.lineWidth = 1;
      for (let y = 0; y < h; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); for (let x = (y / 6) % 2 ? 0 : 6; x < w; x += 12) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 6); ctx.stroke(); } }
      windowPane(ctx, w * 0.28, h * 0.22, w * 0.44, h * 0.52, '#e8e2d4'); win(w * 0.28, h * 0.22, w * 0.44, h * 0.52);
      untint(ctx, w * 0.28 - 3, h * 0.22 - 3, w * 0.44 + 6, h * 0.52 + 6);
    });
    case 'lamell': return facade('lamell', 128, 112, 4, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 212, 10);
      windowPane(ctx, w * 0.12, h * 0.25, w * 0.34, h * 0.45, '#d9d9d4', false); win(w * 0.12, h * 0.25, w * 0.34, h * 0.45);
      untint(ctx, w * 0.12 - 3, h * 0.25 - 3, w * 0.34 + 6, h * 0.45 + 6);
      // balcony
      if (b % 2 === 0) {
        windowPane(ctx, w * 0.58, h * 0.15, w * 0.3, h * 0.7, '#d9d9d4', false); win(w * 0.58, h * 0.15, w * 0.3, h * 0.7);
        ctx.fillStyle = 'rgb(200,198,190)'; ctx.fillRect(w * 0.52, h * 0.6, w * 0.44, h * 0.3);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(w * 0.52, h * 0.88, w * 0.44, 3);
        untint(ctx, w * 0.52, h * 0.12, w * 0.44, h * 0.8);
      }
    });
    case 'concrete': return facade('concrete', 128, 100, 4, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 205, 16);
      ctx.strokeStyle = 'rgba(120,120,115,0.6)'; ctx.strokeRect(0, 0, w, h);
      windowPane(ctx, w * 0.1, h * 0.25, w * 0.8, h * 0.4, '#cfcfc9', false); win(w * 0.1, h * 0.25, w * 0.8, h * 0.4);
      ctx.fillStyle = 'rgb(180,178,170)'; ctx.fillRect(0, h * 0.72, w, h * 0.14);
      untint(ctx, w * 0.1 - 3, h * 0.25 - 3, w * 0.8 + 6, h * 0.4 + 6);
    });
    case 'glass': return facade('glass', 128, 128, 4, 4, (ctx, w, h, f, b, win) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#5c7484'); g.addColorStop(1, '#2c3e4c');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9aa4aa'; ctx.fillRect(0, 0, 3, h); ctx.fillRect(0, 0, w, 3);
      win(4, 4, w - 8, h - 8);
      untint(ctx, 0, 0, w, h);
    });
    case 'metal': return facade('metal', 64, 128, 8, 4, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 200, 8);
      for (let x = 0; x < w; x += 8) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, 0, 2, h); ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + 4, 0, 2, h); }
    });
    case 'shop': return facade('shop', 128, 128, 4, 2, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 220, 8);
      if (f === 1) { windowPane(ctx, 4, h * 0.12, w - 8, h * 0.8, '#5a5f63', false, '#2d3c46'); win(4, h * 0.12, w - 8, h * 0.8); untint(ctx, 0, h * 0.1, w, h * 0.86); }
    });
    case 'falu': return facade('falu', 128, 112, 4, 2, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 238, 18);
      // vertical boards
      for (let x = 0; x < w; x += 10) { ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(x, 0, 2, h); ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x + 3, 0, 1, h); }
      if (b % 2 === 0) {
        windowPane(ctx, w * 0.3, h * 0.22, w * 0.4, h * 0.5, '#f6f4ee'); win(w * 0.3, h * 0.22, w * 0.4, h * 0.5);
        // white window surround (snickarglädje)
        ctx.fillStyle = '#f6f4ee'; ctx.fillRect(w * 0.26, h * 0.16, w * 0.48, 6); ctx.fillRect(w * 0.26, h * 0.74, w * 0.48, 5);
        untint(ctx, w * 0.26, h * 0.16, w * 0.48, h * 0.64);
      }
    });
    case 'wood': return facade('wood', 128, 112, 4, 2, (ctx, w, h, f, b, win) => {
      paintWall(ctx, w, h, rnd, 236, 12);
      for (let y = 0; y < h; y += 9) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, y, w, 2); }
      if (b % 2 === 0) {
        windowPane(ctx, w * 0.3, h * 0.22, w * 0.4, h * 0.5, '#f6f4ee'); win(w * 0.3, h * 0.22, w * 0.4, h * 0.5);
        untint(ctx, w * 0.27, h * 0.19, w * 0.46, h * 0.56);
      }
    });
    default: return facadeTexture('plaster');
  }
}
function untint(ctx, x, y, w, h) {
  if (UNTINT) UNTINT.push([UNTINT_OFF[0] + x, UNTINT_OFF[1] + y, w, h]);
}

// Night window light map matching a facade style (random lit windows).
export function facadeLightTexture(style) {
  return cached('flight_' + style, () => {
    facadeTexture(style);
    const info = WINDOWS[style] || WINDOWS.plaster;
    const c = canvas(info.w, info.h), ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, info.w, info.h);
    const rnd = mulberry32(777 + style.length);
    for (const [x, y, w, h] of info.rects) {
      if (rnd() < 0.42) {
        const warm = rnd();
        const col = warm < 0.7 ? [255, 214, 150] : warm < 0.9 ? [255, 236, 200] : [190, 210, 255];
        const k = 0.55 + rnd() * 0.45;
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, `rgb(${col[0] * k},${col[1] * k},${col[2] * k})`);
        g.addColorStop(1, `rgb(${col[0] * k * 0.6},${col[1] * k * 0.6},${col[2] * k * 0.6})`);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
      }
    }
    return tex(c);
  });
}

export function roofTexture(kind) {
  return cached('roof_' + kind, () => {
    const S = 256, c = canvas(S, S), ctx = c.getContext('2d');
    const rnd = mulberry32(200 + kind.length);
    if (kind === 'tile') {
      paintWall(ctx, S, S, rnd, 200, 20);
      for (let y = 0; y < S; y += 16) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, y + 12, S, 4);
        for (let x = (y / 16) % 2 ? 8 : 0; x < S; x += 16) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(x, y, 2, 14); }
      }
    } else if (kind === 'sheet') {
      paintWall(ctx, S, S, rnd, 205, 8);
      for (let x = 0; x < S; x += 16) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, 0, 3, S); ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(x + 8, 0, 2, S); }
    } else {
      paintWall(ctx, S, S, rnd, 190, 30);
      blobs(ctx, S, S, 30, 10, 40, '100,100,100', 0.2, rnd);
    }
    return tex(c);
  });
}

/* ------------------------------ Signs ------------------------------ */
export function signTexture(key, draw, w = 256, h = 256) {
  return cached('sign_' + key, () => {
    const c = canvas(w, h), ctx = c.getContext('2d');
    draw(ctx, w, h);
    return tex(c, { repeat: false });
  });
}

export function textTexture(key, w, h, draw) {
  return cached('text_' + key, () => {
    const c = canvas(w, h), ctx = c.getContext('2d');
    draw(ctx, w, h);
    return tex(c, { repeat: false });
  });
}

export function plateTexture(text) {
  return cached('plate_' + text, () => {
    const W = 520, H = 112, c = canvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#f4f4f0'; roundRect(ctx, 0, 0, W, H, 10); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 5; roundRect(ctx, 3, 3, W - 6, H - 6, 9); ctx.stroke();
    ctx.fillStyle = '#1a3f9c'; roundRect(ctx, 5, 5, 62, H - 10, 6); ctx.fill();
    // EU stars
    ctx.fillStyle = '#ffd200';
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; ctx.beginPath(); ctx.arc(36 + Math.cos(a) * 17, 38 + Math.sin(a) * 17, 2.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.font = 'bold 34px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('S', 36, 96);
    ctx.fillStyle = '#111'; ctx.font = 'bold 84px "DIN Alternate", "Arial Narrow", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 290, 60);
    return tex(c, { repeat: false });
  });
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
