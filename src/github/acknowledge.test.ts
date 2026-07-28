import { describe, expect, it } from 'vitest';
import { addAcknowledgmentReaction } from './acknowledge.js';
import type { InstallationOctokit } from './auth.js';

function createMockOctokit(): InstallationOctokit & { calls: Array<{ route: string; params: Record<string, unknown> }> } {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return { data: { id: 1 } };
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
