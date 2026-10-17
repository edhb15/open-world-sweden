/* Persistent settings and save data (localStorage, failure tolerant). */
const KEY = 'ows.settings.v1';
const SAVE = 'ows.save.v1';

export const DEFAULT_SETTINGS = {
  lang: (typeof navigator !== 'undefined' && /^(sv|nb|nn|da)/i.test(navigator.language || '')) ? 'sv' : 'en',
  quality: 'auto', // low | medium | high | ultra | auto
  volume: 0.8, music: 0, engineVol: 1,
  traffic: 1.0, // density multiplier
  pedestrians: true,
  fines: true,
  trans: 'auto', // auto | manual (cars that support it)
  autoClutch: true, abs: true, tcs: true, esc: true,
  steerAssist: true,
  camera: 'cockpit', fov: 62, invertY: false, mouseSens: 1,
  units: 'metric',
  voice: true,
  keys: null,
  wheel: null,
  hud: true, minimap: true, speedLimitHint: true,
  showFps: false,
};

export const DEFAULT_SAVE = {
  money: 60000,
  car: { model: 'v7', color: null, plate: null, wheels: null, tires: 'summer', tune: 'stock', susp: 'comfort' },
  owned: ['v7', '245', 'kompis'],
  odo: 0,
  fines: [],
  home: 'bromma',
  fuel: {},
};

function load(key, def) {
  try {
    const s = localStorage.getItem(key);
    if (!s) return structuredClone(def);
    return { ...structuredClone(def), ...JSON.parse(s) };
  } catch { return structuredClone(def); }
}
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode etc. */ } }

export const settings = load(KEY, DEFAULT_SETTINGS);
export const save = load(SAVE, DEFAULT_SAVE);
export function saveSettings() { store(KEY, settings); }
export function saveGame() { store(SAVE, save); }
export function resetSave() { Object.assign(save, structuredClone(DEFAULT_SAVE)); saveGame(); }
