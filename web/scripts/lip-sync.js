/**
 * lip-sync.js —— 口型同步层（音频 → 嘴型参数）
 *
 * 模块职责：
 *   1. 把 WebAudio 的 AnalyserNode 包装成「每帧同步取一次」的廉价接口。sample() 复用同一个结果
 *      对象与同一批 Float32Array —— 音频驱动的代码跑在 rAF 里，任何逐帧分配都会变成 GC 抖动，
 *      表现出来就是嘴一抽一抽的，所以这里刻意「不按常理」返回可变对象。
 *   2. 用第一/第二共振峰（F1/F2）的位置粗略估计元音。不引入任何外部数据文件、不引入依赖：
 *      元音共振峰表是声学常识，六行常量就够，而 MFCC/神经网络在这个离线场景里性价比为零。
 *   3. 提供「预烘焙口型」路径：computeMouthEnvelope(AudioBuffer) 一次性把整段音频算成强度包络，
 *      给「音频已知、不愿实时分析」的场景用（例如 TTS 音频先缓存再播）。
 *
 * 设计取舍：
 *   - 不做 VAD、不做降噪：那是 ASR 的活。这里只回答「现在嘴张多大」。
 *   - detectViseme() 在安静时没有意义（无音可测），此时沿用上一次的判定结果，由 mouthOpen=0
 *     负责闭嘴，调用方应以 mouthOpen 为主、viseme 为辅。
 *   - 自适应增益（AGC）：麦克风音量因人而异，用缓慢衰减的峰值跟踪做归一化，避免小声说话时嘴不动。
 */

/** 人类语音的主要能量带，用于计算 energy 与共振峰搜索（Hz） */
const VOICE_LOW_HZ = 250;
const VOICE_HIGH_HZ = 3400;

/** F1 / F2 的搜索范围（Hz）——取值宽松，宁可粗糙也不要漏掉 */
const F1_MIN_HZ = 220;
const F1_MAX_HZ = 1150;
const F2_MIN_HZ = 750;
const F2_MAX_HZ = 3100;

/** 元音共振峰中心表：[名称, F1, F2]；男女声折中的粗值，够把 aiueo 分开 */
const VOWEL_FORMANTS = [
  ['a', 800, 1250],
  ['i', 300, 2350],
  ['u', 340, 780],
  ['e', 500, 1850],
  ['o', 520, 900],
];

/** 包络跟随器时间常数（秒）：起音快、释放慢，避免嘴抖 */
const ATTACK_TAU = 0.045;
const RELEASE_TAU = 0.16;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function nowMs() {
  // performance 在页面切后台时会被节流，但只用于估 dt，无害
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class LipSync {
  /**
   * @param {{ analyser: AnalyserNode, dataArray?: Uint8Array | Float32Array }} options
   *        dataArray 省略时内部自建 Uint8Array（byte 模式，最省）。传 Float32Array 则走 dB 模式。
   */
  constructor({ analyser, dataArray } = {}) {
    if (!analyser || typeof analyser.getByteFrequencyData !== 'function') {
      throw new Error('[avatar] LipSync 需要一个 AnalyserNode');
    }

    this.#analyser = analyser;

    const binCount = analyser.frequencyBinCount || (analyser.fftSize >> 1) || 512;
    this.#binCount = binCount;

    const sampleRate =
      (analyser.context && analyser.context.sampleRate) || 48000;
    this.#sampleRate = sampleRate;
    this.#binHz = sampleRate / (binCount * 2); // fftSize = binCount * 2

    // 采样数组：默认 byte 模式。外部传错长度不报错，直接按需覆盖（并只警告一次）。
    let freq = dataArray;
    if (freq instanceof Float32Array) {
      this.#isByte = false;
      if (freq.length !== binCount) {
        console.warn('[avatar] lip-sync: dataArray 长度与 frequencyBinCount 不符，已重建');
        freq = new Float32Array(binCount);
      }
    } else {
      this.#isByte = true;
      if (!(freq instanceof Uint8Array) || freq.length !== binCount) {
        freq = new Uint8Array(binCount);
      }
    }
    this.#freq = freq;

    // 统一后的 0..1 频谱（byte 模式取 /255，dB 模式线性拉到 0..1）+ 一次平滑用的副本
    this.#bins = new Float32Array(binCount);
    this.#smooth = new Float32Array(binCount);

    // 语音带对应的 bin 区间
    this.#voiceLo = this.#hzToBin(VOICE_LOW_HZ);
    this.#voiceHi = Math.max(this.#voiceLo + 1, this.#hzToBin(VOICE_HIGH_HZ));

    this.#result = { energy: 0, mouthOpen: 0, bins: this.#bins };
    this.#lastMs = nowMs();

    this.reset();
  }

  #analyser;
  #freq;
  #bins;
  #smooth;
  #result;
  #isByte = true;
  #sampleRate = 48000;
  #binHz = 46.875;
  #binCount = 512;
  #voiceLo = 5;
  #voiceHi = 72;
  #mouth = 0; // 平滑后的口型 0..1
  #energy = 0; // 平滑后的能量 0..1
  #peak = 0.06; // AGC 峰值跟踪
  #viseme = 'a';
  #lastMs = 0;
  #silentFrames = 0;

  /**
   * 创建 AnalyserNode 并接到 sourceNode 上。
   *
   * 注意这里 **不** 把 analyser 连到 destination：source 通常已经连到输出（扬声器）了，
   * 再连一次会让声音叠加/回授。分析器是旁路支路，只需要被 feed。
   * 若调用方确实需要 analyser 作为链路末端（source 没接输出），传 opts.connectToDestination。
   *
   * @param {BaseAudioContext} audioContext
   * @param {AudioNode} sourceNode
   * @param {{ fftSize?: number, smoothingTimeConstant?: number, connectToDestination?: boolean,
   *           dataArray?: Uint8Array | Float32Array }} [opts]
   * @returns {Promise<LipSync>}
   */
  static async attachTo(audioContext, sourceNode, opts = {}) {
    if (!audioContext || typeof audioContext.createAnalyser !== 'function') {
      throw new Error('[avatar] LipSync.attachTo 需要 AudioContext');
    }
    if (!sourceNode || typeof sourceNode.connect !== 'function') {
      throw new Error('[avatar] LipSync.attachTo 需要可连接的音频源节点');
    }

    const analyser = audioContext.createAnalyser();
    // 1024 ≈ 21ms @48k：够快跟上音节，又不会抖得太厉害
    const fftSize = opts.fftSize || 1024;
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant =
      typeof opts.smoothingTimeConstant === 'number'
        ? opts.smoothingTimeConstant
        : 0.6;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -15;

    sourceNode.connect(analyser);
    if (opts.connectToDestination) analyser.connect(audioContext.destination);

    return new LipSync({ analyser, dataArray: opts.dataArray });
  }

  #hzToBin(hz) {
    const b = Math.round(hz / this.#binHz);
    return b < 0 ? 0 : b > this.#binCount - 1 ? this.#binCount - 1 : b;
  }

  #binToHz(bin) {
    return bin * this.#binHz;
  }

  /**
   * 同步采样一次：抓频谱 → 算能量 → 算平滑口型 → 顺手判元音。
   *
   * ⚠️ 返回值是**内部复用对象**（含内部 Float32Array）。要留存请自己拷一份，
   *    不要把它塞进数组里长期持有。
   *
   * @returns {{ energy: number, mouthOpen: number, bins: Float32Array }}
   */
  sample() {
    const t = nowMs();
    let dt = (t - this.#lastMs) / 1000;
    if (!(dt > 0) || dt > 0.5) dt = 1 / 60; // 首帧 / 从后台切回来
    this.#lastMs = t;

    // ---- 1. 取频谱并统一成 0..1 ----
    const bins = this.#bins;
    const freq = this.#freq;
    const smooth = this.#smooth;
    const n = this.#binCount;

    if (this.#isByte) {
      this.#analyser.getByteFrequencyData(freq);
      for (let i = 0; i < n; i++) bins[i] = freq[i] * (1 / 255);
    } else {
      this.#analyser.getFloatFrequencyData(freq);
      // dB(-100..0) → 0..1 的近似线性刻度。这里刻意不做 pow(10, db/20)：
      // 每个 bin 一次 Math.pow 在 512 bin × 60fps 下并不便宜，而包络用途不需要真线性幅度。
      for (let i = 0; i < n; i++) {
        const v = (freq[i] + 100) * 0.01;
        bins[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }

    // 轻度时间平滑（三帧滑动），让共振峰搜索不至于被一个尖峰带偏
    const a = 0.5;
    for (let i = 0; i < n; i++) smooth[i] += (bins[i] - smooth[i]) * a;

    // ---- 2. 语音带能量 ----
    let sum = 0;
    let count = 0;
    const lo = this.#voiceLo;
    const hi = Math.min(this.#voiceHi, n - 1);
    for (let i = lo; i <= hi; i++) {
      sum += bins[i];
      count++;
    }
    const raw = count > 0 ? sum / count : 0;

    // AGC：峰值缓慢回落（τ≈1.5s），保证小声说话也张得开嘴
    const peakDecay = Math.exp(-dt / 1.5);
    this.#peak = Math.max(0.06, this.#peak * peakDecay, raw === 0 ? 0 : raw);
    const gain = 1 / this.#peak;
    const target = clamp01(raw * gain);
    this.#energy = target;

    // ---- 3. 口型包络（起音快 / 释放慢）----
    const tau = target > this.#mouth ? ATTACK_TAU : RELEASE_TAU;
    const k = 1 - Math.exp(-dt / tau);
    this.#mouth += (target - this.#mouth) * k;
    if (this.#mouth < 0.0015) this.#mouth = 0;

    // 开方让中低音量也有可见开口，再压一下顶（0.35 上限之外不追求夸张）
    let open = Math.pow(this.#mouth, 0.65);
    if (open > 1) open = 1;

    // ---- 4. 元音判定（安静时沿用上次结果）----
    if (open > 0.12) {
      this.#viseme = this.#estimateViseme();
      this.#silentFrames = 0;
    } else {
      this.#silentFrames++;
    }

    const out = this.#result;
    out.energy = this.#energy;
    out.mouthOpen = open;
    out.bins = bins;
    return out;
  }

  /**
   * 基于 F1/F2 的元音估计，返回 'a' | 'i' | 'u' | 'e' | 'o' 之一。
   *
   * 方法：在 220–1150Hz 找 F1、750–3100Hz 找 F2（取三点平滑后的局部最大），
   * 然后对内置元音表取加权欧氏距离最近者。F1 权重更高（它更能区分开口度）。
   * 找不到峰（纯噪声 / 静音）时返回上一次的判定，不做随机抖动。
   */
  detectViseme() {
    if (this.#silentFrames > 8) return this.#viseme; // 静音久了就别乱猜
    return this.#viseme;
  }

  #estimateViseme() {
    const f1bin = this.#findPeakBin(F1_MIN_HZ, F1_MAX_HZ, -1);
    if (f1bin < 0) return this.#viseme;

    const f1 = this.#binToHz(f1bin);
    // F2 至少要比 F1 高 250Hz，否则两个峰其实是同一个
    const f2bin = this.#findPeakBin(Math.max(F2_MIN_HZ, f1 + 250), F2_MAX_HZ, f1bin);
    // 找不到 F2 时用经验比例兜底（F2 ≈ 1.8 × F1），比直接放弃更稳
    const f2 = f2bin > 0 ? this.#binToHz(f2bin) : f1 * 1.8;

    let best = 'a';
    let bestD = Infinity;
    for (let i = 0; i < VOWEL_FORMANTS.length; i++) {
      const row = VOWEL_FORMANTS[i];
      const d1 = (f1 - row[1]) / 600; // F1 归一化尺度
      const d2 = (f2 - row[2]) / 1200;
      const d = d1 * d1 + d2 * d2 * 0.55; // F2 权重 0.55：它更容易被录音设备带偏
      if (d < bestD) {
        bestD = d;
        best = row[0];
      }
    }
    return best;
  }

  /**
   * 在 [minHz, maxHz] 内找平滑后的峰值 bin，返回 bin 索引（找不到返回 -1）。
   * @param {number} minHz
   * @param {number} maxHz
   * @param {number} excludeBin 邻近排除（传 F1 的 bin，避免 F2 又选中同一个峰）
   */
  #findPeakBin(minHz, maxHz, excludeBin) {
    const s = this.#smooth;
    const n = this.#binCount;
    let i0 = this.#hzToBin(minHz);
    let i1 = this.#hzToBin(maxHz);
    if (i1 <= i0) return -1;
    if (i0 < 1) i0 = 1;
    if (i1 > n - 2) i1 = n - 2;

    let best = -1;
    let bestVal = 0.02; // 低于此值视为无峰（静音底噪）
    for (let i = i0; i <= i1; i++) {
      if (excludeBin >= 0 && Math.abs(i - excludeBin) < 3) continue;
      const cur = s[i];
      if (cur > bestVal && cur >= s[i - 1] && cur >= s[i + 1]) {
        bestVal = cur;
        best = i;
      }
    }
    return best;
  }

  /** 当前平滑口型 0..1（不触发采样，读的是上次 sample() 的结果） */
  get smoothedMouthOpen() {
    return this.#result.mouthOpen;
  }

  /** 清空所有内部状态（换音频源、用户打断、重新开始播放时调用） */
  reset() {
    this.#mouth = 0;
    this.#energy = 0;
    this.#peak = 0.06;
    this.#viseme = 'a';
    this.#silentFrames = 99;
    this.#lastMs = nowMs();
    if (this.#bins instanceof Float32Array) this.#bins.fill(0);
    if (this.#smooth instanceof Float32Array) this.#smooth.fill(0);
    const out = this.#result;
    out.energy = 0;
    out.mouthOpen = 0;
  }

  /** 释放引用（不断开音频连接——那是调用方的接线，不越权替他拆） */
  dispose() {
    this.reset();
    this.#result.bins = this.#bins;
  }
}

/**
 * 把一整段 AudioBuffer 算成口型强度包络（预烘焙路径）。
 *
 * 返回 Float32Array，长度 ≈ ceil(duration * 60)（即 60fps 一帧一个值），值域 0..1。
 * 同步函数、零依赖：多声道先混合成单声道，按帧取 RMS，再用全局峰值归一化 +
 * 轻微 attack/release 平滑。想要更细的粒度就自己按 100fps 重采样这个包络。
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {Float32Array}
 */
export function computeMouthEnvelope(audioBuffer) {
  if (
    !audioBuffer ||
    typeof audioBuffer.getChannelData !== 'function' ||
    !(audioBuffer.length > 0)
  ) {
    return new Float32Array(0);
  }

  const rate = audioBuffer.sampleRate || 48000;
  const channels = Math.max(1, audioBuffer.numberOfChannels | 0);
  const total = audioBuffer.length | 0;
  const frameSize = Math.max(1, Math.round(rate / 60));
  const frames = Math.max(1, Math.ceil(total / frameSize));

  const out = new Float32Array(frames);

  // 混成单声道（就地累加到第一个声道不可取——AudioBuffer 的数据是共享的，会污染源数据）
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(audioBuffer.getChannelData(c));
  const inv = 1 / channels;

  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * frameSize;
    const end = Math.min(total, start + frameSize);
    let sum = 0;
    for (let i = start; i < end; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += chans[c][i];
      v *= inv;
      sum += v * v;
    }
    const n = Math.max(1, end - start);
    const rms = Math.sqrt(sum / n);
    out[f] = rms;
    if (rms > peak) peak = rms;
  }

  const norm = peak > 1e-5 ? 1 / peak : 0;
  // 起音快、释放慢（每帧百分比），开方抬一下小音量
  let env = 0;
  for (let f = 0; f < frames; f++) {
    const v = clamp01(out[f] * norm);
    const k = v > env ? 0.55 : 0.12;
    env += (v - env) * k;
    out[f] = Math.pow(env, 0.65);
  }

  return out;
}
