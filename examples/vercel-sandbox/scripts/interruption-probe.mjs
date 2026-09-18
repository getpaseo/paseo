console.error(
  "This legacy probe is retired. Use npm run test:live with per-run PASEO_SANDBOX_STATE_DIR and PASEO_TEST_RECEIPTS_DIR. The full journey includes controlled interruption and verified cleanup.",
);
process.exitCode = 1;
