/**
 * 两只「生成」入口：碎碎念与对话。
 *
 * 它们共用同一套前处理（配置合并 → 人设 system → 配图池 → 模型选择），产出也落在同一个地方
 * ——状态仓的 `pets.<id>.say`。碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**
 * （同一个 triggerWhisper、同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子。
 *
 * 生成能力由调用方注入（`whisper` / `chat` 两个函数），本模块**不认识 ctx**——那是宿主的
 * llm 上下文，绑在 `apply()` 里传进来，core 保持纯业务。
 */
import { configuredModel } from './model-selection';
import { findPetInstance, readAllConfig, sliceMemoryRounds, type ConfigPaths } from './config';
import { limitPool, pickMeme, readMemePool } from './memes';
import { petSystemPrompt, withTimeContext } from './prompt';
import type { AssetPaths } from './assets';
import type { ChatMemoryMessage } from './chat';
import type { MemeEntry } from './memes';
import type { ModelRef } from './model-selection';
import type { MemoryStore } from './memory-store';
import type { PollStateStore } from './state';

/** 对话失败的结构化原因（与生成侧一致） */
export type ChatFailure = { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

export interface PetServicesOptions {
  configPaths: ConfigPaths;
  state: PollStateStore;
  memory: MemoryStore;
  memeDirsFor: AssetPaths['memeDirsFor'];
  /** 碎碎念生成（宿主已绑定 ctx） */
  whisper: (
    system: string,
    meme: MemeEntry | undefined,
    model: ModelRef | undefined,
    now: Date,
  ) => Promise<{ ok: true; text: string; image?: string } | { ok: false; reason: string; message?: string }>;
  /** 对话生成（宿主已绑定 ctx） */
  chat: (
    system: string,
    history: ChatMemoryMessage[],
    text: string,
    pool: MemeEntry[],
    model: ModelRef | undefined,
  ) => Promise<{ ok: true; text: string; image?: string } | ChatFailure>;
}

export interface PetServices {
  /** 生成/返回某宠物的一句碎碎念（周期触发与菜单手动触发共用） */
  publishWhisper(petId: string): Promise<boolean>;
  /** 与某只宠物对话：截记忆 → 生成 → 写记忆 → 写 S */
  chatWithPet(petId: string, text: string): Promise<{ ok: true } | ChatFailure>;
}

export function createPetServices(options: PetServicesOptions): PetServices {
  const { configPaths, state, memory, memeDirsFor, whisper, chat } = options;

  return {
    /**
     * 每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say。
     * 配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。
     */
    async publishWhisper(petId: string): Promise<boolean> {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      const conf = found ? found.conf : (cfg.main ?? {});
      const entry = found ? found.entry : 'main';
      const system = petSystemPrompt(petId, cfg);
      // 配图：全局开关关闭 / 池为空 / 池内图片全缺失 → 纯文本（不报错，退化为原行为）
      const meme =
        conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : undefined;
      // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到本地服务配置的模型重试一次
      // now：时间背景由 whisper 侧拼到最后一条 user 消息（不进 system——那是缓存前缀，见 ./prompt）
      const result = await whisper(system, meme, configuredModel(conf, 'whisperModel'), new Date());
      if (!result.ok) {
        // 失败**不写 S**（与改造前一致：静默跳过 + console.warn，不伪造文案、不弹错误气泡）
        console.warn(
          '[dsh-petNG] 碎碎念生成失败 pet=' +
            petId +
            ' reason=' +
            result.reason +
            (result.message ? ' ' + result.message : ''),
        );
        return false;
      }
      state.writePet(petId, 'say', result.image ? { text: result.text, image: result.image } : { text: result.text });
      return true;
    },

    /**
     * 锁内读写，防并发对话交错写盘。配图（chatImageEnabled 开启时）把表情包清单交给模型按语境选一张，
     * 命中池内才随回复写回。
     */
    chatWithPet(petId: string, text: string): Promise<{ ok: true } | ChatFailure> {
      return memory.withLock(async () => {
        const cfg = readAllConfig(configPaths);
        const rounds = memory.roundsFor(petId, cfg);
        const found = findPetInstance(cfg, petId);
        const conf = (found ?? { conf: cfg.main ?? {} }).conf;
        // 人设：所属条目的 whisperPrompt（合并器已填默认）+ 名字声明（与碎碎念同一拼装）
        const system = petSystemPrompt(petId, cfg);
        // 配图：开关关闭 → 空池（指令与解析都不介入，与旧行为逐字一致）；目录链按所属条目取。
        // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
        const pool =
          conf.chatImageEnabled === true
            ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? 'main')), Number(conf.chatImageLimit))
            : [];
        const mem = await memory.read();
        const bucketKey = found?.entry ?? petId;
        const bucket = (mem[bucketKey] ??= {});
        const entry = (bucket[petId] ??= { messages: [] });
        // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
        // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
        const list = sliceMemoryRounds(entry.messages, rounds);
        // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到本地服务配置的模型重试一次
        // 时间背景只进**这一次请求**的 user 消息（不进 system、也不写进记忆）：system + 历史构成
        // 的前缀因此逐字稳定，整段记忆都能命中 prompt cache——见 ./prompt 的头注释。
        const generated = await chat(
          system,
          list,
          withTimeContext(text, new Date()),
          pool,
          configuredModel(conf, 'chatModel'),
        );
        if (!generated.ok) return generated;
        const now = Date.now();
        entry.messages.push({ role: 'user', content: text, ts: now });
        // 记忆只存正文（配图属展示层，不进上下文——否则下次请求会把标记当历史读回去）
        entry.messages.push({ role: 'assistant', content: generated.text, ts: now });
        await memory.write(mem);
        // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）。
        // `reply: true` 是给展示层的信号：这是**用户刚问的那句话的回答**，优先级高于
        // 「终态任务」气泡（否则对话一结束，turn/end 的「这一轮搞定啦」会把回答整段盖掉，
        // 用户只看到"任务结束"、看不到回答——只能再点一次对话翻历史）。
        state.writePet(
          petId,
          'say',
          generated.image
            ? { text: generated.text, image: generated.image, reply: true }
            : { text: generated.text, reply: true },
        );
        return { ok: true as const };
      });
    },
  };
}
