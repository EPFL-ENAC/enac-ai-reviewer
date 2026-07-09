/** Auth/permission/not-found errors from the GitHub API won't resolve by retrying. */
export function isPermanentGithubError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status == null) return false;
  return status === 401 || status === 403 || status === 404 || status === 422;
}
