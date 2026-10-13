import { store, post, savePersisted, isRunning } from './store';
import { h, icon, iconButton } from './dom';
import { renderHeader, renderHistory } from './header';
import { renderThread, resetThread, paintStream } from './thread';
import { renderChanges, applyPatch } from './files';
import { createComposer } from './composer';
import { receiveMentions } from './mentionmenu';
import type { ChatMessage, HostState, StepRecord } from './store';
import type { MessagePart } from '../src/threads';

/** Mirror the host's part-building so the live timeline matches what gets saved. */
function addToParts(m: ChatMessage, kind: 'text' | 'thinking' | 'step', value: string): void {
  const parts: MessagePart[] = (m.parts ??= []);
  const last = parts[parts.length - 1];
  if (kind !== 'thinking' && last?.kind === 'thinking' && !last.endedAt) last.endedAt = Date.now();
  if (kind === 'text') {
    if (last?.kind === 'text') last.text += value;
    else parts.push({ kind: 'text', text: value.replace(/^\n+/, '') });
  } else if (kind === 'thinking') {
    if (last?.kind === 'thinking' && !last.endedAt) last.text += value;
    else parts.push({ kind: 'thinking', text: value, startedAt: Date.now() });
  } else if (!parts.some((p) => p.kind === 'steps' && p.ids.includes(value))) {
    if (last?.kind === 'steps') last.ids.push(value);
    else parts.push({ kind: 'steps', ids: [value] });
  }
}

/**
 * Agent Panel webview. The shell is built once; each region updates on its own so the
 * composer keeps focus and the thread keeps its scroll while the host streams.
 */

const app = document.getElementById('app')!;
const headerEl = h('div', { class: 'ap-header-host' });
const bannerEl = h('div', { class: 'ap-banners' });
const threadEl = h('main', { class: 'ap-thread' });
const historyEl = h('main', { class: 'ap-thread ap-thread--history' });
const changesEl = h('div', { class: 'ap-changes' });
const composer = createComposer();
const dock = h('footer', { class: 'ap-dock' }, changesEl, composer.el);
app.replaceChildren(h('div', { class: 'ap' }, headerEl, bannerEl, threadEl, historyEl, dock));

let threadId: string | null = null;
let streamFrame = 0;
const dirty = new Set<string>();

function renderAll(): void {
  if (!store.host) return;
  renderHeader(headerEl, renderAll);
  renderBanners();
  const history = store.ui.view === 'history';
  threadEl.hidden = history;
  historyEl.hidden = !history;
  if (history) renderHistory(historyEl);
  else renderThread(threadEl);
  renderChanges(changesEl);
  composer.update();
}

function renderBanners(): void {
  const host = store.host!;
  const items: HTMLElement[] = [];
  if (!host.gitOk && host.gitMessage) {
    items.push(h('div', { class: 'ap-alert ap-alert--warn ap-banner' }, icon('warning'), h('span', {}, host.gitMessage)));
  }
  for (const n of store.ui.notices) {
    const close = iconButton('close', 'Dismiss', () => {
      store.ui.notices = store.ui.notices.filter((x) => x.id !== n.id);
      renderBanners();
    });
    close.classList.add('ap-alert__close');
    items.push(h('div', { class: `ap-alert ap-alert--${n.level === 'error' ? 'error' : 'info'} ap-banner`, role: 'status' }, icon(n.level === 'error' ? 'error' : 'info'), h('span', {}, n.text), close));
  }
  bannerEl.replaceChildren(...items);
}

let noticeSeq = 0;
function notice(text: string, level: 'info' | 'error'): void {
  const id = (noticeSeq += 1);
  store.ui.notices.push({ id, text, level });
  renderBanners();
  if (level === 'info') {
    setTimeout(() => {
      store.ui.notices = store.ui.notices.filter((x) => x.id !== id);
      renderBanners();
    }, 6000);
  }
}

function applyState(next: HostState): void {
  savePersisted({ threadId: next.thread.id });
  if (threadId !== next.thread.id) {
    threadId = next.thread.id;
    store.messages.clear();
    store.patches.clear();
    store.ui.openFiles.clear();
    store.ui.openSteps.clear();
    store.ui.openThinking.clear();
    store.ui.showAllFiles.clear();
    store.ui.editingPlan = null;
    resetThread(threadEl);
  }
  // The host is the source of truth, except for text still streaming in.
  const running = next.running?.messageId;
  const ids = new Set<string>();
  for (const m of next.thread.messages) {
    ids.add(m.id);
    const local = store.messages.get(m.id);
    if (local && m.id === running && local.text.length > m.text.length) {
      store.messages.set(m.id, { ...m, text: local.text, thinking: local.thinking });
    } else {
      store.messages.set(m.id, m);
    }
  }
  for (const id of [...store.messages.keys()]) if (!ids.has(id)) store.messages.delete(id);
  store.host = next;
  renderAll();
}

let renderFrame = 0;
/** Bursts of step events (a subagent running many tools) repaint once per frame, not once per event. */
function scheduleRender(): void {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    try {
      renderThread(threadEl);
    } catch (err) {
      console.error('Agent Panel: render failed', err);
    }
  });
}

function scheduleStream(id: string): void {
  dirty.add(id);
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    for (const d of dirty) paintStream(d);
    dirty.clear();
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  try {
    handleHostMessage(event.data);
  } catch (err) {
    console.error('Agent Panel: host message failed', err);
  }
});

function handleHostMessage(data: unknown): void {
  const msg = data as { type: string } & Record<string, unknown>;
  const host = store.host;
  switch (msg.type) {
    case 'state':
      applyState(msg as unknown as HostState);
      break;
    case 'running':
      if (host) {
        host.running = msg.running as HostState['running'];
        renderAll();
      }
      break;
    case 'message': {
      // Another tab's chat: it's saved on the host and shows when that tab opens.
      if (host && msg.threadId && msg.threadId !== host.thread.id) break;
      const m = msg.message as ChatMessage;
      store.messages.set(m.id, { ...m });
      if (host && !host.thread.messages.some((x) => x.id === m.id)) host.thread.messages.push(m);
      if (host && m.role === 'user' && host.thread.title === 'New chat') host.thread.title = m.text.slice(0, 48);
      renderAll();
      break;
    }
    case 'text':
    case 'thinking': {
      const m = store.messages.get(msg.id as string);
      if (!m) break;
      const before = m.parts?.length ?? 0;
      if (msg.type === 'text') m.text += msg.delta as string;
      else m.thinking = (m.thinking ?? '') + (msg.delta as string);
      addToParts(m, msg.type, msg.delta as string);
      // A new part (text after steps, say) needs the message laid out again.
      if ((m.parts?.length ?? 0) !== before) renderThread(threadEl);
      else scheduleStream(m.id);
      break;
    }
    case 'step': {
      const m = store.messages.get(msg.messageId as string);
      if (!m) break;
      const step = msg.step as StepRecord;
      const steps = (m.steps = [...(m.steps ?? [])]);
      const i = steps.findIndex((s) => s.id === step.id);
      if (i >= 0) steps[i] = step;
      else steps.push(step);
      addToParts(m, 'step', step.id);
      scheduleRender();
      break;
    }
    case 'turn-done': {
      const m = msg.message as ChatMessage;
      if (host && msg.threadId && msg.threadId !== host.thread.id) {
        host.running = null;
        renderAll();
        break;
      }
      store.messages.set(m.id, m);
      if (host) {
        const i = host.thread.messages.findIndex((x) => x.id === m.id);
        if (i >= 0) host.thread.messages[i] = m;
        host.running = null;
        renderAll();
      }
      break;
    }
    case 'usage':
      if (host) {
        host.usage = msg.usage as HostState['usage'];
        renderHeader(headerEl, renderAll);
      }
      break;
    case 'patch':
      applyPatch(msg.key as string, (msg.patch as string) ?? '');
      break;
    case 'mentions':
      if (receiveMentions(msg.requestId as number, msg.groups as never)) composer.update();
      break;
    case 'external':
      store.external = { claude: msg.claude as never, cursor: msg.cursor as never, loadingCursor: Boolean(msg.loadingCursor) };
      if (store.ui.view === 'history') renderHistory(historyEl);
      break;
    case 'addMention': {
      const item = msg.item as never as { kind: string; id: string };
      if (!store.ui.mentions.some((x) => x.kind === item.kind && x.id === item.id)) store.ui.mentions.push(msg.item as never);
      store.ui.view = 'chat';
      renderAll();
      composer.focus();
      break;
    }
    case 'notice':
      notice(String(msg.text ?? ''), msg.level === 'error' ? 'error' : 'info');
      break;
    default:
      break;
  }
}

// Close menus on an outside click; ⌘. stops; Escape closes the open menu.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (!store.ui.menu || t.closest('.ap-menu') || t.closest('.ap-picker') || t.closest('.ap-usage')) return;
  store.ui.menu = null;
  renderAll();
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '.') {
    e.preventDefault();
    if (isRunning()) post({ type: 'stop' });
  } else if (e.key === 'Escape' && store.ui.menu) {
    store.ui.menu = null;
    renderAll();
    composer.focus();
  }
});

document.addEventListener('ap-edit', (e) => composer.setText(String((e as CustomEvent).detail ?? '')));

threadEl.append(h('div', { class: 'ap-pending' }, icon('loading', 'ap-spin'), 'Loading…'));
post({ type: 'ready' });
