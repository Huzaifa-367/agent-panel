/** Small DOM helpers and formatters shared by every part of the panel. */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener> & {
  class?: string;
};

/** Create an element: `h('button', { class: 'ap-btn', onclick }, 'Accept')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k in el && typeof v !== 'string') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function icon(name: string, extra = ''): HTMLElement {
  return h('i', { class: `codicon codicon-${name}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });
}

export function button(
  label: string | Child[],
  opts: { variant?: 'primary' | 'secondary' | 'ghost'; icon?: string; title?: string; disabled?: boolean; onClick?: (e: MouseEvent) => void } = {},
): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: `ap-btn ap-btn--${opts.variant ?? 'ghost'}`,
    title: opts.title,
    disabled: opts.disabled,
  });
  if (opts.icon) b.append(icon(opts.icon));
  append(b, Array.isArray(label) ? label : [label]);
  if (opts.onClick) b.addEventListener('click', (e) => opts.onClick!(e as MouseEvent));
  return b;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, extra: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'ap-icon-btn', title, 'aria-label': title, ...extra }, icon(name));
  b.addEventListener('click', (e) => onClick(e as MouseEvent));
  return b;
}

export function engineTag(engine: string): HTMLElement {
  return h('span', { class: `ap-engine ap-engine--${engine}` }, engine === 'cursor' ? 'Cursor' : 'Claude');
}

/** Turn `Read \`a.ts\`` into text with inline code. */
export function inlineCode(text: string): Child[] {
  return text.split(/(`[^`]+`)/g).map((p) => (p.startsWith('`') && p.endsWith('`') && p.length > 1 ? h('code', {}, p.slice(1, -1)) : p));
}

/** A label with some characters in bold (fuzzy-match positions). */
export function highlighted(label: string, match?: number[]): Child[] {
  if (!match?.length) return [label];
  const set = new Set(match);
  const out: Child[] = [];
  let run = '';
  let bold = false;
  for (let i = 0; i < label.length; i += 1) {
    const b = set.has(i);
    if (b !== bold && run) {
      out.push(bold ? h('mark', {}, run) : run);
      run = '';
    }
    bold = b;
    run += label[i];
  }
  if (run) out.push(bold ? h('mark', {}, run) : run);
  return out;
}

export function splitPath(rel: string): { name: string; dir: string } {
  const i = rel.lastIndexOf('/');
  return i < 0 ? { name: rel, dir: '' } : { name: rel.slice(i + 1), dir: rel.slice(0, i) };
}

export function fileIcon(rel: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(rel)?.[1] ?? '').toLowerCase();
  if (['md', 'mdc', 'txt'].includes(ext)) return 'markdown';
  if (['json', 'yml', 'yaml', 'toml'].includes(ext)) return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'file-media';
  return 'file-code';
}

/** A full-panel image preview; click or Escape closes it. */
export function showImage(url: string, name: string): void {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const overlay = h(
    'div',
    { class: 'ap-lightbox', role: 'dialog', 'aria-label': name, tabindex: '-1' },
    h('img', { src: url, alt: name }),
    h('div', { class: 'ap-lightbox__name' }, name),
  );
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  (document.querySelector('.ap') ?? document.body).append(overlay);
  overlay.focus();
}

// ----- formatters -----

export function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h`;
  if (sec < 172_800) return 'Yesterday';
  if (sec < 604_800) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(ms?: number): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function tokens(n?: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function money(n?: number): string {
  if (n === undefined) return '';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/** `Thu 9:00` for this week, otherwise `Oct 20, 9:00`. */
export function resetTime(unixSeconds?: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const soon = d.getTime() - Date.now() < 6 * 86_400_000;
  return d.toLocaleString(undefined, soon ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
