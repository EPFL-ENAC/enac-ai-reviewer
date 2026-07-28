import { describe, expect, it } from 'vitest';
import { mapWebhookEvent } from './map-event.js';

const BOT_LOGIN = 'enac-ai-reviewer';

function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    comment: { id: 1, body: `@${BOT_LOGIN} triage`, user: { login: 'alice' } },
    issue: { number: 42 },
    repository: { full_name: 'EPFL-ENAC/co2-calculator' },
    ...overrides,
  };
}

function labeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    label: { name: 'ai-review' },
    sender: { login: 'alice' },
    repository: { full_name: 'EPFL-ENAC/co2-calculator' },
    pull_request: { number: 7, head: { sha: 'abc123' } },
    ...overrides,
  };
}

function assignedPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'assigned',
    assignee: { login: BOT_LOGIN },
    sender: { login: 'alice' },
    repository: { full_name: 'EPFL-ENAC/co2-calculator' },
    pull_request: { number: 7, head: { sha: 'abc123' } },
    ...overrides,
  };
}

describe('mapWebhookEvent', () => {
  it('maps an issue comment mention', () => {
    const trigger = mapWebhookEvent('issue_comment', 'd1', BOT_LOGIN, issueCommentPayload());
    expect(trigger).not.toBeNull();
    expect(trigger?.triggerActor).toBe('alice');
    expect(trigger?.jobType).toBe('issue_triage');
    expect(trigger?.commentId).toBe(1);
  });

  it('ignores an issue comment with a missing user login', () => {
    const payload = issueCommentPayload({ comment: { id: 1, body: `@${BOT_LOGIN} triage`, user: {} } });
    expect(mapWebhookEvent('issue_comment', 'd1', BOT_LOGIN, payload)).toBeNull();
  });

  it('ignores an issue comment with an empty user login', () => {
    const payload = issueCommentPayload({ comment: { id: 1, body: `@${BOT_LOGIN} triage`, user: { login: '' } } });
    expect(mapWebhookEvent('issue_comment', 'd1', BOT_LOGIN, payload)).toBeNull();
  });

  it('maps a labeled pull request', () => {
    const trigger = mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, labeledPayload());
    expect(trigger).not.toBeNull();
    expect(trigger?.triggerActor).toBe('alice');
    expect(trigger?.jobType).toBe('change_request_review');
  });

  it('ignores a labeled event with a missing sender login', () => {
    const payload = labeledPayload({ sender: {} });
    expect(mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, payload)).toBeNull();
  });

  it('ignores a labeled event with an empty sender login', () => {
    const payload = labeledPayload({ sender: { login: '' } });
    expect(mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, payload)).toBeNull();
  });

  it('maps an assigned pull request', () => {
    const trigger = mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, assignedPayload());
    expect(trigger).not.toBeNull();
    expect(trigger?.triggerActor).toBe('alice');
    expect(trigger?.jobType).toBe('change_request_review');
  });

  it('ignores an assigned event with a missing sender login', () => {
    const payload = assignedPayload({ sender: {} });
    expect(mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, payload)).toBeNull();
  });

  it('ignores an assigned event with an empty sender login', () => {
    const payload = assignedPayload({ sender: { login: '' } });
    expect(mapWebhookEvent('pull_request', 'd1', BOT_LOGIN, payload)).toBeNull();
  });
});
