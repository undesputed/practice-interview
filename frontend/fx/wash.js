// frontend/fx/wash.js
// Full-frame background wash: an edge vignette tinted by the active emotion (eased in/out)
// plus brief colored pulses on gesture/combo onsets. Pure maps + easing; draw() paints a 2D
// context. Unit-tested for the maps + easing (the visual look is verified on camera).
export const EMOTION_WASH = {
  angry: '#ff3b30', happy: '#ffcf40', sad: '#3b6dff', surprise: '#ffffff',
  disgust: '#6fd23a', fear: '#8a5cff', confused: '#ffb84d',
};
const WASH_BASE = 0.38;
const WASH_EASE_MS = 250;
const PULSE_PEAK = 0.3;
const PULSE_LIFE_MS = 500;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function createWash() {
  let targetColor = null; // hex string, or null
  let intensity = 0;      // 0..1, eased toward the target
  const pulses = [];      // { rgb:[r,g,b], age }

  function vignette(ctx, w, h, rgb, alpha) {
    const cx = w / 2, cy = h / 2, R = Math.max(w, h);
    const grad = ctx.createRadialGradient(cx, cy, R * 0.35, cx, cy, R * 0.78);
    grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  }

  return {
    setEmotion(emotion) { targetColor = emotion ? (EMOTION_WASH[emotion] || null) : null; },
    pulse(hex) { if (hex) pulses.push({ rgb: hexToRgb(hex), age: 0 }); },
    update(dt) {
      const target = targetColor ? WASH_BASE : 0;
      intensity += (target - intensity) * Math.min(1, dt / WASH_EASE_MS);
      for (let i = pulses.length - 1; i >= 0; i--) { pulses[i].age += dt; if (pulses[i].age >= PULSE_LIFE_MS) pulses.splice(i, 1); }
    },
    draw(ctx, w, h) {
      if (targetColor && intensity > 0.01) vignette(ctx, w, h, hexToRgb(targetColor), intensity);
      for (const p of pulses) vignette(ctx, w, h, p.rgb, PULSE_PEAK * (1 - p.age / PULSE_LIFE_MS));
    },
    intensity() { return intensity; },
    pulseCount() { return pulses.length; },
    clear() { targetColor = null; intensity = 0; pulses.length = 0; },
  };
}
