import { describe, expect, it } from 'vitest';
import { addAcknowledgmentReaction, setAcknowledgmentReaction } from './acknowledge.js';
import type { InstallationOctokit } from './auth.js';

function createMockOctokit(
  reactions: Array<{ id: number; content: string; user: { login: string } }> = [],
): InstallationOctokit & { calls: Array<{ route: string; params: Record<string, unknown> }> } {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return { data: route.startsWith('GET ') ? reactions : { id: 1 } };
    },
    calls,
  } as unknown as InstallationOctokit & { calls: typeof calls };
  return octokit;
}

describe('addAcknowledgmentReaction', () => {
  it('reacts to the comment when commentId is provided', async () => {
    const octokit = createMockOctokit();
    await addAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { commentId: 123 });

    expect(octokit.calls).toHaveLength(1);
    expect(octokit.calls[0]).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
      params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', comment_id: 123, content: '+1' },
    });
  });

  it('falls back to the issue when no commentId is provided', async () => {
    const octokit = createMockOctokit();
    await addAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { issueNumber: 42 });

    expect(octokit.calls).toHaveLength(1);
    expect(octokit.calls[0]).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/issues/{issue_number}/reactions',
      params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 42, content: '+1' },
    });
  });

  it('prefers the change request number over the issue number for the fallback', async () => {
    const octokit = createMockOctokit();
    await addAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { issueNumber: 42, changeRequestNumber: 7 });

    expect(octokit.calls).toHaveLength(1);
    expect(octokit.calls[0]?.params).toMatchObject({ issue_number: 7, content: '+1' });
  });

  it('throws for a malformed repository full name', async () => {
    const octokit = createMockOctokit();
    await expect(addAcknowledgmentReaction(octokit, 'malformed', { issueNumber: 42 })).rejects.toThrow(
      'Malformed repositoryFullName',
    );
  });
});

describe('setAcknowledgmentReaction', () => {
  it('swaps the bot thumbs-up to thumbs-down on the comment, leaving other users alone', async () => {
    const octokit = createMockOctokit([
      { id: 10, content: '+1', user: { login: 'enac-ai-reviewer' } },
      { id: 11, content: '+1', user: { login: 'someone-else' } },
    ]);
    await setAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { commentId: 123 }, 'enac-ai-reviewer', '-1');

    expect(octokit.calls).toEqual([
      {
        route: 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', comment_id: 123 },
      },
      {
        route: 'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', comment_id: 123, reaction_id: 10 },
      },
      {
        route: 'POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', comment_id: 123, content: '-1' },
      },
    ]);
  });

  it('is a no-op when the bot reaction already matches', async () => {
    const octokit = createMockOctokit([{ id: 12, content: '-1', user: { login: 'enac-ai-reviewer' } }]);
    await setAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { commentId: 123 }, 'enac-ai-reviewer', '-1');

    expect(octokit.calls).toHaveLength(1);
    expect(octokit.calls[0]?.route).toContain('GET');
  });

  it('swaps on the issue itself when no commentId is provided', async () => {
    const octokit = createMockOctokit([{ id: 13, content: '+1', user: { login: 'enac-ai-reviewer' } }]);
    await setAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { issueNumber: 42 }, 'enac-ai-reviewer', '-1');

    expect(octokit.calls).toEqual([
      {
        route: 'GET /repos/{owner}/{repo}/issues/{issue_number}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 42 },
      },
      {
        route: 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 42, reaction_id: 13 },
      },
      {
        route: 'POST /repos/{owner}/{repo}/issues/{issue_number}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 42, content: '-1' },
      },
    ]);
  });

  it('restores thumbs-up on a failed target when asked', async () => {
    const octokit = createMockOctokit([{ id: 14, content: '-1', user: { login: 'enac-ai-reviewer' } }]);
    await setAcknowledgmentReaction(octokit, 'EPFL-ENAC/co2-calculator', { changeRequestNumber: 7 }, 'enac-ai-reviewer', '+1');

    expect(octokit.calls).toEqual([
      {
        route: 'GET /repos/{owner}/{repo}/issues/{issue_number}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 7 },
      },
      {
        route: 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 7, reaction_id: 14 },
      },
      {
        route: 'POST /repos/{owner}/{repo}/issues/{issue_number}/reactions',
        params: { owner: 'EPFL-ENAC', repo: 'co2-calculator', issue_number: 7, content: '+1' },
      },
    ]);
  });

  it('throws for a malformed repository full name', async () => {
    const octokit = createMockOctokit();
    await expect(
      setAcknowledgmentReaction(octokit, 'malformed', { issueNumber: 42 }, 'enac-ai-reviewer', '-1'),
    ).rejects.toThrow('Malformed repositoryFullName');
  });
});
