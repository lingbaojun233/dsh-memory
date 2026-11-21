/**
 * dsh-memory
 *
 * 把「兼容 DSH-MultiTool memory 服务」的 HTTP 接口注册成 DSH 原生工具，
 * 让模型像用 bash/fs 一样直接读写记忆，而不是先翻文档再拼 curl。
 *
 * 为什么不 import @deepseek-ai/dsh-tools：普通 profile 里解析不到这个包，
 * 而 ctx.tools.register 收的本来就是 defineTool 编译后的普通对象
 * （name/description/parameters/output/execute），手写同形状即可。
 *
 * 为什么只用 node 内置能力：这个仓库要能被陌生人 `npm i` 进任意 profile，
 * 多一个运行时依赖就多一次装不上的机会。
 */

export const name = 'dsh-memory';
export const inject = ['tools'];

const DEFAULT_MEMORY_URL = 'http://127.0.0.1:8767';
// 记忆服务是本地进程，15s 足够；再久多半是进程没起来，早点报错比挂住好。
const REQUEST_TIMEOUT_MS = 15000;

// 配置优先、环境变量兜底：同一台机器上跑多份 profile 时，只改 env 就能切后端。
function memoryUrlOf(config) {
  const fromConfig = config && typeof config.memoryUrl === 'string' ? config.memoryUrl.trim() : '';
  const fromEnv = (process.env.DSH_MEMORY_URL || '').trim();
  // 末尾斜杠会让 `${base}/v1/...` 变成双斜杠，部分网关会 404
  return (fromConfig || fromEnv || DEFAULT_MEMORY_URL).replace(/\/+$/, '');
}

// 每次调用都重新读 env，而不是在模块加载时缓存：
// DSH_USER_ID 由 io 在派生子进程时注入，长期驻留的进程若缓存旧值，
// 换了用户之后写入还会落在上一个人名下 —— 记忆串号最难查。
//
// 非法值 fail-closed：缺省才表示共享记忆；配错了就报错。
// 把 "user-42" 静默当成 null 会让检索范围突然扩大到所有人的记忆，
// 这种隐私事故比一次工具调用失败严重得多。
function readUserId() {
  const raw = (process.env.DSH_USER_ID || '').trim();
  if (!raw) return { ok: true, value: null };
  if (!/^-?\d+$/.test(raw)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'BAD_USER_ID',
        message: `DSH_USER_ID must be an integer, got "${raw.slice(0, 40)}"`,
        hint: 'set DSH_USER_ID=42 (integer), or unset it to use shared memory',
      },
    };
  }
  return { ok: true, value: Number(raw) };
}

// 对话对象（QQ 联系人等）。有值就只召回「这个人 + 通用」的记忆，别的对话不串台。
function currentCounterpart() {
  const raw = (process.env.DSH_COUNTERPART || '').trim();
  return raw ? raw.slice(0, 60) : null;
}

async function postJson(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      // 反向代理的 HTML 错误页也走这里，别让 JSON.parse 把真实状态码吃掉
      return { status: res.status, data: { ok: false, error: text.slice(0, 2000) } };
    }
  } finally {
    clearTimeout(timer);
  }
}

const textBlock = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
];

// 工具失败不抛异常：DSH 会把抛出的错误变成一条难读的调用失败，
// 而模型需要看到 ok:false + hint 才能自己改参数或提示用户启动服务。
async function callMemory(memoryUrl, route, body) {
  try {
    const { status, data } = await postJson(`${memoryUrl}${route}`, body);
    if (status >= 400) {
      return {
        ok: false,
        code: `HTTP_${status}`,
        status,
        error: (data && (data.error || data.message)) || 'memory service rejected the request',
        detail: data,
      };
    }
    return data;
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'UNREACHABLE',
      message: aborted
        ? `no response within ${REQUEST_TIMEOUT_MS}ms`
        : String((err && err.message) || err),
      hint: `is the memory service running at ${memoryUrl}? set config.memoryUrl or DSH_MEMORY_URL`,
    };
  }
}

export function apply(ctx, config) {
  const memoryUrl = memoryUrlOf(config);
  // 注册返回 disposer，HMR 重新加载插件时才能干净地摘掉旧工具
  const disposers = [];
  const register = (tool) => {
    const dispose = ctx.tools.register(tool);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  // 1) 检索：双预算（条数 + token），每条带 evidence，避免模型把整段记忆拖进上下文
  register({
    name: 'memory_search',
    description:
      'Recall memories from past sessions under a strict count+token budget. Every item carries an evidence locator. Returns empty when nothing matches — never invent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural language or keywords' },
        max_items: { type: 'integer', minimum: 1, maximum: 32, description: 'Default 8' },
        max_tokens: { type: 'integer', minimum: 50, maximum: 4000, description: 'Default 1200' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      const uid = readUserId();
      if (!uid.ok) return uid.error;
      return callMemory(memoryUrl, '/v1/tools/memory_search', {
        query: String(args.query || ''),
        user_id: uid.value,
        counterpart: currentCounterpart(),
        budget: {
          max_items: args.max_items || 8,
          max_tokens: args.max_tokens || 1200,
        },
      });
    },
  });

  // 2) 写入：evidence 是硬约束（source:locator），服务端缺证据会 400
  register({
    name: 'memory_remember',
    description:
      'Persist one event. Evidence is mandatory: "source:locator" such as chat:g123#m456. Chat-chatter and duplicates are rejected with a reason.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'evidence'],
      properties: {
        content: { type: 'string', description: 'What was said or done' },
        evidence: { type: 'string', description: 'source:locator' },
        kind: { type: 'string', enum: ['msg', 'video', 'action', 'commitment'] },
        speaker: { type: 'string' },
        salience: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      const uid = readUserId();
      if (!uid.ok) return uid.error;
      return callMemory(memoryUrl, '/v1/tools/memory_remember', {
        content: String(args.content || ''),
        evidence: String(args.evidence || ''),
        user_id: uid.value,
        counterpart: currentCounterpart(),
        kind: args.kind || 'msg',
        speaker_name: args.speaker,
        salience: args.salience,
        channel: 'chat',
      });
    },
  });

  // 3) 遗忘：软删可审计、可撤销。记忆写错了要能改，否则用户只能删库。
  register({
    name: 'memory_forget',
    description:
      'Soft-delete one memory (event:<id>). It becomes unsearchable immediately, is audited, and can be undone with {undo:true, tombstone_id}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'event:123 or 123' },
        reason: { type: 'string' },
        undo: { type: 'boolean' },
        tombstone_id: { type: 'integer' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      return callMemory(memoryUrl, '/v1/tools/memory_forget', {
        id: args.id,
        reason: args.reason,
        undo: Boolean(args.undo),
        // 服务端撤销时优先读 tombstoneId；两个名字都带上，兼容旧版本
        tombstoneId: args.tombstone_id,
        tombstone_id: args.tombstone_id,
      });
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载阶段单个 disposer 抛错不该拦住其余清理
      }
    }
  };
}
