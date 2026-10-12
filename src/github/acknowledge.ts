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

/** Ensures the bot's own reaction on the target message/issue is `content`
 * ('+1' or '-1'): removes any other reaction it placed there and adds the
 * desired one when missing. Used to flip the acknowledgment to 👎 when a job
 * fails (and back to 👍 when a retry succeeds). */
export async function setAcknowledgmentReaction(
  octokit: InstallationOctokit,
  repositoryFullName: string,
  target: { commentId?: number; issueNumber?: number; changeRequestNumber?: number },
  botLogin: string,
  content: '+1' | '-1',
): Promise<void> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Malformed repositoryFullName "${repositoryFullName}"`);
  }

  if (target.commentId != null) {
    await ensureCommentReaction(octokit, owner, repo, target.commentId, botLogin, content);
    return;
  }

  const issueNumber = target.changeRequestNumber ?? target.issueNumber;
  if (issueNumber != null) {
    await ensureIssueReaction(octokit, owner, repo, issueNumber, botLogin, content);
  }
}

async function ensureCommentReaction(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  commentId: number,
  botLogin: string,
  content: '+1' | '-1',
): Promise<void> {
  const { data: reactions } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
    owner,
    repo,
    comment_id: commentId,
  });
  const own = reactions.filter((reaction) => reaction.user?.login === botLogin);
  for (const reaction of own) {
    if (reaction.content === content) continue;
    await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}', {
      owner,
      repo,
      comment_id: commentId,
      reaction_id: reaction.id,
    });
  }
  if (!own.some((reaction) => reaction.content === content)) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  }
}

async function ensureIssueReaction(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
  botLogin: string,
  content: '+1' | '-1',
): Promise<void> {
  const { data: reactions } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
    owner,
    repo,
    issue_number: issueNumber,
  });
  const own = reactions.filter((reaction) => reaction.user?.login === botLogin);
  for (const reaction of own) {
    if (reaction.content === content) continue;
    await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}', {
      owner,
      repo,
      issue_number: issueNumber,
      reaction_id: reaction.id,
    });
  }
  if (!own.some((reaction) => reaction.content === content)) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
      owner,
      repo,
      issue_number: issueNumber,
      content,
    });
  }
}
