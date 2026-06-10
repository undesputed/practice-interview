// Renders the persistent shell (sidebar + content slot) and the sidebar nav.
import { currentTheme } from './theme.js';
const NAV = [
  { group: null, items: [
    { path: '/',         icon: '◷', label: 'Dashboard' },
    { path: '/history',  icon: '▤', label: 'History' },
    { path: '/progress', icon: '◴', label: 'Progress' },
    { path: '/new',      icon: '＋', label: 'New interview' },
  ]},
  { group: 'Live tools', items: [
    { path: '/facial', icon: '◉', label: 'Facial Analysis' },
    { path: '/audio',  icon: '♫', label: 'Audio Analysis' },
  ]},
  { group: null, items: [
    { path: '/settings', icon: '⚙', label: 'Settings' },
    { path: '/library',  icon: '▥', label: 'Role & question library' },
  ]},
];

export function mountShell(root){
  root.innerHTML =
    '<div class="app-shell">' +
      '<aside class="sidebar" id="sidebar"></aside>' +
      '<main class="content" id="content"></main>' +
    '</div>';
  return {
    sidebar: root.querySelector('#sidebar'),
    content: root.querySelector('#content'),
  };
}

export function renderSidebar(sidebar, activePath){
  // Match on a path boundary, not a raw string prefix, so '/lib' never lights up
  // for '/library' (and vice versa) once prefix-overlapping routes exist.
  const isActive = (p) => p === '/'
    ? activePath === '/'
    : (activePath === p || activePath.startsWith(p + '/'));
  const html = ['<div class="brand">Rehearsal</div>'];
  for (const sec of NAV){
    if (sec.group) html.push('<div class="nav-group">' + sec.group + '</div>');
    for (const it of sec.items){
      html.push(
        '<a class="nav-item ' + (isActive(it.path) ? 'on' : '') + '" href="#' + it.path + '">' +
          '<span class="nav-ic">' + it.icon + '</span>' + it.label +
        '</a>'
      );
    }
  }
  const dark = currentTheme() === 'dark';
  html.push(
    '<div class="side-foot">' +
      '<button class="theme-toggle" data-theme-toggle type="button">' +
        '<span class="tt-ic">' + (dark ? '☾' : '☀') + '</span>' +
        '<span>' + (dark ? 'Dark' : 'Light') + ' mode</span>' +
      '</button>' +
    '</div>'
  );
  sidebar.innerHTML = html.join('');
}
