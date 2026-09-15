import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    "server/index": "src/server/index.ts",
    "next/index": "src/next/index.tsx",
    "next/CopyReveal": "src/next/views/CopyReveal.tsx",
    "client/index": "src/client/index.ts",
  },
  format: ["esm"], dts: true, sourcemap: true, clean: true,
  target: "node22", external: ["./CopyReveal.js", "next", "react", "react-dom", "pg", "bcryptjs", "jose"],
});
