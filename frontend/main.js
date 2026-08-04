import { mountShell, renderSidebar } from './shell.js';
import * as router from './router.js';
import { screens } from './screens/registry.js';
import { initTheme, toggleTheme } from './theme.js';
import { initLang, setLang, onLangChange, t } from './i18n.js';

initTheme();
initLang();

const root = document.getElementById('app');
const { sidebar, content } = mountShell(root);

sidebar.addEventListener('click', (e) => {
  const langBtn = e.target.closest('[data-lang-set]');
  if (langBtn){
    e.preventDefault();
    setLang(langBtn.getAttribute('data-lang-set'));
    return;
  }
  const btn = e.target.closest('[data-theme-toggle]');
  if (!btn) return;
  e.preventDefault();
  toggleTheme();
  renderSidebar(sidebar, router.currentPath());
});

function show(html){
  content.innerHTML = html;
  renderSidebar(sidebar, router.currentPath());
  content.scrollTop = 0;
}

for (const [pattern, render] of screens){
  router.register(pattern, (params) => show(render(params)));
}
router.setNotFound(() =>
  show('<div class="screen"><div class="screen-head"><h1>' + t('common.notFound') + '</h1></div>' +
       '<p class="muted">' + t('common.noScreen') + '</p></div>')
);

// Re-render the current route when UI language changes so all chrome updates.
onLangChange(() => router.refresh());

router.start();
