/* =====================================================================
   Instanced rendering of AI vehicles. One set of InstancedMeshes per
   model: body (instance colour = paint), dark parts, wheels, lights
   (per-instance light state packed into a vec4 instance attribute).
   ===================================================================== */
import * as THREE from 'three';
import { instancedParts } from '../vehicle/carmesh.js';
import { envUniforms } from '../render/terrainmesh.js';

const CAP = 48;

function lightMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, emissive: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLight;\nattribute vec4 aState;\nattribute vec2 aState2;\nvarying vec3 vEm;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  // aState: x head (0/1/2 high), y brake, z indL, w indR ; aState2: x reverse, y night
  vec3 em = vec3(0.0);
  float L = aLight;
  if (L < 0.5) em = vec3(1.0, 0.96, 0.85) * (aState.x > 0.5 ? (aState.x > 1.5 ? 6.0 : 3.5) : 0.6);
  else if (L < 1.5) em = vec3(1.0, 0.05, 0.03) * (aState.x > 0.5 ? 1.8 : 0.5);
  else if (L < 2.5) em = vec3(1.0, 0.05, 0.03) * (aState.y > 0.5 ? 6.0 : 0.0);
  else if (L < 3.5) em = vec3(1.0, 0.55, 0.0) * (aState.z > 0.5 ? 7.0 : 0.0);
  else if (L < 4.5) em = vec3(1.0, 0.55, 0.0) * (aState.w > 0.5 ? 7.0 : 0.0);
  else em = vec3(1.0) * (aState2.x > 0.5 ? 4.0 : 0.0);
  vEm = em;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEm;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vEm;');
  };
  return m;
}
const MAT = {};
function mats() {
  if (MAT.body) return MAT;
  MAT.body = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  MAT.body.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = envUniforms.uSnow;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vUpN;').replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvUpN = normal.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSnow;\nvarying float vUpN;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92), uSnow * 0.85 * smoothstep(0.7, 0.95, vUpN));');
  };
  MAT.dark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.3 });
  MAT.wheel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3 });
  MAT.light = lightMaterial();
  return MAT;
}

class ModelSet {
  constructor(scene, spec, parts, cap = CAP) {
    mats();
    const CAP_ = cap;
    this.cap = cap;
    this.spec = spec;
    this.parts = parts || instancedParts(spec);
    const P = this.parts;
    this.body = new THREE.InstancedMesh(P.body, MAT.body, CAP_);
    this.dark = new THREE.InstancedMesh(P.dark, MAT.dark, CAP_);
    this.wheel = new THREE.InstancedMesh(P.wheel, MAT.wheel, CAP_ * 4);
    const lg = P.lights.clone();
    this.stateAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAP_ * 4), 4);
    this.stateAttr2 = new THREE.InstancedBufferAttribute(new Float32Array(CAP_ * 2), 2);
    lg.setAttribute('aState', this.stateAttr);
    lg.setAttribute('aState2', this.stateAttr2);
    this.light = new THREE.InstancedMesh(lg, MAT.light, CAP_);
    for (const m of [this.body, this.dark, this.wheel, this.light]) {
      m.count = 0; m.frustumCulled = false; m.castShadow = m !== this.light; m.receiveShadow = m === this.body;
      scene.add(m);
    }
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_ * 3), 3);
    this.slots = new Array(CAP_).fill(null);
    this.used = 0;
  }
  alloc(car) {
    const i = this.slots.indexOf(null);
    if (i < 0) return -1;
    this.slots[i] = car;
    return i;
  }
  free(i) { this.slots[i] = null; }
}

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(1, 1, 1), _E = new THREE.Euler(), _Wq = new THREE.Quaternion(), _Wm = new THREE.Matrix4(), _C = new THREE.Color();

export class Fleet {
  constructor(scene, cap = CAP) {
    this.scene = scene;
    this.cap = cap;
    this.sets = new Map();
  }
  set(spec, parts) {
    let s = this.sets.get(spec.id);
    if (!s) { s = new ModelSet(this.scene, spec, parts, this.cap); this.sets.set(spec.id, s); }
    return s;
  }
  add(car) {
    const s = this.set(car.spec, car.parts);
    const slot = s.alloc(car);
    if (slot < 0) return false;
    car.set = s; car.slot = slot;
    _C.set(car.color);
    s.body.instanceColor.setXYZ(slot, _C.r, _C.g, _C.b);
    s.body.instanceColor.needsUpdate = true;
    return true;
  }
  remove(car) { if (car.set) { car.set.free(car.slot); car.set = null; } }
  // write all instance data; cars must have x,y,z,yaw,pitch,roll,wheelAngle,steer,lights
  commit(cars) {
    for (const s of this.sets.values()) s.n = 0;
    // compact: write each set's cars in slot order
    for (const s of this.sets.values()) {
      let k = 0;
      for (let i = 0; i < s.cap; i++) {
        const c = s.slots[i];
        if (!c) continue;
        _E.set(c.pitch || 0, c.yaw, c.roll || 0, 'YXZ');
        _Q.setFromEuler(_E);
        _M.compose(_P.set(c.x, c.y, c.z), _Q, _S);
        s.body.setMatrixAt(k, _M); s.dark.setMatrixAt(k, _M); s.light.setMatrixAt(k, _M);
        _C.set(c.color); s.body.instanceColor.setXYZ(k, _C.r, _C.g, _C.b);
        // wheels
        const wp = s.parts.wheelPos;
        for (let w = 0; w < 4; w++) {
          const [wx, wz, left] = wp[w];
          const front = w < 2;
          _Wq.setFromEuler(_E.set(left ? c.wheelAngle : -c.wheelAngle, (front ? -(c.steer || 0) : 0) + (left ? Math.PI : 0), 0, 'YXZ'));
          _Wm.compose(_P.set(wx, s.spec.tire.r - s.spec.cgH, wz), _Wq, _S);
          _Wm.premultiply(_M);
          s.wheel.setMatrixAt(k * 4 + w, _Wm);
        }
        const L = c.lights;
        s.stateAttr.setXYZW(k, L.head, L.brake ? 1 : 0, L.indL ? 1 : 0, L.indR ? 1 : 0);
        s.stateAttr2.setXY(k, L.rev ? 1 : 0, 0);
        k++;
      }
      s.body.count = s.dark.count = s.light.count = k;
      s.wheel.count = k * 4;
      for (const m of [s.body, s.dark, s.wheel, s.light]) m.instanceMatrix.needsUpdate = true;
      s.stateAttr.needsUpdate = true; s.stateAttr2.needsUpdate = true; s.body.instanceColor.needsUpdate = true;
    }
  }
}
