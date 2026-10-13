import { store, post } from './store';
import { h, icon, button, splitPath, fileIcon } from './dom';
import { highlightLine, langFromPath } from './highlight';
import type { ChatMessage, TurnFile } from './store';

const FOLD_AFTER = 6;
const CARDS_SHOWN = 3;

/** The latest turn that changed each file: only its card carries Accept and Reject. */
export function latestTurnByFile(messages: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) for (const f of m.files ?? []) out.set(f.relPath, m.id);
  return out;
}

export function patchKey(messageId: string, relPath: string): string {
  return `${messageId}:${relPath}`;
}

/** The file cards for one turn. */
export function fileCards(m: ChatMessage, latest: Map<string, string>): HTMLElement | null {
  const files = m.files ?? [];
  if (!files.length) return null;
  const wrap = h('div', { class: 'ap-files' });
  const showAll = store.ui.showAllFiles.has(m.id) || files.length <= CARDS_SHOWN + 1;
  const shown = showAll ? files : files.slice(0, CARDS_SHOWN);
  for (const f of shown) wrap.append(fileCard(m, f, latest.get(f.relPath) === m.id));
  if (!showAll) {
    wrap.append(
      button(`Show ${files.length - CARDS_SHOWN} more files`, {
        icon: 'chevron-down',
        onClick: () => {
          store.ui.showAllFiles.add(m.id);
          wrap.replaceWith(fileCards(m, latest)!);
        },
      }),
    );
  }
  return wrap;
}

function fileCard(m: ChatMessage, f: TurnFile, isLatest: boolean): HTMLElement {
  const host = store.host!;
  const key = patchKey(m.id, f.relPath);
  const { name, dir } = splitPath(f.relPath);
  const state = isLatest ? host.fileStates[f.relPath] : undefined;
  const open = store.ui.openFiles.has(key);

  const card = h('article', {
    class: `ap-file${open ? ' is-open' : ''}`,
    'data-state': state ?? (isLatest ? 'settled' : 'superseded'),
    'data-key': key,
  });

  const nameEl = h('span', { class: 'ap-file__name', title: `Open ${f.relPath}` }, name);
  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'openFile', path: f.relPath });
  });

  const resolved =
    state === 'accepted' || state === 'rejected'
      ? h(
          'span',
          { class: 'ap-file__resolved' },
          icon(state === 'accepted' ? 'check' : 'discard'),
          state === 'accepted' ? 'Accepted' : 'Rejected',
          h(
            'button',
            {
              type: 'button',
              onclick: (e: Event) => {
                e.stopPropagation();
                post({ type: 'undo', path: f.relPath });
              },
            },
            'Undo',
          ),
        )
      : null;

  const head = h(
    'header',
    { class: 'ap-file__head', role: 'button', tabindex: '0', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    icon(f.status === 'deleted' ? 'trash' : fileIcon(f.relPath), 'ap-file__icon'),
    nameEl,
    h('span', { class: 'ap-file__path', title: dir }, dir),
    f.status === 'added' ? h('span', { class: 'ap-file__tag' }, 'New') : null,
    f.status === 'deleted' ? h('span', { class: 'ap-file__tag' }, 'Deleted') : null,
    resolved ?? h('span', { class: 'ap-file__stat' }, h('span', { class: 'ap-add' }, `+${f.additions}`), h('span', { class: 'ap-del' }, `−${f.deletions}`)),
  );
  const toggle = () => {
    const nowOpen = card.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) {
      store.ui.openFiles.add(key);
      loadPatch(m, f, rows);
    } else {
      store.ui.openFiles.delete(key);
    }
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  const rows = h('div', { class: 'ap-diff__rows' });
  if (open) loadPatch(m, f, rows);

  const actions = h('footer', { class: 'ap-file__actions' });
  actions.append(button('Open diff', { icon: 'diff', onClick: () => post({ type: 'openDiff', path: f.relPath }) }));
  actions.append(h('span', { class: 'ap-spacer' }));
  if (state === 'pending') {
    actions.append(
      button('Reject', { onClick: () => post({ type: 'reject', path: f.relPath }) }),
      button('Accept', { variant: 'primary', onClick: () => post({ type: 'accept', path: f.relPath }) }),
    );
  } else if (!isLatest) {
    actions.append(h('span', { class: 'ap-muted ap-file__later' }, 'Changed again in a later turn'));
  }

  card.append(head, h('div', { class: 'ap-file__body' }, h('div', { class: 'ap-diff' }, rows), actions));
  return card;
}

function loadPatch(m: ChatMessage, f: TurnFile, rows: HTMLElement): void {
  const key = patchKey(m.id, f.relPath);
  const cached = store.patches.get(key);
  if (cached !== undefined) {
    rows.replaceChildren(...renderDiff(cached, langFromPath(f.relPath)));
    return;
  }
  rows.replaceChildren(h('div', { class: 'ap-diff__hunk' }, 'Loading diff…'));
  post({ type: 'getPatch', key, path: f.relPath, base: m.trees?.base, after: m.trees?.after });
}

/** A patch arrived: fill every open card waiting for it. */
export function applyPatch(key: string, patch: string): void {
  store.patches.set(key, patch);
  const card = document.querySelector(`.ap-file[data-key="${CSS.escape(key)}"] .ap-diff__rows`);
  if (card) card.replaceChildren(...renderDiff(patch, langFromPath(key.slice(key.indexOf(':') + 1))));
}

/** Unified diff to rows with old and new line numbers; long unchanged runs fold. */
export function renderDiff(patch: string, lang = ''): HTMLElement[] {
  if (!patch.trim()) return [h('div', { class: 'ap-diff__hunk' }, 'No text changes to show')];
  if (/^Binary files /m.test(patch)) return [h('div', { class: 'ap-diff__hunk' }, 'Binary file changed')];
  const nodes: HTMLElement[] = [];
  let oldLine = 0;
  let newLine = 0;
  let quiet: HTMLElement[] = [];

  const flushQuiet = () => {
    // Keep three lines of context either side of a change; fold the middle.
    if (quiet.length > FOLD_AFTER) {
      const head = quiet.slice(0, 3);
      const tail = quiet.slice(quiet.length - 3);
      const hidden = quiet.slice(3, quiet.length - 3);
      nodes.push(...head);
      const fold = h('button', { type: 'button', class: 'ap-diff__fold' }, icon('unfold'), `${hidden.length} unchanged lines`);
      fold.addEventListener('click', () => fold.replaceWith(...hidden));
      nodes.push(fold, ...tail);
    } else {
      nodes.push(...quiet);
    }
    quiet = [];
  };

  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushQuiet();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      nodes.push(h('div', { class: 'ap-diff__hunk' }, line));
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const row = (cls: string, o: string, n: string, sign: string, text: string) => {
      const code = h('code', {});
      code.innerHTML = highlightLine(text, lang);
      return h('div', { class: `ap-diff__row${cls}` }, h('span', { class: 'ln' }, o), h('span', { class: 'ln' }, n), h('span', { class: 'sg' }, sign), code);
    };
    if (line.startsWith('+')) {
      flushQuiet();
      nodes.push(row(' is-add', '', String(newLine++), '+', line.slice(1)));
    } else if (line.startsWith('-')) {
      flushQuiet();
      nodes.push(row(' is-del', String(oldLine++), '', '−', line.slice(1)));
    } else {
      quiet.push(row('', String(oldLine++), String(newLine++), '', line.startsWith(' ') ? line.slice(1) : line));
    }
  }
  // Trailing context: keep the first three lines, fold the rest.
  if (quiet.length > FOLD_AFTER) {
    const keep = quiet.slice(0, 3);
    const hidden = quiet.slice(3);
    nodes.push(...keep);
    const fold = h('button', { type: 'button', class: 'ap-diff__fold' }, icon('unfold'), `${hidden.length} unchanged lines`);
    fold.addEventListener('click', () => fold.replaceWith(...hidden));
    nodes.push(fold);
  } else {
    nodes.push(...quiet);
  }
  return nodes;
}

/** The bar above the composer: every pending file in the thread, with totals. */
export function renderChanges(root: HTMLElement): void {
  const host = store.host!;
  const pending = host.pending;
  if (!pending.length) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const open = root.classList.contains('is-open');
  let add = 0;
  let del = 0;
  for (const f of pending) {
    add += f.additions;
    del += f.deletions;
  }
  const n = pending.length;
  const toggle = h(
    'button',
    { type: 'button', class: 'ap-changes__toggle', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    `${n} ${n === 1 ? 'file' : 'files'} changed`,
  );
  toggle.addEventListener('click', () => {
    const now = root.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(now));
  });
  const head = h(
    'div',
    { class: 'ap-changes__head' },
    toggle,
    h('span', { class: 'ap-changes__stat' }, h('span', { class: 'ap-add' }, `+${add}`), h('span', { class: 'ap-del' }, `−${del}`)),
    h('span', { class: 'ap-spacer' }),
    button('Reject all', { disabled: !host.gitOk, onClick: () => post({ type: 'rejectAll' }) }),
    button('Accept all', { variant: 'secondary', disabled: !host.gitOk, onClick: () => post({ type: 'acceptAll' }) }),
  );
  const list = h('ul', { class: 'ap-changes__list' });
  for (const f of pending) {
    const { name, dir } = splitPath(f.relPath);
    const li = h(
      'li',
      { class: 'ap-changes__item', tabindex: '0', title: f.relPath },
      icon(fileIcon(f.relPath)),
      h('span', { class: 'ap-file__name' }, name),
      h('span', { class: 'ap-file__path' }, dir),
      h('span', { class: 'ap-file__stat' }, h('span', { class: 'ap-add' }, `+${f.additions}`), h('span', { class: 'ap-del' }, `−${f.deletions}`)),
    );
    li.addEventListener('click', () => post({ type: 'openFile', path: f.relPath }));
    list.append(li);
  }
  root.replaceChildren(head, list);
}
