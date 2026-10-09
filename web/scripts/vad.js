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
 */

/** 一帧的判定结果 */
export const VAD_EVENT = {
  SILENCE: 'silence',   // 静音（还没开始说话，或说完后已重置）
  SPEECH_START: 'start',// 检测到说话开始
  SPEECH: 'speech',     // 说话中
  SPEECH_END: 'end',    // 说完了（静音持续够久）
  TOO_SHORT: 'short',   // 静音了但语音太短 —— 当作噪声丢弃
  TOO_LONG: 'long',     // 超过最长时长，强制收尾
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

    try { this.onLevel?.({ level, threshold: thr, isSpeech, state: this.state, totalMs: this.totalMs }); }
    catch { /* 同上 */ }

    // 被抑制（数字人正在说话）：只报电平，不推进状态机 ——
    // 否则它自己的声音会被当成用户开口，出现自问自答。
    let suppressed = false;
    try { suppressed = !!this.suppressed?.(); } catch { suppressed = false; }
    if (suppressed) {
      if (this.state === 'speaking') {
        // 说话期间被抑制：把这一句作废，避免半句被送出
        this._resetCounters();
        this._setState('silence');
        // 抑制期间同样要估计噪声底：扬声器的声音对 VAD 来说就是「环境噪声」。
        // 不更新的话，解除抑制后会带着一段过时的噪声底，阈值要么太高听不见用户、
        // 要么太低把底噪当说话 —— 这个坑是测试用例抓出来的。
        this._adaptNoise(level * 0.5);   // 打折适应：宁可慢一点，也别把音乐当成底噪
      }
      this.speechMs = 0;
      this.silenceRunMs = 0;
      return VAD_EVENT.SILENCE;
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

    this.vad.onUtterance = ({ durationMs, reason }) => this._emit(durationMs, reason);
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

    // 只在「已开始说话」之后才留数据，否则句首会拖一大段静音
    if (this.state === 'speaking' || this.vad.state === 'speaking' || this.vad.speechMs > 0) this.chunks.push(samples);

    this.vad.push(samples, this._frameMs);
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
    if (!emitted) this._emit(this.vad.utteranceMs, 'manual');
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
