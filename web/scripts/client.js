/**
 * client.js —— WebSocket 通道
 *
 * 职责边界刻意收得很窄：只负责「连上、收发、断线重连、把事件派发到总线」。
 * 会话编排、UI 渲染都不在这里 —— 它们订阅总线事件即可。
 * 这样你换成 SSE/WebRTC 时，只需要替换这一个文件。
 *
 * 二进制帧约定（与后端 api/chat.py 严格对应）：
 *   上行：{"type":"audio_final",...} 之后紧跟一个二进制帧 = 整段录音
 *   下行：audio_begin 事件之后紧跟一个二进制帧 = 一段 TTS 音频
 */

import { emit } from './bus.js';
import { buildConnectionQuery } from './config.js';

const MAX_BACKOFF_MS = 30000;
const BASE_RETRY_MS = 700;

export class ChatClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.state = 'offline';     // offline | connecting | online | error
    this.attempt = 0;
    this.lastBinary = null;     // 最近一段待播音频（供渲染层取用）
    this._manualClose = false;
    this._retryTimer = 0;
  }

  get online() {
    return this.state === 'online' && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(sessionId = this.sessionId) {
    this._manualClose = false;
    this.sessionId = sessionId || null;
    this.setState('connecting');

    const qs = buildConnectionQuery(this.sessionId);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/chat${qs ? '?' + qs : ''}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setState('error', `无法创建连接：${e.message}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('online');
    };

    ws.onmessage = (ev) => this._onMessage(ev);

    ws.onerror = () => {
      // onerror 不带可用信息，真正的诊断靠 onclose 的 code
      this.setState('error', '连接出错');
    };

    ws.onclose = (ev) => {
      if (this._manualClose) {
        this.setState('offline', '已断开');
        return;
      }
      this.setState('offline', `连接关闭（code ${ev.code}）`);
      this._scheduleReconnect();
    };
  }

  /**
   * 断线重连：一直重试，间隔指数退避封顶 30s。
   *
   * 早先的版本重试 6 次就永久放弃，结果「后端重启一下，网页就废了」——
   * 对一个本机开发用的东西来说这是最烦人的失败模式，所以取消上限。
   * 另外 document 变可见、网络恢复、用户手动操作时都会立刻重试一次。
   */
  _scheduleReconnect() {
    if (this._retryTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_RETRY_MS * 2 ** this.attempt);
    this.attempt += 1;
    emit('net:retry', { attempt: this.attempt, inMs: delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = 0;
      if (!this._manualClose) this.connect(this.sessionId);
    }, delay);
  }

  /** 立即重连（不等退避计时器）。 */
  retryNow() {
    if (this.online) return;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = 0; }
    this.connect(this.sessionId);
  }

  _onMessage(ev) {
    // 二进制帧：紧跟在上一条 audio_begin 元数据之后
    if (ev.data instanceof ArrayBuffer) {
      emit('audio:chunk', {
        buffer: ev.data,
        meta: this._pendingAudioMeta || { mime: 'audio/mpeg', text: '', final: true },
      });
      if (this._pendingAudioMeta?.final) this._pendingAudioMeta = null;
      return;
    }

    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      console.warn('[client] 收到无法解析的文本帧');
      return;
    }

    const { type, ...data } = msg;

    if (type === 'ready') {
      this.sessionId = data.session_id || this.sessionId;
    }
    if (type === 'audio_begin') {
      this._pendingAudioMeta = { mime: data.mime, text: data.text, final: data.final !== false };
    }
    if (type === 'status' && data.phase) {
      emit('status', data);
    }
    emit(`ws:${type}`, data);
    emit('ws', { type, data });
  }

  setState(state, detail = '') {
    this.state = state;
    emit('net:state', { state, detail });
  }

  /* ------------------------------------------------------------ 发送 */

  send(obj) {
    if (!this.online) {
      emit('error', { message: '还没连上后端，正在重连…' });
      this.retryNow();
      return false;
    }
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendText(text) {
    return this.send({ type: 'text', text });
  }

  /** 发送整段录音：先发元数据，再发二进制（顺序不能反）。 */
  sendAudio(blob, { mime = 'audio/webm', sampleRate = 16000 } = {}) {
    if (!this.online) {
      emit('error', { message: '还没连上后端，正在重连…' });
      this.retryNow();
      return false;
    }
    this.ws.send(JSON.stringify({ type: 'audio_final', mime, sample_rate: sampleRate }));
    blob.arrayBuffer().then((buf) => {
      if (this.online) this.ws.send(buf);
    });
    return true;
  }

  /** 分批发送大录音，避免一次性占用过多内存（一般录音不需要）。 */
  async sendAudioChunked(blob, { mime = 'audio/webm', chunkSize = 256 * 1024 } = {}) {
    if (!this.online) return false;
    const buf = await blob.arrayBuffer();
    const total = Math.ceil(buf.byteLength / chunkSize);
    for (let i = 0; i < total; i += 1) {
      const slice = buf.slice(i * chunkSize, (i + 1) * chunkSize);
      this.ws.send(JSON.stringify({
        type: 'audio_chunk',
        final: i === total - 1,
        mime,
        index: i,
      }));
      this.ws.send(slice);
    }
    return true;
  }

  interrupt() { return this.send({ type: 'interrupt' }); }
  reset() { return this.send({ type: 'reset' }); }
  ping() { return this.send({ type: 'ping' }); }

  setConfig(patchObj) { return this.send({ type: 'config', ...patchObj }); }

  toolResult(id, ok, content, data = {}) {
    return this.send({ type: 'tool_result', id, ok, content, data });
  }

  confirmResult(id, approved, content = '') {
    return this.send({ type: 'confirm_result', id, approved, content });
  }

  /** 前端主动调用后端工具（例如手动触发一次截图识别）。 */
  callTool(name, args = {}) {
    const id = `ui_${Date.now().toString(36)}`;
    this.send({ type: 'call_tool', id, name, arguments: args });
    return id;
  }

  close() {
    this._manualClose = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = 0; }
    try { this.ws?.close(); } catch { /* 已关闭 */ }
    this.setState('offline', '已断开');
  }

  /** 用新的自带密钥重连（设置里改完密钥后调用）。 */
  reconnect() {
    const sid = this.sessionId;
    this.close();
    setTimeout(() => this.connect(sid), 120);
  }

  /**
   * 开一个全新会话：客户端丢弃 session id，让后端分配一个新的。
   *
   * 为什么不能只发 reset：reset 只清空服务端那条会话的消息，
   * 会话 id 不变。用户刷新页面后旧历史会从会话文件里再被读回来，
   * 表现就是「清空记忆没生效」。
   */
  startFreshSession() {
    this.sessionId = null;
    this.close();
    setTimeout(() => this.connect(undefined), 120);
  }
}

export const client = new ChatClient();

// 回到前台或网络恢复时立刻补一次连接，不用等退避计时器走完
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) client.retryNow();
});
window.addEventListener('online', () => client.retryNow());
