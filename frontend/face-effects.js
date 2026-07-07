// frontend/face-effects.js
// Floating-emoji reaction overlay for the Face Analysis page. Composes the pure
// reaction-trigger and renders each returned emoji as a short burst of DOM spans
// animated by CSS. No network, no scoring — purely cosmetic.
import { createReactionTrigger } from './reaction-trigger.js';

const PARTICLES = 6;
const MAX_ACTIVE = 24;

export function createFaceEffects(container) {
  const trigger = createReactionTrigger();
  let enabled = false;
  let active = 0;
  const reduceMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clear() {
    container.innerHTML = '';
    active = 0;
  }

  function burst(emoji) {
    const count = reduceMotion ? 2 : PARTICLES;
    for (let i = 0; i < count; i++) {
      if (active >= MAX_ACTIVE) break;
      const el = document.createElement('span');
      el.className = 'fx-emoji' + (reduceMotion ? ' reduced' : '');
      el.textContent = emoji;
      el.style.left = (40 + Math.random() * 20).toFixed(1) + '%';           // start near center
      el.style.setProperty('--x', (Math.random() * 60 - 30).toFixed(0) + 'px');
      el.style.setProperty('--dx', (Math.random() * 80 - 40).toFixed(0) + 'px'); // drift
      el.style.setProperty('--rot', (Math.random() * 40 - 20).toFixed(0) + 'deg');
      el.style.setProperty('--scale', (0.8 + Math.random() * 0.6).toFixed(2));
      active += 1;
      el.addEventListener('animationend', () => { el.remove(); active -= 1; }, { once: true });
      container.appendChild(el);
    }
  }

  return {
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) clear();
    },
    feed(sample) {
      if (!enabled) return;
      for (const emoji of trigger.feed(sample)) burst(emoji);
    },
    clear,
    destroy() { clear(); },
  };
}
