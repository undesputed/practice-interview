// frontend/fx/particles.js
// Pure particle model for the reaction-effects engine. No canvas — unit-tested.
// Units: positions in px, velocities px/s, accelerations px/s^2, life in ms.
export function createParticle({ x, y, vx = 0, vy = 0, ax = 0, ay = 0, life,
                                 size = 4, color = '#ffffff', rot = 0, vr = 0, data = null }) {
  return { x, y, vx, vy, ax, ay, age: 0, life, size, color, rot, vr, data };
}

export function stepParticle(p, dt) {
  const s = dt / 1000;
  p.vx += p.ax * s; p.vy += p.ay * s;
  p.x += p.vx * s; p.y += p.vy * s;
  p.rot += p.vr * s;
  p.age += dt;
  return p.age < p.life;
}

export function lifeProgress(p) {
  return Math.max(0, Math.min(1, p.age / p.life));
}
