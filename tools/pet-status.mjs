#!/usr/bin/env node
/**
 * pet-status —— 把桌宠当成本机任务状态灯（一行命令点亮它）。
 *
 * 用法：
 *   node tools/pet-status.mjs working "跑测试"
 *   node tools/pet-status.mjs thinking "读代码"
 *   node tools/pet-status.mjs success
 *   node tools/pet-status.mjs clear            # 回到空闲
 *
 * 选项：
 *   --port <端口>    本地服务端口（默认 7340，也可用 DSH_PET_APP_PORT）
 *   --ttl <秒>       自动清空时间（默认 900；0 = 不自动清）
 *
 * 六个档位（与设置里「状态灯」开关、animations.events.workStatus 索引一一对应）：
 *   thinking  思考    working  干活    result  收尾
 *   waiting   等你确认 success  成功    error   出错
 *
 * 典型接法（shell 里把任意长任务包起来）：
 *   node tools/pet-status.mjs working "跑测试" && npm test; node tools/pet-status.mjs success
 *
 * 注意：状态是**全局**的（不区分宠物），只有开了「状态灯」的宠物会演。
 * 退出码：0 = 写入成功；1 = 连不上 / 服务拒绝。
 */

const STATES = ["thinking", "working", "result", "waiting", "success", "error"];

/** 解析 argv：第一个非选项是 state，第二个是可选文案 */
function parseArgs(argv) {
  const out = {
    state: "",
    text: "",
    port: Number(process.env.DSH_PET_APP_PORT || 7340),
    ttl: undefined,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" || arg === "--ttl") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (arg === "--port") out.port = value;
      else out.ttl = value;
      continue;
    }
    rest.push(arg);
  }
  out.state = rest[0] ?? "";
  out.text = rest.slice(1).join(" ");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const state =
  args.state === "clear" || args.state === "none" ? null : args.state;

if (!state && args.state !== "clear" && args.state !== "none") {
  console.error(
    `用法：node tools/pet-status.mjs <${STATES.join("|")}|clear> [文案] [--port 7340] [--ttl 900]`,
  );
  process.exit(2);
}
if (state && !STATES.includes(state)) {
  console.error(
    `未知状态 ${JSON.stringify(args.state)}，可选：${STATES.join(" / ")} / clear`,
  );
  process.exit(2);
}

const body = { state };
if (args.text) body.text = args.text;
if (args.ttl !== undefined) body.ttlSec = args.ttl;

const url = `http://127.0.0.1:${args.port}/dsh-pet-ng-7340/work-status`;

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok !== true) {
    console.error(
      `[pet-status] 失败（HTTP ${res.status}）：${payload.error ?? JSON.stringify(payload)}`,
    );
    process.exit(1);
  }
  console.log(
    `[pet-status] ${state ?? "clear"}${args.text ? ` 「${args.text}」` : ""} → 当前 ${payload.state ?? "空闲"}`,
  );
} catch (error) {
  console.error(
    `[pet-status] 连不上 ${url}：${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("[pet-status] 应用没在跑？或端口不对（--port 指定）。");
  process.exit(1);
}
