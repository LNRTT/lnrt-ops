import { defineConfig } from "tsup";
export default defineConfig({
  entry: { "server/index": "src/server/index.ts", "next/index": "src/next/index.tsx" },
  format: ["esm"], dts: true, sourcemap: true, clean: true,
  target: "node22", external: ["next", "react", "react-dom", "pg", "bcryptjs", "jose"],
});
