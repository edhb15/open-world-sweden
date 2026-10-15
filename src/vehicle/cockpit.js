/* =====================================================================
   Cockpit interior for the player's car: dashboard, instrument cluster
   (live canvas gauges), steering wheel, centre screen, A-pillars, seats,
   rear-view & side mirrors (render target), wipers and rain on glass.
   ===================================================================== */
import * as THREE from 'three';
import { carGeometry } from './carmesh.js';
import { clamp, lerp } from '../core/math.js';

export class Cockpit {
  constructor(car, game) {
    this.car = car; this.game = game;
    const spec = car.spec;
    const G = carGeometry(spec);
    this.G = G;
    const B = spec.body;
    const P = G.P;
    const big = B.shape === 'bus' || B.shape === 'truck' || B.shape === 'van';
    const y0 = -spec.cgH;
    const belt = y0 + P.lower.belt, roof = y0 + P.green.roof;
    const zA = G.bb.min.z + G.P.green.aBase + 0.02; // windshield base (local z)
    const zRoofF = G.bb.min.z + G.P.green.rFront;
    this.group = new THREE.Group();
    this.group.visible = false;
    car.mesh.body.add(this.group);
    const mat = (c, r = 0.85, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const M = { dash: mat(0x1d1f22, 0.9), trim: mat(0x2a2c30, 0.6), soft: mat(0x3a3a3c, 0.95), metal: mat(0x9a9ea3, 0.3, 0.8), seat: mat(spec.year < 1990 ? 0x4a3a2c : 0x232527, 0.95), head: mat(0x6f6e6a, 0.95), black: mat(0x0b0b0c, 0.6) };
    this.M = M;
    const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); this.group.add(o); return o; };
    const W = B.W * 0.86;
    const driverX = big ? -B.W * 0.28 : -B.W * 0.22;
    // eye point
    const eyeY = big ? belt + 0.45 : belt + 0.36;
    const dashDepth = big ? 0.8 : 0.55;
    const dashZ0 = zA + 0.05; // front of dash under windshield
    const eyeZ = dashZ0 + dashDepth + (big ? 0.75 : 0.62);
    this.eye = new THREE.Vector3(driverX, eyeY, eyeZ);
    // everything below is laid out relative to the driver's eye
    const fwdC = big ? 0.95 : 0.74;           // eye -> instrument cluster distance
    const dashTop = eyeY - (big ? 0.3 : 0.25);
    const dashBack = eyeZ - fwdC + 0.12;       // driver-side edge of the dash
    const dashFront = Math.min(dashBack - 0.3, zA + 0.02);
    const dashD = dashBack - dashFront;
    add(new THREE.BoxGeometry(W, 0.12, dashD), M.dash, 0, dashTop - 0.06, (dashBack + dashFront) / 2);
    add(new THREE.BoxGeometry(W, 0.42, 0.14), M.dash, 0, dashTop - 0.3, dashBack + 0.02);
    // instrument binnacle & cluster
    const clusterW = big ? 0.5 : 0.36, clusterH = 0.14;
    add(new THREE.BoxGeometry(clusterW + 0.08, 0.04, 0.16), M.dash, driverX, dashTop + 0.07, eyeZ - fwdC + 0.02);
    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.width = 640; this.clusterCanvas.height = 256;
    this.clusterTex = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    const clusterMat = new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false });
    add(new THREE.PlaneGeometry(clusterW, clusterH), clusterMat, driverX, dashTop - 0.02, eyeZ - fwdC + 0.08, -0.3);
    add(new THREE.BoxGeometry(clusterW + 0.04, clusterH + 0.04, 0.02), M.black, driverX, dashTop - 0.02, eyeZ - fwdC + 0.065, -0.3);
    // centre screen (navigation)
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 320; this.screenCanvas.height = 200;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    if (spec.year >= 2005) {
      add(new THREE.PlaneGeometry(0.24, 0.15), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }), 0.03, dashTop - 0.04, dashBack + 0.1, -0.15);
    } else {
      add(new THREE.BoxGeometry(0.18, 0.05, 0.03), M.trim, 0.03, dashTop - 0.14, dashBack + 0.1);
    }
    // lower dash & footwell so the cabin is closed below the dash
    add(new THREE.BoxGeometry(W, 0.55, 0.6), M.dash, 0, dashTop - 0.62, dashBack - 0.25);
    add(new THREE.BoxGeometry(W, 0.04, 1.6), M.black, 0, eyeY - 1.05, eyeZ - 0.3);
    // centre console & gear lever
    add(new THREE.BoxGeometry(0.22, 0.25, 0.7), M.dash, 0.03, dashTop - 0.55, dashBack + 0.42);
    this.lever = add(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6), M.metal, 0.03, dashTop - 0.34, dashBack + 0.48);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), M.black); knob.position.y = 0.09; this.lever.add(knob);
    // steering wheel
    const wheelGroup = new THREE.Group();
    const wr = big ? 0.24 : 0.185;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(wr, 0.016, 8, 40), M.black);
    wheelGroup.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.05, 16), M.trim); hub.rotation.x = Math.PI / 2; wheelGroup.add(hub);
    for (const a of [-Math.PI / 2, Math.PI * 0.08, Math.PI * 0.92]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, wr, 0.012), M.trim);
      sp.position.set(Math.cos(a) * wr / 2, Math.sin(a) * wr / 2, 0); sp.rotation.z = a - Math.PI / 2; wheelGroup.add(sp);
    }
    const mk = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), mat(0xb0b4b8, 0.4, 0.6)); mk.position.y = wr; wheelGroup.add(mk);
    this.wheelSpin = new THREE.Group();
    this.wheelSpin.add(wheelGroup);
    this.wheelMount = new THREE.Group();
    this.wheelMount.position.set(driverX, eyeY - (big ? 0.46 : 0.37), eyeZ - (big ? 0.55 : 0.5));
    this.wheelMount.rotation.x = big ? -1.05 : -0.42;
    this.wheelMount.add(this.wheelSpin);
    this.group.add(this.wheelMount);
    // column
    add(new THREE.CylinderGeometry(0.03, 0.035, 0.3, 8), M.dash, driverX, eyeY - 0.5, eyeZ - 0.62, -0.42 + Math.PI / 2, 0, 0);
    // A-pillars
    const pillarLen = Math.hypot(zRoofF - zA, roof - belt);
    const pang = Math.atan2(zRoofF - zA, roof - belt);
    for (const sx of [-1, 1]) {
      const pl = add(new THREE.BoxGeometry(0.07, pillarLen, 0.07), M.trim, sx * (W / 2 - 0.02), (belt + roof) / 2, (zA + zRoofF) / 2);
      pl.rotation.x = pang;
    }
    // roof liner, door panels, seats
    add(new THREE.BoxGeometry(W, 0.02, (G.bb.max.z - zRoofF) * 0.9), M.head, 0, roof - 0.04, zRoofF + (G.bb.max.z - zRoofF) * 0.45);
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.06, 0.5, 1.6), M.soft, sx * (B.W / 2 - 0.1), belt - 0.22, eyeZ - 0.1);
      add(new THREE.BoxGeometry(0.05, 0.05, 1.4), M.trim, sx * (B.W / 2 - 0.12), belt + 0.01, eyeZ - 0.1);
    }
    const seatX = big ? [driverX] : [driverX, -driverX];
    for (const sx of seatX) {
      add(new THREE.BoxGeometry(0.5, 0.12, 0.5), M.seat, sx, eyeY - 0.75, eyeZ + 0.05);
      add(new THREE.BoxGeometry(0.5, 0.65, 0.12), M.seat, sx, eyeY - 0.38, eyeZ + 0.33, -0.12);
      add(new THREE.BoxGeometry(0.26, 0.2, 0.1), M.seat, sx, eyeY + 0.02, eyeZ + 0.38);
    }
    // pedals hint
    add(new THREE.BoxGeometry(0.4, 0.3, 0.02), M.black, driverX, eyeY - 0.95, dashZ0 + dashDepth + 0.1, -0.6);
    // rear-view mirror (render target)
    this.rt = new THREE.WebGLRenderTarget(512, 160, { samples: 0 });
    this.mirrorCam = new THREE.PerspectiveCamera(48, 512 / 160, 0.5, 900);
    const mirMat = new THREE.MeshBasicMaterial({ map: this.rt.texture });
    // flip horizontally (mirror)
    const mg = new THREE.PlaneGeometry(0.25, 0.07);
    const uv = mg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    this.rearMirror = add(mg, mirMat, 0.0, roof - 0.14, zRoofF + 0.0, 0.08, Math.PI - 0.25, 0);
    add(new THREE.BoxGeometry(0.27, 0.082, 0.025), M.black, 0.0, roof - 0.14, zRoofF - 0.017, 0.08, -0.25, 0);
    // side mirror glass (inside view of exterior mirrors), sub-rects of the same target
    const sideGeo = (u0, u1) => { const g = new THREE.PlaneGeometry(0.17, 0.11); const a = g.attributes.uv; for (let i = 0; i < a.count; i++) { const u = a.getX(i); a.setX(i, lerp(u1, u0, u)); a.setY(i, lerp(0.15, 0.85, a.getY(i))); } return g; };
    if (!big) {
      for (const sx of [-1, 1]) {
        const m = add(sideGeo(sx < 0 ? 0.0 : 0.62, sx < 0 ? 0.38 : 1.0), mirMat, sx * (B.W / 2 + 0.07), belt + 0.08, G.bb.min.z + G.P.green.aBase + 0.18 + 0.05, 0, Math.PI + sx * 0.25, 0);
      }
    }
    // windshield rain layer + wipers
    this.rainCanvas = document.createElement('canvas');
    this.rainCanvas.width = 512; this.rainCanvas.height = 256;
    this.rainCtx = this.rainCanvas.getContext('2d');
    this.rainTex = new THREE.CanvasTexture(this.rainCanvas);
    const wsW = W * 0.98, wsH = Math.hypot(zRoofF - zA, roof - belt) * 0.98;
    const ws = add(new THREE.PlaneGeometry(wsW, wsH), new THREE.MeshBasicMaterial({ map: this.rainTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.85 }), 0, (belt + roof) / 2, (zA + zRoofF) / 2 + 0.005);
    ws.rotation.x = -(Math.PI / 2 - pang);
    this.windshield = ws;
    this.wsW = wsW; this.wsH = wsH;
    this.wipers = [];
    for (const px of [-wsW * 0.28, wsW * 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(px, -wsH / 2 + 0.03, 0.02);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.018, wsH * 0.75, 0.012), M.black);
      arm.position.y = wsH * 0.375;
      pivot.add(arm);
      ws.add(pivot);
      this.wipers.push(pivot);
    }
    this.drops = [];
    this.lastWiper = 0;
    this.clusterT = 0;
    this.mirrorT = 0;
    this.prepareDial();
  }

  setVisible(v) {
    this.group.visible = v;
    this.car.mesh.cabinMesh.visible = !v;
    // hide the exterior greenhouse glass from the inside to avoid double glass
    this.car.mesh.greenMesh.visible = !v;
  }

  prepareDial() {
    const spec = this.car.spec;
    const maxKmh = spec.cls === 'bus' || spec.cls === 'truck' ? 125 : spec.year < 1970 ? 160 : spec.year < 2000 ? 200 : 260;
    const maxRpm = Math.ceil((spec.engine.limiter || 7000) / 1000) * 1000;
    this.dial = { maxKmh, maxRpm };
    const c = document.createElement('canvas'); c.width = 640; c.height = 256;
    const g = c.getContext('2d');
    const ev = spec.engine.type === 'ev';
    g.fillStyle = '#07090c'; g.fillRect(0, 0, 640, 256);
    const dial = (cx, cy, r, max, step, label, red) => {
      g.strokeStyle = '#3c4148'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      for (let v = 0; v <= max; v += step / 2) {
        const a = Math.PI * 0.75 + (v / max) * Math.PI * 1.5;
        const major = v % step === 0;
        g.strokeStyle = red && v >= red ? '#e33' : '#e8eaee'; g.lineWidth = major ? 3 : 1.5;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r * (major ? 0.8 : 0.86), cy + Math.sin(a) * r * (major ? 0.8 : 0.86)); g.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94); g.stroke();
        if (major) { g.fillStyle = '#e8eaee'; g.font = '600 18px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label(v), cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64); }
      }
    };
    dial(150, 128, 112, maxKmh, maxKmh > 200 ? 20 : maxKmh > 130 ? 20 : 10, (v) => String(v), 0);
    if (!ev) dial(490, 128, 112, maxRpm, 1000, (v) => String(v / 1000), spec.engine.redline);
    else { g.fillStyle = '#e8eaee'; g.font = '600 18px Arial'; g.textAlign = 'center'; g.fillText('kW', 490, 200); dial(490, 128, 112, 300, 50, (v) => String(v), 0); }
    g.fillStyle = '#9aa3ad'; g.font = '14px Arial'; g.textAlign = 'center'; g.fillText('km/h', 150, 190); if (!ev) g.fillText('x1000 r/min', 490, 190);
    this.dialBg = c;
  }

  update(dt, game) {
    const car = this.car, P = car.phys;
    // steering wheel
    this.wheelSpin.rotation.z = -P.steerAngle * car.spec.steer.ratio;
    // gear lever
    this.lever.rotation.x = P.gear > 0 ? (P.gear % 2 ? -0.25 : 0.25) : P.gear < 0 ? 0.3 : 0;
    this.lever.rotation.z = P.gear > 0 ? clamp((Math.ceil(P.gear / 2) - 2) * 0.15, -0.3, 0.3) : 0;
    // wipers
    const ph = car.wiperPhase;
    const ang = Math.sin(ph * Math.PI) * 1.7;
    this.wipers[0].rotation.z = -1.42 + ang; this.wipers[1].rotation.z = -1.42 + ang;
    this.rain(dt, game, ph);
    this.clusterT -= dt;
    if (this.clusterT <= 0) { this.clusterT = 1 / 20; this.drawCluster(game); }
  }

  drawCluster(game) {
    const car = this.car, P = car.phys;
    const g = this.clusterCanvas.getContext('2d');
    g.drawImage(this.dialBg, 0, 0);
    const needle = (cx, cy, r, frac, col) => {
      const a = Math.PI * 0.75 + clamp(frac, 0, 1.03) * Math.PI * 1.5;
      g.strokeStyle = col; g.lineWidth = 4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14); g.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); g.stroke();
      g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
    };
    const kmh = Math.abs(P.fwdSpeed) * 3.6;
    needle(150, 128, 112, kmh / this.dial.maxKmh, '#ff6a3d');
    if (P.ev) needle(490, 128, 112, Math.max(0, P.throttleEff * P.spec.engine.maxPower * Math.min(1, P.speed / 10 + 0.2)) / 300, '#3dc6ff');
    else needle(490, 128, 112, P.rpm / this.dial.maxRpm, '#ff6a3d');
    // centre info
    g.fillStyle = '#e8eaee'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 34px Arial'; g.fillText(P.gearLabel(), 320, 70);
    g.font = '600 16px Arial';
    const t = game.conditions.temp;
    g.fillText(`${t.toFixed(0)}°C${t < 3 ? ' ❄' : ''}`, 320, 112);
    const c = game.env.clock;
    g.fillText(`${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60)).padStart(2, '0')}`, 320, 136);
    g.fillText(`${Math.floor(P.odo / 1000 + (game.save ? game.save.odo : 0)).toString().padStart(6, '0')} km`, 320, 220);
    // fuel bar
    const f = P.fuel / car.spec.fuel.tank;
    g.fillStyle = '#2a2f36'; g.fillRect(270, 160, 100, 8);
    g.fillStyle = f < 0.12 ? '#ff9a00' : '#e8eaee'; g.fillRect(270, 160, 100 * clamp(f, 0, 1), 8);
    g.font = '12px Arial'; g.fillText(P.ev ? 'kWh' : 'E    F', 320, 180);
    // warning lights
    const lamp = (x, y, on, col, txt) => { g.fillStyle = on ? col : '#1b1f24'; g.font = 'bold 14px Arial'; g.fillText(txt, x, y); };
    lamp(275, 30, (car.indicator === -1 || car.indicator === 2) && car.blinkOn, '#3cff6a', '◀');
    lamp(365, 30, (car.indicator === 1 || car.indicator === 2) && car.blinkOn, '#3cff6a', '▶');
    lamp(300, 30, car.headOn && !car.highOn, '#3cff6a', '◐');
    lamp(340, 30, car.highOn && car.headOn, '#4c8dff', '≣');
    lamp(250, 245, P.absActive, '#ffb000', 'ABS');
    lamp(390, 245, P.esc || P.tcsActive, '#ffb000', 'ESC');
    lamp(320, 245, !P.running && !P.ev, '#ff3b30', '⚠');
    if (car.cruise != null) lamp(320, 200, true, '#3cff6a', `⟳ ${Math.round(car.cruise * 3.6)}`);
    if (f < 0.1) lamp(400, 165, true, '#ff9a00', '⛽');
    this.clusterTex.needsUpdate = true;
    // navigation screen
    if (game.minimap && this.car.spec.year >= 2005) {
      const s = this.screenCanvas.getContext('2d');
      game.minimap.drawTo(s, this.screenCanvas.width, this.screenCanvas.height, true);
      this.screenTex.needsUpdate = true;
    }
  }

  rain(dt, game, ph) {
    const C = this.rainCtx, W = this.rainCanvas.width, H = this.rainCanvas.height;
    const wet = game.env.weather.rain + game.env.weather.snow * 0.6;
    const speed = Math.abs(this.car.phys.fwdSpeed);
    // add drops
    if (wet > 0.02) {
      const n = wet * dt * (40 + speed * 3);
      for (let i = 0; i < n; i++) this.drops.push({ x: Math.random() * W, y: Math.random() * H, r: 1.5 + Math.random() * (game.env.weather.snow > 0.3 ? 5 : 3.5), snow: game.env.weather.snow > game.env.weather.rain, life: 0 });
    }
    // drops slide upward with airflow at speed, evaporate slowly
    for (const d of this.drops) { d.life += dt; if (speed > 12) d.y -= (speed - 12) * dt * 4; }
    // wipers clear a sector
    if (ph > 0) {
      const ang = Math.sin(ph * Math.PI) * 1.7;
      for (const [cx, rr] of [[W * 0.22, H * 1.15], [W * 0.68, H * 1.15]]) {
        const a = -Math.PI / 2 + (-1.42 + ang);
        this.drops = this.drops.filter((d) => { const dx = d.x - cx, dy = d.y - H; const da = Math.atan2(dy, dx); return Math.abs(da - a) > 0.12 || Math.hypot(dx, dy) > rr; });
      }
    }
    this.drops = this.drops.filter((d) => d.y > -5 && d.life < 40);
    if (this.drops.length > 900) this.drops.splice(0, this.drops.length - 900);
    this.dropT = (this.dropT || 0) - dt;
    if (this.dropT > 0) return;
    this.dropT = 1 / 15;
    C.clearRect(0, 0, W, H);
    for (const d of this.drops) {
      if (d.snow) { C.fillStyle = 'rgba(240,245,255,0.75)'; C.beginPath(); C.arc(d.x, d.y, d.r, 0, Math.PI * 2); C.fill(); continue; }
      const g = C.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, d.r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.6, 'rgba(160,180,200,0.25)'); g.addColorStop(1, 'rgba(40,50,60,0.35)');
      C.fillStyle = g; C.beginPath(); C.arc(d.x, d.y, d.r, 0, Math.PI * 2); C.fill();
    }
    // glass cracks after hard impacts
    const gd = this.car.phys.damage.glass;
    if (gd > 0.1) {
      C.strokeStyle = `rgba(230,235,240,${clamp(gd, 0, 0.8)})`; C.lineWidth = 1.2;
      const rnd = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const cx = W * 0.62, cy = H * 0.55;
      for (let k = 0; k < 6 + gd * 20; k++) { C.beginPath(); C.moveTo(cx, cy); let x = cx, y = cy; const a = rnd(k) * 6.283; for (let q = 0; q < 5; q++) { x += Math.cos(a + (rnd(k * 7 + q) - 0.5)) * 30; y += Math.sin(a + (rnd(k * 3 + q) - 0.5)) * 30; C.lineTo(x, y); } C.stroke(); }
    }
    this.rainTex.needsUpdate = true;
  }

  // render mirrors (called before the main render)
  renderMirrors(renderer, scene) {
    this.mirrorT -= 1;
    if (this.mirrorT > 0) return;
    this.mirrorT = 2;
    const car = this.car, P = car.phys;
    const back = car.spec.body.L * 0.5 + 0.3;
    const p = P.pointWorld(0, this.G.P.green.roof - car.spec.cgH - 0.2, back);
    const t = P.pointWorld(0, this.G.P.green.roof - car.spec.cgH - 1.2, back + 30);
    this.mirrorCam.position.set(p[0], p[1], p[2]);
    this.mirrorCam.lookAt(t[0], t[1], t[2]);
    this.mirrorCam.updateMatrixWorld();
    const vis = this.group.visible;
    this.group.visible = false;
    const old = renderer.getRenderTarget();
    const sh = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, this.mirrorCam);
    renderer.setRenderTarget(old);
    renderer.shadowMap.autoUpdate = sh;
    this.group.visible = vis;
  }
}
