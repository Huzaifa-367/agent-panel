import type { EngineId } from './engines/types';

/**
 * Model catalogs for the picker, grouped the way Cursor's own picker groups them:
 * a family (Claude, GPT, Gemini…), a base model, and variants of that base
 * (effort level, thinking on or off, fast on or off).
 */

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_ORDER: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL: Record<Effort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export interface ModelVariant {
  /** The id passed to the CLI. */
  id: string;
  label: string;
  effort?: Effort;
  thinking: boolean;
  fast: boolean;
  /** This variant's setting values, keyed by setting id (`effort`, `context`, `fast`…). */
  params?: Record<string, string>;
  /** The old flat CLI id, so earlier saved picks still resolve. */
  legacy?: string;
}

/** What a setting is for, whatever the model calls it (`effort`, `reasoning_effort`, `reasoning`…). */
export type ParamRole = 'effort' | 'context' | 'fast' | 'thinking' | 'other';

export interface ParamDef {
  id: string;
  label: string;
  role: ParamRole;
  kind: 'enum' | 'bool';
  values: { value: string; label: string; costly?: boolean }[];
  tooltip?: string;
}

export interface ModelBase {
  /** Stable key for the base model, e.g. `claude-opus-5-5`. */
  key: string;
  label: string;
  family: string;
  /** Short notes shown as tags, e.g. `1M`, `No ZDR`. */
  tags: string[];
  variants: ModelVariant[];
  /** The variant picked when the base is chosen. */
  defaultId: string;
  /** The settings this model takes, in the order to show them. */
  params?: ParamDef[];
  /** Hover text: what the model is for, its window. */
  description?: string;
  /** Name for the composer button, e.g. `Opus 5.5`. */
  short?: string;
  badges?: string[];
  /** Not switched on in Cursor's picker: listed under "Show more". */
  hidden?: boolean;
  supportsImages?: boolean;
}

export interface ModelCatalog {
  engine: EngineId;
  /** Families in display order, each with its bases in display order. */
  families: { name: string; bases: ModelBase[] }[];
  /** Cursor's `auto`, shown above the families. */
  auto?: ModelVariant;
  /** Where the list came from; a `fallback` list must never replace a real one. */
  source?: 'app' | 'cli' | 'fallback' | 'claude-cli' | 'builtin';
}

/** Claude Code CLI aliases. Effort is a separate `--effort` flag, not part of the id. */
export const CLAUDE_MODELS = [
  { id: 'fable', label: 'Fable', note: 'Most capable' },
  { id: 'opus', label: 'Opus', note: '' },
  { id: 'sonnet', label: 'Sonnet', note: 'Faster' },
  { id: 'haiku', label: 'Haiku', note: 'Fastest' },
] as const;

export const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeCatalog(): ModelCatalog {
  return {
    engine: 'claude',
    families: [
      {
        name: 'Claude',
        bases: CLAUDE_MODELS.map((m) => ({
          key: m.id,
          label: m.label,
          family: 'Claude',
          tags: m.note ? [m.note] : [],
          variants: [{ id: m.id, label: m.label, thinking: true, fast: false }],
          defaultId: m.id,
        })),
      },
    ],
  };
}

export function isClaudeModel(id: string): boolean {
  return CLAUDE_MODELS.some((m) => m.id === id);
}

const SUFFIX = /^(.*?)(-thinking)?(?:-(none|minimal|low|medium|high|xhigh|max))?(-fast)?$/;

/** Split a Cursor model id into its base key and variant flags. */
export function parseCursorId(id: string): { key: string; effort?: Effort; thinking: boolean; fast: boolean } {
  const m = SUFFIX.exec(id);
  if (!m) {
    return { key: id, thinking: false, fast: false };
  }
  return {
    key: m[1] || id,
    effort: (m[3] as Effort | undefined) ?? undefined,
    thinking: Boolean(m[2]),
    fast: Boolean(m[4]),
  };
}

/**
 * Group heading, as in Cursor's own picker: its own models (Composer, Grok) draw on
 * the "Cursor Models" usage pool, everything else on "Other Models".
 */
export function groupOf(key: string): string {
  return /^composer|grok/i.test(key) ? 'Cursor Models' : 'Other Models';
}

/** Vendor of a Cursor base model, for search. */
export function familyOf(key: string): string {
  const k = key.toLowerCase();
  if (k.startsWith('composer')) return 'Cursor';
  if (k.includes('claude') || k.includes('opus') || k.includes('sonnet') || k.includes('haiku') || k.includes('fable')) {
    return 'Claude';
  }
  if (k.startsWith('gpt') || k.startsWith('o3') || k.startsWith('o4')) return 'GPT';
  if (k.startsWith('gemini')) return 'Gemini';
  if (k.includes('grok')) return 'Grok';
  return 'Other';
}

const GROUP_ORDER = ['Cursor Models', 'Other Models'];

/** Remove effort, thinking and fast words from a label to get the base label. */
export function baseLabel(label: string): { label: string; tags: string[] } {
  const tags: string[] = [];
  let l = label;
  if (/\(NO ZDR\)/i.test(l)) {
    tags.push('No ZDR');
    l = l.replace(/\(NO ZDR\)/i, '');
  }
  l = l
    .replace(/\bNo Thinking\b/gi, '')
    .replace(/\bThinking\b/gi, '')
    .replace(/\bFast\b/gi, '')
    .replace(/\b(Extra High|None|Minimal|Low|Medium|High|Max)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const ctx = /\b(\d+[MK])\b/.exec(l);
  if (ctx) {
    tags.unshift(ctx[1]);
    l = l.replace(ctx[0], '').replace(/\s+/g, ' ').trim();
  }
  return { label: l, tags };
}

/**
 * Parse `agent --list-models` output (`id - Label` per line) into a grouped catalog.
 * Order follows the CLI's own order within each family.
 */
export function parseCursorModels(output: string): ModelCatalog {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => / - /.test(l) && !/^(Available|Tip:)/.test(l));

  const bases = new Map<string, ModelBase>();
  let auto: ModelVariant | undefined;

  for (const line of lines) {
    const sep = line.indexOf(' - ');
    const id = line.slice(0, sep).trim();
    const rawLabel = line.slice(sep + 3).replace(/\s*\((current|default)[^)]*\)\s*/gi, ' ').trim();
    if (!id || /\s/.test(id)) continue;
    if (id === 'auto') {
      auto = { id, label: 'Auto', thinking: false, fast: false };
      continue;
    }
    const parsed = parseCursorId(id);
    const { label, tags } = baseLabel(rawLabel);
    let base = bases.get(parsed.key);
    if (!base) {
      // "1M" sits on nearly every model; only tags that tell models apart are kept.
      base = { key: parsed.key, label: label || parsed.key, family: groupOf(parsed.key), tags: tags.filter((t) => t !== '1M'), variants: [], defaultId: id };
      bases.set(parsed.key, base);
    }
    base.variants.push({ id, label: rawLabel, effort: parsed.effort, thinking: parsed.thinking, fast: parsed.fast });
  }

  for (const base of bases.values()) {
    base.defaultId = pickDefault(base);
  }

  const families = GROUP_ORDER.map((name) => ({
    name,
    bases: [...bases.values()].filter((b) => b.family === name),
  })).filter((f) => f.bases.length);

  return { engine: 'cursor', families, auto: auto ?? { id: 'auto', label: 'Auto', thinking: false, fast: false } };
}

/**
 * The variant chosen when a base is picked: the one whose label is the plain base
 * name (Cursor's own default), else medium, else the first listed. Never fast by default.
 */
const EFFORT_WORD = /\b(Extra High|None|Minimal|Low|Medium|High|Max)\b/i;

function pickDefault(base: ModelBase): string {
  const slow = base.variants.filter((v) => !v.fast);
  const pool = slow.length ? slow : base.variants;
  const plain = pool.find((v) => !EFFORT_WORD.test(v.label));
  if (plain) return plain.id;
  const medium = pool.find((v) => v.effort === 'medium' && !v.thinking) ?? pool.find((v) => v.effort === 'medium');
  return (medium ?? pool[0]).id;
}

/** Find the base and variant for an id. */
export function findVariant(catalog: ModelCatalog, id: string): { base?: ModelBase; variant?: ModelVariant } {
  if (catalog.auto && catalog.auto.id === id) return { variant: catalog.auto };
  for (const f of catalog.families) {
    for (const b of f.bases) {
      const v = b.variants.find((x) => x.id === id || x.legacy === id);
      if (v) return { base: b, variant: v };
    }
  }
  return {};
}

/**
 * Resolve a variant of `base` with the requested flags, falling back to the nearest one
 * that exists (keeps effort if possible, then thinking, then fast).
 */
export function resolveVariant(
  base: ModelBase,
  want: { effort?: Effort; thinking?: boolean; fast?: boolean },
): ModelVariant {
  const score = (v: ModelVariant) =>
    (want.effort !== undefined && v.effort === want.effort ? 4 : 0) +
    (want.thinking !== undefined && v.thinking === want.thinking ? 2 : 0) +
    (want.fast !== undefined && v.fast === want.fast ? 1 : 0);
  return [...base.variants].sort((a, b) => score(b) - score(a))[0];
}

/** What sets a variant apart from its base, as Cursor writes it: `Medium`, `High Fast`, `Max Thinking`. */
export function variantNote(base: ModelBase, v: ModelVariant): string {
  const bits: string[] = [];
  if (v.effort && base.variants.some((x) => x.effort !== v.effort)) bits.push(EFFORT_LABEL[v.effort]);
  if (v.thinking && base.variants.some((x) => !x.thinking)) bits.push('Thinking');
  if (v.fast) bits.push('Fast');
  return bits.join(' ');
}

/** Short label for the composer button: base name plus effort, e.g. `Opus 5.5 · High`. */
export function shortLabel(catalog: ModelCatalog, id: string, effort?: string): string {
  if (catalog.engine === 'claude') {
    const m = CLAUDE_MODELS.find((x) => x.id === id);
    const name = m?.label ?? id;
    return effort ? `${name} · ${EFFORT_LABEL[effort as Effort] ?? effort}` : name;
  }
  const { base, variant } = findVariant(catalog, id);
  if (!variant) return id;
  if (!base) return variant.label;
  const name = base.label.replace(/^Claude /, '').replace(/^GPT-/, 'GPT-');
  const bits = [name];
  if (variant.effort && base.variants.some((v) => v.effort !== variant.effort)) bits.push(EFFORT_LABEL[variant.effort]);
  if (variant.fast) bits.push('Fast');
  return bits.join(' · ');
}


// ----- settings: one way to read and pick effort, context, fast and thinking -----

export function roleOf(id: string): ParamRole {
  if (/^(effort|reasoning_effort|reasoning)$/.test(id)) return 'effort';
  if (id === 'context') return 'context';
  if (id === 'fast') return 'fast';
  if (id === 'thinking') return 'thinking';
  return 'other';
}

/** The settings of a base, derived from its variants when the source gave none (the CLI list). */
export function paramsOf(base: ModelBase): ParamDef[] {
  if (base.params) return base.params;
  const out: ParamDef[] = [];
  const efforts = EFFORT_ORDER.filter((e) => base.variants.some((v) => v.effort === e));
  if (efforts.length > 1) out.push({ id: 'effort', label: 'Effort', role: 'effort', kind: 'enum', values: efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] })) });
  if (base.variants.some((v) => v.thinking) && base.variants.some((v) => !v.thinking)) {
    out.push({ id: 'thinking', label: 'Thinking', role: 'thinking', kind: 'bool', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Thinking' }] });
  }
  if (base.variants.some((v) => v.fast) && base.variants.some((v) => !v.fast)) {
    out.push({ id: 'fast', label: 'Fast', role: 'fast', kind: 'bool', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast', costly: true }] });
  }
  base.params = out;
  for (const v of base.variants) {
    v.params ??= {
      ...(v.effort ? { effort: v.effort } : {}),
      thinking: String(v.thinking),
      fast: String(v.fast),
    };
  }
  return out;
}

export function valuesOf(base: ModelBase, variant: ModelVariant): Record<string, string> {
  paramsOf(base);
  return variant.params ?? {};
}

/**
 * The variant with these settings. When the exact combination doesn't exist, the one
 * that keeps `changed` and matches most of the rest.
 */
export function variantFor(base: ModelBase, want: Record<string, string>, changed?: string): ModelVariant {
  const defs = paramsOf(base);
  let best = base.variants[0];
  let bestScore = -1;
  for (const v of base.variants) {
    const vals = v.params ?? {};
    let score = 0;
    for (const d of defs) {
      if (want[d.id] === undefined) continue;
      if (vals[d.id] === want[d.id]) score += d.id === changed ? 100 : 1;
    }
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const stripTags = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\*\*?|_/g, '').trim();

/**
 * Cursor's own catalog, from its settings store: names, descriptions, the settings each
 * model takes, which models your Cursor picker shows, and your last settings per model.
 */
export function cursorCatalogFromApp(raw: unknown, cliIds?: Set<string>): ModelCatalog | null {
  const root = (raw ?? {}) as Record<string, any>;
  const models: any[] = Array.isArray(root.availableDefaultModels2) ? root.availableDefaultModels2 : [];
  if (!models.length) return null;
  const ai = (root.aiSettings ?? {}) as Record<string, any>;
  const enabled = new Set<string>(ai.modelOverrideEnabled ?? []);
  const disabled = new Set<string>(ai.modelOverrideDisabled ?? []);
  const prefs = (ai.modelParameterPreferences ?? {}) as Record<string, { parameters?: { id: string; value: string }[] }>;
  const groups = new Map<string, ModelBase[]>([['Cursor Models', []], ['Other Models', []]]);
  let auto: ModelVariant | undefined;

  for (const m of models) {
    const key = String(m.serverModelName ?? m.name ?? '');
    if (!key) continue;
    if (key === 'default') {
      auto = { id: 'auto', label: 'Auto', thinking: false, fast: false, params: {} };
      continue;
    }
    if (m.supportsAgent === false) continue;
    const defs: ParamDef[] = (m.parameterDefinitions ?? []).map((p: any) => {
      const e = p.parameterType?.enumParameter ?? p.parameterType?.booleanParameter;
      const isBool = Boolean(p.parameterType?.booleanParameter);
      return {
        id: String(p.id),
        label: String(p.name ?? p.id),
        role: roleOf(String(p.id)),
        kind: isBool ? 'bool' : 'enum',
        values: (e?.values ?? []).map((v: any) => ({ value: String(v.value), label: String(v.displayName ?? (v.value === 'true' ? p.name : 'Off')), costly: Boolean(v.increasesModelCost) })),
        tooltip: p.markdownTooltip ? stripTags(String(p.markdownTooltip)) : undefined,
      } as ParamDef;
    });
    const variants: ModelVariant[] = (m.variants ?? []).map((v: any) => {
      const params = Object.fromEntries((v.parameterValues ?? []).map((pv: any) => [String(pv.id), String(pv.value)]));
      const effort = (params.effort ?? params.reasoning_effort ?? params.reasoning) as Effort | undefined;
      return {
        // The bracket form is what Cursor's CLI takes; the old flat slug is the fallback.
        id: String(v.variantStringRepresentation ?? v.legacySlug ?? key),
        legacy: v.legacySlug ? String(v.legacySlug) : undefined,
        label: stripTags(String(v.displayName ?? key)),
        effort,
        thinking: params.thinking === 'true',
        fast: params.fast === 'true',
        params,
      };
    });
    if (!variants.length) variants.push({ id: key, label: String(m.clientDisplayName ?? key), thinking: false, fast: false, params: {} });
    // Default: your last settings in Cursor for this model, else medium effort, smallest context, not fast.
    const pref = Object.fromEntries((prefs[key]?.parameters ?? []).map((p) => [p.id, p.value]));
    const fallbackWant: Record<string, string> = {};
    for (const d of defs) {
      if (d.role === 'effort') fallbackWant[d.id] = d.values.some((v) => v.value === 'medium') ? 'medium' : d.values[0]?.value;
      else if (d.role === 'fast') fallbackWant[d.id] = 'false';
      else fallbackWant[d.id] = d.values[0]?.value;
    }
    const base: ModelBase = {
      key,
      label: String(m.clientDisplayName ?? key),
      short: String(m.inputboxShortModelName ?? m.clientDisplayName ?? key),
      family: String(m.vendorName ?? m.vendor?.displayName ?? '').toLowerCase() === 'cursor' ? 'Cursor Models' : 'Other Models',
      tags: [],
      variants,
      defaultId: variants[0].id,
      params: defs,
      description: m.tooltipData?.markdownContent ? stripTags(String(m.tooltipData.markdownContent)) : undefined,
      badges: (m.modelPickerBadges ?? []).map((b: any) => String(b.label)).filter(Boolean),
      hidden: !((m.defaultOn === true || enabled.has(key)) && !disabled.has(key)),
      supportsImages: m.supportsImages === true,
    };
    base.defaultId = variantFor(base, { ...fallbackWant, ...pref }).id;
    // Hide models the CLI can't run, when we know its list.
    if (cliIds && cliIds.size && !variants.some((v) => cliIds.has(v.id.replace(/\[.*$/, '')) || cliIds.has(key)) && !(m.legacySlugs ?? []).some((s: string) => cliIds.has(s))) continue;
    groups.get(base.family)!.push(base);
  }
  return {
    engine: 'cursor',
    source: 'app',
    auto: auto ?? { id: 'auto', label: 'Auto', thinking: false, fast: false, params: {} },
    families: [...groups.entries()].map(([name, bases]) => ({ name, bases })).filter((f) => f.bases.length),
  };
}

/** Claude's models from the CLI's `initialize` reply: names, descriptions, effort levels, fast mode. */
export interface ClaudeInitModel {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

export function claudeCatalogFromInit(models: ClaudeInitModel[]): ModelCatalog {
  const current = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
  const toBase = (m: ClaudeInitModel, hidden: boolean): ModelBase => {
    const params: ParamDef[] = [];
    if (m.supportsEffort && m.supportedEffortLevels?.length) {
      params.push({
        id: 'effort',
        label: 'Effort',
        role: 'effort',
        kind: 'enum',
        values: m.supportedEffortLevels.map((e) => ({ value: e, label: EFFORT_LABEL[e as Effort] ?? e })),
        tooltip: 'How hard the model works on each answer',
      });
    }
    if (m.supportsFastMode) {
      params.push({ id: 'fast', label: 'Fast', role: 'fast', kind: 'bool', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast', costly: true }], tooltip: 'Faster output at a higher cost' });
    }
    const label = String(m.displayName ?? m.value).replace(/^Claude /, '');
    return {
      key: m.value,
      label,
      short: label.replace(/ \(recommended\)$/, ''),
      family: 'Claude',
      tags: [],
      variants: [{ id: m.value, label, thinking: true, fast: false, params: {} }],
      defaultId: m.value,
      params,
      description: [m.description, m.resolvedModel ? `Runs ${m.resolvedModel}` : ''].filter(Boolean).join('\n'),
      hidden,
    };
  };
  const main = models.filter((m) => current.includes(m.value)).sort((a, b) => current.indexOf(a.value) - current.indexOf(b.value));
  const older = models.filter((m) => !current.includes(m.value));
  return {
    engine: 'claude',
    source: 'claude-cli',
    families: [{ name: 'Claude', bases: [...main.map((m) => toBase(m, false)), ...older.map((m) => toBase(m, true))] }],
  };
}

/** Claude model ids the CLI accepts: the catalog's, else the built-in aliases. */
export function claudeIds(catalog: ModelCatalog | undefined): string[] {
  return catalog?.families.flatMap((f) => f.bases.map((b) => b.key)) ?? CLAUDE_MODELS.map((m) => m.id);
}

/** The composer's model button: `Opus 5.5 · High ⚡`. */
export function buttonLabel(catalog: ModelCatalog | null | undefined, id: string, extra: { effort?: string | null; fast?: boolean } = {}): string {
  if (!catalog) return id === 'auto' ? 'Auto' : id;
  const { base, variant } = findVariant(catalog, id);
  if (!variant) return id === 'auto' ? 'Auto' : id;
  if (!base) return variant.label;
  const vals = valuesOf(base, variant);
  // The button is narrow: drop the vendor word ("Claude Opus 5.5" → "Opus 5.5").
  const bits = [(base.short ?? base.label).replace(/^Claude (?=\S)/, '')];
  const effortDef = (base.params ?? []).find((d) => d.role === 'effort');
  const effort = catalog.engine === 'claude' ? extra.effort ?? undefined : effortDef ? vals[effortDef.id] : undefined;
  if (effort && effortDef && effortDef.values.length > 1) bits.push(effortDef.values.find((v) => v.value === effort)?.label ?? effort);
  const ctx = (base.params ?? []).find((d) => d.role === 'context');
  if (ctx && vals[ctx.id] && vals[ctx.id] !== ctx.values[0]?.value) bits.push(ctx.values.find((v) => v.value === vals[ctx.id])?.label ?? vals[ctx.id]);
  const fast = catalog.engine === 'claude' ? extra.fast : vals.fast === 'true';
  return `${bits.join(' · ')}${fast ? ' ⚡' : ''}`;
}
