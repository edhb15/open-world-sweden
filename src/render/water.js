/* =====================================================================
   Water: sea/big-lake plane at level 0 that follows the camera, small
   forest lakes with their own level, sloped rivers, and winter ice.
   ===================================================================== */
import * as THREE from 'three';
import { RIVERS, smallLakesNear, debugGeo } from '../world/geo.js';
import { mulberry32 } from '../core/math.js';

function waterNormalTexture() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(5);
  // sum of a few tileable waves -> height, then normals
  const waves = [];
  for (let k = 0; k < 18; k++) waves.push([Math.floor(rnd() * 6) + 1, Math.floor(rnd() * 6) - 3, rnd() * 6.28, 0.3 + rnd()]);
  const H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let h = 0;
    for (const [a, b, p, amp] of waves) h += Math.sin(((a * x + b * y) / S) * Math.PI * 2 + p) * amp / (Math.abs(a) + Math.abs(b));
    H[y * S + x] = h;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = H[y * S + ((x + 1) % S)] - H[y * S + ((x - 1 + S) % S)];
    const dy = H[((y + 1) % S) * S + x] - H[((y - 1 + S) % S) * S + x];
    const nx = -dx * 2, ny = -dy * 2, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class Water {
  constructor(scene) {
    this.scene = scene;
    const nt = waterNormalTexture();
    this.normalTex = nt;
    this.mat = new THREE.MeshStandardMaterial({ color: 0x1d3a44, roughness: 0.06, metalness: 0.0, normalMap: nt, normalScale: new THREE.Vector2(0.35, 0.35), transparent: true, opacity: 0.93 });
    this.lakeMat = this.mat.clone();
    this.lakeMat.color.set(0x1a2c26);
    this.iceMat = new THREE.MeshStandardMaterial({ color: 0xc9d6de, roughness: 0.35, metalness: 0.0 });
    this.snowIceMat = new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 0.8 });
    const g = new THREE.PlaneGeometry(14000, 14000, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(g, this.mat);
    this.sea.renderOrder = 1;
    this.sea.receiveShadow = true;
    scene.add(this.sea);
    this.lakes = new Map(); // lake key -> mesh
    this.rivers = [];
    this.frozen = 0; // 0 open, 1 ice, 2 snow on ice
    this.buildRivers();
  }
  buildRivers() {
    for (const r of RIVERS) {
      if (!r.slope) continue;
      const pos = [], idx = [];
      const pts = r.pts;
      // densify
      const dense = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.ceil(L / 30);
        for (let k = 0; k < n; k++) {
          const t = k / n;
          dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r.fromMouth[i] + (r.fromMouth[i + 1] - r.fromMouth[i]) * t]);
        }
      }
      dense.push([pts[pts.length - 1][0], pts[pts.length - 1][1], 0]);
      const ox = dense[0][0], oz = dense[0][1];
      for (let i = 0; i < dense.length; i++) {
        const p = dense[i];
        const q = dense[Math.min(dense.length - 1, i + 1)], o = dense[Math.max(0, i - 1)];
        let tx = q[0] - o[0], tz = q[1] - o[1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const w = r.w / 2 + 6;
        const y = p[2] * r.slope - 0.05;
        pos.push(p[0] - tz * w - ox, y, p[1] + tx * w - oz, p[0] + tz * w - ox, y, p[1] - tx * w - oz);
        if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const uv = [];
      for (let i = 0; i < pos.length / 3; i++) uv.push(pos[i * 3] / 40, pos[i * 3 + 2] / 40);
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, this.lakeMat);
      m.position.set(ox, 0, oz);
      m.renderOrder = 1;
      this.scene.add(m);
      this.rivers.push(m);
    }
  }
  // keep lake meshes for lakes near the camera
  update(cam, dt, time) {
    const sx = Math.round(cam.x / 128) * 128, sz = Math.round(cam.z / 128) * 128;
    this.sea.position.set(sx, 0, sz);
    const o = (time * 0.012) % 1;
    this.normalTex.offset.set(o, o * 0.6);
    this.normalTex.repeat.set(2800, 2800);
    const near = smallLakesNear(cam.x, cam.z, 2600);
    const keep = new Set();
    for (const l of near) {
      const key = l.x + ':' + l.z;
      keep.add(key);
      if (!this.lakes.has(key)) {
        const seg = 48;
        const g = new THREE.CircleGeometry(l.R * 1.62, seg);
        g.rotateX(-Math.PI / 2);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * l.R * 0.08, uv.getY(i) * l.R * 0.08);
        const m = new THREE.Mesh(g, this.frozen ? this.iceMat : this.lakeMat);
        m.position.set(l.x, l.level, l.z);
        m.renderOrder = 1;
        m.userData.lake = l;
        this.scene.add(m);
        this.lakes.set(key, m);
      }
    }
    for (const [k, m] of this.lakes) if (!keep.has(k)) { this.scene.remove(m); m.geometry.dispose(); this.lakes.delete(k); }
  }
  // freeze: 0 = open water, 1 = ice, 2 = snow-covered ice (lakes only; sea stays open)
  setFrozen(level, seaFrozen) {
    this.frozen = level;
    const lm = level === 2 ? this.snowIceMat : level === 1 ? this.iceMat : this.lakeMat;
    for (const m of this.lakes.values()) m.material = lm;
    for (const m of this.rivers) m.material = lm;
    this.sea.material = seaFrozen ? lm : this.mat;
  }
}
