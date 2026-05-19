/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  concurrency: 8,
  reporters: ['progress', 'html', 'json'],
  coverageAnalysis: 'perTest',
  incremental: true,
  vitest: {
    configFile: 'vitest.mutation.config.ts',
    related: true,
  },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/index.ts',
    '!src/**/types.ts',
    '!src/benchmark/**',
    '!src/cli/**',
    '!src/workspace/git-helper.ts',
    '!src/workspace/patch-parser.ts',
  ],
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },
};
