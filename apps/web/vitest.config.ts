/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  // The base tsconfig sets `jsx: "preserve"` (Next.js compiles JSX itself),
  // which Vite 8's oxc transform honours, leaving raw JSX in any .tsx file a
  // test imports. Force the automatic runtime so those files can be parsed.
  oxc: {
    jsx: { runtime: "automatic" },
  },
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
