const mode = process.argv[2];

if (mode === 'web') {
  await import('./web/server.js');
} else if (mode === 'worker') {
  await import('./worker/worker.js');
} else {
  console.error(`Unknown mode "${mode}". Expected "web" or "worker".`);
  process.exit(1);
}
