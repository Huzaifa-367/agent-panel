import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CursorStreamParser } from '../src/engines/cursor';
import type { AgentEvent } from '../src/engines/types';

const fixture = readFileSync(
  join(__dirname, '..', 'test', 'fixtures', 'cursor-edit.jsonl'),
  'utf8',
);

describe('CursorStreamParser', () => {
  it('maps fixture events into the common model', () => {
    const events: AgentEvent[] = [];
    const parser = new CursorStreamParser((e) => events.push(e));
    for (const line of fixture.split('\n')) {
      parser.pushLine(line);
    }

    const session = events.find((e) => e.kind === 'session');
    assert.ok(session && session.kind === 'session');
    assert.equal(session.engine, 'cursor');
    assert.ok(session.sessionId);

    const thinking = events.filter((e) => e.kind === 'thinking');
    assert.ok(thinking.length > 0);

    const starts = events.filter((e) => e.kind === 'tool-start');
    const ends = events.filter((e) => e.kind === 'tool-end');
    assert.ok(starts.some((e) => e.kind === 'tool-start' && e.tool === 'editToolCall'));
    assert.ok(starts.some((e) => e.kind === 'tool-start' && e.tool === 'globToolCall'));
    assert.equal(starts.length, ends.length);

    const text = events
      .filter((e) => e.kind === 'text')
      .map((e) => (e.kind === 'text' ? e.delta : ''))
      .join('');
    assert.ok(text.includes('a.txt') || text.includes('Done'));

    const done = events.find((e) => e.kind === 'done');
    assert.ok(done && done.kind === 'done' && done.ok);
  });
});

describe('CursorStreamParser command output', () => {
  it('carries the command and its full stdout and stderr', () => {
    const events: AgentEvent[] = [];
    const parser = new CursorStreamParser((e) => events.push(e));
    const call = (subtype: string, result?: object) =>
      JSON.stringify({ type: 'tool_call', subtype, call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm test' }, ...(result ? { result } : {}) } } });
    parser.pushLine(call('started'));
    parser.pushLine(call('completed', { success: { stdout: 'ok 1\nok 2\n', stderr: 'deprecated\n' } }));
    const start = events.find((e) => e.kind === 'tool-start');
    const end = events.find((e) => e.kind === 'tool-end');
    assert.ok(start && start.kind === 'tool-start');
    assert.equal((start.input as { command?: string }).command, 'npm test');
    assert.ok(end && end.kind === 'tool-end');
    assert.equal(end.output, 'ok 1\nok 2\ndeprecated');
  });
});
