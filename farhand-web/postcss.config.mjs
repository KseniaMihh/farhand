/**
 * Tailwind v4 is a PostCSS plugin and nothing else — there is no
 * `tailwind.config.js` any more. What used to live in that file is CSS now,
 * in the `@theme` block at the top of app/globals.css, which is why the
 * design tokens could move across almost unchanged (#158).
 */
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
