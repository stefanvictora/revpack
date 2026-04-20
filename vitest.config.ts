import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@providers': path.resolve(__dirname, 'src/providers'),
      '@workspace': path.resolve(__dirname, 'src/workspace'),
      '@orchestration': path.resolve(__dirname, 'src/orchestration'),
      '@cli': path.resolve(__dirname, 'src/cli'),
    },
  },
});
