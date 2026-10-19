/**
 * 凭证引用（本包自己的实现）。
 *
 * 宿主半边只用它构造一个交给 `ctx.credentials.resolve()` 的引用（余额接口那一条路径）。
 * 独立模式没有凭证后端——应用侧的 `ctx.credentials.resolve` 直接查本机 `secrets.json`，
 * 引用本身不需要任何结构，因此原样返回即可；余额路由会走到「未登记接口 / 缺凭证」的
 * 明确失败分支，而不是崩掉。
 *
 * 原先这里是从 DSH 的 `@deepseek-ai/dsh-credentials` 借的 `credentialRef()`，
 * 脱离 DSH 后由本文件接管，语义不变。
 */

/** 引用原样返回（独立模式不解析凭证，只保证模块图可加载） */
export function credentialRef(ref: unknown): unknown {
  return ref;
}
