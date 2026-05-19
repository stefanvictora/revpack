import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: {
        REVPACK_MUTATION_TEST: '1',
      },
    },
  }),
);
