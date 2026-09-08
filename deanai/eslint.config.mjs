import next from "eslint-config-next";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...next,
  {
    ignores: [".next/**", ".pwa-stage/**", "pwa-dist/**", "desktop-web-dist/**", "node_modules/**"],
  },
];

export default eslintConfig;
