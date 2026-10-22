import { defineConfig, globalIgnores } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import globals from "globals";

// What eslint-config-next 16 (core-web-vitals + typescript) applied, built
// from the plugins it bundled, less its own @next/next rules: its plugin pins
// fast-glob 3.3.1, whose micromatch and braces have advisories with no fixed
// version (22/10). Same rules, same severities, same settings; its Babel
// parser is left out, as it was already overridden for every file by
// typescript-eslint's, below. The root's eslint.config.mjs builds the same.
const nextRules = {
  name: "next-without-next-plugin",
  files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
  plugins: { react, "react-hooks": reactHooks, import: importPlugin, "jsx-a11y": jsxA11y },
  languageOptions: {
    parserOptions: { sourceType: "module" },
    globals: { ...globals.browser, ...globals.node },
  },
  settings: {
    react: { version: "detect" },
    "import/parsers": { "@typescript-eslint/parser": [".ts", ".mts", ".cts", ".tsx", ".d.ts"] },
    "import/resolver": { node: { extensions: [".js", ".jsx", ".ts", ".tsx"] }, typescript: { alwaysTryTypes: true } },
  },
  rules: {
    ...react.configs.recommended.rules,
    ...reactHooks.configs.recommended.rules,
    "import/no-anonymous-default-export": "warn",
    "react/no-unknown-property": "off",
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
    "jsx-a11y/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
    "jsx-a11y/aria-props": "warn",
    "jsx-a11y/aria-proptypes": "warn",
    "jsx-a11y/aria-unsupported-elements": "warn",
    "jsx-a11y/role-has-required-aria-props": "warn",
    "jsx-a11y/role-supports-aria-props": "warn",
    "react/jsx-no-target-blank": "off",
  },
};

const eslintConfig = defineConfig([
  nextRules,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  globalIgnores([
    // What eslint-config-next ignored:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
