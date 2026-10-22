import { defineConfig } from "vitest/config";

/**
 * Node, not a browser, and nothing is rendered.
 *
 * What is tested here is lib/api.ts — the layer every screen depends on. A
 * DOM-rendering setup (jsdom, a testing library, a config for both) earns its
 * place when there are components with logic in them worth pinning; one
 * screen that lists what the API sent is not that yet.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": import.meta.dirname },
  },
});
