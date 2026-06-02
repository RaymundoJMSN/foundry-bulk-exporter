import { defineConfig } from "vite";
import { resolve } from "node:path";

const MODULE_ID = "foundry-bulk-exporter";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    lib: {
      entry: resolve(__dirname, "src/module.ts"),
      name: MODULE_ID,
      fileName: () => "module.js",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.name === "style.css" ? "module.css" : "assets/[name][extname]",
      },
    },
  },
});
