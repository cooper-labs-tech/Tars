import { defineConfig, globalIgnores } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import globals from "globals";

// What eslint-config-next 16.3 (core-web-vitals + typescript) applied, built
// from the plugins it bundled, less its own @next/next rules: its plugin pins
// fast-glob 3.3.1, whose micromatch and braces have advisories with no fixed
// version (22/10). Same rules, same severities, same settings; its Babel
// parser is left out, as it was already overridden for every file by
// typescript-eslint's, below.
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
  // Everything we do not want linted has to be listed here.
  globalIgnores([
    // What eslint-config-next ignored, widened to any depth: the landing page
    // is a second Next app, so its build output is at landing/.next.
    "**/.next/**",
    "**/out/**",
    "build/**",
    "**/next-env.d.ts",

    // What `claude plugin validate` writes beside a mod it checks: Claude
    // Code's own declarations and a tsconfig that extends them.
    "mods/*/.claude-plugin/types/**",

    // Playwright writes a bundled HTML viewer into e2e/report after a run.
    "e2e/report/**",
    "test-results/**",

    // Build output. electron/dist is compiled from electron/, release/ holds
    // packaged .app bundles - linting either reports the same problems twice,
    // once in source and once in a generated copy we never edit.
    "electron/dist/**",
    "release/**",
    "**/*.asar",

    // Agent worktrees. These are checkouts of other branches living inside the
    // repo; their files belong to those branches, not to this one, and they
    // accounted for 1229 of the 1916 errors the lint used to report.
    ".worktrees/**",
    ".claude/worktrees/**",

    // Bundled MCP servers build themselves and carry their own configs.
    "mcp-*/dist/**",
    "mcp-*/node_modules/**",
  ]),

  {
    // Two rules from eslint-plugin-react-hooks 7's React Compiler set, which
    // arrived with a transitive bump and lit up 59 errors across files nobody
    // had touched. Neither applies here.
    //
    // `set-state-in-effect` says "calling setState SYNCHRONOUSLY within an
    // effect", and every one of its 54 reports is on a line like
    // `void loadHistory()`: an async loader that sets state once its promise
    // resolves, which is neither synchronous nor a cascading render. The rule
    // cannot see through the async boundary, and that pattern is how every
    // page in this app loads over IPC.
    //
    // `preserve-manual-memoization` reports "Compilation Skipped", which only
    // means anything when the React Compiler is compiling. next.config.ts does
    // not enable it.
    //
    // The rest of the set is on and was worth having: `refs` found eleven ref
    // writes during render and `immutability` found a function referenced
    // above its own declaration. Those are fixed, not silenced.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },

  {
    // Tests stub what they are not testing: a fake PTY, a window that only has
    // the one method under test, a dependency bag with three of its twelve
    // members. Typing every stub in full makes the test longer and more
    // brittle without making the product any safer, so `any` is allowed here
    // and nowhere else. Production code has none.
    files: ["__tests__/**/*.ts", "e2e/**/*.ts", "e2e/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  {
    // A CommonJS script shipped as a resource and run by node directly, not
    // bundled and not compiled. `require` is how it loads, and rewriting it as
    // ESM would stop it running.
    files: ["electron/resources/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
