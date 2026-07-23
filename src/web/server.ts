import { createPool } from '../db/pool.js';
import { loadWebConfig } from '../domain/config.js';
import { createGithubApp } from '../github/auth.js';
import { buildApp } from './app.js';

const config = loadWebConfig();
const sql = createPool(config.DATABASE_URL);
const githubApp = createGithubApp(config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY);
const app = buildApp(sql, config, githubApp);

app
  .listen({ host: '0.0.0.0', port: config.PORT })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  await app.close();
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
