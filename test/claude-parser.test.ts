import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeStreamParser, partialInput, turnCost } from '../src/engines/claude';
import type { AgentEvent } from '../src/engines/types';

const fixture = readFileSync(
  join(__dirname, '..', 'test', 'fixtures', 'claude-edit.jsonl'),
  'utf8',
);

describe('ClaudeStreamParser', () => {
  it('maps fixture events into the common model', () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    for (const line of fixture.split('\n')) {
      parser.pushLine(line);
    }

    const session = events.find((e) => e.kind === 'session');
    assert.ok(session && session.kind === 'session');
    assert.equal(session.engine, 'claude');
    assert.ok(session.sessionId);

    const toolsStart = events.filter((e) => e.kind === 'tool-start');
    const toolsEnd = events.filter((e) => e.kind === 'tool-end');
    assert.ok(toolsStart.some((e) => e.kind === 'tool-start' && e.tool === 'Edit'));
    assert.ok(toolsStart.some((e) => e.kind === 'tool-start' && e.tool === 'Write'));
    assert.ok(toolsEnd.length >= 2);
    // A command's full output comes through, not just the short summary.
    assert.ok(toolsEnd.some((e) => e.kind === 'tool-end' && e.output === '     1\tline1\n     2\tline2\n---'));

    const usage = events.find((e) => e.kind === 'usage');
    assert.ok(usage && usage.kind === 'usage');
    assert.ok(typeof usage.sevenDay === 'number');

    const done = events.filter((e) => e.kind === 'done');
    assert.ok(done.some((e) => e.kind === 'done' && e.ok));
  });
});

describe('ClaudeStreamParser command output', () => {
  const run = (...lines: object[]) => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    for (const l of lines) parser.pushLine(JSON.stringify(l));
    return events.filter((e) => e.kind === 'tool-end');
  };
  const result = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error: false }] }, ...extra });

  it('joins stdout and stderr in full, past the short summary', () => {
    const out = 'x'.repeat(900);
    const [end] = run(result('ignored', { tool_use_result: { stdout: out, stderr: 'warning: slow' } }));
    assert.ok(end.kind === 'tool-end');
    assert.equal(end.output, `${out}\nwarning: slow`);
    assert.equal(end.summary?.length, 500);
  });

  it('reads text blocks when there is no stdout, and gives none for empty output', () => {
    const [a] = run(result([{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }]));
    assert.ok(a.kind === 'tool-end');
    assert.equal(a.output, 'line 1\nline 2');
    const [b] = run(result('', { tool_use_result: { stdout: '', stderr: '' } }));
    assert.ok(b.kind === 'tool-end');
    assert.equal(b.output, undefined);
  });
});

describe('ClaudeStreamParser live tool input', () => {
  it('reads the fields of half-arrived input', () => {
    assert.deepEqual(partialInput('{"command":"git status && ec'), { command: 'git status && ec' });
    assert.deepEqual(partialInput('{"file_path":"/a/b.ts","old_string":"x'), { file_path: '/a/b.ts' });
    assert.deepEqual(partialInput('{"command":"echo \\"hi\\" \\\\n done"}'), { command: 'echo "hi" \\n done' });
    assert.equal(partialInput('{"descr'), undefined);
  });

  it('names a running command before its input has finished arriving', () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    const ev = (event: object) => parser.pushLine(JSON.stringify({ type: 'stream_event', event }));
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tb', name: 'Bash', input: {} } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm run build && ' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'npm test --silent"}' } });
    const starts = events.filter((e) => e.kind === 'tool-start');
    assert.equal(starts[0].kind === 'tool-start' && starts[0].title, 'Ran command');
    const last = starts[starts.length - 1];
    assert.ok(last.kind === 'tool-start');
    assert.equal(last.title, 'Ran `npm run build && npm test --silent`');
    assert.equal((last.input as { command: string }).command, 'npm run build && npm test --silent');
  });
});

describe('turnCost', () => {
  it("is this turn's share of the process total", () => {
    assert.equal(turnCost(2825.13, 2824.86).toFixed(2), '0.27');
    assert.equal(turnCost(0.4, 0), 0.4);
    assert.equal(turnCost(0.1, 3), 0.1);
  });
});

describe('ClaudeStreamParser subagents', () => {
  it("marks a subagent's steps with their parent and keeps its text out of the answer", () => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    const send = (o: object) => parser.pushLine(JSON.stringify(o));
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'A1', name: 'Agent', input: { description: 'Find imports', subagent_type: 'Explore', prompt: 'grep it' } }] }, parent_tool_use_id: null });
    send({ type: 'stream_event', parent_tool_use_id: 'A1', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'G1', name: 'Grep', input: {} } } });
    send({ type: 'stream_event', parent_tool_use_id: 'A1', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'inner chatter' } } });
    send({ type: 'assistant', parent_tool_use_id: 'A1', message: { content: [{ type: 'tool_use', id: 'G1', name: 'Grep', input: { pattern: 'import' } }] } });
    send({ type: 'user', parent_tool_use_id: 'A1', message: { content: [{ type: 'tool_result', tool_use_id: 'G1', content: 'a.ts:1' }] } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'A1', content: [{ type: 'text', text: 'It imports node:test.' }] }] } });

    const starts = events.filter((e) => e.kind === 'tool-start');
    const top = starts.find((e) => e.kind === 'tool-start' && e.id === 'A1');
    assert.ok(top && top.kind === 'tool-start' && !top.parentId && top.tool === 'Agent');
    const inner = starts.filter((e) => e.kind === 'tool-start' && e.id === 'G1');
    assert.ok(inner.length >= 1 && inner.every((e) => e.kind === 'tool-start' && e.parentId === 'A1'));
    assert.ok(!events.some((e) => e.kind === 'text'));
    const end = events.find((e) => e.kind === 'tool-end' && e.id === 'A1');
    assert.ok(end && end.kind === 'tool-end' && end.output === 'It imports node:test.');
  });
});
