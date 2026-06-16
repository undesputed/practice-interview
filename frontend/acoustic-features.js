// frontend/acoustic-features.js
// In-browser pitch + energy features for a recorded interview, ported from
// molave-ai's acousticFeatures.ts. Decodes the audio, runs autocorrelation pitch
// tracking + RMS energy per frame, and aggregates over the whole recording.
// Used to feed the Delivery score (pitch variation = expressiveness; energy = loudness).

const MIN_F0_HZ = 70;
const MAX_F0_HZ = 400;
const VOICING_THRESHOLD = 0.45;   // autocorr peak strength vs energy to count as voiced
const ENERGY_FLOOR = 1e-4;        // skip pitch in near-silence
const MAX_FRAMES = 24000;         // bound work on long recordings

function decimateTo8k(samples, sampleRate){
  const factor = Math.max(1, Math.round(sampleRate / 8000));
  if (factor === 1) return { samples, sampleRate };
  const length = Math.floor(samples.length / factor);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1){
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += samples[index * factor + k];
    out[index] = sum / factor;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

function computeFrames(rawSamples, rawRate){
  const { samples, sampleRate } = decimateTo8k(rawSamples, rawRate);
  const window = Math.round(0.04 * sampleRate);
  let hop = Math.round(0.02 * sampleRate);
  const estimatedFrames = Math.floor((samples.length - window) / hop);
  if (estimatedFrames > MAX_FRAMES) hop = Math.ceil((samples.length - window) / MAX_FRAMES);

  const minLag = Math.floor(sampleRate / MAX_F0_HZ);
  const maxLag = Math.floor(sampleRate / MIN_F0_HZ);
  const f0 = [];
  const rms = [];

  for (let start = 0; start + window <= samples.length; start += hop){
    let energy = 0;
    for (let i = 0; i < window; i += 1){ const v = samples[start + i]; energy += v * v; }
    const frameRms = Math.sqrt(energy / window);
    rms.push(frameRms);
    if (frameRms < ENERGY_FLOOR){ f0.push(0); continue; }

    let bestLag = 0, bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1){
      let corr = 0;
      const limit = window - lag;
      for (let i = 0; i < limit; i += 1) corr += samples[start + i] * samples[start + i + lag];
      if (corr > bestCorr){ bestCorr = corr; bestLag = lag; }
    }
    const ratio = energy > 0 ? bestCorr / energy : 0;
    f0.push(bestLag > 0 && ratio > VOICING_THRESHOLD ? sampleRate / bestLag : 0);
  }
  return { f0, rms };
}

function mean(values){ return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function std(values, avg){
  if (!values.length) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
function median(values){
  const c = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!c.length) return 0;
  const mid = Math.floor(c.length / 2);
  return c.length % 2 === 0 ? (c[mid - 1] + c[mid]) / 2 : c[mid];
}
function trimOctaveOutliers(values){
  if (values.length < 4) return values;
  const center = median(values);
  if (center <= 0) return values;
  const kept = values.filter((v) => v >= center * 0.6 && v <= center * 1.8);
  return kept.length >= 2 ? kept : values;
}

// Decode an audio Blob and return whole-recording acoustic features. Never throws:
// returns null when the audio can't be decoded so the caller can degrade.
export async function computeAcousticFeatures(blob){
  try {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    ctx.close();
    const samples = audio.getChannelData(0);
    const { f0, rms } = computeFrames(samples, audio.sampleRate);
    const pitches = trimOctaveOutliers(f0.filter((v) => v > 0));
    const voiced = f0.filter((v) => v > 0).length;
    const pitchMean = mean(pitches);
    const energyMean = mean(rms);
    return {
      pitchMeanHz: Math.round(pitchMean * 10) / 10,
      pitchStdHz: Math.round(std(pitches, pitchMean) * 10) / 10,
      energyMean: Math.round(energyMean * 10000) / 10000,
      energyStd: Math.round(std(rms, energyMean) * 10000) / 10000,
      voicedRatio: f0.length ? Math.round((voiced / f0.length) * 100) / 100 : 0,
    };
  } catch (e){
    console.warn('[voice] acoustic feature extraction failed:', e && e.message);
    return null;
  }
}
