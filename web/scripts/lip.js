/**
 * lip.js —— 把「声音能量」变成「嘴在动」
 *
 * 渲染层（avatar.js，可能由别人实现、也可能因为缺模型而降级）与本模块之间
 * 只通过一组很窄的方法耦合：setMouthOpen / setEmotion / setEnergy / lookAt。
 * 无论背后是 Live2D 还是纯 CSS 占位形象，这一层都不用改。
 *
 * 三种驱动源，优先级从高到低：
 *   1. 真实音频能量（Speaker 的分析器）—— 最准
 *   2. 无分析器时的估算（Speaker.sampleEnergy 的兜底分支）
 *   3. 完全没在说话时的待机（呼吸 + 偶尔眨眼）
 *
 * 口型平滑用的是「快开慢合」的非对称低通：嘴巴张开要跟得上音节（10ms 级），
 * 合拢可以慢一点（80ms 级），否则会出现机械的抖动式开合。
 */

import { clamp, emit } from './bus.js';
import { getIn, setIn } from './config.js';

export class LipDriver {
  constructor() {
    this.avatar = null;        // 由 main.js 注入（Avatar 实例）
    this.speaker = null;       // 由 main.js 注入（Speaker 实例）
    this.enabled = getIn('avatar.lipsync', true);
    this.lookAtEnabled = getIn('avatar.lookAt', true);
    this.mouthGain = getIn('avatar.mouthGain', 1.3);
    this.emotionGain = getIn('avatar.emotionGain', 0.9);

    this._mouth = 0;
    this._energy = 0;
    this._targetEmotion = 'neutral';
    this._emotionUntil = 0;
    this._lastBlink = performance.now();
    this._blinkUntil = 0;
    this._running = false;
    this._raf = 0;
  }

  attach({ avatar, speaker }) {
    this.avatar = avatar;
    this.speaker = speaker;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      this._update();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  setEnabled(on) {
    this.enabled = !!on;
    setIn('avatar.lipsync', this.enabled);
    if (!this.enabled) this._apply(0, this._energy);
  }

  setLookAtEnabled(on) {
    this.lookAtEnabled = !!on;
    setIn('avatar.lookAt', this.lookAtEnabled);
  }

  setMouthGain(v) {
    this.mouthGain = Number(v) || 1;
    setIn('avatar.mouthGain', this.mouthGain);
  }

  setEmotionGain(v) {
    this.emotionGain = Number(v) || 0;
    setIn('avatar.emotionGain', this.emotionGain);
  }

  /** 由消息流触发的表情（句子里带情绪标签时调用）。 */
  showEmotion(name, holdMs = 2600) {
    if (!name || name === 'neutral') return;
    this._targetEmotion = name;
    this._emotionUntil = performance.now() + holdMs;
    this.avatar?.setEmotion?.(name, this.emotionGain);
    emit('emotion:changed', { emotion: name });
  }

  /** 视线跟随：由 main.js 在 mousemove 时调用，坐标已归一化到 -1..1。 */
  lookAt(x, y) {
    if (!this.lookAtEnabled) return;
    this.avatar?.lookAt?.(clamp(x, -1, 1), clamp(y, -1, 1));
  }

  _update() {
    const now = performance.now();

    // ---- 能量 ----
    let energy = this.speaker ? this.speaker.sampleEnergy() : 0;
    if (!Number.isFinite(energy)) energy = 0;
    this._energy = clamp(energy, 0, 1);

    // ---- 目标口型 ----
    const target = this.enabled
      ? clamp(this._energy * this.mouthGain, 0, 1)
      : 0;

    // 非对称平滑：开得快、合得慢
    const rate = target > this._mouth ? 0.55 : 0.18;
    this._mouth += (target - this._mouth) * rate;

    // ---- 情绪超时回落 ----
    if (this._targetEmotion !== 'neutral' && now > this._emotionUntil) {
      this._targetEmotion = 'neutral';
      this.avatar?.setEmotion?.('neutral', 0);
      emit('emotion:changed', { emotion: 'neutral' });
    }

    // ---- 待机眨眼：2.6~6.4 秒随机一次 ----
    if (getIn('avatar.blink', true)) {
      if (now > this._blinkUntil && now - this._lastBlink > 2600 + Math.random() * 3800) {
        this._blinkUntil = now + 130;
        this._lastBlink = now;
      }
      const eye = now < this._blinkUntil ? 0.06 : 1;
      this.avatar?.setEyeOpen?.(eye);
      document.documentElement.style.setProperty('--eye-open', String(eye));
    }

    this._apply(this._mouth, this._energy);
  }

  _apply(mouth, energy) {
    // 渲染层（Live2D 或 CSS 占位）都吃这两个方法
    this.avatar?.setMouthOpen?.(mouth);
    this.avatar?.setEnergy?.(energy);

    // 同时写到 CSS 变量上：占位形象与任何外挂皮肤都能直接用
    const root = document.documentElement.style;
    root.setProperty('--mouth-open', mouth.toFixed(3));
    root.setProperty('--energy', energy.toFixed(3));
  }
}

export const lip = new LipDriver();
