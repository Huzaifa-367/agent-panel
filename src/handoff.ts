/** Prompts for the hand-off flow: the planner plans read-only, the builder builds, the planner reviews. */

export function planPrompt(request: string): string {
  return [
    'You are planning only. Do not edit files or run mutating commands.',
    'Produce a clear, concrete implementation plan for this request.',
    'Use short sections and numbered steps. End with a brief risk note.',
    '',
    'Request:',
    request,
  ].join('\n');
}

export function buildPrompt(request: string, plan: string): string {
  return [
    'Implement the following plan. Make the code changes needed. Do not commit.',
    '',
    'Original request:',
    request,
    '',
    'Plan:',
    plan,
  ].join('\n');
}

export function reviewPrompt(request: string, plan: string, changedFiles: string[]): string {
  return [
    'Review the builder\'s work against the plan. Read-only: do not edit files.',
    'Say what looks correct, what is missing, and any risks.',
    '',
    'Original request:',
    request,
    '',
    'Plan:',
    plan,
    '',
    'Files changed:',
    changedFiles.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '(none reported)',
  ].join('\n');
}
