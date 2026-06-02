import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// occt-import-js ships a .wasm file that must be served as-is.
// We exclude it from dep optimization so the wasm loader resolves correctly.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["occt-import-js"],
  },
  server: {
    port: 5173,
    open: false,
  },
  // wasm is loaded at runtime; make sure it is treated as an asset.
  assetsInclude: ["**/*.wasm"],
});
