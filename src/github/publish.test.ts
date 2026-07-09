import { describe, expect, it, vi } from 'vitest';
import { createPullRequestReview } from './publish.js';
import type { InstallationOctokit } from './auth.js';

describe('createPullRequestReview', () => {
  it('always sends event COMMENT, never APPROVE or REQUEST_CHANGES', async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const octokit = { request } as unknown as InstallationOctokit;

    await createPullRequestReview(octokit, {
      owner: 'EPFL-ENAC',
      repo: 'co2-calculator',
      pullNumber: 7,
      body: 'summary',
      comments: [],
    });

    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      expect.objectContaining({ event: 'COMMENT' }),
    );
  });
});
