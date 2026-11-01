import { OrbRenderer } from '../../../core-ui/src/orb-rendering/renderer';
import { orbPalettes } from '../../../core-ui/src/orb-rendering/palettes';

const canvas = document.querySelector<HTMLCanvasElement>('#permission-orb, #startup-orb');
if (canvas) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new OrbRenderer(canvas, { finish: 'vessel', field: 'dark', colors: orbPalettes.spectrum.dark, state: 'idle', grain: 0.05, seed: 0, speed: 0.3, still: reduced.matches }, { getOutputLevel: () => 0.4 });
  const sync = () => { renderer.update({ still: reduced.matches }); if (reduced.matches) { renderer.stop(); renderer.renderStill(); } else if (document.hidden) renderer.stop(); else renderer.start(); };
  if (renderer.supported) {
    sync();
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    window.addEventListener('pagehide', () => { document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync); renderer.destroy(); }, { once: true });
  } else canvas.hidden = true;
}
