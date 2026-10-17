/* Entry point. */
import { buildWorld } from './world/world.js';
import { Game } from './game.js';
import { save } from './core/settings.js';
import { App } from './ui/app.js';

const params = new URLSearchParams(location.search);
const ldText = document.getElementById('ld-text');
const ldFill = document.getElementById('ld-fill');

async function main() {
  if (!window.WebGL2RenderingContext) {
    ldText.textContent = 'Din webbläsare saknar WebGL 2 / Your browser does not support WebGL 2.';
    return;
  }
  const steps = ['geo', 'cities', 'routes', 'side roads', 'villages', 'index', 'crossings', 'elevation', 'junctions', 'lanes', 'lots'];
  const world = await buildWorld((label) => {
    const i = steps.indexOf(label);
    ldFill.style.width = Math.round(((i + 1) / steps.length) * 60) + '%';
  });
  const game = new Game(world, { params });
  window.__game = game;
  const app = new App(game, params);
  await app.boot((frac, text) => { ldFill.style.width = Math.round(60 + frac * 40) + '%'; if (text) ldText.textContent = text; });
}
main().catch((e) => { console.error(e); ldText.textContent = 'Fel / Error: ' + e.message; });
