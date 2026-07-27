import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const mode = process.argv[2];

if (mode === 'web') {
  await import('./web/server.js');
} else if (mode === 'worker') {
  await import('./worker/worker.js');
} else if (mode === 'migrate') {
  const subcommand = process.argv[3] ?? 'up';
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/.bin/node-pg-migrate'),
      '-m',
      'src/db/migrations',
      '-j',
      'sql',
      subcommand,
    ],
    { stdio: 'inherit' },
  );
  child.on('close', (code) => process.exit(code ?? 0));
} else {
  console.error(
    `Unknown mode "${mode}". Expected "web", "worker" or "migrate".`,
  );
  process.exit(1);
}
