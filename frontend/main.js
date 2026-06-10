import { mountShell, renderSidebar } from './shell.js';
import * as router from './router.js';
import { screens } from './screens/registry.js';
import { initTheme, toggleTheme } from './theme.js';

initTheme();

const root = document.getElementById('app');
const { sidebar, content } = mountShell(root);

sidebar.addEventListener('click', (e) => {
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
  show('<div class="screen"><div class="screen-head"><h1>Not found</h1></div>' +
       '<p class="muted">No screen for this route.</p></div>')
);

router.start();
