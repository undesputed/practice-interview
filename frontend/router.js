// Minimal hash router. Patterns like '/session/:id' capture params.
const routes = [];
let notFoundHandler = () => {};

export function register(pattern, handler){ routes.push({ pattern, handler }); }
export function setNotFound(fn){ notFoundHandler = fn; }

export function currentPath(){
  const raw = (location.hash || '#/').replace(/^#/, '');
  return raw === '' ? '/' : raw;
}

function matchPattern(pattern, path){
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++){
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

function resolve(){
  const path = currentPath();
  for (const { pattern, handler } of routes){
    const params = matchPattern(pattern, path);
    if (params){ handler(params, path); return; }
  }
  notFoundHandler(path);
}

export function navigate(path){ location.hash = '#' + path; }

export function start(){
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = '#/';
  else resolve();
}
