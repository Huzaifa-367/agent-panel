import { store, post } from './store';
import { h, icon, iconButton, engineTag, relativeTime, resetTime, money, tokens } from './dom';
import type { ChatMessage, EngineId } from './store';

/** The header: title, usage, history and new chat. The usage popover hangs off it. */
export function renderHeader(root: HTMLElement, rerender: () => void): void {
  const host = store.host!;
  const ui = store.ui;
  const title = ui.view === 'history' ? 'Chats' : host.thread.title;

  const usageBtn = usageButton(() => {
    ui.menu = ui.menu === 'usage' ? null : 'usage';
    if (ui.menu === 'usage') post({ type: 'refreshUsage' });
    rerender();
  });

  const header = h(
    'header',
    { class: 'ap-header' },
    ui.view === 'history'
      ? iconButton('arrow-left', 'Back to chat', () => {
          ui.view = 'chat';
          rerender();
        })
      : null,
    h('div', { class: 'ap-header__title', title }, title),
    usageBtn,
    iconButton(
      'history',
      'Chats',
      () => {
        ui.view = ui.view === 'history' ? 'chat' : 'history';
        ui.menu = null;
        if (ui.view === 'history') post({ type: 'listExternal' });
        rerender();
      },
      { 'aria-pressed': String(ui.view === 'history') },
    ),
    iconButton('add', 'New chat', () => {
      ui.view = 'chat';
      post({ type: 'newChat' });
    }),
  );
  if (ui.menu === 'usage') {
    // Keep the open popover (and its scroll) unless the numbers in it changed.
    const sig = JSON.stringify([host.usage, host.thread.messages.length]);
    const keep = root.querySelector<HTMLElement>('.ap-usage-pop');
    header.append(keep && keep.dataset.sig === sig ? keep : usagePopover());
    const pop = header.querySelector<HTMLElement>('.ap-usage-pop');
    if (pop) pop.dataset.sig = sig;
  }
  root.replaceChildren(header);
}


function usageButton(onClick: () => void): HTMLElement {
  const c = store.host!.usage.claude;
  const pct = c.sevenDay !== undefined ? Math.round(c.sevenDay * 100) : undefined;
  const b = h('button', { type: 'button', class: 'ap-usage', title: 'Usage for Claude and Cursor', 'aria-expanded': String(store.ui.menu === 'usage') });
  if (pct === undefined) {
    b.append(icon('pulse'), 'Usage');
  } else {
    if (pct >= 80) b.classList.add('is-high');
    b.append(meter(pct), `Week ${pct}%`);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function meter(pct: number, wide = false): HTMLElement {
  const fill = h('span');
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  return h('span', { class: `ap-usage__bar${wide ? ' ap-usage__bar--wide' : ''}${pct >= 80 ? ' is-high' : ''}` }, fill);
}

/** Totals for this chat, per engine, from each turn's result. */
function chatTotals(engine: EngineId) {
  const t = { turns: 0, cost: undefined as number | undefined, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' };
  for (const m of store.host!.thread.messages as ChatMessage[]) {
    if (m.role !== 'assistant' || m.engine !== engine || !m.meta?.usage) continue;
    const u = m.meta.usage;
    t.turns += 1;
    t.input += u.inputTokens ?? 0;
    t.output += u.outputTokens ?? 0;
    t.cacheRead += u.cacheReadTokens ?? 0;
    t.cacheWrite += u.cacheWriteTokens ?? 0;
    if (u.costUsd !== undefined) t.cost = (t.cost ?? 0) + u.costUsd;
    if (m.meta.modelLabel) t.model = m.meta.modelLabel;
  }
  return t;
}

const PLAN: Record<string, string> = { free: 'Free', pro: 'Pro', pro_plus: 'Pro+', ultra: 'Ultra', business: 'Business', team: 'Team', enterprise: 'Enterprise', free_trial: 'Trial' };
const plan = (p?: string) => (p ? PLAN[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1) : '');

function usagePopover(): HTMLElement {
  const { claude, cursor } = store.host!.usage;
  const cl = chatTotals('claude');
  const cu = chatTotals('cursor');

  const row = (label: string, value: (Node | string)[], note?: string) =>
    h('div', { class: 'ap-usage-pop__row' }, h('span', { class: 'ap-usage-pop__label' }, label), h('span', { class: 'ap-usage-pop__value' }, ...value), note ? h('span', { class: 'ap-usage-pop__note' }, note) : null);
  const window = (label: string, util?: number, reset?: number) =>
    util === undefined
      ? row(label, [h('span', { class: 'ap-muted' }, 'Not reported yet')])
      : row(label, [meter(Math.round(util * 100), true), `${Math.round(util * 100)}%`], reset ? `Resets ${resetTime(reset)}` : undefined);
  const link = (label: string, url: string) =>
    h('button', { type: 'button', class: 'ap-link', onclick: () => post({ type: 'openExternal', url }) }, label, icon('link-external'));
  const breakdown = (t: ReturnType<typeof chatTotals>) =>
    `${tokens(t.input + t.cacheRead + t.cacheWrite)} in (${tokens(t.cacheRead)} cached) · ${tokens(t.output)} out`;

  const claudeStatus =
    claude.status === 'rejected' ? 'Limit reached: Claude turns wait for the reset.' : claude.status === 'allowed_warning' ? 'Close to the limit.' : '';

  const claudeSection = h(
    'section',
    { class: 'ap-usage-pop__section' },
    h('div', { class: 'ap-usage-pop__head' }, engineTag('claude'), h('span', { class: 'ap-muted' }, 'Your Claude plan')),
    window('Session (5 h)', claude.fiveHour, claude.fiveHourResetsAt),
    window('Week', claude.sevenDay, claude.sevenDayResetsAt),
    claudeStatus ? h('p', { class: `ap-usage-pop__alert${claude.status === 'rejected' ? ' is-error' : ''}` }, icon('warning'), claudeStatus) : null,
    ...(cl.turns
      ? [
          row('This chat', [`${cl.turns} turn${cl.turns === 1 ? '' : 's'}${cl.cost !== undefined ? ` · ${money(cl.cost)}` : ''}`]),
          cl.input + cl.output ? row('Tokens', [breakdown(cl)]) : null,
          cl.model ? row('Last model', [cl.model]) : null,
        ]
      : [row('This chat', [h('span', { class: 'ap-muted' }, 'No Claude turns yet')])]),
    h(
      'div',
      { class: 'ap-usage-pop__foot' },
      claude.updatedAt ? `Updated ${relativeTime(claude.updatedAt)}${relativeTime(claude.updatedAt) === 'just now' ? '' : ' ago'}` : 'Updates after each Claude turn',
      link('Usage page', 'https://claude.ai/settings/usage'),
    ),
  );

  const cliOut = cursor.signedIn === false;
  const differs = Boolean(!cliOut && cursor.email && cursor.appEmail && cursor.email.toLowerCase() !== cursor.appEmail.toLowerCase());
  const cursorSection = h(
    'section',
    { class: 'ap-usage-pop__section' },
    h('div', { class: 'ap-usage-pop__head' }, engineTag('cursor'), h('span', { class: 'ap-muted' }, cliOut ? 'CLI signed out' : cursor.tier ? `${plan(cursor.tier)} plan` : 'Your Cursor plan')),
    row('Panel uses', [cliOut ? h('span', { class: 'ap-muted' }, 'Signed out') : `${cursor.email ?? 'Unknown'}${cursor.tier ? ` · ${plan(cursor.tier)}` : ''}`], "Cursor's CLI account"),
    cursor.appEmail ? row('Cursor app', [`${cursor.appEmail}${cursor.appPlan ? ` · ${plan(cursor.appPlan)}` : ''}${cursor.appStatus && cursor.appStatus !== 'active' ? ` (${cursor.appStatus})` : ''}`]) : null,
    differs || cliOut
      ? h(
          'div',
          { class: 'ap-usage-pop__alert' },
          icon('warning'),
          h('span', {}, cliOut ? "Cursor's CLI is signed out, so Cursor turns can't run." : `Cursor turns in this panel run on ${cursor.email}, not the app's account.`),
          h('button', { type: 'button', class: 'ap-btn ap-btn--secondary', onclick: () => post({ type: 'runInTerminal', command: cliOut ? 'agent login' : 'agent relogin' }) }, cliOut ? 'Sign in' : 'Switch CLI account'),
        )
      : null,
    ...(cu.turns
      ? [row('This chat', [`${cu.turns} turn${cu.turns === 1 ? '' : 's'}`]), cu.input + cu.output ? row('Tokens', [breakdown(cu)]) : null]
      : [row('This chat', [h('span', { class: 'ap-muted' }, 'No Cursor turns yet')])]),
    h(
      'div',
      { class: 'ap-usage-pop__foot' },
      `Plan quota isn't in Cursor's CLI${cursor.cliVersion ? ` · CLI ${cursor.cliVersion.split('-')[0]}` : ''}`,
      link('Dashboard', 'https://cursor.com/dashboard?tab=usage'),
    ),
  );

  const pop = h('div', { class: 'ap-menu ap-usage-pop', role: 'dialog', 'aria-label': 'Usage' }, claudeSection, h('div', { class: 'ap-menu__sep' }), cursorSection);
  pop.addEventListener('click', (e) => e.stopPropagation());
  return pop;
}

/** Full-panel list of chats: this panel's, Claude Code sessions, and Cursor's own chats. */
export function renderHistory(root: HTMLElement): void {
  const host = store.host!;
  const ext = store.external;
  const sections: HTMLElement[] = [];

  if (host.threads.length) {
    const list = h('ul', { class: 'ap-history' });
    for (const t of host.threads) {
      const del = iconButton('trash', 'Delete chat', (e) => {
        e.stopPropagation();
        post({ type: 'deleteThread', id: t.id });
      });
      del.classList.add('ap-history__delete');
      list.append(
        item(
          t.title,
          t.updatedAt,
          [
            ...t.engines.map((e) => engineTag(e)),
            t.mode === 'handoff' ? h('span', {}, 'Hand-off') : t.mode === 'plan' ? h('span', {}, 'Plan') : t.mode === 'auto' ? h('span', {}, 'Auto') : null,
            t.files ? h('span', {}, `${t.files} file${t.files === 1 ? '' : 's'}`) : null,
          ],
          () => post({ type: 'loadThread', id: t.id }),
          t.id === host.thread.id,
          del,
        ),
      );
    }
    sections.push(h('p', { class: 'ap-section-label' }, 'In this panel'), list);
  }

  const external = (label: string, note: string, chats: { source: 'claude' | 'cursor'; id: string; title: string; updatedAt: number }[], loading: boolean) => {
    const head = h('p', { class: 'ap-section-label' }, label, h('span', { class: 'ap-section-label__note' }, loading ? 'Loading…' : note));
    if (!chats.length) {
      sections.push(head, h('p', { class: 'ap-history__none' }, loading ? '' : 'None in this workspace yet'));
      return;
    }
    const list = h('ul', { class: 'ap-history' });
    for (const c of chats) {
      list.append(item(c.title, c.updatedAt, [engineTag(c.source)], () => post({ type: 'openChat', source: c.source, id: c.id }), c.source === 'claude' && host.thread.claudeSessionId === c.id));
    }
    sections.push(head, list);
  };
  external('Claude Code sessions', 'CLI and the Claude Code extension', ext?.claude ?? [], !ext);
  external('Cursor chats', "Cursor's chat panel, read-only", ext?.cursor ?? [], !ext || ext.loadingCursor);

  root.replaceChildren(...sections);
}

function item(title: string, updatedAt: number, meta: (Node | null)[], open: () => void, current: boolean, extra?: HTMLElement): HTMLElement {
  const li = h(
    'li',
    { class: `ap-history__item${current ? ' is-current' : ''}`, tabindex: '0' },
    h('span', { class: 'ap-history__title' }, title),
    h('span', { class: 'ap-history__time' }, relativeTime(updatedAt)),
    h('span', { class: 'ap-history__meta' }, ...meta),
    extra ?? null,
  );
  const go = () => {
    store.ui.view = 'chat';
    open();
  };
  li.addEventListener('click', go);
  li.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') go();
  });
  return li;
}
