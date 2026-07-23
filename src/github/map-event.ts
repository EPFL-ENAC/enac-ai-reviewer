import { commandForLabel, parseMentionCommand, resolveJobType } from '../domain/commands.js';
import type { JobType } from '../domain/types.js';

export interface MappedTrigger {
  jobType: JobType;
  repositoryFullName: string;
  issueNumber?: number;
  changeRequestNumber?: number;
  headSha?: string;
  triggerActor: string;
  dedupeKey: string;
  payload: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface IssueCommentPayload {
  action: string;
  comment: { id: number; body: string; user: { login: string } };
  issue: { number: number; pull_request?: unknown };
  repository: { full_name: string };
}

interface LabeledPayload {
  action: string;
  label: { name: string };
  repository: { full_name: string };
  sender: { login: string };
  issue?: { number: number };
  pull_request?: { number: number; head: { sha: string } };
}

interface AssignedPayload {
  action: string;
  assignee: { login: string } | null;
  repository: { full_name: string };
  sender: { login: string };
  issue?: { number: number };
  pull_request?: { number: number; head: { sha: string } };
}

function issueCommentTrigger(botLogin: string, deliveryId: string, payload: IssueCommentPayload): MappedTrigger | null {
  if (payload.action !== 'created') return null;

  const actor = payload.comment?.user?.login;
  if (!nonEmptyString(actor)) return null;
  if (actor === botLogin) return null; // never react to our own comments

  const isChangeRequest = Boolean(payload.issue.pull_request);
  const command = parseMentionCommand(botLogin, payload.comment.body);
  if (!command) return null;

  const jobType = resolveJobType(command, isChangeRequest ? 'change_request' : 'issue');
  if (!jobType) return null;

  const repositoryFullName = payload.repository.full_name;
  const number = payload.issue.number;

  return {
    jobType,
    repositoryFullName,
    issueNumber: isChangeRequest ? undefined : number,
    changeRequestNumber: isChangeRequest ? number : undefined,
    triggerActor: actor,
    dedupeKey: `github:${repositoryFullName}:${jobType}:${number}:comment-${payload.comment.id}`,
    payload,
  };
}

function labeledTrigger(deliveryId: string, payload: LabeledPayload): MappedTrigger | null {
  if (payload.action !== 'labeled') return null;

  const actor = payload.sender?.login;
  if (!nonEmptyString(actor)) return null;

  const command = commandForLabel(payload.label.name);
  if (!command) return null;

  const isChangeRequest = Boolean(payload.pull_request);
  const jobType = resolveJobType(command, isChangeRequest ? 'change_request' : 'issue');
  if (!jobType) return null;

  const repositoryFullName = payload.repository.full_name;
  const number = isChangeRequest ? payload.pull_request!.number : payload.issue!.number;
  const headSha = payload.pull_request?.head.sha;

  return {
    jobType,
    repositoryFullName,
    issueNumber: isChangeRequest ? undefined : number,
    changeRequestNumber: isChangeRequest ? number : undefined,
    headSha,
    triggerActor: actor,
    dedupeKey: headSha
      ? `github:${repositoryFullName}:${jobType}:${number}:${headSha}`
      : `github:${repositoryFullName}:${jobType}:${number}:delivery-${deliveryId}`,
    payload,
  };
}

function assignedTrigger(botLogin: string, deliveryId: string, payload: AssignedPayload): MappedTrigger | null {
  if (payload.action !== 'assigned') return null;
  if (payload.assignee?.login !== botLogin) return null;

  const actor = payload.sender?.login;
  if (!nonEmptyString(actor)) return null;

  const isChangeRequest = Boolean(payload.pull_request);
  const jobType: JobType | null = isChangeRequest ? 'change_request_review' : 'issue_triage';

  const repositoryFullName = payload.repository.full_name;
  const number = isChangeRequest ? payload.pull_request!.number : payload.issue!.number;
  const headSha = payload.pull_request?.head.sha;

  return {
    jobType,
    repositoryFullName,
    issueNumber: isChangeRequest ? undefined : number,
    changeRequestNumber: isChangeRequest ? number : undefined,
    headSha,
    triggerActor: actor,
    dedupeKey: headSha
      ? `github:${repositoryFullName}:${jobType}:${number}:${headSha}`
      : `github:${repositoryFullName}:${jobType}:${number}:delivery-${deliveryId}`,
    payload,
  };
}

/** Translates a raw GitHub webhook event into a neutral trigger, or null if it should be ignored. */
export function mapWebhookEvent(
  event: string,
  deliveryId: string,
  botLogin: string,
  payload: unknown,
): MappedTrigger | null {
  switch (event) {
    case 'issue_comment':
      return issueCommentTrigger(botLogin, deliveryId, payload as IssueCommentPayload);
    case 'issues':
    case 'pull_request': {
      const action = (payload as { action: string }).action;
      if (action === 'labeled') return labeledTrigger(deliveryId, payload as LabeledPayload);
      if (action === 'assigned') return assignedTrigger(botLogin, deliveryId, payload as AssignedPayload);
      return null;
    }
    default:
      return null;
  }
}
