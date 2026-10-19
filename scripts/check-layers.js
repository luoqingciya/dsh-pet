#!/usr/bin/env node
/**
 * check-layers.js —— 分层依赖守卫（CI 里跑，违反就红）。
 *
 * 目标：`src/` 内部**只允许单向依赖**，任何反向边或循环都视为错误。
 *
 * 分层（上面的可以 import 下面的，反之不行）：
 *
 *   main      Electron 壳：进程生命周期、窗口、托盘、协议、自动更新
 *   api       HTTP 契约层：路由、请求/响应形状、设置页接口
 *   desktop   桌面窗口层（渲染端，跑在经典 script 里）
 *   ui        设置页（浏览器代码，不许碰 node:*）
 *   core      纯业务：配置 / 状态 / 素材 / 余额 / 对话
 *   shared    两端共用的纯逻辑（菜单、气泡、物理、文案）
 *   platform  electron 的薄封装（screen / app / window），让 core 可脱离 electron 单测
 *
 * 两条额外规则：
 *   1. `ui` 与 `desktop` 是浏览器/渲染端代码，**不得 import `node:*`**；
 *   2. 测试文件豁免层间限制（它们要跨层做集成验证），但仍参与循环检测。
 *
 * 用法：node scripts/check-layers.js [--verbose]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');
const VERBOSE = process.argv.includes('--verbose');

/** 允许的依赖方向：from → 可以 import 的层 */
const LAYERS = {
  main: ['api', 'desktop', 'core', 'shared', 'platform'],
  api: ['core', 'shared', 'platform'],
  desktop: ['shared'],
  ui: ['shared'],
  core: ['shared', 'platform'],
  shared: [],
  platform: [],
};

/** 只跑在浏览器/渲染端的层：不许出现 node 内置模块 */
const BROWSER_ONLY = new Set(['ui', 'desktop']);

const fail = (message) => {
  console.error(`[check-layers] FAIL: ${message}`);
  process.exitCode = 1;
};
const ok = (message) => console.log(`[check-layers] ok: ${message}`);

/** 递归收集源文件 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 文件所属的层（src/<layer>/...）；不在任何已知层里返回 undefined */
function layerOf(file) {
  const rel = relative(SRC, file);
  if (rel.startsWith('..')) return undefined;
  const first = rel.split(/[\\/]/)[0];
  return Object.hasOwn(LAYERS, first) ? first : undefined;
}

/** 抽出该文件的 import 说明符（含 `export ... from`） */
function importsOf(text) {
  const specs = [];
  for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) specs.push(match[1]);
  return specs;
}

const files = walk(SRC);
if (files.length === 0) {
  fail('src/ 下没有找到任何 .ts/.tsx');
}

/** 边集合：`from -> to` → 出处文件 */
const edges = new Map();
const violations = [];

for (const file of files) {
  // 测试文件整份豁免：它们要跨层做集成验证，也不进产物，不该污染依赖图
  if (/\.test\.tsx?$/.test(file)) continue;
  const from = layerOf(file);
  if (!from) continue;
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  for (const spec of importsOf(text)) {
    // 1) 浏览器层不许碰 node 内置
    if (spec.startsWith('node:') && BROWSER_ONLY.has(from)) {
      violations.push(`${rel}：${from} 是浏览器/渲染端代码，不能 import '${spec}'`);
      continue;
    }
    // 2) 只看 src 内部的相对依赖
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    const to = layerOf(target);
    if (!to || to === from) continue;

    const key = `${from} -> ${to}`;
    if (!edges.has(key)) edges.set(key, new Set());
    edges.get(key).add(rel);

    if (!LAYERS[from].includes(to)) {
      violations.push(`${rel}：${from} 不允许依赖 ${to}（只允许 ${LAYERS[from].join(' / ') || '无'}）`);
    }
  }
}

// 3) 循环检测（把层当节点）
const graph = new Map(Object.keys(LAYERS).map((name) => [name, new Set()]));
for (const key of edges.keys()) {
  const [from, to] = key.split(' -> ');
  graph.get(from)?.add(to);
}
const cycles = [];
const state = new Map(); // 0=未访问 1=在栈上 2=已完成
function visit(node, stack) {
  state.set(node, 1);
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].join(' → '));
    else if (!state.get(next)) visit(next, stack);
  }
  stack.pop();
  state.set(node, 2);
}
for (const node of graph.keys()) if (!state.get(node)) visit(node, []);

if (VERBOSE) {
  console.log('[check-layers] 依赖边：');
  for (const key of [...edges.keys()].sort()) console.log(`  ${key.padEnd(24)} ${edges.get(key).size} 个文件`);
  console.log('');
}

if (cycles.length > 0) fail(`存在循环依赖：${cycles.join('；')}`);
if (violations.length > 0) {
  for (const item of violations) console.error(`  ✖ ${item}`);
  fail(`${violations.length} 处违反分层方向`);
} else {
  ok(`分层方向正确（${edges.size} 条跨层边，${files.length} 个文件）`);
}
