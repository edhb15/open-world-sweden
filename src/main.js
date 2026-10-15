/* Dev bootstrap (temporary): renders the world with a free camera. */
import * as THREE from 'three';
import { buildWorld } from './world/world.js';
import { Terrain } from './world/terrain.js';
import { ChunkManager } from './render/chunks.js';
import { Environment } from './render/env.js';
import { Water } from './render/water.js';
import { roadChunkJob } from './render/roadmesh.js';
import { setLandcoverExtras } from './render/landcover.js';
import { setMaxAnisotropy } from './render/textures.js';
import { envUniforms } from './render/terrainmesh.js';
import { buildingChunkJob, indexWorldContent, buildingEmissive } from './render/buildings.js';
import { vegetationChunkJob, indexParks } from './render/vegetation.js';

const params = new URLSearchParams(location.search);
const ldText = document.getElementById('ld-text');
const ldFill = document.getElementById('ld-fill');

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 12000);
  const world = await buildWorld((label) => { ldText.textContent = 'Bygger världen: ' + label; });
  setLandcoverExtras(world);
  const terrain = new Terrain(world.net);
  world.terrain = terrain;
  const env = new Environment(renderer, scene, { shadows: 1 });
  env.day = +(params.get('day') || 172); env.clock = +(params.get('t') || 14);
  const W = params.get('w');
  if (W === 'rain') Object.assign(env.weather, { cloud: 0.9, overcast: 0.9, rain: 0.8 });
  if (W === 'snow') { Object.assign(env.weather, { cloud: 0.9, overcast: 0.8, snow: 0.6 }); envUniforms.uSnow.value = 1; }
  if (params.get('snow')) envUniforms.uSnow.value = +params.get('snow');
  if (params.get('wet')) envUniforms.uWet.value = +params.get('wet');
  if (params.get('autumn')) envUniforms.uAutumn.value = +params.get('autumn');
  const water = new Water(scene);
  indexWorldContent(world); indexParks(world);
  const grp = (ch, st) => { ch.group.add(st.group); st.group.updateMatrixWorld(true); };
  const ungrp = (ch, st) => { ch.group.remove(st.group); st.group.traverse((o) => { if (o.geometry && !o.isInstancedMesh) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); }); };
  const layers = [
    { name: 'buildings', maxLod: 2, lodOf: (l) => (l === 0 ? 0 : 1), job: (ch, lod, res) => buildingChunkJob(world, ch.cx, ch.cz, lod, res), attach: grp, detach: ungrp },
    { name: 'trees', maxLod: 2, lodOf: (l) => Math.min(l, 2), job: (ch, lod, res) => vegetationChunkJob(world, ch.cx, ch.cz, lod, res), attach: grp, detach: ungrp },
    { name: 'roads', maxLod: 2, lodOf: (l) => (l <= 1 ? 1 : 0), job: (ch, lod, res) => roadChunkJob(world, ch.cx, ch.cz, lod, res),
      attach: (ch, st) => { ch.group.add(st.group); st.group.updateMatrixWorld(true); }, detach: (ch, st) => { ch.group.remove(st.group); st.group.traverse((o) => o.geometry && o.geometry.dispose()); } },
  ];
  const chunks = new ChunkManager({ scene, world, terrain, layers });
  if (params.get('range')) { const R = +params.get('range'); chunks.ranges = [R * 0.12, R * 0.26, R * 0.55, R]; }
  if (params.get('noshadow')) { renderer.shadowMap.enabled = false; env.shadowsEnabled = false; }
  // camera start
  const start = world.starts.find((s) => s.id === (params.get('start') || 'bromma')) || world.starts[0];
  let px, pz;
  if (params.get('x')) { px = +params.get('x'); pz = +params.get('z'); }
  else { const p = world.net.pointAt(start.road, start.s, 0); px = p[0]; pz = p[2]; }
  const camH = +(params.get('h') || 40);
  const yaw0 = +(params.get('yaw') || 0) * Math.PI / 180;
  const pitch0 = +(params.get('pitch') || -15) * Math.PI / 180;
  camera.position.set(px, terrain.height(px, pz) + camH, pz);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch0, yaw0, 0);
  ldText.textContent = 'Laddar terräng…';
  await chunks.preload(camera.position, +(params.get('preload') || 1200), (n) => { ldText.textContent = 'Laddar terräng… ' + n; });
  document.getElementById('loading').classList.add('hidden');
  // free fly controls
  const keys = {};
  addEventListener('keydown', (e) => keys[e.code] = true);
  addEventListener('keyup', (e) => keys[e.code] = false);
  renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
  addEventListener('mousemove', (e) => { if (document.pointerLockElement) { camera.rotation.y -= e.movementX * 0.002; camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x - e.movementY * 0.002)); } });
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  let last = performance.now();
  window.__game = { world, camera, chunks, env, terrain, renderer, scene };
  function frame() {
    const t = performance.now();
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    const sp = keys.ShiftLeft ? 300 : 40;
    const f = new THREE.Vector3(); camera.getWorldDirection(f);
    const r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
    if (keys.KeyW) camera.position.addScaledVector(f, sp * dt);
    if (keys.KeyS) camera.position.addScaledVector(f, -sp * dt);
    if (keys.KeyD) camera.position.addScaledVector(r, sp * dt);
    if (keys.KeyA) camera.position.addScaledVector(r, -sp * dt);
    env.update(dt, camera.position);
    water.update(camera.position, dt, env.time);
    chunks.update(camera.position);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  if (params.get('shot')) {
    // deterministic screenshot mode: a few frames, then stop
    for (let i = 0; i < 3; i++) { env.update(0.016, camera.position); water.update(camera.position, 0.016, env.time); chunks.update(camera.position); }
    env.refreshEnv();
    renderer.render(scene, camera);
    window.__shotReady = true;
    window.__renderOnce = () => { env.update(0.016, camera.position); chunks.update(camera.position); renderer.render(scene, camera); };
    return;
  }
  frame();
}
main().catch((e) => { console.error(e); ldText.textContent = 'Fel: ' + e.message; });
