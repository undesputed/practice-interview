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
};
