import type { InstallationOctokit } from './auth.js';

/** Adds a 👍 reaction to the message/issue that triggered the bot. When the
 * invocation came from an issue comment, the reaction is placed on that
 * comment. Otherwise it falls back to the issue or pull request itself. */
export async function addAcknowledgmentReaction(
  octokit: InstallationOctokit,
  repositoryFullName: string,
  target: { commentId?: number; issueNumber?: number; changeRequestNumber?: number },
): Promise<void> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Malformed repositoryFullName "${repositoryFullName}"`);
  }

  if (target.commentId != null) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
      owner,
      repo,
      comment_id: target.commentId,
      content: '+1',
    });
    return;
  }

  const issueNumber = target.changeRequestNumber ?? target.issueNumber;
  if (issueNumber != null) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
      owner,
      repo,
      issue_number: issueNumber,
      content: '+1',
    });
  }
}
