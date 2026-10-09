/**
 * avatar.js —— 形象层（Live2D 与纯 CSS 占位形象的统一门面）
 *
 * 模块职责：
 *   把「渲染一个数字人」这件事收敛成一个类。上层（对话 / TTS / 设置面板）只调 setMouthOpen、
 *   setEmotion、lookAt、blink、setEnergy，根本不需要知道背后是真的 Live2D 模型还是一片 CSS。
 *
 * 两种模式：
 *   - 'live2d'      ：Core 与模型都就位，逐帧写 Cubism 参数、驱动模型更新与重绘。
 *   - 'empty' ：Core 缺失 / 没有模型 / 模型加载失败 / 根本没有 canvas 时的**一等公民**状态，
 *                     不是错误页。此时所有表现力 API 依然生效，只是出口换成了容器上的
 *                     CSS 类（is-empty / is-live2d）、data-emotion 属性与 CSS 自定义属性
 *                     （--mouth-open / --energy / --emotion / --look-x / --look-y），
 *                     由外部 CSS 去画一个会张嘴、会变脸、会呼吸的虚拟形象。
 *                     这就是「绝不因为缺个专有 SDK 整个前端就崩」的具体做法。
 *
 * 渲染循环：单一 requestAnimationFrame。页面切后台浏览器会自动停 rAF，回来时 dt 会很大，
 * 所以 dt 一律 clamp —— 否则物理/动作会「瞬移」。DPR 变化也在这里顺带检测。
 */

import { FrameworkLive2DLoader as Live2DLoader } from './live2d-framework-model.js';

/**
 * 情绪 → 参数微调表。
 *
 * 为什么走「参数微调」而不是只调 Expression：
 *   1. 官方 sample 模型的 Expression 命名五花八门（F01/exp_01/happy…），只认名字必然有的模型无表情；
 *   2. 这些参数（眉毛/眼睛/嘴型/脸颊）是 Cubism 的事实标准，绝大多数模型都有；
 *   3. Expression 依然会尝试（见 #applyEmotion 里的 expression 名匹配），两条路同时走。
 * 参数值都写在参数的合法范围内；即便模型没有该参数，setParameter 也是安全 no-op。
 */
const EMOTIONS = {
  neutral: {
    expressions: ['neutral', 'normal', 'default', 'none'],
    params: {},
  },
  happy: {
    expressions: ['happy', 'smile', 'joy', 'fun', 'f01'],
    params: {
      ParamMouthForm: 1,
      ParamMouthOpenY: 0.18,
      ParamEyeLSmile: 1,
      ParamEyeRSmile: 1,
      ParamBrowLY: 0.7,
      ParamBrowRY: 0.7,
      ParamBrowLForm: 0.3,
      ParamBrowRForm: 0.3,
    },
  },
  angry: {
    expressions: ['angry', 'anger', 'mad', 'f02'],
    params: {
      ParamMouthForm: -1,
      ParamBrowLY: -1,
      ParamBrowRY: -1,
      ParamBrowLForm: -0.7,
      ParamBrowRForm: -0.7,
      ParamEyeLOpen: 0.85,
      ParamEyeROpen: 0.85,
      ParamAngleZ: 3,
    },
  },
  sad: {
    expressions: ['sad', 'sorrow', 'cry', 'f03'],
    params: {
      ParamMouthForm: -1,
      ParamBrowLForm: -1,
      ParamBrowRForm: -1,
      ParamBrowLY: 0.35,
      ParamBrowRY: 0.35,
      ParamEyeLOpen: 0.7,
      ParamEyeROpen: 0.7,
      ParamEyeBallY: -0.5,
      ParamAngleY: 6,
    },
  },
  surprised: {
    expressions: ['surprised', 'surprise', 'shock', 'f04'],
    params: {
      ParamEyeLOpen: 1.6,
      ParamEyeROpen: 1.6,
      ParamBrowLY: 1,
      ParamBrowRY: 1,
      ParamMouthOpenY: 0.55,
      ParamMouthForm: 0,
      ParamEyeBallY: 0.2,
    },
  },
  shy: {
    expressions: ['shy', 'blush', 'embarrassed', 'f05'],
    params: {
      ParamCheek: 1,
      ParamEyeLSmile: 0.5,
      ParamEyeRSmile: 0.5,
      ParamMouthForm: 0.6,
      ParamAngleZ: 4,
      ParamEyeBallY: -0.3,
      ParamBrowLForm: 0.4,
      ParamBrowRForm: 0.4,
    },
  },
};

/**
 * 视线输入的 y 轴符号：1 = 传入的 y 向下为正（与浏览器鼠标坐标一致，默认）；
 * -1 = 传入的 y 向上为正。
 * 之所以做成常量而不是硬编码：不同模型的 ParamAngleY 正方向不一致，
 * 万一你的模型上下颠倒，改这一个数字就行，不必翻代码逻辑。
 */
const LOOK_Y_SIGN = 1;

/** 平滑时间常数（秒）：越小越跟手，越大越「软」 */
const TAU_MOUTH = 0.04;
const TAU_LOOK = 0.18;
const TAU_ENERGY = 0.25;
const TAU_EMOTION = 0.22;

/** rAF 多久没回调就判定「被浏览器暂停了」并降级到 setTimeout（见 #scheduleFrame） */
const RAF_WATCHDOG_MS = 250;
/** 降级驱动的最小间隔（后台标签页的 setTimeout 本来就会被节流，给个下限避免空转） */
const FALLBACK_INTERVAL_MS = 100;
/**
 * 降级模式下每多少帧重试一次 rAF。
 *
 * 必须重试：否则只要 rAF 因为任何原因晚回一次（窗口被遮挡、切标签、系统弹窗…），
 * 就会永久留在被节流到 ~1Hz 的 setTimeout 路径上 —— 画面一秒跳一次，看着就是抽搐。
 */
const FALLBACK_RAF_RETRY = 8;

/**
 * 模型加载后跑满多少帧做一次渲染健康检查。
 *
 * 为什么用「帧窗口」而不是「只查一次的布尔标记」：
 * 后者会让第一次检查的结论永久生效 —— 用户后来换上的模型会被旧结论误杀（实测踩到过：
 * 点「使用」后模型刚加载成功，就被上一轮的回退逻辑释放，界面报 "Avatar 已 dispose"）。
 * 每换一次模型，这个窗口都重新计时。
 */
const RENDER_CHECK_AT_FRAME = 14;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Avatar {
  /**
   * @param {{ canvas?: HTMLCanvasElement, container?: HTMLElement | null,
   *           onStatus?: (status: { state: 'live2d' | 'empty', [k: string]: any }) => void }} options
   */
  constructor({ canvas, container, onStatus } = {}) {
    this.#canvas = canvas || null;
    this.#container = container || (canvas && canvas.parentElement) || null;
    this.#onStatus = typeof onStatus === 'function' ? onStatus : null;

    if (!this.#canvas) {
      console.warn('[avatar] 构造时没给 canvas：将一直停留在 empty 模式（CSS 表现仍可用）');
    }

    this.#loader = new Live2DLoader();
    this.#applyModeClasses();

    // 开发用出口：控制台里 __dhAvatar.mode / .status / .model 能直接看到当前状态，
    // 排障时不必翻 DOM 找 canvas 再猜实例在哪。只读引用，不改变行为。
    if (typeof window !== 'undefined') window.__dhAvatar = this;
  }

  #canvas;
  #container;
  #onStatus;
  #loader;
  #model = null;
  #mode = 'empty';
  #status = { state: 'empty', reason: 'not-initialized' };
  #disposed = false;

  #raf = 0;
  #lastTs = 0;
  #phase = 0;
  /**
   * rAF 看门狗与降级调度。
   *
   * 为什么必须有：浏览器在页面不可见时**完全暂停 requestAnimationFrame**。
   * 此时渲染循环一次都不会执行 —— 表现为画布一片空白，
   * 而状态回调早已报「loaded/live2d」，排查时极易误判成渲染管线坏了。
   * 这里用 setTimeout 兜底：被暂停时自动降级（后台会被节流到 ~1Hz，
   * 对本机开发与最小化窗口足够用），且可见性恢复后立刻切回 rAF。
   */
  #watchdog = 0;
  #fallbackTimer = 0;
  #usingFallback = false;
  /** 降级期间累计的帧数，用来决定何时重试 rAF */
  #fallbackTicks = 0;
  #renderFailed = false;
  #frameCount = 0;
  #renderChecked = false;

  #ro = null;
  #onWinResize = null;
  #dpr = 1;
  #sizeOk = true;
  #dprCheckTick = 0;
  /** 帧率统计（诊断用）：最近 90 帧的间隔、最长间隔、平均 fps */
  #fpsStats = null;

  #mouthTarget = 0;
  #mouth = 0;
  #energyTarget = 0;
  #energy = 0;

  #lookTargetX = 0;
  #lookTargetY = 0;
  #lookX = 0;
  #lookY = 0;

  #emotion = 'neutral';
  #emotionIntensity = 0;
  #emotionWeight = 0;
  #lastExpression = '';

  #blinkOffTimer = 0;
  #eyeOpen = null; // null = 内部自动眨眼；数值 = 外部接管

  // ---------------------------------------------------------------- 生命周期

  /**
   * 探测 Core → 拉模型清单 → 装第一个模型。
   * 任何一步失败都**不抛错**，而是落到 empty 并把原因通过 onStatus 报出去。
   */
  async init() {
    if (this.#disposed) return;
    this.#startLoop();
    this.#observeResize();
    this.#syncSize();

    if (!this.#canvas) {
      this.#toEmpty('no-canvas');
      return;
    }

    let coreReady = false;
    try {
      coreReady = await this.#loader.ensureCore();
    } catch (err) {
      coreReady = false;
      this.#warnOnce('ensureCore 异常：' + msg(err));
    }
    if (!coreReady) {
      this.#toEmpty('cubism-core-missing');
      return;
    }

    let models = [];
    try {
      models = await this.#loader.listModels();
    } catch (err) {
      models = [];
      this.#warnOnce('listModels 异常：' + msg(err));
    }
    if (!Array.isArray(models) || models.length === 0) {
      this.#toEmpty('no-models');
      return;
    }

    const first = models[0];
    try {
      await this.loadModel(first.path || first.name);
    } catch (err) {
      this.#toEmpty('model-load-failed: ' + msg(err));
    }
  }

  /**
   * 切换到指定模型（服务器路径 /assets/models/X/X.model3.json，或完整 URL）。
   * 失败时抛出可捕获的 Error，并自动回到 empty——调用方可以放心 try/catch。
   */
  async loadModel(pathOrUrl) {
    if (this.#disposed) throw new Error('[avatar] Avatar 已 dispose');
    if (!pathOrUrl) throw new Error('[avatar] loadModel 需要模型路径');

    const url = String(pathOrUrl);
    const name = guessModelName(url);

    // 先建后拆：新模型真正就位之前绝不释放旧模型。
    // 上层（main.js 启动时会用 localStorage 里存的路径再 loadModel 一次）拿到失效路径是常态，
    // 如果先拆后建，一次失败的切换就会让已经跑起来的形象凭空消失 —— 那是不可接受的退步。
    let model;
    try {
      model = await this.#loader.loadFromUrl(url, { canvas: this.#canvas });
    } catch (err) {
      if (this.#model) this.#warnOnce('切换模型失败，保留当前形象：' + msg(err));
      else this.#toEmpty('model-load-failed: ' + msg(err));
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.#releaseModel();
    this.#model = model;
    this.#mode = 'live2d';
    this.#armRenderCheck();
    this.#syncSize();
    this.#applyModeClasses();
    this.#lastExpression = '';
    this.#emit({ state: 'live2d', model: model.name || name, path: url });
    return model;
  }

  /**
   * 本地拖入 / <input type=file> 的模型文件（不上传，纯内存映射）。
   * @param {FileList | File[]} files
   */
  async loadFromFiles(files) {
    if (this.#disposed) throw new Error('[avatar] Avatar 已 dispose');
    if (!files || !files.length) throw new Error('[avatar] loadFromFiles 需要文件列表');

    // 同 loadModel：先建后拆，拖入一个坏文件夹不该把画面清空
    let model;
    try {
      model = await this.#loader.loadFromFiles(files, { canvas: this.#canvas });
    } catch (err) {
      if (this.#model) this.#warnOnce('本地模型加载失败，保留当前形象：' + msg(err));
      else this.#toEmpty('model-load-failed: ' + msg(err));
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.#releaseModel();
    this.#model = model;
    this.#mode = 'live2d';
    this.#armRenderCheck();
    this.#syncSize();
    this.#applyModeClasses();
    this.#lastExpression = '';
    this.#emit({ state: 'live2d', model: model.name || 'local-model', local: true });
    return model;
  }

  /** 'live2d' | 'empty' */
  get mode() {
    return this.#mode;
  }

  /** 最近一次状态对象（onStatus 漏掉了也能补看） */
  get status() {
    return this.#status;
  }

  /** 当前模型实例（empty 模式下为 null；给高级调用方留的逃生口） */
  get model() {
    return this.#model;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    // 降级调度用到的两个计时器也要清掉，否则 dispose 之后循环还在跑
    clearTimeout(this.#watchdog);
    clearTimeout(this.#fallbackTimer);
    this.#watchdog = 0;
    this.#fallbackTimer = 0;
    this.#usingFallback = false;
    if (this.#ro) {
      try {
        this.#ro.disconnect();
      } catch {
        /* 忽略：不同浏览器 disconnect 契约略有差异 */
      }
      this.#ro = null;
    }
    if (this.#onWinResize) {
      window.removeEventListener('resize', this.#onWinResize);
      this.#onWinResize = null;
    }
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (this.#blinkOffTimer) {
      clearTimeout(this.#blinkOffTimer);
      this.#blinkOffTimer = 0;
    }
    this.#releaseModel();
    if (this.#container && this.#container.style) {
      const s = this.#container.style;
      s.removeProperty('--mouth-open');
      s.removeProperty('--energy');
      s.removeProperty('--emotion');
      s.removeProperty('--look-x');
      s.removeProperty('--look-y');
      s.removeProperty('--eye-open');
    }
  }

  // ---------------------------------------------------------------- 表现力 API（两种模式都生效）

  /** 嘴张开度 0..1（TTS 播放时由 LipSync.sample().mouthOpen 驱动） */
  setMouthOpen(v) {
    this.#mouthTarget = clamp01(Number(v) || 0);
  }

  /**
   * 情绪。
   * @param {string} name neutral|happy|angry|sad|surprised|shy
   * @param {number} [intensity=1] 0..1
   * 未知情绪名一律忽略（记一次 warn），绝不抛错——情绪名多半来自 LLM 输出，脏数据是常态。
   */
  setEmotion(name, intensity = 1) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(EMOTIONS, key)) {
      this.#warnOnce('未知情绪，已忽略：' + key);
      return;
    }
    this.#emotion = key;
    this.#emotionIntensity = clamp01(Number(intensity));
    if (this.#emotionIntensity === 0) this.#emotionIntensity = key === 'neutral' ? 0 : 1;

    if (this.#container) {
      this.#container.dataset.emotion = key;
      if (key === 'neutral') delete this.#container.dataset.emotion;
    }
    // 立刻把强度写出去：CSS 表现不该等下一帧
    this.#writeCssVars();
  }

  /**
   * 视线跟随。
   * @param {number} x -1..1（左→右）
   * @param {number} y -1..1（**上→下**：-1 是屏幕顶部、+1 是屏幕底部，
   *        与 `(e.clientY - rect.top) / rect.height * 2 - 1` 这类鼠标归一化坐标一致，
   *        上层不需要再翻一次符号；ParamAngleY 的正负由 LOOK_Y_SIGN 控制）
   */
  lookAt(x, y) {
    this.#lookTargetX = clamp(Number(x) || 0, -1, 1);
    this.#lookTargetY = clamp(Number(y) || 0, -1, 1);
  }

  /** 手动眨一次眼（Live2D 走模型内部眨眼通道，无模型时是空状态，不画假形象） */
  blink() {
    if (this.#model && typeof this.#model.blink === 'function') {
      this.#model.blink();
      return;
    }
    if (!this.#container) return;
    this.#container.classList.add('is-blinking');
    if (this.#blinkOffTimer) clearTimeout(this.#blinkOffTimer);
    this.#blinkOffTimer = setTimeout(() => {
      this.#blinkOffTimer = 0;
      if (this.#container) this.#container.classList.remove('is-blinking');
    }, 140);
  }

  /**
   * 外部接管睁眼度（0 = 闭眼，1 = 完全睁开）。
   *
   * 为什么需要这个入口：眨眼有两个可能的驱动方 —— Live2DModel 内部的自动眨眼，
   * 以及上层（如 lip.js 的待机眨眼/自定义表情）外接的驱动。两边同时写 ParamEyeLOpen
   * 会互相打架（表现为眼皮抖）。所以这里给外部一个明确的接管口：调用过 setEyeOpen 之后，
   * 内部自动眨眼照样算但结果会被覆盖；传 null / undefined 则把控制权交还内部。
   *
   * @param {number|null} v 0..1，或 null 交还自动眨眼
   */
  setEyeOpen(v) {
    if (v === null || v === undefined) {
      this.#eyeOpen = null;
      return;
    }
    const n = Number(v);
    this.#eyeOpen = Number.isFinite(n) ? clamp01(n) : null;
  }

  /** 当前音频能量 0..1（驱动呼吸 / 身体起伏 / CSS 呼吸动画幅度） */
  setEnergy(v) {
    this.#energyTarget = clamp01(Number(v) || 0);
  }

  /** 一步到位：把一次 LipSync 采样结果同时喂给嘴与能量（顺手省掉调用方的胶水代码） */
  applyLipSample(sample) {
    if (!sample) return;
    this.setMouthOpen(sample.mouthOpen);
    this.setEnergy(sample.energy);
  }

  // ---------------------------------------------------------------- 内部：模式切换

  #applyModeClasses() {
    const c = this.#container;
    if (!c || !c.classList) return;
    const live = this.#mode === 'live2d';
    c.classList.toggle('is-live2d', live);
    // 没模型时是 empty（空状态引导），不是「占位形象」——
    // 早先这里会显示一个 CSS 画的扁平卡通头像，那是在用一个假东西糊弄用户：
    // 既看不出问题在哪，也不知道该做什么。现在直接告诉他要放模型文件。
    c.classList.toggle('is-empty', !live);
    // data-mode 必须一起同步：CSS 里是用 [data-mode] 控制 canvas 显隐的，
    // 而 index.html 上的静态属性写的是 "empty"。只切 class 会留下
    // 「class 说已加载、属性说没模型」的撕裂状态 —— canvas 被 display:none 藏着，
    // 于是 clientWidth=0 → 尺寸不同步 → 一帧都不画 → 又被判成「没画出画面」，
    // 自锁成死循环（drawn>0 也救不回来）。
    c.setAttribute('data-mode', live ? 'live2d' : 'empty');
  }

  #toEmpty(reason) {
    this.#releaseModel();
    this.#mode = 'empty';
    this.#applyModeClasses();
    this.#emit({ state: 'empty', reason: String(reason) });
  }

  /**
   * 为「刚加载的这个模型」重置渲染健康检查窗口。
   *
   * 每换一次模型都要重新计时：新模型需要自己的十几帧来出画面，
   * 不能沿用上一个模型的检查结论。
   */
  #armRenderCheck() {
    this.#renderChecked = false;
    this.#frameCount = 0;
    if (this.#canvas) this.#canvas.__dhVisiblePixels = undefined;
  }

  #releaseModel() {
    if (this.#model) {
      try {
        this.#model.dispose();
      } catch (err) {
        console.warn('[avatar] 释放旧模型时出错：' + msg(err));
      }
      this.#model = null;
    }
  }

  #emit(status) {
    this.#status = status;
    if (!this.#onStatus) return;
    try {
      this.#onStatus(status);
    } catch (err) {
      // 回调是外部代码，它炸了不能带崩渲染循环
      this.#warnOnce('onStatus 回调抛错：' + msg(err));
    }
  }

  #warnOnce(text) {
    if (this.#warned.has(text)) return;
    this.#warned.add(text);
    console.warn('[avatar] ' + text);
  }

  #warned = new Set();

  // ---------------------------------------------------------------- 内部：尺寸

  #observeResize() {
    if (!this.#canvas) return;
    const target = this.#container || this.#canvas;

    if (typeof ResizeObserver === 'function') {
      this.#ro = new ResizeObserver(() => this.#syncSize());
      try {
        this.#ro.observe(target);
      } catch (err) {
        this.#warnOnce('ResizeObserver.observe 失败：' + msg(err));
      }
    }
    this.#onWinResize = () => this.#syncSize();
    window.addEventListener('resize', this.#onWinResize);
    // 屏幕/缩放变化（DPR 改变）不一定触发 resize，交给 tick 里的低频检查兜底

    // 页面重新可见：立刻切回 rAF（否则可能停留在被节流的 setTimeout 路径上，
    // 表现就是「人一秒抽一下」）。见 #scheduleFrame 的注释。
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
  }

  /**
   * 同步画布像素尺寸：容器 CSS 尺寸 × devicePixelRatio。
   * 尺寸为 0（隐藏、display:none、还没布局）时退化成 1×1 —— canvas 在 WebGL 下不允许 0 尺寸，
   * 硬设 0 会让后续 texImage2D 直接报错。标记 #sizeOk 让渲染循环知道「这帧不用画」。
   */
  #syncSize() {
    if (!this.#canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const el = this.#container || this.#canvas;
    let w = 0;
    let h = 0;
    if (el && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      w = r.width;
      h = r.height;
    }
    if (!(w > 0) || !(h > 0)) {
      w = el ? el.clientWidth || 0 : 0;
      h = el ? el.clientHeight || 0 : 0;
    }
    if (!(w > 0) || !(h > 0)) {
      w = this.#canvas.clientWidth || 0;
      h = this.#canvas.clientHeight || 0;
    }

    this.#sizeOk = w > 0 && h > 0;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));

    // 只有真的变了才赋值：给 canvas.width 赋值会清空画布并重置 GL 状态
    if (this.#canvas.width !== pw) this.#canvas.width = pw;
    if (this.#canvas.height !== ph) this.#canvas.height = ph;

    this.#dpr = dpr;
    if (this.#model) this.#model.resize(pw, ph);
  }

  // ---------------------------------------------------------------- 内部：渲染循环

  /** 画布上是否真的有可见像素（用于首帧健康检查） */
  #canvasHasPixels() {
    const canvas = this.#canvas;
    if (!canvas || !canvas.width || !canvas.height) return false;
    // 优先用 renderer 的自检结果：它在帧缓冲里直接 readPixels，最可信。
    // 没拿到（比如旧模型实例）时才退回 drawImage 中转。
    if (typeof canvas.__dhVisiblePixels === 'number') {
      return canvas.__dhVisiblePixels > 20;
    }
    try {
      const probe = document.createElement('canvas');
      const SW = 96;
      const SH = Math.max(1, Math.round((SW * canvas.height) / canvas.width));
      probe.width = SW;
      probe.height = SH;
      const ctx = probe.getContext('2d');
      if (!ctx) return true; // 读不了就当它正常，不要误降级
      ctx.drawImage(canvas, 0, 0, SW, SH);
      const data = ctx.getImageData(0, 0, SW, SH).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) return true;
      }
      return false;
    } catch (err) {
      this.#warnOnce('画布像素检查失败（按正常处理）：' + msg(err));
      return true;
    }
  }

  #startLoop() {
    if (this.#raf || this.#disposed) return;
    this.#lastTs = 0;
    this.#scheduleFrame(true);
  }

  /**
   * 调度下一帧。优先 rAF；若 rAF 在 RAF_WATCHDOG_MS 内没有回调（页面被判为不可见时
   * 浏览器会暂停它），就切换到 setTimeout 继续驱动。
   *
   * 两个曾经导致「画面抽搐」的坑：
   *   1. 降级之后**再也不主动尝试 rAF** —— 只要 rAF 因为任何原因晚回一次，
   *      就永久留在 setTimeout 路径上（后台被节流到 ~1Hz，画面一秒一跳）。
   *      现在降级期间也按固定帧数重试 rAF，抢回来就切回正常节奏。
   *   2. 浏览器在被打断/放后台后，rAF 的恢复可能晚于一次看门狗超时，
   *      于是「可见但按 1Hz 跑」。所以页面重新可见时立刻强制切回 rAF。
   */
  #scheduleFrame(isFirst = false) {
    if (this.#disposed) return;
    if (!this.#usingFallback && typeof requestAnimationFrame === 'function') {
      this.#raf = requestAnimationFrame(this.#tick);
      clearTimeout(this.#watchdog);
      this.#watchdog = setTimeout(() => {
        if (this.#disposed || this.#usingFallback) return;
        this.#usingFallback = true;
        this.#fallbackTicks = 0;
        this.#warnOnce(
          'requestAnimationFrame 停摆（页面被判为不可见时浏览器会暂停它），' +
          '已降级为 setTimeout 驱动渲染 —— 后台帧率会被浏览器节流。',
        );
        try { cancelAnimationFrame(this.#raf); } catch { /* 忽略 */ }
        this.#tick(performance.now());
      }, RAF_WATCHDOG_MS);
      return;
    }
    if (isFirst) return;
    clearTimeout(this.#fallbackTimer);
    this.#fallbackTimer = setTimeout(() => {
      // 降级期间定期重试 rAF：抢回来就立刻恢复「可见时 60fps」的节奏
      if (this.#usingFallback && typeof document !== 'undefined' && !document.hidden) {
        this.#fallbackTicks = (this.#fallbackTicks || 0) + 1;
        if (this.#fallbackTicks >= FALLBACK_RAF_RETRY) {
          this.#usingFallback = false;
          this.#fallbackTicks = 0;
          this.#scheduleFrame();
          return;
        }
      }
      this.#tick(performance.now());
    }, FALLBACK_INTERVAL_MS);
  }

  /** 页面重新可见时立刻切回 rAF（不要等下一次「卡顿」才发现） */
  #onVisibilityChange = () => {
    if (this.#disposed) return;
    if (typeof document !== 'undefined' && !document.hidden) {
      this.#usingFallback = false;
      this.#fallbackTicks = 0;
      clearTimeout(this.#fallbackTimer);
      this.#scheduleFrame();
    }
  };

  #tick = (ts) => {
    if (this.#disposed) return;
    clearTimeout(this.#watchdog);

    const now = typeof ts === 'number' ? ts : 0;
    let dt = this.#lastTs > 0 ? (now - this.#lastTs) / 1000 : 1 / 60;
    this.#lastTs = now;
    if (!(dt > 0)) dt = 1 / 60;
    // 切后台回来 / 长卡顿：宁可少走一点时间，也不要让物理和动作瞬移
    if (dt > 0.1) dt = 0.1;

    // 整帧受保护：任何异常都不许打断 rAF/setTimeout 的重新调度。
    // 否则一次渲染错误就永久停更，表现是「画布永远空白」，而错误只在控制台闪一下。
    try {
      this.#step(dt);
    } catch (err) {
      this.#warnOnce('渲染帧抛错（已兜住，继续下一帧）：' + msg(err));
    }
    this.#frameCount++;

    // 渲染健康检查（放在 tick 层 —— #step 里有几条提前 return 的路径会把它跳过）：
    // 在「本模型加载之后的第 CHECK_AT_FRAME 帧」做一次像素检测。
    // 用帧窗口而不是「只查一次的布尔标记」：后者会让第一次检查的结论永远生效，
    // 于是用户后来换上的模型也会被旧结论误杀（实测撞到：点「使用」后模型刚加载成功，
    // 就被上一轮的回退逻辑释放掉，界面报 "Avatar 已 dispose"）。
    if (!this.#renderChecked && this.#model && this.#canvas
        && this.#frameCount >= RENDER_CHECK_AT_FRAME) {
      this.#renderChecked = true;
      if (!this.#canvasHasPixels()) {
        this.#toEmpty('model-loaded-but-no-pixels（模型已加载，但渲染管线没有输出像素）');
      }
    }
    // 探针：无侵入地把内部状态挂到 canvas 元素上，方便在浏览器控制台/自动化里诊断
    // （私有字段外部读不到，但「有没有真的在跑」必须可观测）
    if (this.#canvas) {
      this.#canvas.__dhFrames = (this.#canvas.__dhFrames || 0) + 1;
      // 帧率统计（供肉眼/自动化判断「画面是不是在卡」）：
      // 「抽搐」有两种完全不同的成因 —— 动画参数本身跳变，或者帧率不稳。
      // 参数是否平滑可以用 model.getParameter 逐帧量；帧率只能在这里量。
      if (!this.#fpsStats) {
        this.#fpsStats = { last: now, intervals: [], maxDt: 0, samples: 0 };
      }
      const fs = this.#fpsStats;
      // 恢复可见后的**第一帧不算入统计**：它前面隔着整段隐藏时间，
      // 记进去会得出「fps=1」这种假结论（实测撞到过：可见状态下报 1fps）。
      const gap = now - fs.last;
      if (gap > 0 && gap < 1000 && fs.samples > 0) {
        fs.intervals.push(gap);
        if (fs.intervals.length > 90) fs.intervals.shift();
        if (gap > fs.maxDt) fs.maxDt = gap;
      }
      fs.samples++;
      fs.last = now;
      this.#canvas.__dhFps = this.#fpsSummary();
      this.#canvas.__dhDiag = {
        frames: this.#canvas.__dhFrames,
        usingFallback: this.#usingFallback,
        sizeOk: this.#sizeOk,
        hasModel: !!this.#model,
        canvasPx: `${this.#canvas.width}x${this.#canvas.height}`,
      };
    }

    // 页面回到可见时立刻交还给 rAF（它的节奏更准、也更省电）
    if (this.#usingFallback && typeof document !== 'undefined' && !document.hidden) {
      this.#usingFallback = false;
      clearTimeout(this.#fallbackTimer);
    }
    this.#scheduleFrame();
  };

  /** 帧率摘要：p50 / p95 / 最大间隔，用来判断「画面卡不卡」 */
  #fpsSummary() {
    const fs = this.#fpsStats;
    if (!fs || !fs.intervals.length) return null;
    const arr = [...fs.intervals].sort((a, b) => a - b);
    const p = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    const p50 = p(0.5);
    return {
      samples: fs.samples,
      fps: p50 > 0 ? +(1000 / p50).toFixed(1) : null,
      p50Ms: +p50.toFixed(1),
      p95Ms: +p(0.95).toFixed(1),
      maxMs: +fs.maxDt.toFixed(1),
      // 超过 50ms 的间隔次数：这些就是肉眼可见的「卡一下 / 抽一下」
      hitches: fs.intervals.filter((v) => v > 50).length,
    };
  }

  /** 帧率统计（诊断用） */
  get fpsStats() {
    return this.#fpsSummary();
  }

  #step(dt) {
    // DPR 变化兜底：每 20 帧查一次（读 devicePixelRatio 很便宜，但没必要每帧都读）
    if (++this.#dprCheckTick >= 20) {
      this.#dprCheckTick = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      if (Math.abs(dpr - this.#dpr) > 0.01) this.#syncSize();
    }

    // ---- 平滑 ----
    this.#mouth += (this.#mouthTarget - this.#mouth) * (1 - Math.exp(-dt / TAU_MOUTH));
    this.#energy += (this.#energyTarget - this.#energy) * (1 - Math.exp(-dt / TAU_ENERGY));
    this.#lookX += (this.#lookTargetX - this.#lookX) * (1 - Math.exp(-dt / TAU_LOOK));
    this.#lookY += (this.#lookTargetY - this.#lookY) * (1 - Math.exp(-dt / TAU_LOOK));

    const emoKey = EMOTIONS[this.#emotion] ? this.#emotion : 'neutral';
    const emoTarget = emoKey === 'neutral' ? 0 : this.#emotionIntensity;
    this.#emotionWeight += (emoTarget - this.#emotionWeight) * (1 - Math.exp(-dt / TAU_EMOTION));
    if (this.#emotionWeight < 0.002) this.#emotionWeight = 0;

    this.#phase += dt;

    this.#writeCssVars();

    const model = this.#model;
    if (!model) return;
    if (!this.#sizeOk) {
      // 画布不可见时依然推进逻辑（动作/物理按时间走），只是不浪费一个 draw call
      // —— 但 update() 会顺带重绘，这里直接跳过整帧更省。
      return;
    }

    this.#applyToModel(model, emoKey);
    // 渲染是整条链路里最脆弱的一环（模型数据、GL 状态、着色器都可能出问题）。
    // 这里兜住异常：一帧画不出来不应该让 rAF 回调整体崩掉 ——
    // 崩掉的表现是「画布永远空白」，而真正的错误信息只在控制台一闪而过。
    try {
      model.update(dt);
    } catch (err) {
      this.#warnOnce('模型渲染抛错（已兜住，后续帧继续尝试）：' + msg(err));
      this.#renderFailed = true;
    }

    // 首帧健康检查：跑了若干帧后如果画布仍全透明，说明渲染管线没出画面。
    // 这时候继续留在 live2d 模式会把占位形象藏掉，用户看到的是一片空白 ——
    // 比「降级成占位形象 + 明确提示」糟糕得多。所以主动退回占位。
    // （实际判定在 #tick 里，因为 #step 有几条提前 return 的路径会绕过这里。）
  }

  /** 把当前状态写成 CSS 自定义属性（两种模式都写：外部皮肤/叠加特效用得上，live2d 便于外部调试/叠加特效） */
  #writeCssVars() {
    const c = this.#container;
    if (!c || !c.style) return;
    const s = c.style;
    s.setProperty('--mouth-open', this.#mouth.toFixed(4));
    s.setProperty('--energy', this.#energy.toFixed(4));
    s.setProperty('--emotion', this.#emotionWeight.toFixed(4));
    s.setProperty('--look-x', this.#lookX.toFixed(4));
    s.setProperty('--look-y', this.#lookY.toFixed(4));
    // 睁眼度只在被外部接管时才往外写（否则交给 CSS 自己的眨眼动画，别互相踩）
    if (this.#eyeOpen !== null) s.setProperty('--eye-open', this.#eyeOpen.toFixed(4));
  }

  /** 逐帧写 Cubism 参数（写法见 Live2DModel.setParameter 的 weight 语义） */
  #applyToModel(model, emoKey) {
    // 1) 嘴：完全接管（口型必须准，不给动作留余地）
    model.setParameter('ParamMouthOpenY', this.#mouth, 1);

    // 2) 情绪：按平滑权重叠加；切到 neutral 时权重自然衰减回 0
    const preset = EMOTIONS[emoKey];
    const w = this.#emotionWeight;
    if (preset && w > 0.002) {
      const params = preset.params;
      for (const id in params) {
        if (Object.prototype.hasOwnProperty.call(params, id)) {
          model.setParameter(id, params[id], w);
        }
      }
      // Expression 只在情绪切换时试一次，避免每帧重复触发淡入把表情锁死
      if (this.#lastExpression !== emoKey) {
        this.#lastExpression = emoKey;
        const names = model.getExpressionNames();
        const want = pickExpression(preset.expressions, names, emoKey);
        model.setExpression(want || '');
      }
    } else if (this.#lastExpression && w <= 0.002) {
      this.#lastExpression = '';
      model.setExpression('');
    }

    // 3) 视线：角度参数给 0.7 权重（让待机动作还能带一点头部自然摆动），眼球给 0.85
    model.setParameter('ParamAngleX', this.#lookX * 30, 0.7);
    model.setParameter('ParamAngleY', this.#lookY * 30 * LOOK_Y_SIGN, 0.7);
    model.setParameter('ParamEyeBallX', this.#lookX, 0.85);
    model.setParameter('ParamEyeBallY', this.#lookY * LOOK_Y_SIGN, 0.85);

    // 4) 能量 → 呼吸/身体起伏：两个不同频率的正弦叠加，避免机械感
    //    权重压到 0.35，音量再大也不会把身体摇成抽筋
    if (this.#energy > 0.002) {
      const amp = this.#energy;
      const z = (Math.sin(this.#phase * 1.9) * 0.6 + Math.sin(this.#phase * 0.7) * 0.4) * 7 * amp;
      model.setParameter('ParamBodyAngleZ', z, 0.35);
      model.setParameter('ParamAngleZ', z * 0.25, 0.25);
      // 部分模型用独立呼吸参数（有就写，没有就是 no-op）
      model.setParameter('ParamBreath', this.#energy * 0.7, 0.4);
    }

    // 5) 外部接管的睁眼度（最后写，保证压过模型内部的自动眨眼，见 setEyeOpen）
    if (this.#eyeOpen !== null) {
      model.setParameter('ParamEyeLOpen', this.#eyeOpen, 1);
      model.setParameter('ParamEyeROpen', this.#eyeOpen, 1);
    }
  }
}

// ---------------------------------------------------------------- 工具函数

function msg(err) {
  if (!err) return 'unknown';
  return err.message || String(err);
}

/** 从 '/assets/models/Hiyori/Hiyori.model3.json' 里猜一个好看的显示名 */
function guessModelName(url) {
  const clean = String(url).split('?')[0].replace(/\\/g, '/');
  const parts = clean.split('/').filter(Boolean);
  const file = parts[parts.length - 1] || '';
  const base = file.replace(/\.model3\.json$/i, '');
  if (base) return base;
  return parts[parts.length - 2] || 'model';
}

/**
 * 在模型实际拥有的 Expression 名单里挑一个想要的。
 * 精确匹配优先（忽略大小写），其次前缀/包含匹配 —— LLM 或配置里给的 'happy' 撞上
 * 'Happy_01' 也应该认。
 */
function pickExpression(wanted, available, emoKey) {
  if (!Array.isArray(available) || available.length === 0) return '';
  const list = wanted && wanted.length ? wanted : [emoKey];
  for (const want of list) {
    if (!want) continue;
    const lower = String(want).toLowerCase();
    for (const name of available) {
      if (String(name).toLowerCase() === lower) return name;
    }
    for (const name of available) {
      if (String(name).toLowerCase().startsWith(lower)) return name;
    }
  }
  return '';
}
