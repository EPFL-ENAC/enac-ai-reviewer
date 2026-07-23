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

export async function getInstallationOctokitForRepo(app: App, repositoryFullName: string): Promise<InstallationOctokit> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) throw new Error(`Malformed repositoryFullName "${repositoryFullName}"`);

  const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
  return app.getInstallationOctokit(installation.id);
}
