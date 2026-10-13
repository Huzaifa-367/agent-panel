import { store, post } from './store';
import { h, icon, highlighted } from './dom';
import type { MentionItem, MentionScope } from './store';

const SCOPE_LABEL: Record<MentionScope, string> = {
  files: 'Files & folders',
  code: 'Code',
  git: 'Git',
  chats: 'Past chats',
  rules: 'Rules',
};

let requestSeq = 0;

/** The `@word` right before the caret, if the caret sits in one. */
export function mentionAtCaret(ta: HTMLTextAreaElement): { start: number; query: string } | null {
  const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

export function openMention(query: string, scope?: MentionScope): void {
  requestSeq += 1;
  const prev = store.ui.mention;
  store.ui.mention = {
    query,
    scope,
    groups: prev && prev.scope === scope ? prev.groups : [],
    active: 0,
    requestId: requestSeq,
  };
  post({ type: 'searchMentions', query, scope, requestId: requestSeq });
}

export function closeMention(): void {
  store.ui.mention = null;
}

export function receiveMentions(requestId: number, groups: NonNullable<typeof store.ui.mention>['groups']): boolean {
  const m = store.ui.mention;
  if (!m || m.requestId !== requestId) return false;
  m.groups = groups;
  m.active = 0;
  return true;
}

function flatItems(): MentionItem[] {
  return (store.ui.mention?.groups ?? []).flatMap((g) => g.items);
}

/** Arrow keys, Enter, Tab and Escape while the popover is open. Returns true when handled. */
export function mentionKey(e: KeyboardEvent, ta: HTMLTextAreaElement, onChange: () => void): boolean {
  const m = store.ui.mention;
  if (!m) return false;
  const items = flatItems();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) m.active = (m.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    onChange();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (!items.length) return false;
    e.preventDefault();
    pick(items[m.active], ta, onChange);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (m.scope) openMention('', undefined);
    else closeMention();
    onChange();
    return true;
  }
  if (e.key === 'Backspace' && m.scope && !m.query && !mentionAtCaret(ta)?.query) {
    // Backspace on an empty scoped search goes back to the categories.
    openMention('', undefined);
    onChange();
    return false;
  }
  return false;
}

/** Pick an item: a category drills in, anything else becomes a chip. */
export function pick(item: MentionItem, ta: HTMLTextAreaElement, onChange: () => void): void {
  if (item.kind === 'category') {
    const at = mentionAtCaret(ta);
    if (at) {
      // Keep the @ so typing narrows the category.
      ta.value = ta.value.slice(0, at.start + 1) + ta.value.slice(ta.selectionStart);
      ta.selectionStart = ta.selectionEnd = at.start + 1;
    }
    openMention('', item.id as MentionScope);
    onChange();
    ta.focus();
    return;
  }
  const at = mentionAtCaret(ta);
  if (at) {
    const end = ta.selectionStart;
    ta.value = ta.value.slice(0, at.start) + ta.value.slice(end).replace(/^\s?/, '');
    ta.selectionStart = ta.selectionEnd = at.start;
  }
  if (!store.ui.mentions.some((x) => x.kind === item.kind && x.id === item.id)) store.ui.mentions.push(item);
  closeMention();
  onChange();
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

export function mentionPopover(ta: HTMLTextAreaElement, onChange: () => void): HTMLElement | null {
  const m = store.ui.mention;
  if (!m) return null;
  const pop = h('div', { class: 'ap-menu ap-mention-pop', role: 'listbox', 'aria-label': 'Add context' });
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box

  if (m.scope) {
    const back = h('button', { type: 'button', class: 'ap-mention-pop__back' }, icon('chevron-left'), SCOPE_LABEL[m.scope]);
    back.addEventListener('click', () => {
      openMention('', undefined);
      onChange();
    });
    pop.append(back);
  }

  let index = 0;
  for (const g of m.groups) {
    if (!g.items.length) continue;
    if (!m.scope || m.groups.length > 1) pop.append(h('div', { class: 'ap-menu__label' }, g.label));
    for (const item of g.items) {
      const i = index;
      const el = h(
        'button',
        { type: 'button', class: `ap-menu__item${i === m.active ? ' is-active' : ''}`, role: 'option', 'aria-selected': String(i === m.active), title: item.kind === 'file' ? item.id : item.detail ?? '' },
        icon(item.icon),
        h('span', { class: 'ap-mention-pop__label' }, ...highlighted(item.label, item.match)),
        h('span', { class: 'ap-file__path' }, item.detail ?? ''),
        item.kind === 'category' ? icon('chevron-right', 'ap-mention-pop__more') : null,
      );
      el.addEventListener('mouseenter', () => {
        m.active = i;
        pop.querySelectorAll('.ap-menu__item').forEach((x, j) => x.classList.toggle('is-active', j === i));
      });
      el.addEventListener('click', () => pick(item, ta, onChange));
      pop.append(el);
      index += 1;
    }
  }
  if (!index) {
    pop.append(h('div', { class: 'ap-menu__label' }, m.groups.length || m.query ? 'Nothing matches' : 'Searching…'));
  }
  requestAnimationFrame(() => pop.querySelector('.ap-menu__item.is-active')?.scrollIntoView({ block: 'nearest' }));
  return pop;
}
