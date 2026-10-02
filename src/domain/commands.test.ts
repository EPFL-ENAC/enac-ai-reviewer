import { describe, expect, it } from 'vitest';
import { parseCommandArgs, parseMentionCommand } from './commands.js';

const BOT_LOGIN = 'enac-ai-reviewer';

describe('parseMentionCommand', () => {
  it('returns the command and empty args for a plain mention', () => {
    const parsed = parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN} review`);
    expect(parsed).toEqual({ command: 'review', args: {} });
  });

  it('parses review arguments after the command word', () => {
    const parsed = parseMentionCommand(
      BOT_LOGIN,
      `@${BOT_LOGIN} review --effort=high --model=Qwen/Qwen3.5-122B-A10B --context backend --prompt="focus on security"`,
    );
    expect(parsed).toEqual({
      command: 'review',
      args: {
        effort: 'high',
        model: 'Qwen/Qwen3.5-122B-A10B',
        context: 'backend',
        prompt: 'focus on security',
      },
    });
  });

  it('is case-insensitive for the bot mention and command', () => {
    const parsed = parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN.toUpperCase()} REVIEW --EFFORT LOW`);
    expect(parsed).toEqual({ command: 'review', args: { effort: 'low' } });
  });

  it('ignores unknown arguments', () => {
    const parsed = parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN} review --unknown value --effort medium`);
    expect(parsed).toEqual({ command: 'review', args: { effort: 'medium' } });
  });

  it('returns null when the bot is not mentioned', () => {
    expect(parseMentionCommand(BOT_LOGIN, 'hello world')).toBeNull();
  });

  it('returns null when no known command follows the mention', () => {
    expect(parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN} unknown`)).toBeNull();
  });

  it('returns empty args for explain and triage', () => {
    expect(parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN} explain`)).toEqual({ command: 'explain', args: {} });
    expect(parseMentionCommand(BOT_LOGIN, `@${BOT_LOGIN} triage`)).toEqual({ command: 'triage', args: {} });
  });
});

describe('parseCommandArgs', () => {
  it('returns an empty object for an empty string', () => {
    expect(parseCommandArgs('')).toEqual({});
  });

  it('supports spaced and equals syntax', () => {
    expect(parseCommandArgs('--effort high')).toEqual({ effort: 'high' });
    expect(parseCommandArgs('--effort=high')).toEqual({ effort: 'high' });
  });

  it('supports single and double quoted values', () => {
    expect(parseCommandArgs('--prompt "focus on security"')).toEqual({ prompt: 'focus on security' });
    expect(parseCommandArgs("--prompt 'focus on security'")).toEqual({ prompt: 'focus on security' });
  });

  it('normalises effort to known values', () => {
    expect(parseCommandArgs('--effort LOW')).toEqual({ effort: 'low' });
    expect(parseCommandArgs('--effort Medium')).toEqual({ effort: 'medium' });
    expect(parseCommandArgs('--effort HIGH')).toEqual({ effort: 'high' });
  });

  it('ignores invalid effort values', () => {
    expect(parseCommandArgs('--effort extreme')).toEqual({});
  });

  it('parses all supported arguments', () => {
    const args = parseCommandArgs(
      '--effort=high --model=Qwen/Qwen3.5-122B-A10B --context backend --prompt="focus on security"',
    );
    expect(args).toEqual({
      effort: 'high',
      model: 'Qwen/Qwen3.5-122B-A10B',
      context: 'backend',
      prompt: 'focus on security',
    });
  });
});
