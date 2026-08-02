import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Layer 2 spawns real subprocesses against real temp dirs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
