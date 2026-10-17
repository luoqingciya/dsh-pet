/**
 * 测试用模块解析钩子，解决两件「只在 node:test 直连源码时才会遇到」的事：
 *
 * 1. **相对 import 补 `.ts`**：src/ 是给打包器吃的源码（moduleResolution: Bundler），相对 import
 *    一律不写扩展名（`./pickers`）；而单测走 `node --experimental-strip-types` 直连源文件，
 *    Node 的 ESM 解析器要求完整说明符，`./pickers` 会 ERR_MODULE_NOT_FOUND。
 * 2. **`@deepseek-ai/*` → 本地替身**：宿主半边静态 import 了三个 DSH 的包，构建期由 tsdown 的
 *    alias 换掉、类型期由 tsconfig 的 paths 换掉；测试期必须走**同一份**替身，否则 CI（没有这些
 *    包）会在 import 阶段就崩，本地有包时又会测到另一套实现。
 *
 * 三处映射必须同步：tsdown.config.mjs 的 alias、tsconfig.json 的 paths、本文件。
 */
const SHIMS = {
  '@deepseek-ai/dsh-home-paths': new URL('../src/app/shims/dsh-home-paths.ts', import.meta.url).href,
  '@deepseek-ai/dsh-credentials': new URL('../src/app/shims/dsh-credentials.ts', import.meta.url).href,
  '@deepseek-ai/dsh-llm': new URL('../src/app/shims/dsh-llm.ts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const shim = SHIMS[specifier];
  // 不指定 format：让 Node 按扩展名判定（.ts → module-typescript，才会走类型剥离）
  if (shim) return { url: shim, shortCircuit: true };

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.[cm]?[jt]sx?$/.test(specifier) && !specifier.endsWith('.json')) {
      try {
        return await nextResolve(specifier + '.ts', context);
      } catch {
        /* 落回原说明符，让 Node 报它自己的错 */
      }
    }
  }
  return nextResolve(specifier, context);
}
