// QA harness: a fake extension host for the built webview. Open
// qa/harness.html#<scenario>&theme=light&w=340 in a browser.
// Each scenario mirrors a page of prototype/.

(function () {
  const params = new URLSearchParams(location.hash.slice(1).replace(/^([\w-]+)/, 's=$1'));
  const scenario = params.get('s') || 'agent-turn';
  document.documentElement.dataset.theme = params.get('theme') || 'dark';
  document.documentElement.style.setProperty('--w', `${params.get('w') || 420}px`);

  const now = Date.now();
  const min = 60_000;
  const sent = [];
  window.QA_SENT = sent;

  const step = (id, tool, title, status, summary, ask) => ({ id, tool, title, status, summary, ask });
  const file = (relPath, additions, deletions, status = 'modified') => ({ relPath, additions, deletions, status });
  const trees = { base: 'base', after: 'after' };

  const PATCHES = {
    'resources/js/components/shared/kit/scroll-wrap.tsx':
      "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,16 @@\n+import { cn } from '@/lib/utils';\n+import type { ReactNode } from 'react';\n+\n+type ScrollWrapProps = {\n+    children: ReactNode;\n+    className?: string;\n+};\n+\n+/** Lets wide content scroll sideways inside its card instead of the page. */\n+export function ScrollWrap({ children, className }: ScrollWrapProps) {\n+    return (\n+        <div className={cn('-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0', className)}>\n+            <div className=\"min-w-max sm:min-w-0\">{children}</div>\n+        </div>\n+    );\n+}\n",
    'resources/js/pages/central/support/index.tsx':
      "@@ -3,6 +3,7 @@ import { PageHeader } from '@/components/shared/kit';\n import { Card } from '@/components/ui/card';\n import { Badge } from '@/components/ui/badge';\n+import { ScrollWrap } from '@/components/shared/kit/scroll-wrap';\n import { Table } from '@/components/ui/table';\n@@ -43,9 +44,11 @@ export default function SupportIndex\n         <Card>\n-            <Table>\n+            <ScrollWrap>\n+            <Table>\n                 <TicketRows tickets={tickets} />\n-            </Table>\n+            </Table>\n+            </ScrollWrap>\n         </Card>\n",
  };

  function baseState() {
    return {
      thread: {
        id: 't-1',
        title: 'Support tables overflow on phones',
        createdAt: now - 20 * min,
        updatedAt: now - 2 * min,
        messages: [],
        engine: 'claude',
        model: 'opus',
        claudeModel: 'opus',
        cursorModel: 'auto',
        mode: 'agent',
        planner: 'claude',
        builder: 'cursor',
        reviewAfter: true,
      },
      threads: [
        { id: 't-1', title: 'Support tables overflow on phones', updatedAt: now - 2 * min, engines: ['claude', 'cursor'], files: 4, mode: 'agent' },
        { id: 't-2', title: 'SLA countdown on support tickets', updatedAt: now - 70 * min, engines: ['claude', 'cursor'], files: 6, mode: 'handoff' },
        { id: 't-3', title: 'Why does the odometer query sort the whole history?', updatedAt: now - 26 * 60 * min, engines: ['claude'], files: 0, mode: 'plan' },
        { id: 't-4', title: 'Billing cutover in batches of 500', updatedAt: now - 3 * 24 * 60 * min, engines: ['cursor'], files: 3, mode: 'agent' },
      ],
      gitOk: true,
      gitMessage: '',
      running: null,
      pending: [],
      fileStates: {},
      usage: {
        claude: { fiveHour: 0.1, fiveHourResetsAt: now / 1000 + 3 * 3600, sevenDay: 0.88, sevenDayResetsAt: now / 1000 + 2.4 * 86400, updatedAt: now - 3 * min },
        cursor: { tier: 'ultra', email: 'engineering@atomcamp.com', signedIn: true, cliVersion: '2026.10.01-e373342', appEmail: 'huzaifanawaz367@gmail.com', appPlan: 'pro', appStatus: 'active' },
      },
      catalogs: window.QA_CATALOGS,
      slashCommands: ['compact', 'clear', 'init', 'review', 'security-review', 'tax-fraud', 'zero-sleep'],
      slashItems: [
        { name: 'tax-fraud', description: 'Hunts cost everywhere: trims tokens and redundant calls', kind: 'skill' },
        { name: 'zero-sleep', description: 'Keeps the thread across long multi-step builds', kind: 'skill' },
        { name: 'aura-farming', description: 'Maximum-aesthetic mode for visual work', kind: 'skill' },
        { name: 'crash-out', description: 'Attacks every claim before answering', kind: 'skill' },
        { name: 'replica-build', description: 'Builds the clone screen by screen', kind: 'skill' },
        { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'command' },
        { name: 'clear', description: 'Start the conversation fresh', kind: 'command' },
        { name: 'init', description: 'Write a CLAUDE.md for this project', kind: 'command' },
      ],
      tabs: [
        { id: 't-1', title: 'Support tables overflow on phones', running: false, engine: 'claude' },
        { id: 't-2', title: 'SLA countdown on support tickets', running: false, engine: 'cursor' },
      ],
      queue: [],
      selection: { claudeModel: 'opus', claudeEffort: 'high', claudeFast: false, cursorModel: 'auto' },
      cursorSignedOut: false,
    };
  }

  const SCENARIOS = {
    'agent-turn'() {
      const s = baseState();
      s.thread.engine = 'cursor';
      s.thread.messages = [
        { id: 'u1', role: 'user', engine: 'claude', createdAt: now - 20 * min, text: 'The support tables overflow on phones. Wrap them in a horizontal scroller on both the central and tenant support pages.', mentions: [{ kind: 'file', id: 'resources/js/pages/central/support/index.tsx', label: 'index.tsx', detail: 'resources/js/pages/central/support' }] },
        {
          id: 'a1', role: 'assistant', engine: 'claude', createdAt: now - 19 * min,
          thinking: 'Both pages render <Table> directly inside <Card>. A wrapper component keeps the fix in one place.',
          text: 'Both pages render the ticket table straight into the card, so on a narrow screen the table pushes the whole page sideways. I added a small `ScrollWrap` to the shared kit and used it on both pages.',
          steps: [
            step('s1', 'Read', 'Read `pages/central/support/index.tsx`', 'ok'),
            step('s2', 'Read', 'Read `pages/tenant/support/index.tsx`', 'ok'),
            step('s3', 'Grep', 'Searched for `overflow-x-auto`', 'ok', '6 results'),
            step('s4', 'Write', 'Edited `scroll-wrap.tsx`', 'ok', 'create'),
          ],
          files: [file('resources/js/components/shared/kit/scroll-wrap.tsx', 16, 0, 'added'), file('resources/js/pages/central/support/index.tsx', 5, 2), file('resources/js/pages/tenant/support/index.tsx', 5, 2)],
          trees,
          meta: { model: 'opus', modelLabel: 'Opus', mode: 'agent', durationMs: 41_000, usage: { inputTokens: 12, outputTokens: 900, cacheReadTokens: 80_000, costUsd: 0.24 } },
        },
        { id: 'u2', role: 'user', engine: 'cursor', createdAt: now - 5 * min, text: 'Run the support e2e tests and fix anything that breaks.' },
        { id: 'n1', role: 'system', icon: 'arrow-swap', createdAt: now - 5 * min + 1, text: 'Switched to Cursor · 2 messages and 3 changed files passed on' },
        {
          id: 'a2', role: 'assistant', engine: 'cursor', createdAt: now - 5 * min + 2,
          text: 'One test in `e2e/central/support.spec.ts:31` found the table as the card\'s first child. With the wrapper in between it found nothing, so I pointed it at the table by role instead. Running the tests again',
          steps: [
            { id: 't1', tool: 'TodoWrite', title: 'Updated the to-do list', status: 'ok', todos: [
              { content: 'Run the support e2e tests', status: 'completed' },
              { content: 'Fix the table locator', status: 'completed' },
              { content: 'Run the tests again', status: 'in_progress' },
            ] },
            { ...step('c1', 'readToolCall', 'Read `e2e/central/support.spec.ts`', 'ok'), path: 'e2e/central/support.spec.ts' },
            step('c2', 'shellToolCall', 'Ran `npx playwright test e2e/central/support.spec.ts`', 'fail', 'Running 4 tests using 2 workers\n\n  ✓ support list loads (1.8s)\n  ✘ table fits the card on mobile (2.4s)\n    Error: locator(\'.card > table\') resolved to 0 elements\n\n  1 failed, 3 passed (6.2s)'),
            { ...step('c3', 'editToolCall', 'Edited `support.spec.ts`', 'ok'), path: 'e2e/central/support.spec.ts', line: 31, additions: 2, deletions: 1,
              diff: "@@ -30,4 +30,5 @@\n test('table fits the card on mobile', async ({ page }) => {\n     await page.setViewportSize({ width: 390, height: 844 });\n-    const table = page.locator('.card > table');\n+    // the table now sits inside ScrollWrap, so find it by role\n+    const table = page.getByRole('table');\n     await expect(table).toBeVisible();" },
            step('c4', 'shellToolCall', 'Ran `npx playwright test e2e/central/support.spec.ts`', 'running'),
            { ...step('ag1', 'Agent', 'Started a subagent: Find the table wrapper', 'ok', 'ScrollWrap is used by both pages.'), agent: { type: 'Explore', description: 'Find the table wrapper', prompt: 'Find where Table is wrapped in Card and list the files.' }, output: 'ScrollWrap is used by support/index.tsx and billing/index.tsx.' },
            { ...step('ag1a', 'Grep', 'Searched `ScrollWrap`', 'ok'), parentId: 'ag1' },
            { ...step('ag1b', 'Read', 'Read `scroll-wrap.tsx`', 'ok'), parentId: 'ag1', path: 'resources/js/components/scroll-wrap.tsx' },
            { ...step('ag2', 'Agent', 'Started a subagent: Check usages', 'running'), parentId: 'ag1', agent: { type: 'general-purpose', description: 'Check usages' } },
            { ...step('ag2a', 'Bash', 'Ran `grep -rn ScrollWrap resources`', 'running'), parentId: 'ag2', command: 'grep -rn ScrollWrap resources' },
          ],
          meta: { model: 'auto', modelLabel: 'Auto', mode: 'agent' },
          thinking: 'The failing test looks for the table as the card child.',
          parts: [
            { kind: 'thinking', text: 'The failing test looks for the table as the card child.', startedAt: now - 300000, endedAt: now - 296000 },
            { kind: 'thinking', text: '', startedAt: now - 296000, endedAt: now - 295000 },
            { kind: 'steps', ids: ['t1', 'c1', 'c2'] },
            { kind: 'text', text: 'One test found the table as the card\'s first child. With the wrapper in between it found nothing, so I pointed it at the table by role.' },
            { kind: 'steps', ids: ['c3', 'ag1'] },
            { kind: 'text', text: 'Running the tests again in `e2e/central/support.spec.ts:31`' },
            { kind: 'steps', ids: ['c4'] },
          ],
        },
      ];
      s.running = { messageId: 'a2', engine: 'cursor', threadId: 't-1' };
      s.tabs[0].running = true;
      s.queue = [{ text: 'Then update the support page screenshot in the docs', attachments: 0 }];
      s.pending = [file('resources/js/components/shared/kit/scroll-wrap.tsx', 16, 0, 'added'), file('resources/js/pages/central/support/index.tsx', 5, 2)];
      s.fileStates = { 'resources/js/components/shared/kit/scroll-wrap.tsx': 'pending', 'resources/js/pages/central/support/index.tsx': 'pending', 'resources/js/pages/tenant/support/index.tsx': 'accepted' };
      return s;
    },

    handoff() {
      const s = baseState();
      s.thread.title = 'SLA countdown on support tickets';
      s.thread.mode = 'handoff';
      const plan = '1. Add `sla_due_at` to tickets and set it to 24 hours after creation.\n   Files: database/migrations, app/Models/Ticket.php\n2. Send `sla_due_at` with each ticket.\n3. Add an `SlaBadge` to the shared kit: counts down, amber under 4 hours, red when overdue.\n4. Show the badge in both support tables.\n5. A feature test for the due date and an e2e check for the badge.';
      s.thread.messages = [
        { id: 'u1', role: 'user', engine: 'claude', createdAt: now - 30 * min, text: 'Add an SLA countdown to each open support ticket: 24 hours from creation, amber under 4 hours, red when overdue.' },
        {
          id: 'a1', role: 'assistant', engine: 'claude', createdAt: now - 29 * min, text: plan,
          steps: [step('s1', 'Read', 'Read `app/Models/Ticket.php`', 'ok'), step('s2', 'Grep', 'Searched for `created_at`', 'ok', '4 results')],
          plan: { request: '…', planner: 'claude', builder: 'cursor', reviewAfter: true, state: 'built' },
          meta: { model: 'opus', modelLabel: 'Opus', mode: 'plan', role: 'planner', durationMs: 22_000, usage: { costUsd: 0.11 } },
        },
        { id: 'n1', role: 'system', icon: 'arrow-right', createdAt: now - 28 * min, text: 'Plan and request passed to Cursor' },
        {
          id: 'a2', role: 'assistant', engine: 'cursor', createdAt: now - 27 * min, text: 'Built all five steps. Both test runs pass.',
          steps: [step('c1', 'shellToolCall', 'Ran `php artisan test --filter=TicketSla`', 'ok', '2 passed'), step('c2', 'shellToolCall', 'Ran `npx playwright test e2e/central/support.spec.ts`', 'ok', '5 passed')],
          files: [file('database/migrations/2026_10_13_add_sla_due_at_to_tickets.php', 24, 0, 'added'), file('resources/js/components/shared/kit/sla-badge.tsx', 31, 0, 'added'), file('app/Models/Ticket.php', 6, 0), file('app/Http/Resources/TicketResource.php', 1, 0), file('resources/js/pages/central/support/index.tsx', 3, 1), file('resources/js/pages/tenant/support/index.tsx', 3, 1)],
          trees,
          meta: { model: 'auto', modelLabel: 'Auto', mode: 'agent', role: 'builder', durationMs: 134_000, usage: { inputTokens: 48_000, outputTokens: 2100 } },
        },
        { id: 'n2', role: 'system', icon: 'arrow-left', createdAt: now - 25 * min, text: 'Diff sent back to Claude for review, read-only' },
        {
          id: 'a3', role: 'assistant', engine: 'claude', createdAt: now - 24 * min,
          text: '- Migration, model cast and resource match the plan.\n- Badge thresholds are right: amber under 4 hours, red when overdue.\n- **One gap:** `sla_due_at` is set in the controller, so tickets created by the email importer get none. Set it in a model `creating` hook instead.',
          meta: { model: 'opus', modelLabel: 'Opus', mode: 'plan', role: 'reviewer', durationMs: 19_000, usage: { costUsd: 0.09 } },
        },
        { id: 'u2', role: 'user', engine: 'claude', createdAt: now - 3 * min, text: 'Now add a filter for overdue tickets.' },
        {
          id: 'a4', role: 'assistant', engine: 'claude', createdAt: now - 2 * min, text: '1. Add an `overdue` scope to `Ticket`.\n2. Add an Overdue tab to both support pages.\n3. Cover the scope with a feature test.',
          plan: { request: '…', planner: 'claude', builder: 'cursor', reviewAfter: true, state: 'ready' },
          meta: { model: 'opus', modelLabel: 'Opus', mode: 'plan', role: 'planner', durationMs: 14_000, usage: { costUsd: 0.06 } },
        },
      ];
      s.pending = [file('resources/js/components/shared/kit/sla-badge.tsx', 31, 0, 'added'), file('app/Models/Ticket.php', 6, 0)];
      for (const f of s.thread.messages[3].files) s.fileStates[f.relPath] = 'pending';
      return s;
    },

    states() {
      const s = baseState();
      s.thread.title = 'Rebuild the front-end assets';
      s.gitOk = false;
      s.gitMessage = "This folder isn't a git repository, so changes can't be tracked. Accept and Reject are off.";
      s.thread.messages = [
        { id: 'u1', role: 'user', engine: 'claude', createdAt: now - 6 * min, text: 'Clear the Vite cache, rebuild the assets, and push the branch.' },
        {
          id: 'a1', role: 'assistant', engine: 'claude', createdAt: now - 6 * min + 1, text: '',
          steps: [
            step('s1', 'Read', 'Read `package.json`', 'ok'),
            { ...step('s1b', 'Bash', 'Ran `npm run build`', 'ok'), command: 'npm run build 2>&1 | tail -20', output: 'vite v5.4.0 building for production...\nwarning: chunk larger than 500 kB\n✓ 1204 modules transformed.\ndist/app.js  412.3 kB\nError: none, just a test\n✓ built in 6.31s' },
            step('s2', 'Bash', 'Ran `git push origin support-sla`', 'denied'),
            step('s3', 'Bash', 'Ran `rm -rf node_modules/.vite && npm run build`', 'ask', undefined, { id: 'p1', title: 'Claude wants to run a command', detail: "rm -rf node_modules/.vite && npm run build --silent\ncat >> test/a.test.ts <<'EOF'\nit('works', () => { assert.equal(1, 1); });\nEOF" }),
          ],
          meta: { model: 'opus', modelLabel: 'Opus', mode: 'agent' },
        },
        { id: 'u2', role: 'user', engine: 'cursor', createdAt: now - 4 * min, text: 'Use Cursor to check the build output size.' },
        { id: 'a2', role: 'assistant', engine: 'cursor', createdAt: now - 4 * min + 1, text: '', meta: { model: 'composer-2.5', modelLabel: 'Composer 2.5', mode: 'agent', error: "Cursor stopped: you're out of usage for this model." } },
        { id: 'u3', role: 'user', engine: 'claude', createdAt: now - 2 * min, text: 'Try again with Claude.' },
        { id: 'a3', role: 'assistant', engine: 'claude', createdAt: now - 2 * min + 1, text: '', meta: { model: 'opus', modelLabel: 'Opus', mode: 'agent', error: "Claude isn't signed in. Run `claude` in a terminal, sign in, then retry." } },
      ];
      s.running = { messageId: 'a1', engine: 'claude' };
      return s;
    },

    empty() {
      const s = baseState();
      s.thread.title = 'New chat';
      s.thread.id = 't-new';
      return s;
    },

    pickers() {
      const s = baseState();
      s.thread.title = 'SLA badge colours';
      s.thread.mode = 'plan';
      s.thread.messages = [
        { id: 'u1', role: 'user', engine: 'claude', createdAt: now - 3 * min, text: 'Which colour tokens does the NEMT kit use for warning and danger?' },
        {
          id: 'a1', role: 'assistant', engine: 'claude', createdAt: now - 3 * min + 1,
          text: 'Both live in `nemt/resources/css/shared/tokens.css`:\n\n| Token | Used for |\n| --- | --- |\n| `--warning` | Amber states, due soon |\n| `--destructive` | Red states, overdue |\n\n```css\n.sla-soon { color: var(--warning); }\n.sla-overdue { color: var(--destructive); }\n```',
          meta: { model: 'sonnet', modelLabel: 'Sonnet', mode: 'plan', durationMs: 9000, usage: { costUsd: 0.02 } },
        },
      ];
      s.selection.claudeModel = 'sonnet';
      s.selection.cursorModel = 'claude-opus-5-5-high-fast';
      return s;
    },
  };

  const MENTIONS = {
    '': [
      { label: 'Recent', items: [
        { kind: 'file', id: 'resources/js/components/shared/kit/sla-badge.tsx', label: 'sla-badge.tsx', detail: 'resources/js/components/shared/kit', icon: 'file-code' },
        { kind: 'file', id: 'app/Models/Ticket.php', label: 'Ticket.php', detail: 'app/Models', icon: 'file-code' },
      ] },
      { label: 'Add context', items: [
        { kind: 'category', id: 'files', label: 'Files & folders', icon: 'files' },
        { kind: 'category', id: 'code', label: 'Code', detail: 'Functions, classes, types', icon: 'symbol-method' },
        { kind: 'category', id: 'git', label: 'Git', detail: 'Working changes, commits', icon: 'git-commit' },
        { kind: 'problems', id: 'problems', label: 'Problems', detail: '2 errors, 5 warnings', icon: 'warning' },
        { kind: 'category', id: 'chats', label: 'Past chats', icon: 'comment-discussion' },
        { kind: 'category', id: 'rules', label: 'Rules', detail: 'AGENTS.md, CLAUDE.md, Cursor rules', icon: 'law' },
      ] },
    ],
    sla: [
      { label: 'Files', items: [
        { kind: 'file', id: 'resources/js/components/shared/kit/sla-badge.tsx', label: 'sla-badge.tsx', detail: 'resources/js/components/shared/kit', icon: 'file-code', match: [0, 1, 2] },
        { kind: 'file', id: 'tests/Feature/Support/TicketSlaTest.php', label: 'TicketSlaTest.php', detail: 'tests/Feature/Support', icon: 'file-code', match: [6, 7, 8] },
        { kind: 'file', id: 'config/sla.php', label: 'sla.php', detail: 'config', icon: 'file-code', match: [0, 1, 2] },
      ] },
      { label: 'Code', items: [{ kind: 'symbol', id: 'resources/js/components/shared/kit/sla-badge.tsx:9', label: 'SlaBadge', detail: 'sla-badge.tsx:10', icon: 'symbol-method', match: [0, 1, 2] }] },
      { label: 'Past chats', items: [{ kind: 'chat', id: 't-2', label: 'SLA countdown on support tickets', detail: 'Oct 13', icon: 'comment-discussion', match: [0, 1, 2] }] },
    ],
  };

  let current = null;
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      sent.push(msg);
      const reply = (m) => setTimeout(() => window.postMessage(m, '*'), 0);
      const echo = () => reply({ type: 'state', ...current });
      if (msg.type === 'ready') {
        current = SCENARIOS[scenario]();
        echo();
      }
      if (msg.type === 'listExternal') {
        reply({ type: 'external', loadingCursor: false,
          claude: [
            { source: 'claude', id: 'c05d6eb1', title: 'Anthropic.claude-code extension ID', updatedAt: now - 3 * min },
            { source: 'claude', id: '28018c24', title: 'AiLixar monorepo codebase overview', updatedAt: now - 60 * min },
          ],
          cursor: [{ source: 'cursor', id: '805a0af0', title: 'Agent panel build process', updatedAt: now - 2 * 60 * min }],
        });
      }
      if (msg.type === 'setEngine') { current.thread.engine = msg.engine; echo(); }
      if (msg.type === 'setMode') { current.thread.mode = msg.mode; echo(); }
      if (msg.type === 'setHandoff') { Object.assign(current.thread, Object.fromEntries(Object.entries(msg).filter(([k]) => k !== 'type'))); echo(); }
      if (msg.type === 'setModel') {
        if (msg.engine === 'claude') {
          current.selection.claudeModel = msg.model;
          if (msg.effort !== undefined) current.selection.claudeEffort = msg.effort;
        } else current.selection.cursorModel = msg.model;
        echo();
      }
      if (msg.type === 'getPatch') reply({ type: 'patch', key: msg.key, patch: PATCHES[msg.path] || '@@ -1,2 +1,3 @@\n line one\n+line two\n line three\n' });
      if (msg.type === 'searchMentions') reply({ type: 'mentions', requestId: msg.requestId, groups: MENTIONS[msg.query] || MENTIONS[msg.query.slice(0, 3)] || [] });
    },
    getState: () => ({}),
    setState: () => {},
  });
})();
