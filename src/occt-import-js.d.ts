declare module "occt-import-js" {
  /** Factory that resolves to the OCCT wasm module instance. */
  const occtimportjs: (opts?: any) => Promise<any>;
  export default occtimportjs;
}

declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
