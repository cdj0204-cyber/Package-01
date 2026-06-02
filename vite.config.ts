import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// occt-import-js is a UMD/CommonJS bundle. It MUST be pre-bundled by esbuild
// (i.e. NOT excluded from optimizeDeps) so its `module.exports = factory` is
// converted to a real ESM default export — excluding it yields an empty module.
// The .wasm is located at runtime via `locateFile` (see geometry/stepImport.ts),
// so it does not need to go through the bundler.
export default defineConfig({
  plugins: [react()],
  // three + its examples/jsm controls (OrbitControls, TransformControls) must
  // resolve to ONE three instance, or the gizmo's objects belong to a second
  // copy and break ("Multiple instances of Three.js being imported").
  resolve: {
    dedupe: ["three"],
  },
  optimizeDeps: {
    include: ["occt-import-js", "three"],
  },
  server: {
    port: 5173,
    open: false,
  },
  // wasm is loaded at runtime; make sure it is treated as an asset.
  assetsInclude: ["**/*.wasm"],
});
