import { store, post } from './store';
import { h, icon } from './dom';
import { buttonLabel, findVariant, paramsOf, valuesOf, variantFor, familyOf, type ModelBase, type ModelCatalog, type ParamDef } from '../src/models';
import type { EngineId } from './store';

/** Label for the composer's model button, e.g. `Opus 5.5 · High ⚡`. */
export function modelButtonLabel(engine: EngineId): string {
  const host = store.host!;
  const sel = host.selection;
  if (engine === 'claude') return buttonLabel(host.catalogs.claude, sel.claudeModel, { effort: sel.claudeEffort, fast: sel.claudeFast });
  return buttonLabel(host.catalogs.cursor, sel.cursorModel);
}

let showAll = false;
let listScroll = 0;

/**
 * The model menu. One row per model, with its settings on the same row: an effort
 * stepper, fast mode and the context size where the model has them (like Cursor's
 * picker and the Claude extension's effort slider). Changing a setting keeps the menu
 * open; clicking a model's name picks it and closes.
 */
export function modelMenu(engine: EngineId, close: () => void): HTMLElement {
  const host = store.host!;
  const catalog = engine === 'claude' ? host.catalogs.claude : host.catalogs.cursor;
  const menu = h('div', { class: 'ap-menu ap-model-menu', role: 'dialog', 'aria-label': 'Model' });
  menu.addEventListener('click', (e) => e.stopPropagation());

  if (engine === 'cursor' && host.cursorSignedOut) {
    const signIn = h('button', { type: 'button', class: 'ap-btn ap-btn--secondary' }, 'Sign in');
    signIn.addEventListener('click', () => post({ type: 'runInTerminal', command: 'agent login' }));
    const retry = h('button', { type: 'button', class: 'ap-btn ap-btn--ghost' }, 'Check again');
    retry.addEventListener('click', () => post({ type: 'refreshModels' }));
    menu.append(h('div', { class: 'ap-model-menu__alert' }, icon('warning'), h('span', {}, "Cursor's CLI is signed out, so Cursor can't run and its model list may be out of date."), signIn, retry));
  }
  if (!catalog) {
    menu.append(h('div', { class: 'ap-menu__label' }, 'Loading models…'));
    return menu;
  }

  const search = h('input', {
    class: 'ap-model-menu__search',
    type: 'text',
    placeholder: engine === 'claude' ? 'Search Claude models' : 'Search Cursor models',
    'aria-label': 'Search models',
    value: store.ui.modelSearch,
  });
  const list = h('div', { class: 'ap-model-menu__list', role: 'listbox' });
  const plan = h('div', { class: 'ap-model-menu__plan' }, engine === 'claude' ? `Runs on your ${host.usage.claude.plan ?? 'Claude'} plan` : 'Runs on your Cursor plan', h('span', { class: 'ap-muted' }, '←→ effort · F fast'));
  menu.append(search, list, plan);

  const rowsOf = () => Array.from(list.querySelectorAll<HTMLElement>('.ap-model-row'));
  const paint = () => {
    const q = store.ui.modelSearch.trim().toLowerCase();
    const out: HTMLElement[] = [];
    if (catalog.auto && (!q || 'auto'.includes(q))) out.push(autoRow(catalog, close));
    let hiddenCount = 0;
    for (const fam of catalog.families) {
      const match = (b: ModelBase) => !q || `${fam.name} ${familyOf(b.key)} ${b.label} ${b.key} ${b.description ?? ''}`.toLowerCase().includes(q);
      const visible = fam.bases.filter((b) => match(b) && (q || showAll || !b.hidden));
      hiddenCount += fam.bases.filter((b) => b.hidden && match(b) && !q && !showAll).length;
      if (!visible.length) continue;
      const label = engine === 'claude' ? (visible.every((b) => b.hidden) ? 'Older models' : '') : fam.name;
      if (label) out.push(h('div', { class: 'ap-menu__label' }, label));
      for (const b of visible) out.push(modelRow(engine, catalog, b, close));
    }
    if (hiddenCount) {
      const more = h('button', { type: 'button', class: 'ap-slash-more' }, `Show ${hiddenCount} more model${hiddenCount === 1 ? '' : 's'}`);
      more.addEventListener('click', () => {
        showAll = true;
        paint();
      });
      out.push(more);
    }
    if (!out.length) out.push(h('div', { class: 'ap-menu__label' }, 'No models match'));
    list.replaceChildren(...out);
    store.ui.modelActive = Math.min(store.ui.modelActive, Math.max(0, rowsOf().length - 1));
    markActive(list);
  };

  search.addEventListener('input', () => {
    store.ui.modelSearch = search.value;
    store.ui.modelActive = 0;
    paint();
  });
  search.addEventListener('keydown', (e) => {
    const rows = rowsOf();
    const row = rows[store.ui.modelActive];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      store.ui.modelActive = (store.ui.modelActive + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length);
      markActive(list);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !search.value) {
      // Effort on the highlighted row.
      e.preventDefault();
      row?.querySelector<HTMLElement>(e.key === 'ArrowLeft' ? '[data-step="down"]' : '[data-step="up"]')?.click();
    } else if ((e.key === 'f' || e.key === 'F') && !search.value) {
      e.preventDefault();
      row?.querySelector<HTMLElement>('.ap-fast')?.click();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      row?.querySelector<HTMLElement>('.ap-model-row__name')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  list.addEventListener('scroll', () => (listScroll = list.scrollTop));

  paint();
  const sel = rowsOf().findIndex((r) => r.getAttribute('aria-selected') === 'true');
  if (sel >= 0 && !store.ui.modelSearch && store.ui.modelActive === 0) {
    store.ui.modelActive = sel;
    markActive(list, false);
  }
  requestAnimationFrame(() => {
    search.focus();
    // The menu redraws when a setting changes; keep its place.
    if (listScroll) list.scrollTop = listScroll;
    else list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  return menu;
}

function markActive(list: HTMLElement, scroll = true): void {
  list.querySelectorAll('.ap-model-row').forEach((el, i) => el.classList.toggle('is-active', i === store.ui.modelActive));
  if (scroll) list.querySelector('.ap-model-row.is-active')?.scrollIntoView({ block: 'nearest' });
}

function autoRow(catalog: ModelCatalog, close: () => void): HTMLElement {
  const selected = store.host!.selection.cursorModel === catalog.auto!.id;
  const name = h('button', { type: 'button', class: 'ap-model-row__name' }, 'Auto', h('span', { class: 'ap-model-menu__note' }, ' Cursor picks the model for each request'));
  name.addEventListener('click', () => {
    post({ type: 'setModel', engine: 'cursor', model: catalog.auto!.id });
    close();
  });
  return h('div', { class: 'ap-model-row', role: 'option', 'aria-selected': String(selected), title: 'Balanced quality and speed, recommended for most tasks' }, name, h('span'), selected ? icon('check') : h('span'));
}

/** One model: name, then its settings on the same row, then the check. */
function modelRow(engine: EngineId, catalog: ModelCatalog, base: ModelBase, close: () => void): HTMLElement {
  const host = store.host!;
  const sel = host.selection;
  const defs = paramsOf(base);
  const { base: selBase, variant: selVariant } = findVariant(catalog, engine === 'claude' ? sel.claudeModel : sel.cursorModel);
  const selected = selBase?.key === base.key;

  // The row's current values: the chosen settings if it's selected, else its own defaults.
  const variant = selected && selVariant ? selVariant : base.variants.find((v) => v.id === base.defaultId) ?? base.variants[0];
  const values: Record<string, string> = { ...valuesOf(base, variant) };
  if (engine === 'claude') {
    if (sel.claudeEffort) values.effort = sel.claudeEffort;
    values.fast = String(Boolean(sel.claudeFast));
  }

  const apply = (changes: Record<string, string>, andClose = false) => {
    if (engine === 'claude') {
      const effort = changes.effort !== undefined ? changes.effort : undefined;
      post({ type: 'setModel', engine, model: base.key, effort, fast: changes.fast !== undefined ? changes.fast === 'true' : undefined });
    } else {
      const changed = Object.keys(changes)[0];
      post({ type: 'setModel', engine, model: variantFor(base, { ...values, ...changes }, changed).id });
    }
    if (andClose) close();
  };

  const effortDef = defs.find((d) => d.role === 'effort');
  const fastDef = defs.find((d) => d.role === 'fast');
  const ctxDef = defs.find((d) => d.role === 'context');
  const thinkDef = defs.find((d) => d.role === 'thinking');

  const name = h(
    'button',
    { type: 'button', class: 'ap-model-row__name' },
    base.label,
    ...(base.badges ?? []).map((b) => h('span', { class: 'ap-model-menu__tag' }, b)),
    ...base.tags.map((t) => h('span', { class: 'ap-model-menu__tag' }, t)),
  );
  name.addEventListener('click', () => apply({}, true));

  // Fixed slots, so steppers and toggles line up down the list.
  const slot = (el: HTMLElement | null) => el ?? h('span', { class: 'ap-model-row__slot' });
  const controls = h(
    'span',
    { class: 'ap-model-row__controls' },
    slot(effortDef && effortDef.values.length > 1 ? stepper(effortDef, values[effortDef.id], (v) => apply({ [effortDef.id]: v })) : null),
    slot(thinkDef ? toggle('lightbulb', 'Thinking', values[thinkDef.id] === 'true', (on) => apply({ [thinkDef.id]: String(on) }), 'ap-think') : null),
    slot(ctxDef && ctxDef.values.length > 1 ? contextChip(ctxDef, values[ctxDef.id], (v) => apply({ [ctxDef.id]: v })) : null),
    slot(fastDef ? toggle('zap', fastDef.tooltip ?? 'Fast mode: faster output at a higher cost', values[fastDef.id] === 'true', (on) => apply({ [fastDef.id]: String(on) }), 'ap-fast') : null),
  );

  const effortLabel = effortDef?.values.find((v) => v.value === values[effortDef.id])?.label;
  const tip = [base.label, base.description, effortLabel ? `Effort: ${effortLabel}` : '', values.fast === 'true' ? 'Fast mode on' : ''].filter(Boolean).join('\n');
  return h('div', { class: `ap-model-row${selected ? ' is-selected' : ''}`, role: 'option', 'aria-selected': String(selected), title: tip }, name, controls, selected ? icon('check') : h('span'));
}

/** Effort as dots on a track with a knob, like the Claude extension's slider. Click or drag. */
function stepper(def: ParamDef, current: string | undefined, set: (v: string) => void): HTMLElement {
  const values = def.values;
  const idx = values.findIndex((v) => v.value === current);
  const track = h('span', { class: 'ap-stepper', role: 'slider', tabindex: '-1', 'aria-label': def.label, 'aria-valuemin': '0', 'aria-valuemax': String(values.length - 1), 'aria-valuenow': String(Math.max(0, idx)), 'aria-valuetext': values[idx]?.label ?? 'Default' });
  track.style.setProperty('--n', String(values.length));
  values.forEach((v, i) => {
    const dot = h('button', { type: 'button', class: `ap-stepper__dot${i === idx ? ' is-on' : ''}${i < idx ? ' is-below' : ''}`, title: `${def.label}: ${v.label}`, 'aria-label': v.label });
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      set(v.value);
    });
    track.append(dot);
  });
  if (idx >= 0) {
    const knob = h('span', { class: 'ap-stepper__knob' });
    knob.style.setProperty('--i', String(idx));
    track.append(knob);
  }
  // Hidden keyboard handles for ←→ on the highlighted row.
  const down = h('button', { type: 'button', class: 'ap-stepper__key', 'data-step': 'down', tabindex: '-1', 'aria-hidden': 'true' });
  const up = h('button', { type: 'button', class: 'ap-stepper__key', 'data-step': 'up', tabindex: '-1', 'aria-hidden': 'true' });
  down.addEventListener('click', () => set(values[Math.max(0, (idx < 0 ? 1 : idx) - 1)].value));
  up.addEventListener('click', () => set(values[Math.min(values.length - 1, idx + 1)].value));
  // Drag: the nearest dot under the pointer wins.
  track.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).classList.contains('ap-stepper__dot')) return;
    track.setPointerCapture(e.pointerId);
    const pick = (x: number) => {
      const r = track.getBoundingClientRect();
      const i = Math.round(((x - r.left) / r.width) * (values.length - 1));
      return values[Math.max(0, Math.min(values.length - 1, i))].value;
    };
    const up2 = (ev: PointerEvent) => {
      track.releasePointerCapture(ev.pointerId);
      track.removeEventListener('pointerup', up2);
      set(pick(ev.clientX));
    };
    track.addEventListener('pointerup', up2);
  });
  return h('span', { class: 'ap-stepper-wrap' }, track, down, up);
}

function toggle(iconName: string, title: string, on: boolean, set: (on: boolean) => void, cls: string): HTMLElement {
  const b = h('button', { type: 'button', class: `ap-model-toggle ${cls}${on ? ' is-on' : ''}`, title, 'aria-pressed': String(on), 'aria-label': title }, icon(iconName));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!on);
  });
  return b;
}

/** Context size: a small chip that steps through the sizes the model offers. */
function contextChip(def: ParamDef, current: string | undefined, set: (v: string) => void): HTMLElement {
  const i = Math.max(0, def.values.findIndex((v) => v.value === current));
  const v = def.values[i];
  const next = def.values[(i + 1) % def.values.length];
  const b = h(
    'button',
    { type: 'button', class: `ap-ctx-chip${v.costly ? ' is-costly' : ''}`, title: `Context: ${def.values.map((x) => `${x.label}${x.costly ? ' (costs more)' : ''}`).join(', ')}. Click for ${next.label}.` },
    v.label,
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    set(next.value);
  });
  return b;
}
