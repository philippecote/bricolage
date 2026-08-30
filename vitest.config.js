import { defineConfig } from 'vitest/config';

// The config module is process-wide, so a test run and a running Workshop server
// would otherwise share apps/ and .workshop/. A test BuildService hydrating the
// server's in-flight builds marks them failed and writes that into real
// manifests, so tests get their own data tree.
export default defineConfig({
  test: {
    env: { WORKSHOP_DATA_DIR: '.workshop-test' },
    // Both files share that one data tree, and starter migration is not safe to
    // run twice at once against an empty one.
    fileParallelism: false,
  },
});
