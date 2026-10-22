import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The same arrangement as farhand-api/eslint.config.js, and for the same
 * reasons — including the TypeScript version alias in package.json, which is
 * explained there: typescript-eslint needs TypeScript's JavaScript API, and
 * the npm `typescript` package is now version 7, which no longer ships it.
 *
 * What is NOT here: `eslint-config-next`. Next's own rules are mostly about
 * its conventions (`next/image` over `<img>`, for one), and this app has a
 * single screen whose one image is a redirect to a signed link in another
 * bucket — exactly the case `next/image` cannot optimise. Worth adding when
 * there are enough screens for its advice to be about something.
 */
export default defineConfig(
  { ignores: [".next/", "node_modules/", "next-env.d.ts"] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      // A browser app that is rendered on a server: both sets of globals are
      // real here, which is the one thing this config has to say that the
      // API's does not.
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        // No `allowDefaultProject` here, unlike the API's: this tsconfig
        // includes every .ts in the project, so next.config.ts and
        // vitest.config.ts are already type-checked members of it.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },

  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
