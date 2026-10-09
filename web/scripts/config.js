/**
 * config.js —— 前端配置与「自带密钥」的本地存储
 *
 * 安全边界（这一段很重要，改动前请读）：
 *   - 密钥只写进浏览器的 localStorage，后端不接收持久化。
 *   - 发给后端的通道是 WebSocket 的 URL 查询参数（浏览器的 WebSocket
 *     构造函数无法自定义请求头，这是标准限制，不是偷懒）。
 *   - 因此：同一台机器上的其他程序、浏览器扩展、以及任何能看到本轮 URL
 *     的中间层，理论上都能读到密钥。**自用可接受，给别人用必须改成
 *     后端加密存储 + 鉴权**。UI 上已明确标注这一点。
 *   - 绝不要把密钥写进日志、上报、错误信息。本文件里所有对外暴露的函数
 *     都只返回「是否已配置」，不返回值本身。
 */

const LS_KEY = 'dh.config.v1';

export const CAPS = ['llm', 'asr', 'tts', 'vlm'];
export const CAP_LABEL = { llm: '大脑', asr: '耳朵', tts: '嗓子', vlm: '眼睛' };

const DEFAULTS = {
  providers: {
    // provider 留空 = 用后端 .env 里的默认值
    llm: { provider: '', model: '', base_url: '', key: '', voice: '' },
    asr: { provider: '', model: '', base_url: '', key: '', voice: '' },
    tts: { provider: '', model: '', base_url: '', key: '', voice: '' },
    vlm: { provider: '', model: '', base_url: '', key: '', voice: '' },
  },
  persona: { name: '', style: '' },
  ui: {
    theme: 'starlight',
    motion: 1,
    reduceMotion: false,
    typewriter: true,
    showTools: true,
    fontSize: 15,
    skin: '',
    /** 设置侧栏宽度（拖左边缘调宽后存这里） */
    drawerW: 640,
  },
  avatar: {
    lipsync: true,
    lookAt: true,
    blink: true,
    mouthGain: 1.3,
    emotionGain: 0.9,
    model: '',        // /assets/models/... 路径
  },
  /** 语音采集：自动断句（VAD）相关 */
  voiceInput: {
    auto: true,             // 说完自动发送，不用再点麦克风
    thresholdFactor: 3.2,   // 判定阈值 = 噪声底 × 该倍数（越大越不敏感）
    silenceMs: 900,         // 静音多久算一句结束
  },
  /**
   * 语音输出。
   *
   * `autoplay` **默认 false** 是刻意的：早期版本默认开启浏览器 TTS，
   * 结果用户一发消息网页就自己开口说话（还挑了个安静的时候），把人吓一跳。
   * 会发出声音的东西必须默认关 —— 这是礼貌，也是可用性。
   */
  voice: {
    autoplay: false,   // 关着的时候：只显示文字，绝不发声
    speak: true,       // 语音模式下按句边播边说（仅在 autoplay 开启时才有意义）
    mode: 'voice',
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (e) {
    console.warn('[config] 读取本地配置失败，使用默认值', e);
    return structuredClone(DEFAULTS);
  }
}

export function get() {
  return state;
}

export function getIn(path, fallback = undefined) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state) ?? fallback;
}

export function setIn(path, value) {
  const keys = path.split('.');
  let node = state;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[keys.at(-1)] = value;
  persist();
  return value;
}

export function patch(obj) {
  state = deepMerge(state, obj);
  persist();
}

export function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[config] 保存失败（可能是隐私模式或空间不足）', e);
  }
}

export function resetAll() {
  state = structuredClone(DEFAULTS);
  persist();
}

/* ------------------------------------------------------------------
   自带密钥 → 传给后端的连接参数
   ------------------------------------------------------------------ */

/** 某个能力是否已由用户自带配置（不返回值本身，只回布尔与摘要）。 */
export function credSummary(cap) {
  const c = state.providers[cap] || {};
  const has = !!(c.provider || c.key || c.model || c.base_url);
  return {
    configured: has,
    provider: c.provider || '(服务端默认)',
    hasKey: !!c.key,
    model: c.model || '(默认)',
  };
}

/** 任意能力的密钥是否已填（UI 用来提示风险）。 */
export function anyKeyStored() {
  return CAPS.some((cap) => !!state.providers[cap]?.key);
}

/**
 * 生成 WebSocket 的查询参数。
 * 格式：p=llm.provider:deepseek,llm.key:sk-xxx&p=tts.provider:openai
 * 只传有值的字段，避免把空串塞给后端把默认值顶掉。
 */
export function buildConnectionQuery(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session_id', sessionId);

  for (const cap of CAPS) {
    const c = state.providers[cap] || {};
    const parts = [];
    if (c.provider) parts.push(`${cap}.provider:${c.provider}`);
    if (c.model) parts.push(`${cap}.model:${c.model}`);
    if (c.base_url) parts.push(`${cap}.base_url:${c.base_url}`);
    if (c.key) parts.push(`${cap}.key:${c.key}`);
    if (c.voice) parts.push(`${cap}.voice:${c.voice}`);
    if (parts.length) params.append('p', parts.join(','));
  }
  return params.toString();
}

/** 给 HTTP 接口（如 /api/vision）用的请求头版本。 */
export function buildCredentialHeaders(extra = {}) {
  const headers = { ...extra };
  for (const cap of CAPS) {
    const c = state.providers[cap] || {};
    if (c.provider) headers[`x-provider-${cap}-provider`] = c.provider;
    if (c.model) headers[`x-provider-${cap}-model`] = c.model;
    if (c.base_url) headers[`x-provider-${cap}-base-url`] = c.base_url;
    if (c.key) headers[`x-provider-${cap}-key`] = c.key;
    if (c.voice) headers[`x-provider-${cap}-voice`] = c.voice;
  }
  return headers;
}

export { DEFAULTS };
