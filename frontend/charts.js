// Minimal dependency-free SVG charts drawn from numeric data.

// A responsive line chart. `values` is an array of numbers (nulls skipped).
export function svgLineChart(values, opts){
  opts = opts || {};
  const stroke = opts.stroke || '#157a4c';
  const height = opts.height || 120;
  const pts = (values || []).filter((v) => v != null && !isNaN(v));
  if (pts.length < 2){
    return '<div class="muted" style="font-size:12px;padding:8px 0">Not enough data to chart yet.</div>';
  }
  const w = 600, h = height, pad = 8;
  const max = Math.max.apply(null, pts);
  const min = Math.min.apply(null, pts);
  const span = (max - min) || 1;
  const step = w / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1);
    return x + ',' + y;
  }).join(' ');
  const last = coords.split(' ').pop().split(',');
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" ' +
         'style="width:100%;height:' + h + 'px;display:block">' +
         '<polyline points="' + coords + '" fill="none" stroke="' + stroke +
         '" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
         '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.5" fill="' + stroke + '"/>' +
         '</svg>';
}
