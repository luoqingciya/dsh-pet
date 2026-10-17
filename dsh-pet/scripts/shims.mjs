/**
 * `@deepseek-ai/*` 替身映射的**唯一来源**：读 `tsconfig.json` 的 `compilerOptions.paths`。
 *
 * 为什么要有这个文件：同一套映射要被三个地方消费——
 *   1. 类型检查（tsc）→ 直接读 tsconfig 的 paths
 *   2. 打包（tsdown）→ 需要 alias 对象
 *   3. 单测（node:test 直连源码）→ 需要 import 解析钩子
 * 以前 tsdown 与测试解析器各自抄了一份映射，改一处忘一处就会出现
 * "本地能跑、CI 报 Cannot find module"（0.4.1 就是这么挂的）。
 * 现在 tsconfig 是唯一事实来源，另外两处都从这里读。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（本文件在 scripts/ 下） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读出全部 `@deepseek-ai/*` 替身映射。
 * @returns `{ '@deepseek-ai/dsh-llm': '<绝对路径>/src/app/shims/dsh-llm.ts', ... }`
 */
export function loadShims() {
  const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8'));
  const options = tsconfig.compilerOptions ?? {};
  const baseUrl = resolve(ROOT, options.baseUrl ?? '.');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, targets] of Object.entries(options.paths ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const first = Array.isArray(targets) ? targets[0] : undefined;
    if (typeof first !== 'string' || !first) continue;
    out[name] = resolve(baseUrl, first);
  }
  return out;
}
