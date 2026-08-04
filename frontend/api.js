// Thin fetch wrappers for the backend. Endpoints land in Phase 2; defined now
// so screen modules can import a stable surface.
async function request(method, url, body){
  const opts = { method, headers: {} };
  if (body !== undefined){
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status);
  return res.status === 204 ? null : res.json();
}

const _SC_KEY = 'molave_sessions_cache';
const _SC_TTL = 60_000;
function _scRead(){ try { const r = sessionStorage.getItem(_SC_KEY); if (!r) return null; const { ts, data } = JSON.parse(r); if (Date.now() - ts < _SC_TTL) return data; } catch(_){} return null; }
function _scWrite(data){ try { sessionStorage.setItem(_SC_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(_){} }
function _scClear(){ try { sessionStorage.removeItem(_SC_KEY); } catch(_){} }

export const api = {
  listSessions: async () => {
    const cached = _scRead();
    if (cached) return { sessions: cached };
    const data = await request('GET', '/api/sessions');
    _scWrite(data.sessions || []);
    return data;
  },
  invalidateSessionsCache: _scClear,
  updateSessionsCache: _scWrite,
  getSession:     (id)      => request('GET',    '/api/sessions/' + encodeURIComponent(id)),
  deleteSession:  (id)      => request('DELETE', '/api/sessions/' + encodeURIComponent(id)),
  renameSession:  (id, lbl) => request('PATCH',  '/api/sessions/' + encodeURIComponent(id), { label: lbl }),
  getSettings:    ()        => request('GET',    '/api/settings'),
  putSettings:    (s)       => request('PUT',    '/api/settings', s),
  getRoles:       ()        => request('GET',    '/api/roles'),
  putRoles:       (r)       => request('PUT',    '/api/roles', r),
  // Mint a Deepgram voice-agent token + config for the interview settings.
  interviewToken: (s)       => request('POST',   '/api/interview/token', s),
  // POST a finished interview (frames + transcript + events) and get back the
  // session id + scored summary. Phase 1 is JSON; audio is added in a later plan.
  createSession: (payload) => request('POST', '/api/session', payload),
  // Translate saved LLM feedback into another language (cached on the session).
  localizeSession: (id, language) =>
    request('POST', '/api/sessions/' + encodeURIComponent(id) + '/localize', { language }),
  // Generate a tailored question set for the Practice Interview page. Never throws;
  // resolves to {questions:[]} when the server can't generate.
  generateQuestions: (s) => request('POST', '/api/questions', s).catch(() => ({ questions: [] })),
  // POST the recorded audio + browser acoustic features for Delivery scoring.
  // Never throws: resolves to {available:false} when the server can't score it.
  analyzeVoice: (blob, acoustic) => {
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ acoustic }));
    fd.append('audio', blob, 'interview' + (blob.type.includes('mp4') ? '.mp4' : '.webm'));
    return fetch('/api/voice', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .catch(() => ({ available: false }));
  },
  // POST a single face-crop blob to the live DeepFace endpoint. Never throws;
  // resolves to {available:false} when the server can't score it.
  scoreEmotionFrame: (blob) => {
    const fd = new FormData();
    fd.append('image', blob, 'crop.jpg');
    return fetch('/api/emotion/frame', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .catch(() => ({ available: false }));
  },
};
