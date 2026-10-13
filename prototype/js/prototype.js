// Agent Panel prototype: the interactions every page shares.
// The behaviour is the spec; the extension's webview should do the same things the same way.

(function () {
  const root = document.documentElement;

  // ----- preview only: theme and frame width -----

  function readPref(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* storage blocked: the page still works, it just forgets */
    }
  }

  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = readPref('ap-theme') || (prefersLight ? 'light' : 'dark');
  root.style.setProperty('--pv-w', (readPref('ap-width') || '420') + 'px');

  function syncPreviewButtons() {
    document.querySelectorAll('[data-pv-theme]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.pvTheme === root.dataset.theme));
    });
    const w = getComputedStyle(root).getPropertyValue('--pv-w').trim();
    document.querySelectorAll('[data-pv-width]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.pvWidth + 'px' === w));
    });
  }

  // ----- the panel -----

  function closeMenus(except) {
    document.querySelectorAll('.ap-menu').forEach((m) => {
      if (m !== except && !m.hasAttribute('data-static')) m.hidden = true;
    });
    document.querySelectorAll('[data-menu][aria-expanded="true"]').forEach((b) => {
      if (!except || b.dataset.menu !== except.dataset.menuId) b.setAttribute('aria-expanded', 'false');
    });
  }

  function openMenu(button) {
    const menu = document.querySelector('[data-menu-id="' + button.dataset.menu + '"]');
    if (!menu) return;
    const willOpen = menu.hidden;
    closeMenus(menu);
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      // anchor the menu above its button, kept inside the composer
      const host = menu.offsetParent || menu.parentElement;
      const left = button.getBoundingClientRect().left - host.getBoundingClientRect().left;
      menu.style.left = Math.max(0, Math.min(left, host.clientWidth - menu.offsetWidth)) + 'px';
    }
  }

  function selectMenuItem(item) {
    const menu = item.closest('.ap-menu');
    const group = item.closest('[data-group]') || menu;
    group.querySelectorAll('.ap-menu__item').forEach((i) => i.setAttribute('aria-checked', 'false'));
    item.setAttribute('aria-checked', 'true');
    const button = document.querySelector('[data-menu="' + menu.dataset.menuId + '"]');
    if (button) {
      const label = button.querySelector('.ap-picker__label');
      if (label) label.textContent = item.dataset.label || item.dataset.value;
    }
    if (menu.dataset.menuId === 'mode') {
      const row = document.querySelector('.ap-handoff-row');
      if (row) row.hidden = item.dataset.value !== 'handoff';
    }
    closeMenus();
  }

  function setEngine(button) {
    const seg = button.closest('.ap-seg');
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === button)));
    const engine = button.dataset.engine;
    const composer = button.closest('.ap-composer');
    composer.dataset.engine = engine;
    // each engine keeps its own model list and its own selected model
    document.querySelectorAll('[data-menu-id="model"] [data-group]').forEach((g) => {
      g.hidden = g.dataset.group !== engine;
    });
    const checked = document.querySelector('[data-menu-id="model"] [data-group="' + engine + '"] [aria-checked="true"]');
    const label = document.querySelector('[data-menu="model"] .ap-picker__label');
    if (checked && label) label.textContent = checked.dataset.label;
  }

  // Changes bar: built from every pending file card in the thread.
  function refreshChanges() {
    const bar = document.querySelector('.ap-changes');
    if (!bar) return;
    const pending = Array.from(document.querySelectorAll('.ap-file[data-state="pending"]'));
    bar.hidden = pending.length === 0;
    let add = 0;
    let del = 0;
    const list = bar.querySelector('.ap-changes__list');
    list.innerHTML = '';
    pending.forEach((card) => {
      add += Number(card.dataset.add || 0);
      del += Number(card.dataset.del || 0);
      const li = document.createElement('li');
      li.className = 'ap-changes__item';
      li.innerHTML =
        '<i class="codicon codicon-file"></i>' +
        '<span class="ap-file__name"></span><span class="ap-file__path"></span>' +
        '<span class="ap-file__stat"><span class="ap-add">+' + card.dataset.add + '</span>' +
        '<span class="ap-del">−' + card.dataset.del + '</span></span>';
      li.querySelector('.ap-file__name').textContent = card.dataset.name;
      li.querySelector('.ap-file__path').textContent = card.dataset.path;
      li.addEventListener('click', () => {
        card.classList.add('is-open');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      list.appendChild(li);
    });
    const n = pending.length;
    bar.querySelector('[data-changes-count]').textContent = n + (n === 1 ? ' file' : ' files') + ' changed';
    bar.querySelector('[data-changes-add]').textContent = '+' + add;
    bar.querySelector('[data-changes-del]').textContent = '−' + del;
  }

  function resolveFile(card, state) {
    card.dataset.state = state;
    if (state !== 'pending') card.classList.remove('is-open');
    const label = card.querySelector('[data-resolved-label]');
    if (label) label.textContent = state === 'accepted' ? 'Accepted' : 'Rejected';
    refreshChanges();
  }

  function autogrow(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }

  document.addEventListener('click', (e) => {
    const t = e.target;

    const pvTheme = t.closest('[data-pv-theme]');
    if (pvTheme) {
      root.dataset.theme = pvTheme.dataset.pvTheme;
      writePref('ap-theme', root.dataset.theme);
      syncPreviewButtons();
      return;
    }
    const pvWidth = t.closest('[data-pv-width]');
    if (pvWidth) {
      root.style.setProperty('--pv-w', pvWidth.dataset.pvWidth + 'px');
      writePref('ap-width', pvWidth.dataset.pvWidth);
      syncPreviewButtons();
      return;
    }

    const action = t.closest('[data-action]');
    if (action) {
      e.stopPropagation();
      const a = action.dataset.action;
      const card = action.closest('.ap-file');
      if (a === 'accept') resolveFile(card, 'accepted');
      if (a === 'reject') resolveFile(card, 'rejected');
      if (a === 'undo') resolveFile(card, 'pending');
      if (a === 'accept-all' || a === 'reject-all') {
        document.querySelectorAll('.ap-file[data-state="pending"]').forEach((c) =>
          resolveFile(c, a === 'accept-all' ? 'accepted' : 'rejected'),
        );
      }
      if (a === 'build') action.closest('.ap-plan').dataset.state = 'built';
      if (a === 'copy') {
        const icon = action.querySelector('.codicon');
        icon.className = 'codicon codicon-check';
        setTimeout(() => (icon.className = 'codicon codicon-copy'), 1200);
      }
      if (a === 'allow' || a === 'deny') {
        const wrap = action.closest('.ap-step-wrap');
        const step = wrap.querySelector('.ap-step');
        step.classList.remove('ap-step--ask');
        step.classList.add(a === 'allow' ? 'ap-step--running' : 'ap-step--denied');
        step.querySelector('.codicon').className =
          a === 'allow' ? 'codicon codicon-loading ap-spin' : 'codicon codicon-circle-slash';
        wrap.querySelector('.ap-ask').remove();
      }
      if (a === 'mention') {
        const chips = document.querySelector('.ap-composer__chips');
        const chip = document.createElement('span');
        chip.className = 'ap-chip';
        chip.innerHTML = '<i class="codicon codicon-file"></i><span></span><button title="Remove"><i class="codicon codicon-close"></i></button>';
        chip.querySelector('span').textContent = action.dataset.file;
        chips.hidden = false;
        chips.appendChild(chip);
        const input = document.querySelector('.ap-composer__input');
        input.value = input.value.replace(/@\S*$/, '');
        action.closest('.ap-menu').hidden = true;
        input.focus();
      }
      return;
    }

    const chipRemove = t.closest('.ap-chip button');
    if (chipRemove) {
      chipRemove.closest('.ap-chip').remove();
      return;
    }

    const seg = t.closest('.ap-seg button');
    if (seg) {
      setEngine(seg);
      return;
    }

    const menuButton = t.closest('[data-menu]');
    if (menuButton) {
      openMenu(menuButton);
      return;
    }

    const item = t.closest('.ap-menu__item[data-value]');
    if (item) {
      selectMenuItem(item);
      return;
    }

    const toggle = t.closest('[data-toggle]');
    if (toggle) {
      const box = toggle.closest('[data-collapsible]');
      if (box) box.classList.toggle('is-open');
      return;
    }

    if (!t.closest('.ap-menu')) closeMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
    const input = e.target.closest && e.target.closest('.ap-composer__input');
    if (input && e.key === 'Enter' && !e.shiftKey) {
      // Enter sends; Shift+Enter adds a new line. The prototype only clears the box.
      e.preventDefault();
      input.value = '';
      autogrow(input);
    }
  });

  document.addEventListener('input', (e) => {
    const input = e.target.closest && e.target.closest('.ap-composer__input');
    if (!input) return;
    autogrow(input);
    const pop = document.querySelector('[data-menu-id="mention"]');
    if (pop) pop.hidden = !/@\S*$/.test(input.value);
  });

  document.addEventListener('DOMContentLoaded', () => {
    syncPreviewButtons();
    refreshChanges();
    document.querySelectorAll('.ap-composer__input').forEach(autogrow);
    const thread = document.querySelector('.ap-thread[data-scroll="end"]');
    if (thread) thread.scrollTop = thread.scrollHeight;
  });
})();
