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

export const api = {
  listSessions:   ()        => request('GET',    '/api/sessions'),
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
