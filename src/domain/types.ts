export type JobType =
  | 'issue_triage'
  | 'change_request_explain'
  | 'change_request_review'
  | 'review_thread_reply';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

export type TriggerCommand = 'review' | 'explain' | 'triage';

export interface ReviewJob {
  id: string;
  provider: 'github';
  type: JobType;
  status: JobStatus;
  repositoryFullName: string;
  issueNumber: number | null;
  changeRequestNumber: number | null;
  headSha: string | null;
  triggerActor: string;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
}

export interface NewReviewJob {
  provider: 'github';
  type: JobType;
  repositoryFullName: string;
  issueNumber?: number;
  changeRequestNumber?: number;
  headSha?: string;
  triggerActor: string;
  dedupeKey: string;
  payload: unknown;
}
