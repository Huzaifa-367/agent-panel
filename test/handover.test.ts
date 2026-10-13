import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoverPrefix, createThread, type Thread } from '../src/threads';

function thread(): Thread {
  const t = createThread({ engine: 'cursor', mode: 'agent', claudeModel: 'opus', cursorModel: 'auto', planner: 'claude', builder: 'cursor', reviewAfter: true });
  t.messages = [
    { id: 'u1', role: 'user', engine: 'cursor', text: 'Fix the support table test', createdAt: 1 },
    {
      id: 'a1', role: 'assistant', engine: 'cursor', text: 'Pointed the locator at the table by role.', createdAt: 2,
      steps: [
        { id: 's1', tool: 'readToolCall', title: 'Read `support.spec.ts`', status: 'ok', path: 'e2e/support.spec.ts' },
        { id: 's2', tool: 'shellToolCall', title: 'Ran `npx playwright test`', status: 'fail', summary: '1 failed\nError: locator resolved to 0 elements' },
        { id: 's3', tool: 'editToolCall', title: 'Edited `support.spec.ts`', status: 'ok', path: 'e2e/support.spec.ts', additions: 2, deletions: 1, diff: '@@' },
        { id: 's4', tool: 'todoToolCall', title: 'Updated the to-do list', status: 'ok', todos: [
          { content: 'Fix the locator', status: 'completed' },
          { content: 'Run the tests again', status: 'in_progress' },
        ] },
      ],
    },
  ];
  return t;
}

describe('hand-over between engines', () => {
  it('carries what was asked, done, and where the work stands', () => {
    const text = buildHandoverPrefix(thread(), 'claude', [{ relPath: 'e2e/support.spec.ts', additions: 2, deletions: 1 }], '-old\n+new\n');
    assert.match(text, /taking over this chat from Cursor/);
    assert.match(text, /User: Fix the support table test/);
    assert.match(text, /Cursor: Pointed the locator/);
    assert.match(text, /read e2e\/support\.spec\.ts/);
    assert.match(text, /npx playwright test \[failed: .*locator resolved to 0 elements/);
    assert.match(text, /edited e2e\/support\.spec\.ts \(\+2 −1\)/);
    assert.match(text, /- \[x\] Fix the locator/);
    assert.match(text, /- \[~\] Run the tests again/);
    assert.match(text, /Changed files not reviewed yet: e2e\/support\.spec\.ts \(\+2 −1\)/);
    assert.match(text, /```diff\n-old\n\+new/);
  });

  it('drops the oldest turns first when over budget, keeping the newest and the work state', () => {
    const t = thread();
    for (let i = 0; i < 40; i += 1) {
      t.messages.unshift({ id: `old${i}`, role: 'user', engine: 'cursor', text: `old question ${i} ${'x'.repeat(900)}`, createdAt: 0 });
    }
    const text = buildHandoverPrefix(t, 'claude', []);
    assert.ok(text.length <= 24_000);
    assert.match(text, /earlier turns left out/);
    assert.match(text, /Fix the support table test/);
    assert.match(text, /Run the tests again/);
  });
});
