import { App } from '@octokit/app';

export function createGithubApp(appId: string, privateKey: string): App {
  return new App({ appId, privateKey });
}

export type InstallationOctokit = Awaited<ReturnType<App['getInstallationOctokit']>>;

export async function getInstallationOctokitForRepo(app: App, repositoryFullName: string): Promise<InstallationOctokit> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) throw new Error(`Malformed repositoryFullName "${repositoryFullName}"`);

  const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
  return app.getInstallationOctokit(installation.id);
}
