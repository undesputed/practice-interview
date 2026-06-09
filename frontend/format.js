// Small formatting helpers shared across screens.

export function fmtDate(iso){
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDuration(sec){
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? (m + 'm ' + s + 's') : (s + 's');
}

// Returns 'good' | 'mid' | 'low' for color-coding. Nervousness is inverted
// (low is good); the other three score higher-is-better.
export function scoreClass(key, v){
  if (v == null) return '';
  if (key === 'nervousness') return v <= 40 ? 'good' : (v <= 60 ? 'mid' : 'low');
  return v >= 70 ? 'good' : (v >= 50 ? 'mid' : 'low');
}

export function round(v, dp){
  if (v == null || isNaN(v)) return '—';
  const f = Math.pow(10, dp || 0);
  return Math.round(v * f) / f;
}
