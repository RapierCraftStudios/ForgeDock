// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5635: identifier soundness only. An undefined name (#5616 `finish`) or a call before a `const` declaration (#5632
// `refreshHeld`) ships whenever no test executes that line in that order; these two rules catch both without running it.
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "**/fixtures/**", "site/**", "docs/**", "**/*.min.js", ".forge*/**", ".claude/**"] },
  {
    files: ["bin/**/*.mjs", "scripts/**/*.mjs", "packages/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "no-undef": "error",
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true, allowNamedExports: true }],
    },
  },
];
