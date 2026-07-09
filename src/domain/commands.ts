import type { JobType, TriggerCommand } from './types.js';

const COMMANDS: readonly TriggerCommand[] = ['review', 'explain', 'triage'];

export type EventContext = 'issue' | 'change_request';

/** Maps a trigger command to a job type given the context it fired in. Returns
 * null for combinations the bot doesn't support (e.g. "review" on a plain issue). */
export function resolveJobType(command: TriggerCommand, context: EventContext): JobType | null {
  if (command === 'triage' && context === 'issue') return 'issue_triage';
  if (command === 'explain' && context === 'change_request') return 'change_request_explain';
  if (command === 'review' && context === 'change_request') return 'change_request_review';
  return null;
}

export function parseMentionCommand(botLogin: string, body: string): TriggerCommand | null {
  const mention = `@${botLogin}`;
  const idx = body.toLowerCase().indexOf(mention.toLowerCase());
  if (idx === -1) return null;

  const rest = body.slice(idx + mention.length).trim();
  const word = rest.split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z]/g, '');
  return COMMANDS.find((c) => c === word) ?? null;
}

export function commandForLabel(label: string): TriggerCommand | null {
  if (label === 'ai-review') return 'review';
  if (label === 'ai-triage') return 'triage';
  return null;
}
