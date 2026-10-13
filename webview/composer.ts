import { store, post, isRunning, saveDraft, loadDraft } from './store';
import { h, icon, engineTag, tokens, append, showImage } from './dom';
import { modelButtonLabel, modelMenu } from './modelpicker';
import { mentionAtCaret, mentionKey, mentionPopover, openMention, closeMention } from './mentionmenu';
import { mentionIcon } from './thread';
import type { ChatMessage, EngineId } from './store';

const MODES = [
  { value: 'agent', label: 'Agent', icon: 'zap', desc: 'Edits files and runs commands on its own' },
  { value: 'auto', label: 'Auto', icon: 'rocket', desc: 'Runs every command and edit without asking. Use it in folders you trust.' },
  { value: 'ask', label: 'Ask first', icon: 'shield', desc: 'Asks before each edit or command. Cursor proposes edits without applying them.' },
  { value: 'plan', label: 'Plan', icon: 'checklist', desc: 'Reads only, then proposes a plan' },
  { value: 'handoff', label: 'Hand-off', icon: 'arrow-swap', desc: 'One engine plans, the other builds' },
] as const;

const PLACEHOLDER: Record<string, string> = {
  auto: 'Ask, @ for context, / for commands',
  agent: 'Ask, @ for context, / for commands',
  ask: 'Ask, @ for context, / for commands',
  plan: 'Ask for a plan, @ for context',
  handoff: 'Describe the change to plan',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface Composer {
  el: HTMLElement;
  update(): void;
  focus(): void;
  /** Put text in the box, e.g. to edit an earlier message. */
  setText(text: string): void;
}

/**
 * The composer is built once and then only updated, so typing, focus and the caret
 * survive every state message from the host.
 */
export function createComposer(): Composer {
  const el = h('div', { class: 'ap-composer' });
  const queueEl = h('div', { class: 'ap-queue' });
  const handoffRow = h('div', { class: 'ap-handoff-row' });
  const chips = h('div', { class: 'ap-composer__chips' });
  const ta = h('textarea', { class: 'ap-composer__input', rows: 1, 'aria-label': 'Message' });
  const bar = h('div', { class: 'ap-composer__bar' });
  const seg = h('div', { class: 'ap-seg', role: 'radiogroup', 'aria-label': 'Engine' });
  const modelBtn = picker('model');
  const modeBtn = picker('mode');
  modeBtn.classList.add('ap-picker--mode');
  const contextBtn = h('button', { type: 'button', class: 'ap-context' });
  const imageBtn = h('button', { type: 'button', class: 'ap-icon-btn', title: 'Attach images', 'aria-label': 'Attach images' }, icon('file-media'));
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const atBtn = h('button', { type: 'button', class: 'ap-icon-btn', title: 'Add context (@)', 'aria-label': 'Add context' }, icon('mention'));
  const sendBtn = h('button', { type: 'button', class: 'ap-send' });
  const popHost = h('div', { class: 'ap-composer__pop' });

  bar.append(seg, modelBtn, modeBtn, h('span', { class: 'ap-spacer' }), contextBtn, imageBtn, atBtn, sendBtn, fileInput);
  el.append(popHost, queueEl, handoffRow, chips, ta, bar);

  ta.value = loadDraft();

  const autogrow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  };

  const update = () => {
    const host = store.host;
    if (!host) return;
    const t = host.thread;
    const running = isRunning();
    el.dataset.engine = t.engine;
    ta.placeholder = running ? 'Queue a follow-up' : PLACEHOLDER[t.mode] ?? PLACEHOLDER.agent;

    seg.replaceChildren(
      ...(['claude', 'cursor'] as EngineId[]).map((e) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.engine === e), title: e === 'claude' ? 'Claude: your Claude plan' : 'Cursor: your Cursor plan' }, engineTag(e));
        b.addEventListener('click', () => {
          if (t.engine !== e) post({ type: 'setEngine', engine: e });
        });
        return b;
      }),
    );

    setPickerLabel(modelBtn, modelButtonLabel(t.engine), store.ui.menu === 'model');
    const mode = MODES.find((m) => m.value === t.mode) ?? MODES[0];
    setPickerLabel(modeBtn, mode.label, store.ui.menu === 'mode', mode.icon);

    paintContext(t.engine);
    paintQueue();

    handoffRow.hidden = t.mode !== 'handoff';
    if (t.mode === 'handoff') {
      const swap = (which: 'planner' | 'builder', cur: EngineId) => {
        const b = h('button', { type: 'button', class: 'ap-picker', title: 'Switch engine' }, engineTag(cur), icon('chevron-down'));
        b.addEventListener('click', () => post({ type: 'setHandoff', [which]: cur === 'claude' ? 'cursor' : 'claude' }));
        return b;
      };
      const review = h('input', { type: 'checkbox', checked: t.reviewAfter ?? true });
      review.addEventListener('change', () => post({ type: 'setHandoff', reviewAfter: review.checked }));
      handoffRow.replaceChildren(
        h('span', {}, 'Plan with'),
        swap('planner', (t.planner ?? 'claude') as EngineId),
        icon('arrow-right'),
        h('span', {}, 'Build with'),
        swap('builder', (t.builder ?? 'cursor') as EngineId),
        h('label', { class: 'ap-check' }, review, 'Review after'),
      );
    }

    paintChips();

    sendBtn.replaceChildren(icon(running && !hasDraft() ? 'debug-stop' : 'arrow-up'));
    sendBtn.classList.toggle('ap-send--stop', running && !hasDraft());
    sendBtn.title = running ? (hasDraft() ? 'Queue (Enter)' : 'Stop (⌘.)') : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', running ? (hasDraft() ? 'Queue' : 'Stop') : 'Send');
    sendBtn.disabled = !running && !hasDraft();

    // An open menu stays put while the agent works: it's rebuilt only when what it
    // shows changes, never just because a new event arrived.
    const sel = store.host!.selection;
    const key = store.ui.slash
      ? `slash:${store.ui.slash.query}:${store.ui.slash.active}:${store.ui.slash.showAll}:${(store.host?.slashItems ?? []).length}`
      : store.ui.mention
        ? `mention:${store.ui.mention.requestId}:${store.ui.mention.active}:${store.ui.mention.groups.length}:${store.ui.mention.scope ?? ''}`
        : store.ui.menu === 'model'
          ? `model:${t.engine}:${sel.claudeModel}:${sel.claudeEffort}:${sel.claudeFast}:${sel.cursorModel}:${store.host!.catalogs.cursor?.source}:${store.host!.catalogs.claude.source}:${store.host!.cursorSignedOut}`
          : store.ui.menu === 'mode'
            ? `mode:${t.mode}`
            : store.ui.menu === 'context'
              ? `context:${t.engine}:${store.messages.size}`
              : '';
    if (key !== popKey) {
      popKey = key;
      const pop = store.ui.slash
        ? slashMenu()
        : store.ui.mention
          ? mentionPopover(ta, update)
          : store.ui.menu === 'model'
            ? modelMenu(t.engine, closeMenus)
            : store.ui.menu === 'mode'
              ? modeMenu()
              : store.ui.menu === 'context'
                ? contextMenu(t.engine)
                : null;
      popHost.replaceChildren(...(pop ? [pop] : []));
    }
  };
  let popKey = '';

  const hasDraft = () => Boolean(ta.value.trim());

  function paintChips(): void {
    const items = [
      ...store.ui.images.map((img, i) => {
        const chip = h(
          'span',
          { class: 'ap-chip ap-chip--image ap-chip--open', title: `Preview ${img.name}`, tabindex: '0' },
          h('img', { src: img.url, alt: '' }),
          h('span', { class: 'ap-chip__label' }, img.name),
          removeBtn(img.name, () => store.ui.images.splice(i, 1)),
        );
        chip.addEventListener('click', () => showImage(img.url, img.name));
        return chip;
      }),
      ...store.ui.mentions.map((m, i) => {
        const chip = h(
          'span',
          { class: 'ap-chip ap-chip--open', title: `Open ${m.detail ? `${m.detail}/` : ''}${m.label}`, tabindex: '0' },
          icon(mentionIcon(m.kind, m.id)),
          h('span', { class: 'ap-chip__label' }, m.label),
          removeBtn(m.label, () => store.ui.mentions.splice(i, 1)),
        );
        chip.addEventListener('click', () => post({ type: 'openMention', kind: m.kind, id: m.id, label: m.label }));
        return chip;
      }),
    ];
    chips.hidden = !items.length;
    chips.replaceChildren(...items);
  }

  function removeBtn(label: string, remove: () => void): HTMLElement {
    const x = h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${label}` }, icon('close'));
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      remove();
      update();
      ta.focus();
    });
    return x;
  }

  /** The last turn's context for this engine: how full the conversation is. */
  function lastContext(engine: EngineId) {
    const msgs = [...store.messages.values()].filter((m: ChatMessage) => m.role === 'assistant' && m.engine === engine && m.meta?.usage);
    const u = msgs.sort((a, b) => a.createdAt - b.createdAt).pop()?.meta?.usage;
    if (!u) return undefined;
    const used = u.contextUsed ?? (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    return { u, used, window: u.contextWindow };
  }

  function paintContext(engine: EngineId): void {
    const c = lastContext(engine);
    contextBtn.hidden = !c?.used;
    if (!c?.used) return;
    const pct = c.window ? Math.min(100, Math.round((c.used / c.window) * 100)) : undefined;
    contextBtn.replaceChildren(ring(pct ?? 0), pct !== undefined ? `${pct}%` : tokens(c.used));
    contextBtn.title = 'Context usage';
    contextBtn.setAttribute('aria-expanded', String(store.ui.menu === 'context'));
    contextBtn.disabled = false;
  }

  function ring(pct: number): HTMLElement {
    const el = h('span', { class: 'ap-ring' });
    el.style.setProperty('--p', String(pct));
    return el;
  }

  /** Like Cursor's context popover: how full, of what window, and the last turn's tokens. */
  function contextMenu(engine: EngineId): HTMLElement {
    const c = lastContext(engine);
    const menu = h('div', { class: 'ap-menu ap-context-pop', role: 'dialog', 'aria-label': 'Context usage' });
    menu.addEventListener('click', (e) => e.stopPropagation());
    if (!c) return menu;
    const pct = c.window ? Math.min(100, Math.round((c.used / c.window) * 100)) : undefined;
    const bar = h('span', { class: 'ap-context-pop__bar' }, h('span'));
    (bar.firstElementChild as HTMLElement).style.width = `${pct ?? 0}%`;
    const row = (label: string, value?: number) => (value ? h('div', { class: 'ap-context-pop__row' }, h('span', {}, label), h('span', {}, tokens(value))) : null);
    append(
      menu,
      [h('div', { class: 'ap-context-pop__head' }, h('strong', {}, 'Context usage'), h('span', { class: 'ap-muted' }, engine === 'claude' ? 'Claude' : 'Cursor')),
      h('div', { class: 'ap-context-pop__row' }, h('span', {}, pct !== undefined ? `${pct}% full` : 'In use'), h('span', {}, `~${tokens(c.used)}${c.window ? ` / ${tokens(c.window)}` : ''} tokens`)),
      pct !== undefined ? bar : null,
      h('div', { class: 'ap-menu__label' }, 'Last turn'),
      row('Cached input', c.u.cacheReadTokens),
      row('New cached input', c.u.cacheWriteTokens),
      row('Input', c.u.inputTokens),
      row('Output', c.u.outputTokens)],
    );
    if (engine === 'claude') {
      const compact = h('button', { type: 'button', class: 'ap-btn ap-btn--secondary', disabled: isRunning() }, 'Compact conversation');
      compact.addEventListener('click', () => {
        store.ui.menu = null;
        post({ type: 'send', text: '/compact' });
        update();
      });
      menu.append(h('div', { class: 'ap-context-pop__foot' }, h('span', { class: 'ap-muted' }, 'Summarizes the chat to free up room'), compact));
    } else if (!c.window) {
      menu.append(h('div', { class: 'ap-context-pop__foot ap-muted' }, "Cursor's CLI doesn't report the model's window size."));
    }
    return menu;
  }

  function paintQueue(): void {
    const q = store.host?.queue ?? [];
    queueEl.hidden = !q.length;
    queueEl.replaceChildren(
      ...q.map((item, i) => {
        const at = (item as { index?: number }).index ?? i;
        const x = h('button', { type: 'button', class: 'ap-icon-btn', title: 'Remove from queue', 'aria-label': 'Remove from queue' }, icon('close'));
        x.addEventListener('click', () => post({ type: 'unqueue', index: at }));
        const now = h('button', { type: 'button', class: 'ap-queue__now', title: 'Stop the current turn and send this now', 'aria-label': 'Send now' }, icon('arrow-up'), 'Send now');
        now.addEventListener('click', () => post({ type: 'sendNow', index: at }));
        return h(
          'div',
          { class: 'ap-queue__item' },
          icon('clock'),
          h('span', { class: 'ap-queue__text' }, item.text),
          item.attachments ? h('span', { class: 'ap-muted' }, `+${item.attachments}`) : null,
          now,
          x,
        );
      }),
    );
  }

  const closeMenus = () => {
    store.ui.menu = null;
    update();
    ta.focus();
  };

  const modeMenu = () => {
    const t = store.host!.thread;
    const menu = h('div', { class: 'ap-menu ap-mode-menu', role: 'menu' });
    menu.addEventListener('click', (e) => e.stopPropagation());
    for (const m of MODES) {
      const item = h(
        'button',
        { type: 'button', class: 'ap-menu__item ap-mode-item', role: 'menuitemradio', 'aria-checked': String(t.mode === m.value), title: m.desc },
        icon(m.icon),
        h('span', {}, m.label),
        icon('check'),
      );
      item.addEventListener('click', () => {
        post({ type: 'setMode', mode: m.value });
        closeMenus();
      });
      menu.append(item);
    }
    return menu;
  };

  // ----- slash commands (Claude) -----

  type Slash = { name: string; description: string; kind: 'skill' | 'command' };

  /** Matching skills and commands, as shown: skills first (three unless searching or expanded). */
  function slashView(): { skills: Slash[]; hidden: number; commands: Slash[]; flat: Slash[] } {
    const s = store.ui.slash;
    const q = s?.query.toLowerCase() ?? '';
    const items: Slash[] = store.host?.slashItems?.length
      ? store.host.slashItems
      : (store.host?.slashCommands ?? []).map((name) => ({ name, description: '', kind: 'command' as const }));
    const match = (i: Slash) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q);
    const rank = (a: Slash, b: Slash) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q));
    const allSkills = items.filter((i) => i.kind === 'skill' && match(i)).sort(rank);
    const commands = items.filter((i) => i.kind === 'command' && match(i)).sort(rank).slice(0, 40);
    const showAll = Boolean(q) || Boolean(s?.showAll);
    const skills = showAll ? allSkills.slice(0, 60) : allSkills.slice(0, 3);
    return { skills, hidden: allSkills.length - skills.length, commands, flat: [...skills, ...commands] };
  }

  function slashMenu(): HTMLElement {
    const s = store.ui.slash!;
    const view = slashView();
    const menu = h('div', { class: 'ap-menu ap-mention-pop ap-slash-pop', role: 'listbox', 'aria-label': 'Skills and commands' });
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    let i = 0;
    const item = (c: Slash) => {
      const idx = i++;
      const b = h(
        'button',
        { type: 'button', class: `ap-menu__item ap-slash-item${idx === s.active ? ' is-active' : ''}`, role: 'option', title: c.description },
        h('span', { class: 'ap-slash-item__name' }, `/${c.name}`),
        c.description ? h('span', { class: 'ap-slash-item__desc' }, c.description) : null,
      );
      b.addEventListener('click', () => pickSlash(c.name));
      return b;
    };
    if (view.skills.length) {
      menu.append(h('div', { class: 'ap-menu__label' }, 'Skills'), ...view.skills.map(item));
      if (view.hidden > 0) {
        const more = h('button', { type: 'button', class: 'ap-slash-more' }, `Show ${view.hidden} more`);
        more.addEventListener('click', () => {
          s.showAll = true;
          update();
        });
        menu.append(more);
      }
    }
    if (view.commands.length) {
      if (view.skills.length) menu.append(h('div', { class: 'ap-menu__sep' }));
      menu.append(h('div', { class: 'ap-menu__label' }, 'Commands'), ...view.commands.map(item));
    }
    if (!view.flat.length) menu.append(h('div', { class: 'ap-menu__label' }, 'Nothing matches'));
    requestAnimationFrame(() => menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }));
    return menu;
  }

  function pickSlash(cmd: string): void {
    ta.value = `/${cmd} `;
    store.ui.slash = null;
    autogrow();
    update();
    ta.focus();
  }

  function syncSlash(): void {
    const m = /^\/(\S*)$/.exec(ta.value);
    const t = store.host?.thread;
    store.ui.slash = m && t ? { query: m[1], active: store.ui.slash?.query === m[1] ? store.ui.slash.active : 0, showAll: store.ui.slash?.showAll } : null;
  }

  function slashKey(e: KeyboardEvent): boolean {
    const s = store.ui.slash;
    if (!s) return false;
    const items = slashView().flat.map((x) => x.name);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) s.active = (s.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      update();
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && items.length) {
      e.preventDefault();
      pickSlash(items[s.active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      store.ui.slash = null;
      update();
      return true;
    }
    return false;
  }

  // ----- images -----

  async function addImages(files: FileList | File[]): Promise<void> {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        window.postMessage({ type: 'notice', text: `${f.name || 'Image'} is over 5 MB.`, level: 'error' }, '*');
        continue;
      }
      const url = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(f);
      });
      store.ui.images.push({ name: f.name || `pasted-${store.ui.images.length + 1}.png`, mediaType: f.type, data: url.slice(url.indexOf(',') + 1), url });
    }
    update();
  }

  ta.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  });
  el.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith('image/'))) {
      e.preventDefault();
      el.classList.add('is-drop');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    if (e.dataTransfer?.files.length) {
      e.preventDefault();
      void addImages(e.dataTransfer.files);
    }
  });
  imageBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void addImages(fileInput.files);
    fileInput.value = '';
  });
  contextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMention();
    store.ui.slash = null;
    store.ui.menu = store.ui.menu === 'context' ? null : 'context';
    update();
  });

  // ----- pickers and sending -----

  function picker(which: 'model' | 'mode'): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'ap-picker', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMention();
      store.ui.slash = null;
      store.ui.menu = store.ui.menu === which ? null : which;
      store.ui.modelSearch = '';
      update();
    });
    return b;
  }

  function setPickerLabel(b: HTMLButtonElement, label: string, open: boolean, iconName?: string): void {
    b.replaceChildren(...(iconName ? [icon(iconName)] : []), h('span', { class: 'ap-picker__label' }, label), icon('chevron-down'));
    b.title = label;
    b.setAttribute('aria-expanded', String(open));
  }

  const send = () => {
    const text = ta.value.trim();
    if (!text) return;
    // While a turn runs this queues on the host.
    post({
      type: 'send',
      text,
      mentions: store.ui.mentions,
      images: store.ui.images.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    });
    store.ui.mentions = [];
    store.ui.images = [];
    store.ui.slash = null;
    closeMention();
    ta.value = '';
    saveDraft('');
    autogrow();
    update();
  };

  ta.addEventListener('keydown', (e) => {
    // Enter that commits an IME composition must not send or pick a menu row.
    if (e.isComposing || e.keyCode === 229) return;
    if (slashKey(e)) return;
    if (mentionKey(e, ta, update)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener('input', () => {
    autogrow();
    saveDraft(ta.value);
    syncSlash();
    const at = store.ui.slash ? null : mentionAtCaret(ta);
    if (at) {
      const scope = store.ui.mention?.scope;
      if (!store.ui.mention || store.ui.mention.query !== at.query) openMention(at.query, scope);
    } else if (store.ui.mention) {
      closeMention();
    }
    if (store.ui.menu && store.ui.menu !== 'usage') store.ui.menu = null;
    update();
  });
  ta.addEventListener('blur', () => {
    // Let a click on the popover land first.
    setTimeout(() => {
      if (document.activeElement !== ta && (store.ui.mention || store.ui.slash) && !el.contains(document.activeElement)) {
        closeMention();
        store.ui.slash = null;
        update();
      }
    }, 150);
  });
  atBtn.addEventListener('click', () => {
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const insert = before && !/\s$/.test(before) ? ' @' : '@';
    ta.value = before + insert + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + insert.length;
    ta.focus();
    store.ui.menu = null;
    openMention('', undefined);
    update();
  });
  sendBtn.addEventListener('click', () => {
    if (isRunning() && !hasDraft()) post({ type: 'stop' });
    else send();
  });

  requestAnimationFrame(autogrow);
  return {
    el,
    update,
    focus: () => ta.focus(),
    setText: (text: string) => {
      ta.value = text;
      saveDraft(text);
      autogrow();
      update();
      ta.focus();
      ta.selectionStart = ta.selectionEnd = text.length;
    },
  };
}
