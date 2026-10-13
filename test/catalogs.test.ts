import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorCatalogFromApp, claudeCatalogFromInit, findVariant, variantFor, paramsOf, buttonLabel } from '../src/models';

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', 'test', 'fixtures', f), 'utf8'));

describe("Cursor's own catalog", () => {
  const cat = cursorCatalogFromApp(fx('cursor-app-models.json'))!;

  it('splits Cursor Models and Other Models by vendor, Auto on top', () => {
    assert.equal(cat.auto?.id, 'auto');
    assert.deepEqual(cat.families.map((f) => f.name), ['Cursor Models', 'Other Models']);
    assert.deepEqual(cat.families[0].bases.map((b) => b.key), ['grok-4.7', 'composer-2.5']);
  });

  it("shows the models your Cursor picker shows; the rest are hidden", () => {
    const opus = cat.families[1].bases.find((b) => b.key === 'claude-opus-5-5')!;
    assert.equal(opus.hidden, false);
    const haiku = cat.families[1].bases.find((b) => b.key === 'claude-haiku-4-5')!;
    assert.equal(haiku.hidden, false, 'switched on in Cursor');
  });

  it('reads each setting with its values and cost marks', () => {
    const opus = cat.families[1].bases.find((b) => b.key === 'claude-opus-5-5')!;
    const defs = paramsOf(opus);
    assert.deepEqual(defs.map((d) => `${d.id}:${d.role}`), ['context:context', 'effort:effort', 'fast:fast']);
    assert.deepEqual(defs[0].values.map((v) => [v.value, Boolean(v.costly)]), [['300k', false], ['1m', true]]);
    assert.match(opus.description ?? '', /300k context window/);
  });

  it('picks the bracket id the CLI takes, and keeps old flat ids working', () => {
    const opus = cat.families[1].bases.find((b) => b.key === 'claude-opus-5-5')!;
    const v = variantFor(opus, { context: '1m', effort: 'high', fast: 'true' });
    assert.equal(v.id, 'claude-opus-5-5[context=1m,effort=high,fast=true]');
    assert.equal(findVariant(cat, 'claude-opus-5-5-high-fast').variant?.id, 'claude-opus-5-5[context=300k,effort=high,fast=true]');
    assert.equal(buttonLabel(cat, v.id), 'Opus 5.5 · High · 1M ⚡');
  });

  it("uses each model's own setting names (Grok's reasoning_effort)", () => {
    const grok = cat.families[0].bases.find((b) => b.key === 'grok-4.7')!;
    assert.match(variantFor(grok, { reasoning_effort: 'high', fast: 'false', context: '256k' }).id, /reasoning_effort=high/);
  });
});

describe("Claude's catalog from the CLI", () => {
  const init = fx('claude-init.json').response.response;
  const cat = claudeCatalogFromInit(init.models);

  it('lists Default and the current models first, older ones hidden', () => {
    const bases = cat.families[0].bases;
    assert.deepEqual(bases.filter((b) => !b.hidden).map((b) => b.key), ['default', 'opus', 'fable', 'sonnet', 'haiku']);
    assert.ok(bases.some((b) => b.hidden));
  });

  it('gives each model its effort levels and fast mode where supported', () => {
    const opus = cat.families[0].bases.find((b) => b.key === 'opus')!;
    assert.deepEqual(paramsOf(opus).map((d) => d.role), ['effort', 'fast']);
    const sonnet = cat.families[0].bases.find((b) => b.key === 'sonnet')!;
    assert.deepEqual(paramsOf(sonnet).map((d) => d.role), ['effort']);
    assert.equal(buttonLabel(cat, 'opus', { effort: 'high', fast: true }), 'Opus 5.5 · High ⚡');
  });
});
