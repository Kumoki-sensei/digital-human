/**
 * mic-worklet.js —— AudioWorklet 音频采集处理器
 *
 * 为什么必须用 AudioWorklet 而不是 MediaRecorder：
 *   MediaRecorder 只给压缩后的容器（webm/opus），拿不到原始采样，
 *   而 VAD 判定「有没有人在说话」必须看采样级的能量 —— 这就是自动断句的前提。
 *
 * 运行在音频渲染线程（不是主线程），所以这里有两条硬规矩：
 *   1. **不许分配**：process() 每 2.67ms 就被调一次，在里面 new 数组/对象
 *      会触发 GC 抖动，听感上是爆音和卡顿。
 *   2. **不许碰 DOM / 不许 await**：这条线程上没有这些东西。
 *
 * 缓冲策略：把 128 帧的小块攒到 FRAME_SIZE 再 postMessage 一次。
 * 128 帧一块的话 48kHz 下每秒要发 375 次消息，主线程会被消息淹没；
 * 攒到 512 帧约 94 次/秒，既够实时（10ms 粒度）又不吵。
 */

const FRAME_SIZE = 512;

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(FRAME_SIZE);
    this._filled = 0;
    this._alive = true;
    // 主线程发 close 过来就自己退出（比从外部强行 disconnect 更干净）
    this.port.onmessage = (ev) => {
      if (ev.data === 'close') this._alive = false;
    };
  }

  process(inputs) {
    if (!this._alive) return false;

    const input = inputs[0];
    // 没有输入（设备被拔掉/静音）时继续存活，别让节点过早被回收
    if (!input || !input.length) return true;

    const channel = input[0];
    if (!channel || !channel.length) return true;

    let offset = 0;
    while (offset < channel.length) {
      const room = FRAME_SIZE - this._filled;
      const take = Math.min(room, channel.length - offset);
      this._buf.set(channel.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;

      if (this._filled === FRAME_SIZE) {
        // 必须拷贝一份再发：这块缓冲马上会被下一批采样覆盖
        const out = this._buf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-capture', MicCapture);
