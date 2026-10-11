/**
 * vad.js —— 语音活动检测（端点检测）
 *
 * 为什么要有它：按按钮说话是「对讲机」，说完自动送才是「对话」。
 * 这一段决定数字人的体感是「能用」还是「像在跟人说话」。
 *
 * 设计要点（改之前先读懂）：
 *   1. **算法与浏览器 API 完全解耦**：这里只吃 Float32 PCM 帧 + 时间戳，不碰 AudioContext。
 *      好处是可以用合成音频离线单测（见 web/dev/vad-lab.html），
 *      否则这类逻辑只能靠"对着麦克风喊两句试试"，等于没法验证。
 *   2. **自适应噪声底**：固定阈值在安静房间能用、在有空调/风扇的房间就废了。
 *      这里持续估计背景能量（只在判定为静音时更新），阈值 = 噪声底 × 倍数。
 *   3. **三段状态机**：静音 → 说话中 → 静音持续够久 = 说完。
 *      还需要「最短语音长度」过滤咳嗽/键盘声，「最长语音长度」防止无限录音。
 *
 * 状态机：
 *
 *   silence ──能量超阈值──▶ speaking ──静音达 silenceMs──▶ (触发 onUtterance)
 *      ▲                                                │
 *      └──────────────── 缓冲清空 / 继续监听 ◀───────────┘
 *
 * 打断（barge-in）：她说话期间主状态机被冻结（这是防自问自答的必要条件），
 * 但会另跑一套**受限探测** —— 见 _probeBargeIn。探测成立时返回 BARGE_IN 并触发
 * onBargeIn，由调用方去掐掉播放；用户已经说出口的那一段会被记下（_seedSpeechMs），
 * 等冻结解除后交回主状态机，所以开口的第一个字不会被吞掉。
 */

/** 一帧的判定结果 */
export const VAD_EVENT = {
  SILENCE: 'silence',   // 静音（还没开始说话，或说完后已重置）
  SPEECH_START: 'start',// 检测到说话开始
  SPEECH: 'speech',     // 说话中
  SPEECH_END: 'end',    // 说完了（静音持续够久）
  TOO_SHORT: 'short',   // 静音了但语音太短 —— 当作噪声丢弃
  TOO_LONG: 'long',     // 超过最长时长，强制收尾
  BARGE_IN: 'bargein',  // 她正在说话时检测到用户开口 —— 应当立刻打断她
};

export const VAD_DEFAULTS = {
  /** 判定为语音的能量倍数（相对自适应噪声底）。太小会把呼吸当说话，太大会吃掉轻声 */
  thresholdFactor: 3.2,
  /** 绝对下限：底噪极低时避免倍数判定过于敏感 */
  minRms: 0.008,
  /** 噪声底估计的平滑系数（越小越稳但适应越慢） */
  noiseAdaptation: 0.03,
  /** 初始噪声底（安静房间的典型 RMS） */
  initialNoise: 0.004,
  /** 说完的判定：连续静音多久算一句结束（毫秒） */
  silenceMs: 900,
  /** 开始说话的判定：语音持续多久才算真的开口（毫秒），防咳嗽/爆音 */
  minSpeechMs: 180,
  /** 太短的整句直接丢弃（毫秒） */
  minUtteranceMs: 350,
  /** 最长一句（毫秒），到点强制收尾，避免无限录音 */
  maxUtteranceMs: 15000,

  /* ---------------- 打断（barge-in）----------------
   * 「她说话时冻结判定」是防自问自答用的，但它有个副作用：
   * 用户在她说的时候开口，检测不到 → 必须等她说完整段。
   * 下面这几个参数是「播放期间仍然允许被打断」的代价与边界。
   */
  /** 播放期间是否允许打断。关掉 = 退回旧行为（播放期间完全冻结） */
  bargeInEnabled: true,
  /** 播放期间的打断阈值 = 普通阈值 × 该倍数。越大越难打断，也越不容易被扬声器回声误触 */
  bargeInFactor: 2.5,
  /** 播放刚开始的这段（毫秒）不判定打断 —— 她自己的声音正在爬坡，起音会被当成用户开口。
   *  这段里观测到的电平会被记成「回声基线」，见 bargeInRiseFactor */
  bargeInGraceMs: 600,
  /** 用户电平必须比「回声基线」高出该倍数，才认作真人在说话。
   *  这条是无回声消除时的兜底：扬声器漏进麦克风的能量会被算进基线，单靠它无法触发打断 */
  bargeInRiseFactor: 1.8,
  /** 播放期间要连续多久的人声才算打断（毫秒）。比 minSpeechMs 长，挡咳嗽与爆音 */
  bargeInMinSpeechMs: 320,
  /** 两次打断之间的最小间隔（毫秒）。防扬声器回声把她打断成死循环 */
  bargeInCooldownMs: 1200,
};

/** RMS 能量。无分配，可每帧调用。 */
export function frameRms(frame) {
  if (!frame || !frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * 语音活动检测器。
 *
 * 用法：
 *   const vad = new VAD();
 *   vad.onUtterance = ({ durationMs, reason }) => { ...送出这一段... };
 *   // 每来一帧音频（16000Hz 下通常 128 或 512 个采样）调用一次：
 *   vad.push(frame, frameMs);
 */
export class VAD {
  constructor(opts = {}) {
    this.cfg = { ...VAD_DEFAULTS, ...opts };
    this.noise = this.cfg.initialNoise;
    this.state = 'silence';
    this.speechMs = 0;      // 已累计的语音时长
    this.silenceRunMs = 0;   // 连续静音时长（说完判定用）
    this.utteranceMs = 0;    // 本句总时长
    this.totalMs = 0;        // 从开始到现在的总时长
    /** 每一帧的判定回调（可选）：给前端画电平条 */
    this.onLevel = null;
    /** 一句话结束的回调 */
    this.onUtterance = null;
    /** 状态变化回调（可选） */
    this.onState = null;
    /**
     * 抑制回调：返回 true 时**不推进判定**（但仍上报电平）。
     *
     * 为什么必须有：数字人自己在放语音时，麦克风还是会收到（哪怕开了回声消除），
     * 结果是它听见自己说话 → 当成用户输入 → 自问自答。
     * 播放期间冻结判定，是这件事最简单可靠的解法。
     */
    this.suppressed = null;
    /** 打断回调：播放期间检测到用户明确开口时触发 */
    this.onBargeIn = null;

    /* ---- 打断探测的独立状态（不参与主状态机） ---- */
    /** 探测累计的人声时长 */
    this._probeSpeechMs = 0;
    /** 上一帧是否已超打断阈值 —— 用来要求「起音」，见 _probeBargeIn */
    this._probeAbove = false;
    /** 最近一次触发打断的时刻（totalMs），配合冷却用 */
    this._lastBargeInMs = -Infinity;
    /** 本次抑制的起始时刻（null = 当前未被抑制） */
    this._suppressStartMs = null;
    /** 播放前段观测到的「回声基线」：扬声器漏进麦克风的能量水平 */
    this._echoPeak = 0;
    /** 触发过打断后的闩锁：电平没落回阈值以下之前不再触发 */
    this._bargeInLatched = false;
    /** 打断成立后待接管的一段时长：等抑制解除，把它交回主状态机，别丢掉开口 */
    this._seedSpeechMs = 0;
  }

  /**
   * 播放期间的打断阈值（比普通阈值高，避免扬声器回声误触）。
   * 电平表把它画成第二条线 —— 不打断了要能看出是不是阈值太高。
   */
  get bargeInThreshold() {
    return this.threshold * this.cfg.bargeInFactor;
  }

  /**
   * 这一帧的音频要不要留（拼进 WAV）。
   * 主状态机在说话中、打断探测进行中、或有待接管的一段，都要留。
   */
  get shouldKeepAudio() {
    return this.state === 'speaking' || this.speechMs > 0
      || this._probeSpeechMs > 0 || this._seedSpeechMs > 0;
  }

  /** 当前判定阈值（调试/可视化用） */
  get threshold() {
    return Math.max(this.cfg.minRms, this.noise * this.cfg.thresholdFactor);
  }

  get level() {
    return this._lastLevel || 0;
  }

  /** 归一化电平 0..1，用于 UI 电平条 */
  get normalizedLevel() {
    const t = this.threshold * 2 || 1;
    return Math.min(1, (this._lastLevel || 0) / t);
  }

  reset() {
    this.noise = this.cfg.initialNoise;
    this.state = 'silence';
    this.speechMs = 0;
    this.silenceRunMs = 0;
    this.utteranceMs = 0;
    this.totalMs = 0;
    this._lastLevel = 0;
    this._probeSpeechMs = 0;
    this._probeAbove = false;
    this._lastBargeInMs = -Infinity;
    this._suppressStartMs = null;
    this._echoPeak = 0;
    this._bargeInLatched = false;
    this._seedSpeechMs = 0;
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    try { this.onState?.(next, prev); } catch { /* 回调是外部代码，不能带崩检测 */ }
  }

  /**
   * 喂一帧音频。
   * @param {Float32Array} frame 归一化到 [-1,1] 的采样
   * @param {number} frameMs 该帧的时长（毫秒）
   * @returns {string} VAD_EVENT 之一
   */
  push(frame, frameMs) {
    const level = frameRms(frame);
    this._lastLevel = level;
    this.totalMs += frameMs;
    const thr = this.threshold;
    const isSpeech = level > thr;

    // 先算抑制状态：电平表要据此画「打断阈值」那条线
    let suppressed = false;
    try { suppressed = !!this.suppressed?.(); } catch { suppressed = false; }
    if (!suppressed) this._suppressStartMs = null;

    try {
      this.onLevel?.({
        level, threshold: thr, isSpeech, state: this.state, totalMs: this.totalMs,
        suppressed, bargeInThreshold: this.bargeInThreshold,
      });
    } catch { /* 同上 */ }

    // ---- 她在说话：冻结主状态机，但跑受限的打断探测 ----
    //
    // 旧行为是「完全冻结判定」：能防住自问自答，但副作用是用户在她说的时候开口
    // 也检测不到，必须等她说完整段 —— 那就等于没有打断。现在改成：
    // 主状态机照旧冻结，但跑一套受限探测，只有「明确的人声起音 + 够响 + 够长」才触发。
    if (suppressed) {
      if (this._suppressStartMs === null) {
        // 一次播放 = 一次新的回声基线
        this._suppressStartMs = this.totalMs;
        this._echoPeak = 0;
      }
      if (this.state === 'speaking') {
        // 播放开始时还在录的那一句作废，避免半句被送出
        this._resetCounters();
        this._setState('silence');
      }
      this.speechMs = 0;
      this.silenceRunMs = 0;
      return this._probeBargeIn(level, frameMs);
    }

    // ---- 抑制刚解除，且刚刚发生过打断 ----
    // 把用户已经说出口的那一段交回主状态机。不这么做的话，那 300 多毫秒等于白说，
    // 用户还得再攒够 minSpeechMs 才算开口，第一个字就被吞掉了。
    if (this._seedSpeechMs > 0) {
      const seeded = this._seedSpeechMs;
      this._seedSpeechMs = 0;
      this._resetCounters();
      this.speechMs = seeded;
      this.utteranceMs = seeded;
      this._setState('speaking');
      return VAD_EVENT.SPEECH_START;
    }

    if (isSpeech) {
      this.speechMs += frameMs;
      this.silenceRunMs = 0;
    } else {
      this.silenceRunMs += frameMs;
      this._adaptNoise(level);
    }

    // ---- 静音态：等开口 ----
    if (this.state === 'silence') {
      if (this.speechMs >= this.cfg.minSpeechMs) {
        this._setState('speaking');
        this.utteranceMs = this.speechMs;
        return VAD_EVENT.SPEECH_START;
      }
      return VAD_EVENT.SILENCE;
    }

    // ---- 说话态 ----
    this.utteranceMs += frameMs;

    if (this.utteranceMs >= this.cfg.maxUtteranceMs) {
      // 太长：强制收尾（持续环境噪声 / 麦克风一直开着说话）
      const durationMs = this.utteranceMs;
      this._finish(durationMs, 'max-duration');
      return VAD_EVENT.TOO_LONG;
    }

    if (this.silenceRunMs >= this.cfg.silenceMs) {
      const durationMs = this.utteranceMs;
      this._setState('silence');
      if (durationMs < this.cfg.minUtteranceMs) {
        this._resetCounters();
        return VAD_EVENT.TOO_SHORT;
      }
      this._finish(durationMs, 'silence');
      return VAD_EVENT.SPEECH_END;
    }

    return VAD_EVENT.SPEECH;
  }

  /**
   * 播放期间的「打断探测」。返回 BARGE_IN 表示应当立刻掐掉她的播放。
   *
   * 为什么不能简单地把阈值调高了事：扬声器的声音会顺着麦克风回来。如果回声消除
   * （getUserMedia 的 echoCancellation）有效，残留很小，人声很容易区分；如果无效，
   * 回声能量和被他自己说话的能量是同一个量级 —— 单靠一个固定阈值无法区分。
   *
   * 所以这里用三条互相独立的约束，任何一条单独被回声骗过都不够：
   *   1. **回声基线**：播放前段（grace）只观测不判定，把观测到的峰值当作「回声有多大」。
   *      之后要求人声比这个基线再高 riseFactor 倍 —— 这条管没有回声消除的情况。
   *   2. **要求起音**：必须从「低于阈值」跨到「高于阈值」才算开口。持续存在的回声
   *      永远凑不出第二个起音。这条管回声恰好高于固定阈值的情况。
   *   3. **够长**：要连续 bargeInMinSpeechMs 才成立，挡掉咳嗽、碰麦、爆音。
   *
   * 另外：超过阈值的帧不参与噪声底估计（那是人声，不是环境噪声），
   * 否则用户越说她阈值越高，最后怎么喊都打不断。
   */
  _probeBargeIn(level, frameMs) {
    // ---- 1. 播放前段：只记回声基线，不判定 ----
    if (this.totalMs - this._suppressStartMs < this.cfg.bargeInGraceMs) {
      this._echoPeak = Math.max(this._echoPeak, level);
      this._probeSpeechMs = 0;
      this._probeAbove = false;
      return VAD_EVENT.SILENCE;
    }

    // 关掉打断 = 退回旧行为：播放期间完全冻结判定，但仍然估计噪声底。
    // 不估计的话，解除抑制后会带着一段过时的噪声底，阈值要么太高听不见用户、
    // 要么太低把底噪当说话 —— 这个坑是测试用例抓出来的。
    if (!this.cfg.bargeInEnabled) {
      this._adaptNoise(level * 0.5);   // 打折适应：宁可慢一点，也别把音乐当成底噪
      this._probeSpeechMs = 0;
      this._probeAbove = false;
      return VAD_EVENT.SILENCE;
    }

    const thr = Math.max(
      this.bargeInThreshold,
      this._echoPeak * this.cfg.bargeInRiseFactor,
    );
    const above = level > thr;

    if (!above) this._adaptNoise(level * 0.5);

    // 触发后先上锁：必须看到电平掉回阈值以下（出现一个安静的间隙）才允许再次触发。
    // 只靠冷却期不够 —— 冷却结束时若同一段人声还在继续，会被再判一次打断，
    // 把待接管的那一段反复重置（这个坑是离线断言抓出来的）。
    if (this._bargeInLatched) {
      if (!above) this._bargeInLatched = false;
      this._probeSpeechMs = 0;
      this._probeAbove = above;
      return VAD_EVENT.SILENCE;
    }

    // 冷却期内不重复触发（扬声器回声最可能在这里二次误触）
    if (this.totalMs - this._lastBargeInMs < this.cfg.bargeInCooldownMs) {
      this._probeSpeechMs = 0;
      this._probeAbove = above;
      return VAD_EVENT.SILENCE;
    }

    if (above && !this._probeAbove) {
      this._probeSpeechMs = frameMs;        // 起音：重新开始计时
    } else if (above) {
      this._probeSpeechMs += frameMs;
    } else {
      this._probeSpeechMs = 0;
    }
    this._probeAbove = above;

    if (this._probeSpeechMs < this.cfg.bargeInMinSpeechMs) return VAD_EVENT.SILENCE;

    // ---- 成立 ----
    const ms = this._probeSpeechMs;
    this._probeSpeechMs = 0;
    this._probeAbove = false;
    this._lastBargeInMs = this.totalMs;
    this._bargeInLatched = true;   // 等电平落回阈值以下再解锁
    this._seedSpeechMs = ms;       // 待接管：抑制一解除就交回主状态机，别丢开口
    try { this.onBargeIn?.({ ms, level, threshold: thr }); } catch { /* 外部回调不能带崩检测 */ }
    return VAD_EVENT.BARGE_IN;
  }

  _finish(durationMs, reason) {
    this._resetCounters();
    try { this.onUtterance?.({ durationMs, reason }); }
    catch { /* 同上 */ }
  }

  _resetCounters() {
    this.speechMs = 0;
    this.silenceRunMs = 0;
    this.utteranceMs = 0;
  }

  /**
   * 更新噪声底估计。
   *
   * 只在「这一帧不是语音」时调用 —— 说话时把语音算进背景会把阈值越抬越高，
   * 最后变得听不见人说话（自适应算法的经典自杀方式）。
   */
  _adaptNoise(level) {
    const floor = this.cfg.minRms / Math.max(1.2, this.cfg.thresholdFactor);
    const target = Math.max(level, floor);
    this.noise += (target - this.noise) * this.cfg.noiseAdaptation;
  }

  /** 强行收尾（用户手动点停止时调用）。返回是否真的有内容被送出。 */
  flush() {
    if (this.state !== 'speaking') {
      this._resetCounters();
      this._setState('silence');
      return false;
    }
    const durationMs = this.utteranceMs;
    this._setState('silence');
    if (durationMs < this.cfg.minUtteranceMs) {
      this._resetCounters();
      return false;
    }
    this._finish(durationMs, 'manual');
    return true;
  }
}

/* ================================================================
   PCM 工具：AudioWorklet 采到的浮点 PCM → 后端要的 WAV
   ================================================================ */

/**
 * 把若干段 Float32 PCM 拼成 16bit 单声道 WAV。
 *
 * 为什么在前端做：后端只认「一整段音频」，而流式 PCM 需要一个容器才能被
 * whisper / SenseVoice 这类接口接受。WAV 头 44 字节，自己写比引入编码器省事得多。
 */
export function encodeWav(chunks, sampleRate) {
  let total = 0;
  for (const c of chunks) total += c.length;

  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);      // fmt 块长度
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // 字节率
  view.setUint16(32, 2, true);       // 块对齐
  view.setUint16(34, 16, true);      // 位深
  writeStr(36, 'data');
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * 语音自动断句采集器：AudioWorklet 取 PCM → VAD 判定 → 拼 WAV → 回调送出。
 *
 * 相比 MediaRecorder 强在哪：
 *   · 能拿到原始 PCM，于是 VAD 才有数据可算（MediaRecorder 只给压缩后的容器）；
 *   · 可任意采样率，后端不用转码；
 *   · 边说边判定，说完立刻送 —— 用户不需要再点一下"停止"。
 */
export class AutoRecorder {
  constructor({ workletUrl = 'scripts/mic-worklet.js', vadOptions = {} } = {}) {
    this.workletUrl = workletUrl;
    this.vad = new VAD(vadOptions);
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.chunks = [];
    this.active = false;
    this.sampleRate = 48000;
    this._frameMs = 0;
    /** 打断回调：播放期间用户开口时触发，由调用方去掐掉播放 */
    this.onBargeIn = null;

    this.vad.onUtterance = ({ durationMs, reason }) => this._emit(durationMs, reason);
    this.vad.onBargeIn = (info) => {
      try { this.onBargeIn?.(info); }
      catch (e) { console.warn('[vad] onBargeIn 回调抛错：', e); }
    };
  }

  static get supported() {
    return typeof AudioContext !== 'undefined'
      && !!(navigator.mediaDevices?.getUserMedia)
      && typeof AudioWorkletNode !== 'undefined';
  }

  async start() {
    if (this.active) return true;
    if (!AutoRecorder.supported) throw new Error('这个浏览器不支持 AudioWorklet 采集（需要 Chrome/Edge 等）');

    // 超时保护：某些环境下 getUserMedia 既不 resolve 也不 reject（没有设备、
    // 系统权限被策略拦住、远程桌面重定向麦克风等），调用方会一直等下去，
    // 用户看到的就是「点了麦克风没反应」。宁可报错，也不要无声地卡死。
    const withTimeout = (p, ms, what) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${what}超时（${ms / 1000}s 没有响应，检查系统麦克风权限或设备是否被占用）`)),
        ms,
      )),
    ]);

    this.stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
      8000,
      '请求麦克风权限',
    );

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') {
      // 自动播放策略：没有用户手势时 resume 会一直挂起，同样要限时
      try { await withTimeout(this.ctx.resume(), 3000, '启动音频上下文'); }
      catch (e) { throw new Error(`音频上下文无法启动：${e.message}（需要先点一下页面）`); }
    }
    this.sampleRate = this.ctx.sampleRate;

    await withTimeout(this.ctx.audioWorklet.addModule(this.workletUrl), 5000, '加载 AudioWorklet');
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    this.node.port.onmessage = (ev) => this._onFrame(ev.data);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);

    this.chunks = [];
    this.vad.reset();
    this.active = true;
    return true;
  }

  _onFrame(frame) {
    if (!this.active) return;
    const samples = frame instanceof Float32Array ? frame : new Float32Array(frame);
    if (!this._frameMs) this._frameMs = (samples.length / this.sampleRate) * 1000;

    // 只在她「已经在说话」之后才留数据，否则句首会拖一大段静音。
    // 判定交给 VAD 自己（shouldKeepAudio 把打断探测也算了进去），这里不再猜它的内部字段。
    if (this.vad.shouldKeepAudio) this.chunks.push(samples);

    this.vad.push(samples, this._frameMs);

    // 探测没成立（只是杂音、回声、咳嗽）：把刚攒下的探测数据丢掉，不要留给下一句
    if (!this.vad.shouldKeepAudio) this.chunks.length = 0;
  }

  _emit(durationMs, reason) {
    const chunks = this.chunks;
    this.chunks = [];
    if (!chunks.length) return;
    const blob = encodeWav(chunks, this.sampleRate);
    try { this.onUtterance?.({ blob, durationMs, reason, sampleRate: this.sampleRate }); }
    catch (e) { console.warn('[vad] onUtterance 回调抛错：', e); }
  }

  /** 手动收尾（用户点停止）。 */
  stop() {
    const emitted = this.vad.flush();
    // flush 返回 false = 本来就没在说、或这句太短被丢弃 —— 那就什么都不发。
    // 之前这里会回退到 _emit，把本该丢弃的短音频也送出去。
    if (!emitted) this.chunks = [];
    return emitted;
  }

  /** 彻底释放麦克风。 */
  async release() {
    this.active = false;
    try { this.node?.port?.close?.(); } catch { /* 忽略 */ }
    try { this.node?.disconnect?.(); } catch { /* 忽略 */ }
    try { this.source?.disconnect?.(); } catch { /* 忽略 */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
    try { await this.ctx?.close(); } catch { /* 忽略 */ }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
  }
}
