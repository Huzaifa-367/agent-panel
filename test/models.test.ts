import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCursorModels, parseCursorId, findVariant, resolveVariant, shortLabel, claudeCatalog } from '../src/models';

const list = readFileSync(join(__dirname, '..', 'test', 'fixtures', 'cursor-models.txt'), 'utf8');

describe('Cursor model catalog', () => {
  const cat = parseCursorModels(list);
  const allIds = list
    .split('\n')
    .map((l) => l.split(' - ')[0].trim())
    .filter((id) => id && !/\s/.test(id) && id !== 'Available' && id !== 'auto');

  it('keeps every model id, once', () => {
    const ids = cat.families.flatMap((f) => f.bases.flatMap((b) => b.variants.map((v) => v.id)));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), [...new Set(allIds)].sort());
    assert.equal(cat.auto?.id, 'auto');
  });

  it("groups like Cursor's picker: Cursor Models, then Other Models", () => {
    assert.deepEqual(cat.families.map((f) => f.name), ['Cursor Models', 'Other Models']);
    const cursorKeys = cat.families[0].bases.map((b) => b.key);
    assert.ok(cursorKeys.includes('composer-2.5') && cursorKeys.some((k) => /grok/.test(k)));
    assert.ok(!cursorKeys.some((k) => /claude|gpt|gemini/.test(k)));
  });

  it('folds effort, thinking and fast into one base model', () => {
    const { base } = findVariant(cat, 'claude-opus-5-5-xhigh-fast');
    assert.ok(base);
    assert.equal(base!.key, 'claude-opus-5-5');
    assert.equal(base!.label, 'Claude Opus 5.5');
    assert.ok(!base!.tags.includes('1M'));
    assert.ok(base!.variants.length >= 10);
    // the default is the plain-named, non-fast variant
    assert.equal(base!.defaultId, 'claude-opus-5-5-medium');
  });

  it('switches variants and falls back to the nearest one', () => {
    const { base } = findVariant(cat, 'claude-opus-5-5-medium');
    assert.equal(resolveVariant(base!, { effort: 'high', thinking: false, fast: true }).id, 'claude-opus-5-5-high-fast');
    const sol = findVariant(cat, 'gpt-5.6-sol-high').base!;
    assert.equal(resolveVariant(sol, { effort: 'max', fast: false }).id, 'gpt-5.6-sol-max');
  });

  it('parses suffixes', () => {
    assert.deepEqual(parseCursorId('claude-opus-5-thinking-xhigh-fast'), { key: 'claude-opus-5', effort: 'xhigh', thinking: true, fast: true });
    assert.deepEqual(parseCursorId('composer-2.5'), { key: 'composer-2.5', effort: undefined, thinking: false, fast: false });
  });

  it('labels the composer button briefly', () => {
    assert.equal(shortLabel(cat, 'auto'), 'Auto');
    assert.equal(shortLabel(cat, 'claude-opus-5-5-high-fast'), 'Opus 5.5 · High · Fast');
    assert.equal(shortLabel(claudeCatalog(), 'opus', 'high'), 'Opus · High');
  });
});
