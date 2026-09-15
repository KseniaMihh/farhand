import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint finds bugs; Prettier decides formatting. They don't overlap.
 *
 * The "TypeChecked" presets are the reason to use typescript-eslint at all:
 * they read the actual types, so they catch things a syntax-only linter can't —
 * a forgotten `await`, a promise passed where a callback was expected, an `any`
 * leaking out of an untyped library. They're slower than plain rules, which is
 * a fine trade for a codebase this size.
 *
 * About TypeScript versions: typescript-eslint needs TypeScript's JavaScript
 * API, which TypeScript 7 no longer ships. So package.json installs both —
 * `typescript` is TypeScript 6 (only its API is used, by this linter) and
 * `@typescript/native` is TypeScript 7, which provides the `tsc` we build and
 * typecheck with. Once typescript-eslint supports 7, drop the alias.
 */
export default defineConfig(
  { ignores: ["dist/", "node_modules/"] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Finds the nearest tsconfig.json for each file, the way an editor does.
        // prisma.config.ts isn't in tsconfig.json (its rootDir is src), so it
        // is type-checked with default options instead.
        projectService: {
          allowDefaultProject: ["prisma.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A leading underscore marks a parameter as deliberately unused — Express
      // needs all four arguments on an error handler even when `next` isn't used.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Numbers in template strings are harmless; objects and null are the real
      // bugs ("[object Object]", "null"), and those are still reported.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },

  // Plain JavaScript (this file) has no types to check.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must be last: switches off every rule that would argue with Prettier.
  prettier,
);
