/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  test: {
    alias: {
      "@/*": "./*",
    },
    // Date formatting tests assert UTC renderings; without this the suite
    // fails on any machine east of UTC (Intl uses the OS timezone).
    env: {
      TZ: "UTC",
    },
  },
});
