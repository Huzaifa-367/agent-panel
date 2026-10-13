import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamParser } from '../src/engines/claude';
import { subagentReport, type AgentEvent } from '../src/engines/types';

describe('subagents in the Claude stream', () => {
  const run = (...lines: object[]) => {
    const events: AgentEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    for (const l of lines) parser.pushLine(JSON.stringify(l));
    return events;
  };
  const start = (id: string, name: string, parent: string | null = null) => ({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  });

  it("marks a subagent's tool calls with the subagent's step as parent", () => {
    const events = run(
      start('agent1', 'Agent'),
      start('read1', 'Read', 'agent1'),
      { type: 'assistant', parent_tool_use_id: 'agent1', message: { content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/a/b.ts' } }] } },
      start('top1', 'Bash'),
    );
    const starts = events.filter((e) => e.kind === 'tool-start');
    const by = (id: string) => starts.filter((e) => e.kind === 'tool-start' && e.id === id);
    assert.ok(by('agent1').every((e) => e.kind === 'tool-start' && e.parentId === undefined));
    assert.ok(by('read1').length >= 2 && by('read1').every((e) => e.kind === 'tool-start' && e.parentId === 'agent1'));
    assert.ok(by('top1').every((e) => e.kind === 'tool-start' && e.parentId === undefined));
  });

  it("shows a subagent's report without the harness framing", () => {
    const raw = '[Subagent hand-back] The text below is the final report. The report follows:\n  `a.ts` has 3 imports:\n  \n  ```\n  1: import x\n  ```';
    assert.equal(subagentReport(raw), '`a.ts` has 3 imports:\n\n```\n1: import x\n```');
    assert.equal(subagentReport('plain text'), 'plain text');
  });

  it("keeps a subagent's text out of the answer", () => {
    const events = run(
      { type: 'stream_event', parent_tool_use_id: 'agent1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', parent_tool_use_id: 'agent1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner chatter' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the answer' } } },
    );
    const text = events.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.delta : '')).join('');
    assert.equal(text, 'the answer');
  });
});
