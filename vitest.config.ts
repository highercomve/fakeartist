import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["frontend/p2p/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
