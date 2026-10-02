import type { CommandArgs, JobType, TriggerCommand } from './types.js';

const COMMANDS: readonly TriggerCommand[] = ['review', 'explain', 'triage'];

export type EventContext = 'issue' | 'change_request';

export interface ParsedMentionCommand {
  command: TriggerCommand;
  args: CommandArgs;
}

/** Maps a trigger command to a job type given the context it fired in. Returns
 * null for combinations the bot doesn't support (e.g. "review" on a plain issue). */
export function resolveJobType(command: TriggerCommand, context: EventContext): JobType | null {
  if (command === 'triage' && context === 'issue') return 'issue_triage';
  if (command === 'explain' && context === 'change_request') return 'change_request_explain';
  if (command === 'review' && context === 'change_request') return 'change_request_review';
  return null;
}

const ARG_REGEX = /--([a-zA-Z][a-zA-Z0-9_-]*)(?:(?:\s*=\s*|\s+)(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;

function normaliseEffort(value: string): CommandArgs['effort'] {
  const lower = value.toLowerCase();
  if (lower === 'low' || lower === 'medium' || lower === 'high') return lower;
  return undefined;
}

export function parseCommandArgs(rest: string): CommandArgs {
  const raw: Record<string, string> = {};

  let match: RegExpExecArray | null;
  ARG_REGEX.lastIndex = 0;
  while ((match = ARG_REGEX.exec(rest)) !== null) {
    const key = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4]) || '';
    raw[key] = value;
  }

  const args: CommandArgs = {};
  if (raw.effort) args.effort = normaliseEffort(raw.effort);
  if (raw.model) args.model = raw.model;
  if (raw.context) args.context = raw.context;
  if (raw.prompt) args.prompt = raw.prompt;
  return args;
}

export function parseMentionCommand(botLogin: string, body: string): ParsedMentionCommand | null {
  const mention = `@${botLogin}`;
  const idx = body.toLowerCase().indexOf(mention.toLowerCase());
  if (idx === -1) return null;

  const rest = body.slice(idx + mention.length).trim();
  const word = rest.split(/\s+/, 1)[0]!.toLowerCase().replace(/[^a-z]/g, '');
  const command = COMMANDS.find((c) => c === word);
  if (!command) return null;

  const argSection = rest.slice(word.length).trim();
  return { command, args: parseCommandArgs(argSection) };
}

export function commandForLabel(label: string): TriggerCommand | null {
  if (label === 'ai-review') return 'review';
  if (label === 'ai-triage') return 'triage';
  return null;
}
