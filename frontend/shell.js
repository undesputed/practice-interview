// Renders the persistent shell (sidebar + content slot) and the sidebar nav.
import { currentTheme } from './theme.js';
import { t, currentLang } from './i18n.js';

function navDef(){
  return [
    { group: null, items: [
      { path: '/',         icon: '◷', labelKey: 'nav.dashboard' },
      { path: '/history',  icon: '▤', labelKey: 'nav.history' },
      { path: '/notes',    icon: '☰', labelKey: 'nav.notes' },
      { path: '/progress', icon: '◴', labelKey: 'nav.progress' },
      { path: '/practice-interview', icon: '＋', labelKey: 'nav.practice' },
    ]},
    { groupKey: 'nav.liveTools', items: [
      { path: '/facial',    icon: '◉', labelKey: 'nav.facial' },
      { path: '/audio',     icon: '♫', labelKey: 'nav.audio' },
      { path: '/quickdraw', icon: '✏', labelKey: 'nav.quickdraw' },
    ]},
  ];
}

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
  const html = ['<div class="brand">molave.ai</div>'];
  for (const sec of navDef()){
    if (sec.groupKey) html.push('<div class="nav-group">' + t(sec.groupKey) + '</div>');
    for (const it of sec.items){
      html.push(
        '<a class="nav-item ' + (isActive(it.path) ? 'on' : '') + '" href="#' + it.path + '">' +
          '<span class="nav-ic">' + it.icon + '</span>' + t(it.labelKey) +
        '</a>'
      );
    }
  }
  const dark = currentTheme() === 'dark';
  const lang = currentLang();
  html.push(
    '<div class="side-foot">' +
      '<div class="lang-toggle" role="group" aria-label="' + t('lang.label') + '">' +
        '<button type="button" data-lang-set="en" class="' + (lang === 'en' ? 'on' : '') + '">EN</button>' +
        '<button type="button" data-lang-set="ja" class="' + (lang === 'ja' ? 'on' : '') + '">日本語</button>' +
      '</div>' +
      '<button class="theme-toggle" data-theme-toggle type="button">' +
        '<span class="tt-ic">' + (dark ? '☀' : '☾') + '</span>' +
        '<span>' + t(dark ? 'theme.light' : 'theme.dark') + '</span>' +
      '</button>' +
    '</div>'
  );
  sidebar.innerHTML = html.join('');
}
