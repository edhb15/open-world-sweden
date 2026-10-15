/* =====================================================================
   Swedish road sign textures drawn on canvas (yellow-background
   warning & prohibitory signs, blue information & direction signs).
   ===================================================================== */
import { signTexture, textTexture, roundRect } from './textures.js';

const RED = '#d4161c', YEL = '#ffd200', BLUE = '#1d5bb8', BLK = '#111', WHT = '#fff', GREEN = '#0f7a3d';

function circleSign(ctx, w, h, fill, border, bw = 0.12) {
  const r = w / 2;
  ctx.fillStyle = border; ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(r, r, r * (1 - bw * 2) - 2, 0, Math.PI * 2); ctx.fill();
}
function triangle(ctx, w, h, up = true) {
  const pad = 6;
  ctx.beginPath();
  if (up) { ctx.moveTo(w / 2, pad); ctx.lineTo(w - pad, h - pad * 2); ctx.lineTo(pad, h - pad * 2); }
  else { ctx.moveTo(pad, pad * 2); ctx.lineTo(w - pad, pad * 2); ctx.lineTo(w / 2, h - pad); }
  ctx.closePath();
}
function warnBase(ctx, w, h) {
  ctx.fillStyle = RED; triangle(ctx, w, h); ctx.fill();
  ctx.save(); ctx.translate(w / 2, h * 0.58); ctx.scale(0.74, 0.74); ctx.translate(-w / 2, -h * 0.58);
  ctx.fillStyle = YEL; triangle(ctx, w, h); ctx.fill(); ctx.restore();
}

export function speedSign(v) {
  return signTexture('speed' + v, (ctx, w, h) => {
    circleSign(ctx, w, h, YEL, RED, 0.1);
    ctx.fillStyle = BLK; ctx.font = `bold ${v >= 100 ? 92 : 112}px "Arial Narrow", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(v), w / 2, h / 2 + 6);
  });
}
export function mooseSign() {
  return signTexture('moose', (ctx, w, h) => {
    warnBase(ctx, w, h);
    ctx.fillStyle = BLK;
    ctx.save(); ctx.translate(w * 0.5, h * 0.64); ctx.scale(w / 256, h / 256);
    ctx.beginPath();
    // body
    ctx.ellipse(-4, 0, 44, 20, 0, 0, Math.PI * 2); ctx.fill();
    // legs
    for (const x of [-38, -26, 18, 30]) ctx.fillRect(x, 10, 6, 40);
    // neck & head
    ctx.beginPath(); ctx.moveTo(30, -12); ctx.lineTo(48, -34); ctx.lineTo(64, -30); ctx.lineTo(70, -18); ctx.lineTo(56, -14); ctx.lineTo(40, 6); ctx.closePath(); ctx.fill();
    // antlers
    ctx.beginPath(); ctx.moveTo(48, -34); ctx.lineTo(40, -52); ctx.lineTo(52, -44); ctx.lineTo(58, -56); ctx.lineTo(60, -38); ctx.closePath(); ctx.fill();
    // hump
    ctx.beginPath(); ctx.ellipse(18, -16, 18, 10, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
}
export function curveSign(dir) {
  return signTexture('curve' + dir, (ctx, w, h) => {
    warnBase(ctx, w, h);
    ctx.strokeStyle = BLK; ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.8); ctx.lineTo(w * 0.5, h * 0.6); ctx.quadraticCurveTo(w * 0.5, h * 0.44, w * (0.5 + 0.12 * dir), h * 0.42); ctx.stroke();
    ctx.fillStyle = BLK; ctx.beginPath(); const tx = w * (0.5 + 0.17 * dir); ctx.moveTo(tx, h * 0.42); ctx.lineTo(tx - 22 * dir, h * 0.33); ctx.lineTo(tx - 22 * dir, h * 0.51); ctx.fill();
  });
}
export function yieldSign() {
  return signTexture('yield', (ctx, w, h) => {
    ctx.fillStyle = RED; triangle(ctx, w, h, false); ctx.fill();
    ctx.save(); ctx.translate(w / 2, h * 0.4); ctx.scale(0.72, 0.72); ctx.translate(-w / 2, -h * 0.4);
    ctx.fillStyle = YEL; triangle(ctx, w, h, false); ctx.fill(); ctx.restore();
  });
}
export function stopSign() {
  return signTexture('stop', (ctx, w, h) => {
    ctx.fillStyle = WHT; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; ctx.lineTo(w / 2 + Math.cos(a) * w * 0.48, h / 2 + Math.sin(a) * h * 0.48); }
    ctx.fill();
    ctx.fillStyle = RED; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; ctx.lineTo(w / 2 + Math.cos(a) * w * 0.44, h / 2 + Math.sin(a) * h * 0.44); }
    ctx.fill();
    ctx.fillStyle = WHT; ctx.font = 'bold 72px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('STOP', w / 2, h / 2 + 4);
  });
}
export function priorityRoadSign() {
  return signTexture('priority', (ctx, w, h) => {
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = WHT; ctx.fillRect(-w * 0.34, -h * 0.34, w * 0.68, h * 0.68);
    ctx.fillStyle = BLK; ctx.fillRect(-w * 0.3, -h * 0.3, w * 0.6, h * 0.6);
    ctx.fillStyle = YEL; ctx.fillRect(-w * 0.27, -h * 0.27, w * 0.54, h * 0.54);
    ctx.restore();
  });
}
export function crossingSign() {
  return signTexture('crossing', (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 4, 4, w - 8, h - 8, 12); ctx.fill();
    ctx.strokeStyle = WHT; ctx.lineWidth = 6; roundRect(ctx, 12, 12, w - 24, h - 24, 8); ctx.stroke();
    ctx.fillStyle = WHT; triangle(ctx, w, h); ctx.save(); ctx.translate(w / 2, h * 0.55); ctx.scale(0.75, 0.75); ctx.translate(-w / 2, -h * 0.55); triangle(ctx, w, h); ctx.fill(); ctx.restore();
    // walking figure
    ctx.fillStyle = BLK; ctx.beginPath(); ctx.arc(w * 0.52, h * 0.38, 9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 9; ctx.strokeStyle = BLK; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w * 0.51, h * 0.43); ctx.lineTo(w * 0.48, h * 0.6); ctx.lineTo(w * 0.42, h * 0.72); ctx.moveTo(w * 0.48, h * 0.6); ctx.lineTo(w * 0.56, h * 0.72); ctx.moveTo(w * 0.42, h * 0.5); ctx.lineTo(w * 0.58, h * 0.52); ctx.stroke();
    ctx.fillStyle = WHT; for (let i = 0; i < 4; i++) ctx.fillRect(w * 0.28 + i * 30, h * 0.78, 18, 8);
  });
}
export function roundaboutSign() {
  return signTexture('roundabout', (ctx, w, h) => {
    circleSign(ctx, w, h, BLUE, WHT, 0.025);
    ctx.strokeStyle = WHT; ctx.lineWidth = 14; ctx.fillStyle = WHT;
    for (let i = 0; i < 3; i++) {
      const a0 = (i * Math.PI * 2) / 3 + 0.4, a1 = a0 + 1.4;
      ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.24, a0, a1); ctx.stroke();
      const ax = w / 2 + Math.cos(a1) * w * 0.24, ay = h / 2 + Math.sin(a1) * w * 0.24;
      ctx.save(); ctx.translate(ax, ay); ctx.rotate(a1 + Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-10, -16); ctx.lineTo(-10, 16); ctx.fill(); ctx.restore();
    }
  });
}
export function motorwaySign(end = false) {
  return signTexture('motorway' + end, (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 4, 4, w - 8, h - 8, 12); ctx.fill();
    ctx.strokeStyle = WHT; ctx.lineWidth = 5; roundRect(ctx, 12, 12, w - 24, h - 24, 8); ctx.stroke();
    ctx.strokeStyle = WHT; ctx.lineWidth = 16;
    ctx.beginPath(); ctx.moveTo(w * 0.32, h * 0.82); ctx.quadraticCurveTo(w * 0.42, h * 0.5, w * 0.36, h * 0.3); ctx.moveTo(w * 0.68, h * 0.82); ctx.quadraticCurveTo(w * 0.58, h * 0.5, w * 0.64, h * 0.3); ctx.stroke();
    ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(w * 0.28, h * 0.42); ctx.lineTo(w * 0.72, h * 0.42); ctx.stroke();
    if (end) { ctx.strokeStyle = RED; ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(w * 0.2, h * 0.8); ctx.lineTo(w * 0.8, h * 0.2); ctx.stroke(); }
  });
}
export function cameraSign() {
  return signTexture('atk', (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 4, 4, w - 8, h - 8, 12); ctx.fill();
    ctx.strokeStyle = WHT; ctx.lineWidth = 5; roundRect(ctx, 12, 12, w - 24, h - 24, 8); ctx.stroke();
    ctx.fillStyle = WHT; roundRect(ctx, w * 0.2, h * 0.38, w * 0.6, h * 0.32, 10); ctx.fill();
    ctx.fillStyle = BLUE; ctx.beginPath(); ctx.arc(w * 0.5, h * 0.54, w * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = WHT; ctx.fillRect(w * 0.3, h * 0.3, w * 0.14, h * 0.08);
  });
}
export function restSign() {
  return signTexture('rest', (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 4, 4, w - 8, h - 8, 12); ctx.fill();
    ctx.fillStyle = WHT; ctx.font = 'bold 120px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('P', w * 0.36, h * 0.5);
    ctx.fillRect(w * 0.58, h * 0.46, w * 0.28, 10); ctx.fillRect(w * 0.6, h * 0.46, 8, h * 0.24); ctx.fillRect(w * 0.8, h * 0.46, 8, h * 0.24);
  });
}
export function fuelSign() {
  return signTexture('fuel', (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 4, 4, w - 8, h - 8, 12); ctx.fill();
    ctx.fillStyle = WHT; roundRect(ctx, w * 0.22, h * 0.18, w * 0.56, h * 0.64, 10); ctx.fill();
    ctx.fillStyle = BLK; roundRect(ctx, w * 0.32, h * 0.26, w * 0.36, h * 0.6, 6); ctx.fill();
    ctx.fillStyle = WHT; ctx.fillRect(w * 0.37, h * 0.32, w * 0.26, h * 0.16);
  });
}
// Town name sign (white text on blue) — entering
export function placeSign(name) {
  return textTexture('place_' + name, 512, 160, (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 0, 0, w, h, 14); ctx.fill();
    ctx.strokeStyle = WHT; ctx.lineWidth = 6; roundRect(ctx, 8, 8, w - 16, h - 16, 10); ctx.stroke();
    ctx.fillStyle = WHT; ctx.font = 'bold 64px "Arial Narrow", Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name.toUpperCase(), w / 2, h / 2 + 4, w - 40);
  });
}
export function streetSign(name) {
  return textTexture('street_' + name, 512, 96, (ctx, w, h) => {
    ctx.fillStyle = BLUE; roundRect(ctx, 0, 0, w, h, 8); ctx.fill();
    ctx.fillStyle = WHT; ctx.font = 'bold 52px "Arial Narrow", Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2 + 2, w - 24);
  });
}
// Direction sign: list of {text, ref, arrow: -1/0/1}; blue background (main roads & motorways)
export function directionSign(key, lines, style = 'blue') {
  const H = 96 * lines.length + 40;
  return textTexture('dir_' + key, 640, H, (ctx, w, h) => {
    ctx.fillStyle = style === 'white' ? '#f4f4f0' : BLUE; roundRect(ctx, 0, 0, w, h, 16); ctx.fill();
    ctx.strokeStyle = style === 'white' ? BLK : WHT; ctx.lineWidth = 6; roundRect(ctx, 8, 8, w - 16, h - 16, 12); ctx.stroke();
    lines.forEach((L, i) => {
      const y = 20 + i * 96 + 48;
      ctx.fillStyle = style === 'white' ? BLK : WHT;
      ctx.font = 'bold 56px "Arial Narrow", Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let x = 30;
      if (L.arrow != null) {
        ctx.save(); ctx.translate(x + 28, y); ctx.rotate(L.arrow * Math.PI / 2 - Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(-4, -22); ctx.lineTo(-4, -9); ctx.lineTo(-26, -9); ctx.lineTo(-26, 9); ctx.lineTo(-4, 9); ctx.lineTo(-4, 22); ctx.closePath(); ctx.fill(); ctx.restore();
        x += 76;
      }
      if (L.ref) {
        const e = L.ref.startsWith('E');
        ctx.fillStyle = e ? GREEN : style === 'white' ? BLUE : '#f4f4f0';
        const tw = 34 * L.ref.length + 26;
        roundRect(ctx, x, y - 34, tw, 68, 8); ctx.fill();
        ctx.strokeStyle = e ? WHT : style === 'white' ? WHT : BLK; ctx.lineWidth = 4; roundRect(ctx, x + 4, y - 30, tw - 8, 60, 6); ctx.stroke();
        ctx.fillStyle = e ? WHT : style === 'white' ? WHT : BLK; ctx.font = 'bold 48px Arial'; ctx.textAlign = 'center'; ctx.fillText(L.ref, x + tw / 2, y + 2);
        x += tw + 18;
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = style === 'white' ? BLK : WHT; ctx.font = 'bold 56px "Arial Narrow", Arial';
      ctx.fillText(L.text || '', x, y + 2, w - x - 24);
    });
  });
}
