/**
 * 测试用模块解析钩子，解决一件「只在 node:test 直连源码时才会遇到」的事：
 *
 * **相对 import 补 `.ts`**：src/ 是给打包器吃的源码（moduleResolution: Bundler），相对 import
 * 一律不写扩展名（`./pickers`）；而单测走 `node --experimental-strip-types` 直连源文件，
 * Node 的 ESM 解析器要求完整说明符，`./pickers` 会 ERR_MODULE_NOT_FOUND。
 *
 * 历史上这里还有第二件事：把 `@deepseek-ai/*` 映射到 `src/app/shims/*` 的替身（宿主半边曾
 * 静态 import 三个 DSH 的包）。项目脱离 DSH 后，那三个包换成了 `src/host/standalone/*`
 * 的本地实现，映射随之删除——源码里已经没有非相对的外部包名要处理了。
 */
export async function resolve(specifier, context, nextResolve) {
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
