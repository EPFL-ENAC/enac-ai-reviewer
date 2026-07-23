import { App } from '@octokit/app';

/** Re-wraps a PEM private key that was collapsed to a single line back into
 * the 64-character lines OpenSSL expects. If the key already contains newlines
 * or doesn't look like PEM, it is returned unchanged. */
export function normalizePrivateKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes('\n')) return trimmed;

  const match = trimmed.match(/^(-----BEGIN [A-Z\s]+-----)(.*)(-----END [A-Z\s]+-----)$/s);
  if (!match) return trimmed;

  const [, header, body, footer] = match;
  if (!header || body === undefined || !footer) return trimmed;

  const wrappedBody = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `${header}\n${wrappedBody}\n${footer}`;
}

export function createGithubApp(appId: string, privateKey: string): App {
  return new App({ appId, privateKey: normalizePrivateKey(privateKey) });
}

export type InstallationOctokit = Awaited<ReturnType<App['getInstallationOctokit']>>;

interface CacheEntry {
  id: number;
  expiresAt: number;
}

class InstallationIdCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.id;
  }

  set(key: string, id: number): void {
    this.entries.set(key, { id, expiresAt: Date.now() + this.ttlMs });
  }

  /** Exposed for tests. */
  clear(): void {
    this.entries.clear();
  }
}

/** Caches GitHub App installation IDs to avoid an API call for every webhook. */
const installationIdCache = new InstallationIdCache(60 * 60 * 1000); // 1 hour

/** For tests that need a fresh cache. */
export function resetInstallationIdCache(): void {
  installationIdCache.clear();
}

export async function getInstallationOctokitForRepo(app: App, repositoryFullName: string): Promise<InstallationOctokit> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) throw new Error(`Malformed repositoryFullName "${repositoryFullName}"`);

  const key = `repo:${repositoryFullName}`;
  let id = installationIdCache.get(key);
  if (id === undefined) {
    const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
    id = installation.id;
    installationIdCache.set(key, id);
  }
  return app.getInstallationOctokit(id);
}

export async function getInstallationOctokitForOrg(app: App, org: string): Promise<InstallationOctokit> {
  const key = `org:${org}`;
  let id = installationIdCache.get(key);
  if (id === undefined) {
    const { data: installation } = await app.octokit.request('GET /orgs/{org}/installation', { org });
    id = installation.id;
    installationIdCache.set(key, id);
  }
  return app.getInstallationOctokit(id);
}

/** Returns true if the user is a member of the org. Requires the GitHub App
 * to be installed on the org and to have the `members:read` permission. */
export async function isOrgMember(octokit: InstallationOctokit, org: string, username: string): Promise<boolean> {
  try {
    await octokit.request('GET /orgs/{org}/members/{username}', { org, username });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    throw err;
  }
}
