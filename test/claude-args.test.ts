import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildClaudeArgs, resolveClaudeBinary } from '../src/engines/claude';

describe('Claude launch (Anthropic.claude-code aligned)', () => {
  it('builds the same core argv shape as the VS Code extension', () => {
    const args = buildClaudeArgs({
      model: 'haiku',
      permissionMode: 'auto',
      sessionId: 'abc-123',
    });
    assert.ok(args.includes('--output-format=stream-json'));
    assert.ok(args.includes('--input-format=stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--permission-prompt-tool=stdio'));
    assert.ok(args.includes('--setting-sources=user,project,local'));
    assert.ok(args.includes('--permission-mode=auto'));
    assert.ok(args.includes('--include-partial-messages'));
    assert.ok(args.includes('--model=haiku'));
    assert.ok(args.includes('--no-chrome'));
    assert.ok(args.includes('--replay-user-messages'));
    assert.ok(args.includes('--resume=abc-123'));
    assert.ok(!args.includes('--enable-auth-status'));
    assert.ok(!args.includes('-p'));
    assert.ok(!args.includes('--print'));
  });

  it('resolves a real Claude binary', () => {
    const bin = resolveClaudeBinary();
    assert.ok(typeof bin === 'string' && bin.length > 0);
    if (bin !== 'claude') {
      assert.ok(existsSync(bin), `expected binary to exist: ${bin}`);
    }
  });
});

describe('Auto mode', () => {
  it('can switch to bypassing permissions without a restart', () => {
    const args = buildClaudeArgs({ model: 'haiku', permissionMode: 'bypassPermissions' });
    assert.ok(args.includes('--permission-mode=bypassPermissions'));
    assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  });
});
