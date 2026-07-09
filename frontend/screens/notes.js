// frontend/screens/notes.js — Open-book spread viewer

const byId = (id) => document.getElementById(id);
const esc  = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Module-level state that survives SPA navigation
let _cache         = null;   // last-fetched notebook data
let _currentSpread = 0;      // which open spread is showing (0-indexed)
const FREE_SPREADS = 5;      // spreads 0-4 = pages 1-10 (free); spread 5 = locked

/** Called by live.js after saving so /notes renders instantly. */
export function setNotesCache(nb) { _cache = nb; }

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ── Page rendering ────────────────────────────────────────────────────────────

function pageNotes(pg, idx, totalNotes) {
  if (!pg || !pg.length) {
    return '<div class="nb-pg-empty">' +
      (idx === 0 && totalNotes === 0
        ? 'Hold an open palm during an interview to open this notebook and take notes.'
        : 'Empty page') +
      '</div>';
  }
  return pg.map(n =>
    '<div class="nb-note">' +
      (n.ts ? '<span class="nb-note-ts">' + esc(n.ts) + '</span>' : '') +
      esc(n.text) +
    '</div>'
  ).join('');
}

function openPage(pg, idx, side, totalNotes) {
  const empty = !pg || !pg.length;
  return (
    '<div class="nb-page nb-pg-' + side + (empty ? ' nb-pg-bare' : '') + '">' +
      '<div class="nb-pg-hdr">' +
        (side === 'left'
          ? '<span class="nb-pg-num">' + (idx + 1) + '</span><span class="nb-pg-ttl">Notes</span>'
          : '<span class="nb-pg-ttl">Notes</span><span class="nb-pg-num">' + (idx + 1) + '</span>'
        ) +
      '</div>' +
      '<div class="nb-pg-body">' + pageNotes(pg, idx, totalNotes) + '</div>' +
    '</div>'
  );
}

function lockedPage(pageNum, side) {
  return (
    '<div class="nb-page nb-pg-' + side + ' nb-pg-locked">' +
      '<div class="nb-pg-hdr">' +
        (side === 'left'
          ? '<span class="nb-pg-num">' + pageNum + '</span><span class="nb-pg-ttl">Notes</span>'
          : '<span class="nb-pg-ttl">Notes</span><span class="nb-pg-num">' + pageNum + '</span>'
        ) +
      '</div>' +
      '<div class="nb-pg-lock">' +
        '<div class="nb-lock-ring">🔒</div>' +
        (side === 'left' ? '<div class="nb-lock-msg">Upgrade to unlock<br>more pages</div>' : '') +
      '</div>' +
    '</div>'
  );
}

// ── Spread builder ────────────────────────────────────────────────────────────

function spreadHtml(pages, spread, totalNotes) {
  if (spread >= FREE_SPREADS) {
    // Locked spread preview
    return lockedPage(spread * 2 + 1, 'left') +
           '<div class="nb-spine"></div>' +
           lockedPage(spread * 2 + 2, 'right');
  }
  const li = spread * 2, ri = spread * 2 + 1;
  return openPage(pages[li] || [], li, 'left', totalNotes) +
         '<div class="nb-spine"></div>' +
         openPage(pages[ri] || [], ri, 'right', totalNotes);
}

// ── Dot bar ───────────────────────────────────────────────────────────────────

function dotsHtml(current) {
  const dots = [];
  for (let s = 0; s < FREE_SPREADS; s++) {
    dots.push(
      '<button class="nb-dot' + (s === current ? ' nb-dot-on' : '') +
      '" data-spread="' + s + '" aria-label="Spread ' + (s + 1) + '"></button>'
    );
  }
  // Locked dot
  dots.push(
    '<button class="nb-dot nb-dot-lock' + (current >= FREE_SPREADS ? ' nb-dot-on' : '') +
    '" data-spread="' + FREE_SPREADS + '" aria-label="Upgrade for more pages" title="Upgrade for more pages">+</button>'
  );
  return dots.join('');
}

// ── Full page HTML ────────────────────────────────────────────────────────────

function buildHtml(nb) {
  const pages      = nb.pages || Array.from({ length: 10 }, () => []);
  const totalNotes = pages.reduce((n, p) => n + (p ? p.length : 0), 0);
  const usedPages  = pages.filter(p => p && p.length).length;
  const lastSaved  = nb.updated_at ? fmtDate(nb.updated_at) : null;
  const title      = nb.title || 'My Notebook';
  const fillPct    = Math.round(usedPages / 10 * 100);
  const spread     = Math.min(_currentSpread, FREE_SPREADS);

  return (
    // ── Book cover header ────────────────────────────────────────────────────
    '<div class="nb-cover">' +
      '<div class="nb-cover-spine"></div>' +
      '<div class="nb-cover-body">' +
        '<div class="nb-cover-top">' +
          '<div>' +
            '<div class="nb-cover-label">My Notebook</div>' +
            '<div class="nb-cover-title">' + esc(title) + '</div>' +
          '</div>' +
          '<div class="nb-cover-right">' +
            '<div class="nb-fill-wrap">' +
              '<div class="nb-fill-bar"><div class="nb-fill-inner" style="width:' + fillPct + '%"></div></div>' +
              '<div class="nb-fill-lbl">' + usedPages + ' / 10 pages</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="nb-cover-meta">' +
          totalNotes + ' note' + (totalNotes !== 1 ? 's' : '') +
          (lastSaved ? ' &nbsp;·&nbsp; last saved ' + esc(lastSaved) : '') +
        '</div>' +
      '</div>' +
    '</div>' +

    // ── Open book spread ─────────────────────────────────────────────────────
    '<div class="nb-reader">' +
      '<button class="nb-nav nb-nav-prev" id="nb-prev" aria-label="Previous spread"' +
        (spread === 0 ? ' disabled' : '') + '>‹</button>' +

      '<div class="nb-open-book" id="nb-spread">' +
        spreadHtml(pages, spread, totalNotes) +
      '</div>' +

      '<button class="nb-nav nb-nav-next" id="nb-next" aria-label="Next spread"' +
        (spread >= FREE_SPREADS ? ' disabled' : '') + '>›</button>' +
    '</div>' +

    // ── Dot navigator ────────────────────────────────────────────────────────
    '<div class="nb-dots" id="nb-dots">' + dotsHtml(spread) + '</div>' +

    // ── Upgrade card ─────────────────────────────────────────────────────────
    '<div class="nb-upgrade-card" id="nb-upgrade-card">' +
      '<div class="nb-uc-left">' +
        '<div class="nb-uc-eyebrow">molave.ai Pro</div>' +
        '<div class="nb-uc-title">More pages, more insight.</div>' +
        '<ul class="nb-uc-list">' +
          '<li>50 notebook pages</li>' +
          '<li>AI-generated session summaries</li>' +
          '<li>Export notes to PDF</li>' +
          '<li>Priority support</li>' +
        '</ul>' +
      '</div>' +
      '<div class="nb-uc-right">' +
        '<div class="nb-uc-badge">Coming soon</div>' +
        '<button class="nb-uc-btn" disabled>Get Pro</button>' +
        '<button class="nb-notify-btn" id="nb-notify-btn" type="button">Notify me when ready</button>' +
      '</div>' +
    '</div>'
  );
}

// ── Navigation wiring ─────────────────────────────────────────────────────────

function goToSpread(n, pages, totalNotes) {
  const target  = Math.max(0, Math.min(n, FREE_SPREADS));
  _currentSpread = target;

  const spreadEl = byId('nb-spread');
  const dotsEl   = byId('nb-dots');
  const prevBtn  = byId('nb-prev');
  const nextBtn  = byId('nb-next');
  const upgradeEl = byId('nb-upgrade-card');

  if (spreadEl) {
    spreadEl.classList.add('nb-spread-fade');
    setTimeout(() => {
      spreadEl.innerHTML = spreadHtml(pages, target, totalNotes);
      spreadEl.classList.remove('nb-spread-fade');
    }, 150);
  }

  if (dotsEl) dotsEl.innerHTML = dotsHtml(target);

  if (prevBtn) prevBtn.disabled = (target === 0);
  if (nextBtn) nextBtn.disabled = (target >= FREE_SPREADS);

  // Highlight upgrade card when on locked spread
  if (upgradeEl) {
    if (target >= FREE_SPREADS) {
      upgradeEl.classList.add('nb-upgrade-highlight');
      upgradeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      upgradeEl.classList.remove('nb-upgrade-highlight');
    }
  }

  // Re-wire dot clicks after re-render
  wireNav(pages, totalNotes);
}

function wireNav(pages, totalNotes) {
  const prev = byId('nb-prev');
  const next = byId('nb-next');

  if (prev) {
    prev.onclick = () => goToSpread(_currentSpread - 1, pages, totalNotes);
  }
  if (next) {
    next.onclick = () => goToSpread(_currentSpread + 1, pages, totalNotes);
  }

  // Dot clicks — re-wire each time dots are re-rendered
  document.querySelectorAll('.nb-dot').forEach(dot => {
    dot.onclick = () => goToSpread(Number(dot.dataset.spread), pages, totalNotes);
  });

  const notifyBtn = byId('nb-notify-btn');
  if (notifyBtn && !notifyBtn._wired) {
    notifyBtn._wired = true;
    notifyBtn.addEventListener('click', () => {
      notifyBtn.textContent = "You're on the list ✓";
      notifyBtn.disabled = true;
      notifyBtn.classList.add('nb-notify-done');
    });
  }
}

// ── Main render ───────────────────────────────────────────────────────────────

async function renderMaster(container) {
  if (_cache) {
    container.innerHTML = buildHtml(_cache);
    const pages = _cache.pages || [];
    const total = pages.reduce((n, p) => n + (p ? p.length : 0), 0);
    wireNav(pages, total);

    // Silent background refresh
    fetch('/api/notes/master')
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh || !container.isConnected) return;
        _cache = fresh;
        container.innerHTML = buildHtml(fresh);
        const pg = fresh.pages || [];
        wireNav(pg, pg.reduce((n, p) => n + (p ? p.length : 0), 0));
      })
      .catch(() => {});
    return;
  }

  container.innerHTML = '<p class="nt-loading">Loading notebook…</p>';
  try {
    const res = await fetch('/api/notes/master');
    const nb  = res.ok ? await res.json() : null;
    if (!nb) throw new Error('empty');
    _cache = nb;
    container.innerHTML = buildHtml(nb);
    const pages = nb.pages || [];
    wireNav(pages, pages.reduce((n, p) => n + (p ? p.length : 0), 0));
  } catch (_) {
    container.innerHTML =
      '<div class="nt-empty"><div class="nt-empty-icon">📒</div>' +
      '<p>Could not load notebook.</p>' +
      '<p class="muted" style="font-size:12px;margin-top:4px">Start a practice interview to begin.</p>' +
      '</div>';
  }
}

export function notes() {
  // Reset to first spread on each page visit
  _currentSpread = 0;
  queueMicrotask(() => {
    const c = byId('nt-content');
    if (c) renderMaster(c);
  });
  return (
    '<div class="nt-shell">' +
      '<div class="screen-head" style="margin-bottom:20px"><h1>My Notebook</h1></div>' +
      '<div id="nt-content" class="nt-content"></div>' +
    '</div>'
  );
}
