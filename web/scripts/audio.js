/**
 * audio.js —— 录音、播放、本地识别
 *
 * 三条链路，按「今天就能跑」排序：
 *   1. 录音：MediaRecorder 录成 webm/opus 整段发送（零依赖，兼容性最好）
 *      将来要做流式 VAD 时换 AudioWorklet 发 PCM —— 后端协议已按
 *      audio_chunk 预留，不需要改后端。
 *   2. 播放：Web Audio 解码 + 顺序播放 + AnalyserNode 实时取能量，
 *      这是口型同步的数据来源。解码失败时降级到 <audio>（此时没有真实能量，
 *      用「按字数估算」的假能量兜住口型，宁可粗糙也不哑巴）。
 *   3. 识别：优先浏览器 Web Speech API（零成本、不传音频）。它不可用时
 *      自动切到「录音上传后端」。两条路都给上层同一件事：一段文字。
 */

import { emit } from './bus.js';

/* ================================================================
   录音
   ================================================================ */

export class Recorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.active = false;
  }

  static get supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  static pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
    }
    return '';
  }

  async start() {
    if (this.active) return true;
    if (!Recorder.supported) {
      emit('error', { message: '这个浏览器不支持录音（需要 https 或 localhost 环境）' });
      return false;
    }
    try {
      // 回声消除 + 降噪开着，否则数字人的声音会被自己录进去，形成回环
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      const hint = e.name === 'NotAllowedError'
        ? '麦克风权限被拒绝：请在地址栏左侧的图标里允许麦克风'
        : e.name === 'NotFoundError'
          ? '没有找到麦克风设备'
          : String(e.message || e);
      emit('error', { message: hint });
      return false;
    }

    const mime = Recorder.pickMime();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (ev) => { if (ev.data?.size) this.chunks.push(ev.data); };
    this.recorder.start(250);  // 每 250ms 出一片，避免一次性大块
    this.startedAt = performance.now();
    this.active = true;
    emit('recorder:state', { active: true });
    return true;
  }

  /** 停止并返回整段录音。 */
  stop() {
    return new Promise((resolve) => {
      if (!this.active || !this.recorder) {
        resolve(null);
        return;
      }
      const mime = this.recorder.mimeType || 'audio/webm';
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: mime });
        const duration = (performance.now() - this.startedAt) / 1000;
        this._release();
        emit('recorder:state', { active: false });
        resolve({ blob, mime, duration });
      };
      try { this.recorder.stop(); } catch { this._release(); resolve(null); }
    });
  }

  _release() {
    this.active = false;
    this.chunks = [];
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 已释放 */ }
    this.stream = null;
    this.recorder = null;
  }

  cancel() {
    try { this.recorder?.stop(); } catch { /* ignore */ }
    this._release();
    emit('recorder:state', { active: false });
  }
}

/* ================================================================
   播放（+ 口型能量）
   ================================================================ */

export class Speaker {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.dataArray = null;
    this.queue = [];
    this.playing = false;
    this.currentSource = null;
    this.currentText = '';
    this._energy = 0;
    this._silentDecode = 0;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('这个浏览器不支持 Web Audio');
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      this.dataArray = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* 需要用户手势，会在点击时再试 */ }
    }
    return this.ctx;
  }

  /** 入队一段音频（来自 WS 二进制帧）。 */
  async push(arrayBuffer, meta = {}) {
    await this.ensureContext();
    let buffer = null;
    try {
      // decodeAudioData 会「吃掉」传入的 ArrayBuffer，所以拷贝一份
      buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      this._silentDecode += 1;
      if (this._silentDecode <= 2) {
        console.warn('[audio] 解码失败，改用 <audio> 兜底播放', e?.message || e);
      }
    }
    if (buffer) {
      this.queue.push({ buffer, text: meta.text || '' });
    } else {
      await this._fallbackPlay(arrayBuffer, meta);
      return;
    }
    if (!this.playing) this._drain();
  }

  async _drain() {
    if (this.playing) return;
    this.playing = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      this.currentText = item.text;
      emit('speech:start', { text: item.text });
      try {
        await this._playBuffer(item.buffer);
      } catch (e) {
        console.warn('[audio] 播放中断', e?.message || e);
      }
      emit('speech:segment-end', { text: item.text });
    }
    this.playing = false;
    this.currentText = '';
    this._energy = 0;
    emit('speech:end', {});
  }

  _playBuffer(buffer) {
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.currentSource === src) this.currentSource = null;
        resolve();
      };
      this.currentSource = src;
      src.start();
    });
  }

  /** 解码失败时的兜底：能听见声音，但没有分析器数据（口型靠估算）。 */
  async _fallbackPlay(arrayBuffer, meta) {
    const blob = new Blob([arrayBuffer], { type: meta.mime || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    emit('speech:start', { text: meta.text || '' });
    await new Promise((resolve) => {
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => resolve());
    });
    emit('speech:end', {});
  }

  /** 当前能量 0..1（口型的数据源）。无分析器时按「正在说 + 文本长度」估算。 */
  sampleEnergy() {
    if (this.analyser) {
      this.analyser.getByteTimeDomainData(this.dataArray);
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i += 1) {
        const v = (this.dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.dataArray.length);
      // 经验映射：正常语音 rms 落在 0.02~0.25
      const target = Math.min(1, rms * 4.2);
      this._energy = this._energy * 0.62 + target * 0.38;   // 一阶低通，避免抖动
      return this._energy;
    }
    if (this.playing || this.currentSource) {
      // 估算路径：按 60~90ms 的节奏把嘴一开一合，聊胜于无
      const phase = (performance.now() % 150) / 150;
      return 0.25 + 0.5 * Math.sin(phase * Math.PI);
    }
    return 0;
  }

  /** 打断：立刻静音并清空队列。 */
  stopAll() {
    try { this.currentSource?.stop(); } catch { /* 可能已结束 */ }
    this.currentSource = null;
    this.queue.length = 0;
    this.playing = false;
    this._energy = 0;
    emit('speech:end', { interrupted: true });
  }

  get busy() {
    return this.playing || this.queue.length > 0;
  }
}

/* ================================================================
   浏览器原生识别（Web Speech API）
   ================================================================ */

export class BrowserASR {
  constructor({ lang = 'zh-CN' } = {}) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Ctor;
    this.lang = lang;
    this._Ctor = Ctor;
    this.recognition = null;
    this.finalText = '';
    this.interimText = '';
    this.active = false;
  }

  start() {
    if (!this.supported) return false;
    if (this.active) return true;
    const rec = new this._Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (ev) => {
      this.interimText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        if (res.isFinal) this.finalText += res[0].transcript;
        else this.interimText += res[0].transcript;
      }
      emit('asr:partial', { text: this.finalText + this.interimText, final: false });
    };
    rec.onerror = (ev) => {
      emit('asr:error', { code: ev.error, message: this._explain(ev.error) });
    };
    rec.onend = () => {
      this.active = false;
      emit('asr:final', { text: this.finalText.trim() });
    };

    this.finalText = '';
    this.interimText = '';
    try {
      rec.start();
      this.recognition = rec;
      this.active = true;
      return true;
    } catch (e) {
      emit('asr:error', { code: 'start-failed', message: String(e.message || e) });
      return false;
    }
  }

  stop() {
    if (!this.active) return;
    try { this.recognition?.stop(); } catch { /* 已停 */ }
  }

  _explain(code) {
    return {
      'not-allowed': '麦克风权限被拒绝',
      'service-not-allowed': '浏览器语音服务不可用（可能需要在设置里允许）',
      'no-speech': '没有听到声音',
      'audio-capture': '找不到麦克风',
      network: '语音服务需要联网，网络不通',
      aborted: '识别被中断',
    }[code] || `识别失败：${code}`;
  }
}

export const recorder = new Recorder();
export const speaker = new Speaker();
