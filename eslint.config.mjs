import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.d.ts"],
  },

  // Base config for all TS files
  ...tseslint.configs.recommended,

  // Shared rules for all packages
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  // Library code: warn on console
  {
    files: [
      "packages/shared/src/**/*.ts",
      "packages/server/src/**/*.ts",
      "packages/web/src/**/*.ts",
      "packages/vscode/src/**/*.ts",
    ],
    rules: {
      "no-console": "warn",
    },
  },

  // CLI/TUI: console is fine
  {
    files: [
      "packages/tui/src/**/*.ts",
      "packages/server/src/cli/**/*.ts",
      "packages/server/src/mcp/**/*.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },

  // Relax some rules for test files
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  }
);
