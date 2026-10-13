import { store, post, isRunning } from './store';
import { h, icon, button, engineTag, inlineCode, duration, money, tokens, fileIcon, relativeTime } from './dom';
import { renderMarkdown } from './markdown';
import { fileCards, latestTurnByFile, renderDiff } from './files';
import type { MessagePart } from '../src/threads';
import { highlightOutput, highlightShell, langFromPath } from './highlight';
import type { ChatMessage, StepRecord } from './store';

const ROLE_LABEL = { planner: 'Planner', builder: 'Builder', reviewer: 'Review' } as const;

/** Signature of what a message looks like, so unchanged messages are not rebuilt. */
function signature(m: ChatMessage, latest: Map<string, string>): string {
  const host = store.host!;
  const fileBits = (m.files ?? []).map((f) => `${f.relPath}:${latest.get(f.relPath) === m.id ? host.fileStates[f.relPath] ?? '' : 'old'}`);
  return JSON.stringify([m.text.length, m.thinking?.length ?? 0, m.parts?.length ?? 0, m.parts?.map((p) => (p.kind === 'steps' ? p.ids.length : p.kind === 'thinking' ? Boolean(p.endedAt) : 0)), m.steps, m.meta, m.plan, fileBits, isRunning(m.id), isRunning(), hasCheckpoint(m), store.ui.editingPlan === m.id]);
}

const rendered = new Map<string, { sig: string; el: HTMLElement }>();
const exchanges = new Map<string, HTMLElement>();

/** True while the user is at the bottom; late layout (fonts, diffs) keeps it there. */
let pinned = true;
let watching: HTMLElement | null = null;
let sizes: ResizeObserver | null = null;

/** Messages grow after they are drawn (fonts, diffs, streaming); keep the end in view. */
function watch(list: HTMLElement): void {
  if (watching === list) return;
  watching = list;
  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const keep = () => {
    if (pinned) list.scrollTop = list.scrollHeight;
  };
  // Only the user un-pins (wheel, touch, keys); reaching the end again re-pins.
  const userMoved = () => requestAnimationFrame(() => (pinned = atEnd()));
  list.addEventListener('wheel', userMoved, { passive: true });
  list.addEventListener('touchmove', userMoved, { passive: true });
  list.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) userMoved();
  });
  list.addEventListener('pointerup', userMoved);
  list.addEventListener('scroll', () => {
    if (atEnd()) pinned = true;
  });
  sizes = new ResizeObserver(keep);
  sizes.observe(list);
  void document.fonts?.ready.then(keep);
}

export function scrollToEnd(list: HTMLElement): void {
  pinned = true;
  list.scrollTop = list.scrollHeight;
}

/** One message that fails to draw must not stop the rest of the thread from updating. */
function safeMessageEl(m: ChatMessage, latest: Map<string, string>): HTMLElement {
  try {
    return messageEl(m, latest);
  } catch (err) {
    console.error('Agent Panel: could not draw a message', err);
    const box = h('div', { class: 'ap-alert ap-alert--error' }, icon('error'), h('span', {}, 'This message could not be drawn. The agent is unaffected.'));
    return h('div', { class: 'ap-msg-fallback' }, box, m.text ? h('pre', { class: 'ap-output' }, m.text) : null);
  }
}

/** Bring the thread up to date, rebuilding only the messages that changed. */
export function renderThread(list: HTMLElement): void {
  watch(list);
  const messages = orderedMessages();
  const latest = latestTurnByFile(messages);

  const wanted = new Set(messages.map((m) => m.id));
  for (const [id, r] of rendered) {
    if (!wanted.has(id)) {
      r.el.remove();
      rendered.delete(id);
    }
  }
  list.querySelector(':scope > .ap-empty-wrap')?.remove();

  // Each of your messages and its answer form one exchange; the message stays pinned
  // only while its own exchange is on screen, then the next one takes over (like Cursor).
  const groups: { key: string; ms: ChatMessage[] }[] = [];
  for (const m of messages) {
    if (m.role === 'user' || !groups.length) groups.push({ key: m.role === 'user' ? m.id : 'lead', ms: [] });
    groups[groups.length - 1].ms.push(m);
  }
  const wantedGroups = new Set(groups.map((g) => g.key));
  for (const [key, el] of exchanges) {
    if (!wantedGroups.has(key)) {
      el.remove();
      exchanges.delete(key);
    }
  }
  let prevGroup: Element | null = null;
  for (const g of groups) {
    let box = exchanges.get(g.key);
    if (!box) {
      box = h('div', { class: 'ap-exchange', 'data-exchange': g.key });
      exchanges.set(g.key, box);
    }
    const wantBox: Element | null = prevGroup ? prevGroup.nextElementSibling : list.firstElementChild;
    if (wantBox !== box) list.insertBefore(box, wantBox);
    prevGroup = box;

    let prev: Element | null = null;
    for (const m of g.ms) {
      let sig: string;
      try {
        sig = signature(m, latest);
      } catch {
        sig = `x${Date.now()}`;
      }
      let r = rendered.get(m.id);
      if (!r || r.sig !== sig) {
        const el = safeMessageEl(m, latest);
        sizes?.observe(el);
        if (r) {
          sizes?.unobserve(r.el);
          r.el.replaceWith(el);
        }
        r = { sig, el };
        rendered.set(m.id, r);
      }
      const want: Element | null = prev ? prev.nextElementSibling : box.firstElementChild;
      if (want !== r.el) box.insertBefore(r.el, want);
      prev = r.el;
    }
  }

  if (!messages.length) list.append(emptyState());
  if (pinned) {
    list.scrollTop = list.scrollHeight;
    requestAnimationFrame(() => {
      if (pinned) list.scrollTop = list.scrollHeight;
    });
  }
}

export function resetThread(list: HTMLElement): void {
  rendered.clear();
  exchanges.clear();
  list.replaceChildren();
  pinned = true;
}

export function orderedMessages(): ChatMessage[] {
  return [...store.messages.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// ----- streaming -----

/** Repaint only the live text and thinking of a streaming message. */
export function paintStream(id: string): void {
  const m = store.messages.get(id);
  const r = rendered.get(id);
  if (!m || !r) return;
  const parts = m.parts ?? [];
  const last = parts[parts.length - 1];
  const live = r.el.querySelector<HTMLElement>('.ap-md--live');
  const liveThinking = r.el.querySelector<HTMLElement>('.ap-thinking.is-live .ap-thinking__body');
  if (last?.kind === 'text' && live) paintLive(live, last.text);
  else if (last?.kind === 'thinking' && liveThinking) liveThinking.textContent = last.text;
  else {
    // The live block isn't there yet: lay the message out once.
    rendered.delete(id);
    const list = r.el.closest<HTMLElement>('.ap-thread');
    if (list) renderThread(list);
    return;
  }
  const list = r.el.closest<HTMLElement>('.ap-thread');
  if (list && pinned) list.scrollTop = list.scrollHeight;
}

/**
 * Streaming text renders as markdown, at most every 100 ms: formatted as it arrives
 * (like both official panels) without re-parsing on every token.
 */
const lastLive = new WeakMap<HTMLElement, number>();
function paintLive(el: HTMLElement, text: string): void {
  const now = performance.now();
  const last = lastLive.get(el);
  if (last !== undefined && now - last < 100) {
    // Between full paints, keep the plain tail fresh.
    const tail = el.querySelector(':scope > .ap-live-tail');
    if (tail) tail.textContent = text.slice(Number(el.dataset.len ?? 0));
    return;
  }
  lastLive.set(el, now);
  el.dataset.len = String(text.length);
  el.innerHTML = renderMarkdown(text);
  wireMarkdown(el);
  el.append(h('span', { class: 'ap-live-tail' }), h('span', { class: 'ap-caret' }));
}

// ----- messages -----

function messageEl(m: ChatMessage, latest: Map<string, string>): HTMLElement {
  if (m.role === 'user') return userEl(m);
  if (m.role === 'system') {
    return h('div', { class: 'ap-turn ap-note', 'data-mid': m.id }, h('span', { class: 'ap-note__body' }, icon(m.icon ?? 'info'), m.text));
  }
  return assistantEl(m, latest);
}

function userEl(m: ChatMessage): HTMLElement {
  const chips = (m.mentions ?? []).map((x) => {
    // Every attachment opens: the file, the folder, the diff, the chat, the image.
    const chip = h('button', { type: 'button', class: 'ap-chip ap-chip--open', title: `Open ${x.detail ? `${x.detail}/` : ''}${x.label}` }, icon(mentionIcon(x.kind, x.id)), x.label);
    chip.addEventListener('click', () => post({ type: 'openMention', kind: x.kind, id: x.id, label: x.label }));
    return chip;
  });
  const actions = h('div', { class: 'ap-user__actions' });
  const edit = h('button', { type: 'button', class: 'ap-icon-btn', title: 'Edit and send again', 'aria-label': 'Edit and send again' }, icon('edit'));
  edit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('ap-edit', { detail: m.text })));
  actions.append(edit);
  if (hasCheckpoint(m)) {
    const confirming = store.ui.confirmRestore === m.id;
    const restore = h(
      'button',
      { type: 'button', class: `ap-btn ap-btn--${confirming ? 'secondary' : 'ghost'} ap-user__restore`, title: 'Put the files back to how they were before this message. The chat stays.', disabled: isRunning() },
      icon('history'),
      confirming ? 'Restore files?' : 'Restore checkpoint',
    );
    restore.addEventListener('click', () => {
      if (store.ui.confirmRestore === m.id) {
        store.ui.confirmRestore = null;
        post({ type: 'restore', messageId: m.id });
      } else {
        store.ui.confirmRestore = m.id;
        rerenderMessage(m.id);
        setTimeout(() => {
          if (store.ui.confirmRestore === m.id) {
            store.ui.confirmRestore = null;
            rerenderMessage(m.id);
          }
        }, 4000);
      }
    });
    actions.prepend(restore);
  }
  return h('section', { class: 'ap-turn ap-turn--user', 'data-mid': m.id }, h('div', { class: 'ap-user' }, chips.length ? h('div', { class: 'ap-user__chips' }, ...chips) : null, m.text), actions);
}

/** A later turn changed files, so there is something to restore. */
function hasCheckpoint(m: ChatMessage): boolean {
  let after = false;
  for (const x of orderedMessages()) {
    if (x.id === m.id) after = true;
    else if (after && x.role === 'assistant' && x.trees && x.files?.length) return true;
  }
  return false;
}

function todosEl(m: ChatMessage): HTMLElement | null {
  const todos = [...(m.steps ?? [])].reverse().find((s) => s.todos?.length)?.todos;
  if (!todos) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return h(
    'div',
    { class: 'ap-todos' },
    h('div', { class: 'ap-todos__head' }, icon('checklist'), 'To-dos', h('span', { class: 'ap-muted' }, `${done} of ${todos.length}`)),
    h(
      'ul',
      {},
      ...todos.map((t) =>
        h(
          'li',
          { class: `ap-todo ap-todo--${t.status}` },
          icon(t.status === 'completed' ? 'pass-filled' : t.status === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline'),
          h('span', {}, t.content),
        ),
      ),
    ),
  );
}

export function mentionIcon(kind: string, id: string): string {
  switch (kind) {
    case 'folder':
      return 'folder';
    case 'symbol':
      return 'symbol-method';
    case 'git-diff':
      return 'diff';
    case 'commit':
      return 'git-commit';
    case 'problems':
      return 'warning';
    case 'branch':
      return 'git-branch';
    case 'image':
      return 'file-media';
    case 'chat':
      return 'comment-discussion';
    case 'rule':
      return 'law';
    case 'selection':
      return 'selection';
    default:
      return fileIcon(id);
  }
}

function assistantEl(m: ChatMessage, latest: Map<string, string>): HTMLElement {
  const running = isRunning(m.id);
  const meta = m.meta ?? {};
  const section = h('section', { class: `ap-turn ap-turn--agent${running ? ' is-running' : ''}`, 'data-mid': m.id });

  section.append(
    h(
      'div',
      { class: 'ap-turn__meta' },
      engineTag(m.engine ?? 'claude'),
      meta.modelLabel ? h('span', {}, meta.modelLabel) : null,
      h('span', {}, meta.role ? ROLE_LABEL[meta.role] : meta.mode === 'plan' ? 'Plan' : meta.mode === 'ask' ? 'Ask first' : meta.mode === 'auto' ? 'Auto' : 'Agent'),
    ),
  );

  const todos = todosEl(m);
  if (todos) section.append(todos);

  // The answer as it happened: thinking, text and tool steps in order (like Cursor).
  const parts = m.parts?.length ? m.parts : legacyParts(m);
  const lastIdx = parts.length - 1;
  parts.forEach((p, idx) => {
    const isLast = idx === lastIdx;
    if (p.kind === 'thinking') section.append(thinkingPart(m, p, idx, running && isLast));
    else if (p.kind === 'steps') section.append(...stepBlocks(m, p.ids, idx));
    else if (!m.plan && p.text.trim()) {
      if (running && isLast) {
        const live = h('div', { class: 'ap-md ap-md--live' });
        paintLive(live, p.text);
        section.append(live);
      } else {
        section.append(markdown(p.text));
      }
    }
  });

  if (running && !parts.length) {
    section.append(h('div', { class: 'ap-pending' }, icon('loading', 'ap-spin'), m.engine === 'cursor' ? 'Waiting for Cursor…' : 'Waiting for Claude…'));
  }
  if (m.plan) section.append(planCard(m));

  const files = filesSection(m, latest);
  if (files) section.append(files);

  if (meta.error) section.append(errorEl(m));
  if (!running) {
    const foot = footEl(m);
    if (foot) section.append(foot);
  }
  return section;
}

/** Messages saved before timelines: thinking, then steps, then text. */
function legacyParts(m: ChatMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  if (m.thinking) parts.push({ kind: 'thinking', text: m.thinking });
  if (m.steps?.length) parts.push({ kind: 'steps', ids: m.steps.map((s) => s.id) });
  if (m.text) parts.push({ kind: 'text', text: m.text });
  return parts;
}

function thinkingPart(m: ChatMessage, p: Extract<MessagePart, { kind: 'thinking' }>, idx: number, live: boolean): HTMLElement {
  const key = `${m.id}:${idx}`;
  const open = store.ui.openThinking.has(key);
  const secs = p.startedAt && p.endedAt ? Math.max(1, Math.round((p.endedAt - p.startedAt) / 1000)) : undefined;
  if (!p.text.trim()) {
    // Claude's API sends no reasoning text for these models, so there is nothing to open.
    return h(
      'div',
      { class: `ap-thinking ap-thinking--empty${live ? ' is-live' : ''}`, title: "Claude doesn't share its reasoning text for this model." },
      live ? h('span', { class: 'ap-shimmer' }, 'Thinking') : h('span', {}, 'Thought', secs ? h('span', { class: 'ap-muted' }, ` ${secs}s`) : null),
    );
  }
  const wrap = h('div', { class: `ap-thinking${open ? ' is-open' : ''}${live ? ' is-live' : ''}` });
  const head = h(
    'button',
    { type: 'button', class: 'ap-steps__summary', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    live ? h('span', { class: 'ap-shimmer' }, 'Thinking') : h('span', {}, 'Thought', secs ? h('span', { class: 'ap-muted' }, ` ${secs}s`) : null),
  );
  head.addEventListener('click', () => {
    const now = wrap.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(now));
    if (now) store.ui.openThinking.add(key);
    else store.ui.openThinking.delete(key);
  });
  wrap.append(head, h('div', { class: 'ap-thinking__body' }, p.text));
  return wrap;
}

/**
 * A run of tool steps: reads, searches and commands fold into a group ("Explored 3 files,
 * 2 searches"); each edit with a diff stands on its own as a card with a preview.
 */
function stepBlocks(m: ChatMessage, ids: string[], idx: number): HTMLElement[] {
  const byId = new Map((m.steps ?? []).map((s) => [s.id, s]));
  const steps = ids.map((id) => byId.get(id)).filter((s): s is StepRecord => Boolean(s) && !s!.todos);
  const blocks: HTMLElement[] = [];
  let run: StepRecord[] = [];
  let n = 0;
  const flush = () => {
    if (run.length) blocks.push(stepGroup(m, run, `${m.id}:${idx}:${n++}`));
    run = [];
  };
  const kids = childrenOf(m.steps ?? []);
  for (const s of steps) {
    if (s.agent && !s.ask) {
      flush();
      blocks.push(subagentCard(s, kids));
    } else if (s.diff && !s.ask) {
      flush();
      blocks.push(editCard(s));
    } else {
      run.push(s);
    }
  }
  flush();
  return blocks;
}

/** Steps grouped under the subagent step they ran inside. */
function childrenOf(steps: StepRecord[]): Map<string, StepRecord[]> {
  const map = new Map<string, StepRecord[]>();
  for (const s of steps) {
    if (!s.parentId) continue;
    const list = map.get(s.parentId) ?? [];
    list.push(s);
    map.set(s.parentId, list);
  }
  return map;
}

function descendants(id: string, kids: Map<string, StepRecord[]>): StepRecord[] {
  return (kids.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id, kids)]);
}

/**
 * A subagent as a tree: its name and task on the header, then the steps it took (each of its
 * own subagents nested the same way), then what it handed back.
 */
function subagentCard(s: StepRecord, kids: Map<string, StepRecord[]>): HTMLElement {
  const key = `agent:${s.id}`;
  const live = s.status === 'running' || s.status === 'ask';
  const all = descendants(s.id, kids).filter((c) => !c.agent);
  const open = store.ui.stepChoice.get(key) ?? live;
  const root = h('div', { class: `ap-agent${open ? ' is-open' : ''}${live ? ' is-live' : ''}${s.status === 'fail' ? ' is-failed' : ''}` });
  const kind = s.agent?.type ?? 'agent';
  const head = h(
    'button',
    { type: 'button', class: 'ap-agent__head', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    icon('hubot', 'ap-agent__icon'),
    h('span', { class: 'ap-agent__kind' }, kind),
    h('span', { class: 'ap-agent__task' }, s.agent?.description ?? 'Subagent'),
    h('span', { class: 'ap-agent__side' }, all.length ? `${all.length} step${all.length === 1 ? '' : 's'}` : ''),
    live ? icon('loading', 'ap-spin') : s.status === 'fail' ? icon('error') : icon('check'),
  );
  head.addEventListener('click', () => {
    const now = root.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(now));
    store.ui.stepChoice.set(key, now);
  });
  const body = h('div', { class: 'ap-agent__body' });
  if (s.agent?.prompt) {
    const promptOpen = store.ui.openStepItems.has(`${key}:prompt`);
    const row = h('button', { type: 'button', class: 'ap-agent__prompt-toggle' }, icon('chevron-right', 'ap-chev'), 'Task given to the subagent');
    const text = h('pre', { class: 'ap-agent__prompt' }, s.agent.prompt);
    const wrap = h('div', { class: `ap-agent__section${promptOpen ? ' is-open' : ''}` }, row, text);
    row.addEventListener('click', () => {
      const now = wrap.classList.toggle('is-open');
      if (now) store.ui.openStepItems.add(`${key}:prompt`);
      else store.ui.openStepItems.delete(`${key}:prompt`);
    });
    body.append(wrap);
  }
  const tree = h('ol', { class: 'ap-agent__tree' });
  const draw = (parentId: string, into: HTMLElement) => {
    for (const c of kids.get(parentId) ?? []) {
      if (c.agent) {
        into.append(h('li', { class: 'ap-agent__nested' }, subagentCard(c, kids)));
      } else {
        into.append(stepEl(c));
      }
    }
  };
  draw(s.id, tree);
  if (tree.childElementCount) body.append(tree);
  else if (live) body.append(h('p', { class: 'ap-agent__wait' }, 'Starting…'));
  if (s.output || (!live && s.summary)) {
    body.append(h('div', { class: 'ap-agent__result' }, h('p', { class: 'ap-agent__label' }, 'Result'), h('pre', {}, s.output ?? s.summary ?? '')));
  }
  root.append(head, body);
  return root;
}

function stepGroup(m: ChatMessage, steps: StepRecord[], key: string): HTMLElement {
  void m;
  const live = steps.some((s) => s.status === 'running' || s.status === 'ask');
  const asking = steps.some((s) => s.status === 'ask');
  const open = asking || (store.ui.stepChoice.get(key) ?? live);
  const root = h('div', { class: `ap-steps${open ? ' is-open' : ''}${live ? ' is-live' : ''}` });
  const summary = h(
    'button',
    { type: 'button', class: 'ap-steps__summary', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    h('span', {}, summarize(steps) + (asking ? ' · Waiting for you' : '')),
    live && !asking ? icon('loading', 'ap-spin ap-steps__spin') : null,
  );
  summary.addEventListener('click', () => {
    const now = root.classList.toggle('is-open');
    summary.setAttribute('aria-expanded', String(now));
    store.ui.stepChoice.set(key, now);
  });
  const list = h('ol', { class: 'ap-steps__list' });
  for (const s of steps) list.append(stepEl(s));
  root.append(summary, list);
  return root;
}

/** An edit as Cursor shows it: file, +/−, a few lines of the change; click for all of it. */
function editCard(s: StepRecord): HTMLElement {
  const open = store.ui.openStepItems.has(s.id);
  const name = (s.path ?? '').split('/').pop() || s.title.replace(/^Edited |`/g, '');
  const rows = renderDiff(s.diff ?? '', langFromPath(s.path ?? ''));
  const nameEl = h('span', { class: 'ap-edit__name', title: s.path ? `Open ${s.path}` : '' }, name);
  if (s.path) {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'openFile', path: s.path!, line: s.line });
    });
  }
  const head = h(
    'header',
    { class: 'ap-edit__head', role: 'button', tabindex: '0', 'aria-expanded': String(open) },
    s.status === 'running' ? icon('loading', 'ap-spin') : icon(fileIcon(s.path ?? '')),
    nameEl,
    h('span', { class: 'ap-file__stat' }, h('span', { class: 'ap-add' }, `+${s.additions ?? 0}`), h('span', { class: 'ap-del' }, `−${s.deletions ?? 0}`)),
    s.status === 'fail' ? h('span', { class: 'ap-step__side ap-edit__fail' }, 'Failed') : null,
  );
  const body = h('div', { class: 'ap-edit__body ap-diff' }, h('div', { class: 'ap-diff__rows' }, ...rows));
  const card = h('article', { class: `ap-edit${open ? ' is-open' : ''}` }, head, body);
  const toggle = () => {
    const now = card.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(now));
    if (now) store.ui.openStepItems.add(s.id);
    else store.ui.openStepItems.delete(s.id);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') toggle();
  });
  body.addEventListener('click', () => {
    if (!card.classList.contains('is-open')) toggle();
  });
  return card;
}

/** The turn's changed files, folded into one row: open it for Accept, Reject and full diffs. */
function filesSection(m: ChatMessage, latest: Map<string, string>): HTMLElement | null {
  const cards = fileCards(m, latest);
  if (!cards || !m.files?.length) return null;
  const key = `${m.id}:files`;
  const pending = m.files.filter((f) => latest.get(f.relPath) === m.id && store.host!.fileStates[f.relPath] === 'pending').length;
  const open = store.ui.openStepItems.has(key);
  let add = 0;
  let del = 0;
  for (const f of m.files) {
    add += f.additions;
    del += f.deletions;
  }
  const n = m.files.length;
  const wrap = h('div', { class: `ap-turn-files${open ? ' is-open' : ''}` });
  const head = h(
    'button',
    { type: 'button', class: 'ap-steps__summary', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    h('span', {}, `Changed ${n} file${n === 1 ? '' : 's'}`),
    h('span', { class: 'ap-changes__stat' }, h('span', { class: 'ap-add' }, `+${add}`), h('span', { class: 'ap-del' }, `−${del}`)),
    pending ? h('span', { class: 'ap-muted' }, `${pending} to review`) : null,
  );
  head.addEventListener('click', () => {
    const now = wrap.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(now));
    if (now) store.ui.openStepItems.add(key);
    else store.ui.openStepItems.delete(key);
  });
  wrap.append(head, cards);
  return wrap;
}

function markdown(text: string): HTMLElement {
  const md = h('div', { class: 'ap-md' });
  try {
    md.innerHTML = renderMarkdown(text);
  } catch {
    md.textContent = text; // e.g. absurdly deep quoting: show it plain rather than break the thread
  }
  wireMarkdown(md);
  return md;
}

/** Copy buttons, links and file paths inside rendered markdown. */
function wireMarkdown(md: HTMLElement): void {
  md.querySelectorAll<HTMLElement>('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      const code = document.getElementById(b.dataset.copy!)?.textContent ?? '';
      void navigator.clipboard.writeText(code);
      b.replaceChildren(icon('check'));
      setTimeout(() => b.replaceChildren(icon('copy')), 1200);
    });
  });
  md.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^https:\/\//.test(href)) post({ type: 'openExternal', url: href });
      else if (href && !href.includes('://')) openPath(href);
    });
  });
  md.querySelectorAll<HTMLElement>('code.ap-path').forEach((c) => {
    c.addEventListener('click', () => openPath(c.dataset.path ?? c.textContent ?? ''));
  });
}

/** `src/a.ts:12` or `src/a.ts#L12` opens the file at that line. */
function openPath(raw: string): void {
  const m = /^(?:\.\/)?(.+?)(?::(\d+)(?::\d+)?|#L(\d+).*)?$/.exec(raw.trim());
  if (!m) return;
  const line = m[2] ?? m[3];
  post({ type: 'openFile', path: m[1], line: line ? Number(line) - 1 : undefined });
}

function thinkingEl(m: ChatMessage, live: boolean): HTMLElement {
  const open = store.ui.openThinking.has(m.id);
  const wrap = h('div', { class: `ap-thinking${open ? ' is-open' : ''}` });
  const head = h(
    'button',
    { type: 'button', class: 'ap-steps__summary', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    live ? h('span', { class: 'ap-shimmer' }, 'Thinking') : h('span', {}, 'Thought'),
  );
  head.addEventListener('click', () => {
    const now = wrap.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(now));
    if (now) store.ui.openThinking.add(m.id);
    else store.ui.openThinking.delete(m.id);
  });
  wrap.append(head, h('div', { class: 'ap-thinking__body' }, m.thinking ?? ''));
  return wrap;
}

// ----- tool steps -----

function stepsEl(m: ChatMessage): HTMLElement {
  const steps = m.steps!;
  const live = steps.some((s) => s.status === 'running' || s.status === 'ask');
  const asking = steps.some((s) => s.status === 'ask');
  // A running group opens by itself; once the person opens or closes it, that sticks.
  const open = asking || (store.ui.stepChoice.get(m.id) ?? live);
  const root = h('div', { class: `ap-steps${open ? ' is-open' : ''}${live ? ' is-live' : ''}` });
  const summary = h(
    'button',
    { type: 'button', class: 'ap-steps__summary', 'aria-expanded': String(open) },
    icon('chevron-right', 'ap-chev'),
    h('span', {}, summarize(steps) + (asking ? ' · Waiting for you' : '')),
  );
  summary.addEventListener('click', () => {
    const now = root.classList.toggle('is-open');
    summary.setAttribute('aria-expanded', String(now));
    store.ui.stepChoice.set(m.id, now);
  });
  const list = h('ol', { class: 'ap-steps__list' });
  const kids = childrenOf(steps);
  for (const s of steps) {
    if (s.todos || s.parentId) continue;
    list.append(s.agent ? h('li', {}, subagentCard(s, kids)) : stepEl(s));
  }
  root.append(summary, list);
  return root;
}

function stepKind(tool: string): 'read' | 'run' | 'search' | 'edit' | 'web' | 'other' {
  const t = tool.toLowerCase();
  if (t === 'bash' || t.includes('shell') || t.includes('terminal')) return 'run';
  if (t === 'grep' || t === 'glob' || t.includes('grep') || t.includes('glob') || t === 'ls' || t.startsWith('ls')) return 'search';
  if (t.includes('edit') || t.includes('write') || t.includes('delete')) return 'edit';
  if (t.includes('web')) return 'web';
  if (t.includes('todo')) return 'other';
  if (t === 'read' || t.startsWith('read')) return 'read';
  return 'other';
}

/** "Read 3 files · Ran 2 commands · Edited 1 file". */
export function summarize(steps: StepRecord[]): string {
  const n = { read: 0, run: 0, search: 0, edit: 0, web: 0, other: 0 };
  for (const s of steps) if (!s.todos) n[stepKind(s.tool)] += 1;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (n.read) parts.push(`Read ${plural(n.read, 'file', 'files')}`);
  if (n.search) parts.push(`Searched ${n.search}`);
  if (n.run) parts.push(`Ran ${plural(n.run, 'command', 'commands')}`);
  if (n.edit) parts.push(`Edited ${plural(n.edit, 'file', 'files')}`);
  if (n.web) parts.push(`Web ${n.web}`);
  if (n.other) parts.push(`${plural(n.other, 'other step', 'other steps')}`);
  return parts.join(' · ') || 'Working';
}

function stepIcon(s: StepRecord): HTMLElement {
  if (s.status === 'running') return icon('loading', 'ap-spin');
  if (s.status === 'ask') return icon('shield');
  if (s.status === 'denied') return icon('circle-slash');
  switch (stepKind(s.tool)) {
    case 'run':
      return icon('terminal');
    case 'search':
      return icon('search');
    case 'edit':
      return icon('edit');
    case 'web':
      return icon('globe');
    case 'read':
      return icon('file');
    default:
      return icon('tools');
  }
}

/** An element whose content is already-escaped highlight HTML. */
function html(tag: string, cls: string, markup: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  el.innerHTML = markup;
  return el;
}

/** A command step opened: the command line, then everything it printed, with copy. */
function terminalBlock(command: string, output: string, status: StepRecord['status']): HTMLElement {
  const copy = h('button', { type: 'button', class: 'ap-terminal__copy', title: 'Copy output' }, icon('copy'));
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(`$ ${command}${output ? `\n${output}` : ''}`).catch(() => undefined);
  });
  return h(
    'div',
    { class: 'ap-terminal' },
    copy,
    html('pre', 'ap-terminal__cmd', `<span class="ap-syn-comment">$</span> ${highlightShell(command)}`),
    output ? html('pre', 'ap-terminal__out', highlightOutput(output)) : h('p', { class: 'ap-terminal__empty' }, status === 'running' ? 'Running…' : 'No output'),
  );
}

function stepEl(s: StepRecord): HTMLElement {
  const cls = `ap-step${s.status === 'running' ? ' ap-step--running' : ''}${s.status === 'fail' ? ' ap-step--failed' : ''}${s.status === 'denied' ? ' ap-step--denied' : ''}${s.status === 'ask' ? ' ap-step--ask' : ''}`;
  const output = s.command || s.output ? (s.output ?? '') : s.summary && (s.summary.includes('\n') || s.summary.length > 48) ? s.summary : undefined;
  const terminal = Boolean(s.command);
  const diff = s.diff ? s.diff : undefined;
  const counts = s.additions !== undefined || s.deletions !== undefined;
  const title = s.status === 'ask' ? s.title.replace(/^Ran /, 'Run ').replace(/^Edited /, 'Edit ').replace(/^Deleted /, 'Delete ') : s.title;

  const text = h('span', { class: 'ap-step__text' }, ...inlineCode(title));
  if (s.path) {
    // The file name opens the file, at the line the step worked on.
    const code = text.querySelector('code') ?? text;
    code.classList.add('ap-step__file');
    code.setAttribute('title', `Open ${s.path}`);
    code.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'openFile', path: s.path!, line: s.line });
    });
  }

  let side: Node | null = null;
  if (s.status === 'denied') side = document.createTextNode('Denied');
  else if (counts) side = h('span', {}, h('span', { class: 'ap-add' }, `+${s.additions ?? 0}`), ' ', h('span', { class: 'ap-del' }, `−${s.deletions ?? 0}`));
  else if (s.status === 'fail') side = document.createTextNode(output ? 'Failed' : s.summary || 'Failed');
  else if (!output && s.summary) side = document.createTextNode(s.summary);

  const expandable = Boolean(terminal || output || diff);
  const row = h(
    'div',
    { class: `${cls}${expandable ? ' ap-step--expandable' : ''}`, title: title.replace(/`/g, '') },
    expandable ? icon('chevron-right', 'ap-chev ap-step__chev') : null,
    stepIcon(s),
    text,
    side ? h('span', { class: 'ap-step__side' }, side) : null,
  );

  if (!expandable && !s.ask) return h('li', {}, row);
  const open = store.ui.openStepItems.has(s.id);
  const wrap = h('li', { class: `ap-step-wrap${open ? ' is-open' : ''}` }, row);
  if (expandable) {
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    const toggle = () => {
      const now = wrap.classList.toggle('is-open');
      if (now) store.ui.openStepItems.add(s.id);
      else store.ui.openStepItems.delete(s.id);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') toggle();
    });
    if (diff) {
      const rows = h('div', { class: 'ap-diff__rows' }, ...renderDiff(diff, langFromPath(s.path ?? '')));
      wrap.append(h('div', { class: 'ap-step__diff ap-diff' }, rows));
    } else {
      wrap.append(terminal ? terminalBlock(s.command!, output ?? '', s.status) : h('pre', { class: 'ap-output' }, output!));
    }
  }
  if (s.ask) {
    const ask = s.ask;
    const answer = (decision: 'allow' | 'allow-session' | 'deny') => post({ type: 'permission', id: ask.id, decision });
    wrap.append(
      h(
        'div',
        { class: 'ap-ask' },
        h('p', { class: 'ap-ask__title' }, ask.title),
        ask.detail ? (/^Claude|^Cursor/.test(ask.title) && /command/.test(ask.title) ? html('pre', 'ap-ask__cmd', highlightShell(ask.detail)) : h('pre', {}, ask.detail)) : null,
        h(
          'div',
          { class: 'ap-ask__actions' },
          button('Deny', { onClick: () => answer('deny') }),
          button('Allow for this chat', { variant: 'secondary', onClick: () => answer('allow-session') }),
          button('Allow', { variant: 'primary', onClick: () => answer('allow') }),
        ),
      ),
    );
  }
  return wrap;
}

// ----- errors and footers -----

function errorEl(m: ChatMessage): HTMLElement {
  const text = m.meta!.error!;
  const actions = h('div', { class: 'ap-alert__actions' });
  const engine = m.engine ?? 'claude';
  if (/out of usage/i.test(text) && engine === 'cursor') {
    actions.append(button('Switch to Auto and retry', { variant: 'secondary', onClick: () => post({ type: 'retry', messageId: m.id, model: 'auto' }) }));
  }
  if (/isn't signed in/i.test(text)) {
    actions.append(
      button('Open terminal', {
        variant: 'secondary',
        icon: 'terminal',
        onClick: () => post({ type: 'runInTerminal', command: engine === 'cursor' ? 'agent login' : 'claude' }),
      }),
    );
  }
  actions.append(button('Retry', { onClick: () => post({ type: 'retry', messageId: m.id }), disabled: isRunning() }));
  return h('div', { class: 'ap-alert ap-alert--error' }, icon('error'), h('span', {}, ...inlineCode(text)), actions);
}

function footEl(m: ChatMessage): HTMLElement | null {
  const meta = m.meta;
  if (!meta) return null;
  const bits: string[] = [];
  if (meta.stopped) bits.push('Stopped');
  else if (meta.durationMs !== undefined && !meta.error) bits.push(`Worked for ${duration(meta.durationMs)}`);
  const files = m.files?.length ?? 0;
  if (files) bits.push(`${files} file${files === 1 ? '' : 's'}`);
  const u = meta.usage;
  if (u?.costUsd !== undefined) bits.push(money(u.costUsd));
  else if (u && (u.inputTokens || u.outputTokens)) {
    bits.push(`${tokens((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0))} tokens`);
  }
  if (!bits.length) return null;
  const copy = h('button', { type: 'button', class: 'ap-icon-btn ap-turn__copy', title: 'Copy answer', 'aria-label': 'Copy answer' }, icon('copy'));
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(m.text);
    copy.replaceChildren(icon('check'));
    setTimeout(() => copy.replaceChildren(icon('copy')), 1200);
  });
  return h('div', { class: 'ap-turn__foot' }, ...bits.map((b) => h('span', {}, b)), m.text ? copy : null);
}

// ----- hand-off plan card -----

function planCard(m: ChatMessage): HTMLElement {
  const plan = m.plan!;
  const running = isRunning(m.id);
  const editing = store.ui.editingPlan === m.id;
  const builder = plan.builder === 'cursor' ? 'Cursor' : 'Claude';
  const card = h('article', { class: 'ap-plan', 'data-state': plan.state === 'built' ? 'built' : 'ready' });

  card.append(
    h(
      'header',
      { class: 'ap-plan__head' },
      icon('checklist'),
      h('strong', {}, 'Plan'),
      plan.state === 'built' ? h('span', { class: 'ap-plan__status' }, '· Built by ', engineTag(plan.builder)) : null,
      plan.state === 'building' ? h('span', { class: 'ap-muted' }, `· Building with ${builder}…`) : null,
      h('span', { class: 'ap-spacer' }),
      plan.state === 'ready' && !running && !editing
        ? button('Edit plan', {
            icon: 'edit',
            onClick: () => {
              store.ui.editingPlan = m.id;
              rerenderMessage(m.id);
            },
          })
        : null,
    ),
  );

  if (running) {
    card.append(h('div', { class: 'ap-plan__body ap-md ap-md--live' }, m.text || '', h('span', { class: 'ap-caret' })));
    return card;
  }

  if (editing) {
    const ta = h('textarea', { class: 'ap-plan__editor', rows: 10, 'aria-label': 'Plan' });
    ta.value = m.text;
    card.append(
      h('div', { class: 'ap-plan__body' }, ta),
      h(
        'footer',
        { class: 'ap-plan__foot' },
        h('span', { class: 'ap-spacer' }),
        button('Cancel', {
          onClick: () => {
            store.ui.editingPlan = null;
            rerenderMessage(m.id);
          },
        }),
        button('Save', {
          variant: 'primary',
          onClick: () => {
            store.ui.editingPlan = null;
            post({ type: 'savePlan', messageId: m.id, text: ta.value });
          },
        }),
      ),
    );
    requestAnimationFrame(() => ta.focus());
    return card;
  }

  const body = markdown(m.text || '_The planner returned no plan._');
  body.classList.add('ap-plan__body');
  card.append(body);
  if (plan.state === 'ready') {
    const review = h('input', { type: 'checkbox', checked: plan.reviewAfter });
    card.append(
      h(
        'footer',
        { class: 'ap-plan__foot' },
        h('span', {}, 'Builder'),
        engineTag(plan.builder),
        h('label', { class: 'ap-check' }, review, 'Review after'),
        button(`Build with ${builder}`, {
          variant: 'primary',
          disabled: isRunning(),
          onClick: () => {
            post({ type: 'setHandoff', reviewAfter: review.checked });
            post({ type: 'buildPlan', messageId: m.id });
          },
        }),
      ),
    );
  }
  return card;
}

function rerenderMessage(id: string): void {
  const r = rendered.get(id);
  if (!r) return;
  rendered.delete(id);
  const list = r.el.closest<HTMLElement>('.ap-thread');
  if (list) renderThread(list);
}

// ----- empty state -----

function emptyState(): HTMLElement {
  const keys: [string[], string][] = [
    [['Enter'], 'Send'],
    [['Shift', 'Enter'], 'New line'],
    [['@'], 'Add files, code, git, problems, chats or rules'],
    [['⌘', '.'], 'Stop'],
  ];
  const dl = h('dl', { class: 'ap-empty__keys' });
  for (const [k, v] of keys) {
    dl.append(h('dt', {}, ...k.flatMap((x) => [h('span', { class: 'ap-kbd' }, x), ' '])), h('dd', {}, v));
  }
  const recent = store.host!.threads.filter((t) => t.id !== store.host!.thread.id).slice(0, 5);
  const wrap = h(
    'div',
    { class: 'ap-empty-wrap' },
    h(
      'div',
      { class: 'ap-empty' },
      h('p', { class: 'ap-empty__title' }, 'New chat'),
      h('p', { class: 'ap-muted ap-empty__lead' }, 'Claude and Cursor share this thread. Pick who answers under the box, message by message.'),
      dl,
    ),
  );
  if (recent.length) {
    const list = h('ul', { class: 'ap-history' });
    for (const t of recent) {
      const li = h(
        'li',
        { class: 'ap-history__item', tabindex: '0' },
        h('span', { class: 'ap-history__title' }, t.title),
        h('span', { class: 'ap-history__time' }, relativeTime(t.updatedAt)),
        h('span', { class: 'ap-history__meta' }, ...t.engines.map((e) => engineTag(e)), t.files ? h('span', {}, `${t.files} file${t.files === 1 ? '' : 's'}`) : null),
      );
      li.addEventListener('click', () => post({ type: 'loadThread', id: t.id }));
      list.append(li);
    }
    wrap.append(h('p', { class: 'ap-section-label' }, 'Recent in this workspace'), list);
  }
  return wrap;
}
