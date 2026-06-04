/// <reference types="vite/client" />

// opencascade.js ships an emscripten factory with no bundled types.
declare module "opencascade.js/dist/opencascade.wasm.js" {
  const factory: (opts: { locateFile: (path: string) => string }) => Promise<any>;
  export default factory;
}
