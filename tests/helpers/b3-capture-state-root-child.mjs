const { B3_CAPTURE_STATE_REPOSITORY_ROOT } = await import(
  '../../scripts/lib/b3-capture-state-location.mjs'
);

process.stdout.write(`${JSON.stringify({
  repositoryRoot: B3_CAPTURE_STATE_REPOSITORY_ROOT,
})}\n`);
