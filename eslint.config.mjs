import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Bundles gerados pelo esbuild — lintar saída de build não diz nada
    // sobre a qualidade da fonte.
    "packages/*/dist/**",
    "packages/*/node_modules/**",
    "coverage/**",
  ]),
  {
    // Scripts de Node rodam em CommonJS por design.
    files: ["scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
