declare module "occt-import-js" {
  /** Factory that resolves to the OCCT wasm module instance. */
  const occtimportjs: (opts?: any) => Promise<any>;
  export default occtimportjs;
}
