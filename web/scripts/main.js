/**
 * main.js —— 前端编排入口（接线板）
 *
 * 这个文件只做三件事：
 *   1. 启动时把各模块初始化好（外观、形象、连接）
 *   2. 把总线上的事件翻译成界面动作（气泡、状态、设置）
 *   3. 决定交互语义：什么时候录音、什么时候打断、浏览器 TTS 怎么念
 *
 * 业务规则不写在这里 —— 那属于后端（brain.py）。前端不许自己编回答。
 */

import { $, on, emit, clamp, debounce, dumpListeners, listenerCount } from './bus.js';
import { get as getConfig, getIn, patch, setIn, CAPS } from './config.js';
import { client } from './client.js';
import { recorder, speaker, BrowserASR } from './audio.js';
import { AutoRecorder, VAD_EVENT } from './vad.js';
import { lip } from './lip.js';
import { lookOnce } from './vision.js';
import * as UI from './ui.js';
import { initTheme, applyTheme, loadSkin } from './themes.js';
import { initHome } from './home.js';

const SESSION_KEY = 'dh.session.v1';

let avatar = null;          // Avatar 实例（可能因缺模型而处于占位模式）
let avatarModule = null;
let browserAsr = null;      // 浏览器原生识别（可用时优先）
let useLocalAsr = false;
let recording = false;
let lastEmotionReset = 0;
let turnStartedAt = 0;              // 本轮起点，用于浏览器 TTS 的首帧估算
let browserTtsUsedLastTurn = false; // 本轮是否用了浏览器 TTS（决定首帧数是否标「估算」）
let browserTtsFirstMs = 0;          // 浏览器 TTS 的「开口→出声」墙钟时间

/** 自动断句采集器（AudioWorklet + VAD）。null = 未启用或当前浏览器不支持 */
let autoRecorder = null;
/** 自动监听是否进行中（这个模式下点一次麦克风会持续听多句） */
let autoListening = false;
/** 每隔几帧重画一次电平表（每帧都画太浪费，人眼也看不出差别） */
let vadDrawTick = 0;

/* ================================================================
   启动
   ================================================================ */

/**
 * 单例防护。
 *
 * 排查幽灵 bug 时就撞上过这个：入口脚本被执行了两遍（两套模块实例、两套事件订阅、
 * 两套 UI 状态），表现为「同一段回复在界面上渲染两遍」，而所有监听器各自都只有一份，
 * 极难定位。这里用 document 上的标记（而不是模块变量——模块变量有两份，挡不住）
 * 保证无论入口被评估几次，只会真正初始化一次。
 */
if (globalThis.document?.documentElement.dataset.dhBooted === '1') {
  console.error(
    '[main] 检测到入口脚本被重复执行（模块被评估了不止一遍）。' +
    '已忽略本次初始化以免重复订阅。请检查是否有重复的 <script> 标签、' +
    '是否被 Service Worker 二次注入、或是否用两个不同 URL 引了同一个模块。'
  );
} else {
  if (globalThis.document) globalThis.document.documentElement.dataset.dhBooted = '1';
  bootstrap().catch((e) => {
    console.error('[main] 启动失败', e);
    UI.toast(`启动失败：${e.message}`, 'err', 6000);
  });
}

async function bootstrap() {
  initTheme();
  UI.initSettings();
  UI.refreshSessions();
  UI.refreshAvatarPanel();

  // 品牌主页：一打开先见它，点击「开始对话」再淡出、露出工作台
  initHome();

  // 形象：动态导入，缺文件也不至于整个页面白屏
  await initAvatar();

  // 浏览器原生能力探测
  browserAsr = new BrowserASR({ lang: 'zh-CN' });
  useLocalAsr = browserAsr.supported;
  UI.setModeBadge(useLocalAsr ? '语音模式 · 本地识别' : '语音模式 · 上传识别');

  wireBus();
  wireDom();
  wireNetwork();

  // 把持久化的声音/人格设置推给后端
  restoreConfigToServer();
}

async function initAvatar() {
  // 没有模型时进入「空状态引导」：画布上只显示一句「请把模型文件放进来」，
  // 不再画一个假的扁平头像 —— 那是在用假东西糊弄用户，既看不出问题也看不出该做什么。
  UI.setAvatarMode('empty');
  try {
    const mod = await import('./avatar.js');
    avatarModule = mod;
    const canvas = $('#live2d-canvas');
    const container = $('#avatar-container');
    if (!mod.Avatar || !canvas) throw new Error('avatar.js 未导出 Avatar');

    // 记录「是否成功载入过模型」。这个标记决定空状态该说什么话：
    //   · 从没载入成功 → 「还没有可用的模型」，让用户去放文件
    //   · 载入成功过但画不出来 → 「渲染引擎画不出画面」，这时让用户去换模型是误导
    let everLoadedModel = false;

    avatar = new mod.Avatar({
      canvas,
      container,
      onStatus: (st) => {
        if (st.state === 'live2d') {
          everLoadedModel = true;
          UI.setAvatarMode('live2d');
          // 空状态元素由 CSS（[data-mode="live2d"]）自动隐藏，不需要额外操作
        } else {
          UI.setAvatarMode('empty');
          // reason 是给排查用的技术原因，界面上转成人话（英文标识符不直接甩给用户）
          UI.setEmptyReason(st.reason, { everLoadedModel });
        }
        emit('avatar:status', st);
      },
    });
    await avatar.init();

    const savedModel = getIn('avatar.model', '');
    if (savedModel && avatar.mode === 'live2d') {
      await avatar.loadModel(savedModel).catch(() => {});
    }
  } catch (e) {
    console.warn('[main] Live2D 模块不可用：', e.message);
    UI.setAvatarMode('empty');
    UI.setEmptyReason('live2d-runtime-unavailable: ' + e.message);
  }

  lip.attach({ avatar, speaker });
  lip.setEmotionGain(getIn('avatar.emotionGain', 0.9));
  lip.setMouthGain(getIn('avatar.mouthGain', 1.3));
  lip.start();
}

/* ================================================================
   连接
   ================================================================ */

function wireNetwork() {
  const savedSession = localStorage.getItem(SESSION_KEY) || '';
  client.connect(savedSession || undefined);

  const ping = setInterval(() => {
    if (client.online) client.ping();
  }, 25000);

  window.addEventListener('beforeunload', () => {
    clearInterval(ping);
    if (client.sessionId) localStorage.setItem(SESSION_KEY, client.sessionId);
  });
}

/* ================================================================
   事件总线 → 界面
   ================================================================ */

function wireBus() {
  // 订阅重复是这类幽灵 bug 的头号来源，启动时自检一次，重复就吼出来。
  {
    const before = dumpListeners();
    if (Object.values(before).some((n) => n > 0)) {
      console.error('[main] 事件总线里已有监听器，wireBus 被调了不止一次！', before);
    }
  }

  /* ---------- 网络 ---------- */
  on('net:state', ({ state, detail }) => UI.setNetStatus(state, detail));
  on('net:retry', ({ attempt, inMs }) => UI.toast(`连接断开，${(inMs / 1000).toFixed(1)}s 后第 ${attempt} 次重连…`, 'warn', 2000));

  on('ws:ready', (data) => {
    if (data.session_id) localStorage.setItem(SESSION_KEY, data.session_id);
    UI.setPersonaTitle(data.persona_name || '数字人');
    if (Array.isArray(data.history) && data.history.length) {
      UI.renderHistory(data.history);
    }
    const overrides = data.providers || {};
    const used = Object.entries(overrides)
      .filter(([, v]) => v.provider)
      .map(([k, v]) => `${k}:${v.provider}`);
    UI.toast(used.length ? `已用你自己的配置：${used.join(' / ')}` : '已连接（使用服务端默认模型）', 'ok');
    UI.refreshSessions();
    emit('app:ready', data);
  });

  /* ---------- 对话流 ---------- */
  on('ws:status', ({ phase, detail }) => {
    UI.setStatus(phase, detail);
    UI.setStopVisible(phase === 'thinking' || phase === 'speaking');
    if (phase === 'listening' || phase === 'thinking') UI.beginTurn();
  });

  // 用户气泡只由后端的 user 事件渲染。
  // 早先前端也自己渲染一份，加上 asr 事件那个分支就成了三条同样的气泡 —— 双源必炸，别再回来。
  on('ws:user', ({ text }) => {
    UI.addUserBubble(text);
    UI.hideLatencyPanel();   // 新的一轮开始，先收起上一轮的耗时面板
  });
  on('ws:asr', ({ ms }) => {
    if (ms) UI.toast(`识别完成（${ms}ms）`, 'info', 1500);
  });

  on('ws:token', ({ text }) => UI.appendToken(text));
  on('ws:segment', ({ text, emotion }) => {
    UI.appendSegment(text);
    // 情绪交给 lip → 渲染层（Live2D 参数 / CSS 变量），没有模型时它什么都不会发生
    if (emotion) lip.showEmotion(emotion);
  });

  on('ws:done', (data) => {
    UI.endTurn();
    UI.setStatus('idle');
    UI.setLatency(data.total_ms);
    UI.setStopVisible(false);
    // 三段耗时分解：调优时唯一能告诉你「该换哪个模型」的东西
    if (data.timing) {
      const timing = { ...data.timing, total_ms: data.total_ms };
      // 浏览器 TTS 没有音频流，主帧测不到；用「开口→出声」的墙钟时间近似顶上，
      // 并在面板里标注为估算 —— 宁可标清楚，也不要让它看起来像精确值。
      if (browserTtsUsedLastTurn && browserTtsFirstMs) {
        timing.tts = { ...(timing.tts || {}), first_frame_ms: browserTtsFirstMs };
      }
      UI.renderLatencyPanel(timing, { estimatedTts: browserTtsUsedLastTurn });
      UI.showLatencyPanel();   // 每轮结束自动亮出耗时分解，看一眼就知道这轮慢在哪
    }
    turnStartedAt = 0;
    browserTtsUsedLastTurn = false;
    browserTtsFirstMs = 0;
  });

  on('ws:error', ({ message }) => {
    UI.addErrorBubble(message);
    UI.setStatus('error', '出错');
    UI.setStopVisible(false);
    UI.endTurn();
  });

  /* ---------- 音频 ----------
     铁律：未开启「自动播放语音」时，一个字都不许出声。
     早期版本默认开着浏览器 TTS，用户一发消息网页就自己说话 —— 会吓到人。 */
  on('ws:audio', ({ mode, text }) => {
    if (!getIn('voice.autoplay', false)) return;
    if (mode === 'browser') browserSpeak(text);
  });
  on('ws:audio_begin', () => { /* 元数据帧本身不用处理，等二进制 */ });

  on('audio:chunk', async ({ buffer, meta }) => {
    if (!getIn('voice.autoplay', false)) return;
    await speaker.push(buffer, meta);
  });

  on('ui:voice-option', ({ key, value }) => {
    client.setConfig({ [key]: value });
  });

  // 前端侧的「要不要放出来」：关掉时立即停掉正在念的内容。
  // 只改设置不停播，等于没关 —— 用户按了开关却还在出声，比不按更糟。
  on('voice:autoplay-changed', ({ value }) => {
    if (!value) interrupt({ silent: true });
  });

  /* ---------- 工具 ---------- */
  on('ws:tool_call', async ({ id, name, arguments: args }) => {
    UI.addToolCard({ name, arguments: args, side: 'client' });
    const result = await runClientTool(name, args);
    client.toolResult(id, result.ok, result.content, result.data || {});
  });

  on('ws:tool_result', ({ name, ok, content }) => UI.addToolCard({ name, ok, content }));

  on('ws:confirm_request', (data) => UI.addConfirmCard(data));
  on('confirm:answered', ({ id, approved }) => {
    client.confirmResult(id, approved);
    UI.addSysBubble(approved ? '已允许该操作' : '已拒绝该操作');
  });

  on('ws:config_ack', () => UI.toast('后端设置已更新', 'ok', 1500));

  /* ---------- 语音状态 ---------- */
  on('speech:start', ({ text }) => {
    UI.setStatus('speaking', '说话中');
    lip.showEmotion(guessFromText(text));
    if (browserTtsUsedLastTurn && turnStartedAt && !browserTtsFirstMs) {
      // Web Speech 拿不到音频流，只能量出「从开口到出声」的墙钟时间
      browserTtsFirstMs = Math.round(performance.now() - turnStartedAt);
    }
  });
  on('speech:end', () => { UI.setStatus('idle'); });

  /* ---------- 视觉 ---------- */
  on('vision:start', ({ source }) => UI.toast(`正在看你的${source === 'camera' ? '摄像头' : '屏幕'}…`, 'info', 1500));
  on('vision:result', ({ text }) => UI.addToolCard({ name: 'look_at_screen', content: text, ok: true }));
  on('vision:error', ({ message }) => UI.addErrorBubble(`视觉识别失败：${message}`));

  /* ---------- 设置交互 ---------- */
  on('ui:avatar-option', ({ key, value }) => {
    if (key === 'lipsync') lip.setEnabled(value);
    if (key === 'lookAt') lip.setLookAtEnabled(value);
    if (key === 'blink') setIn('avatar.blink', value);
    if (key === 'mouthGain') lip.setMouthGain(value);
    if (key === 'emotionGain') lip.setEmotionGain(value);
  });

  /* ---------- 自动断句（VAD） ---------- */
  on('ui:vad-option', ({ key, value }) => {
    // 参数改动实时生效：VAD 实例持着 cfg，直接改就行（下一帧判定就用新值）
    if (key === 'thresholdFactor' && autoRecorder) autoRecorder.vad.cfg.thresholdFactor = value;
    if (key === 'silenceMs' && autoRecorder) autoRecorder.vad.cfg.silenceMs = value;
    if (key === 'auto' && !value) stopAutoListening({ silent: true });
  });

  on('vad:level', (info) => {
    UI.pushVadLevel(info);
    if (++vadDrawTick % 3 === 0) UI.drawVadMeter(true, true);
  });

  on('vad:state', ({ state }) => {
    if (state === VAD_EVENT.SPEECH_START) UI.setVadInfo('检测到说话…', 'speaking');
    else if (state === VAD_EVENT.TOO_SHORT) UI.setVadInfo('太短（按噪声忽略）', 'listening');
    else if (state === VAD_EVENT.SPEECH_END) UI.setVadInfo('已断句，发送中…', 'listening');
    else UI.setVadInfo('聆听中（说完自动发送）', 'listening');
  });

  on('ui:voice-option', ({ key, value }) => client.setConfig({ [key]: value }));

  on('ui:load-model', async ({ path, format }) => {
    if (!avatar) return UI.toast('Live2D 运行时不可用', 'err');
    // Cubism 2 旧模型走的是另一套运行时（.moc + .model.json），
    // 当前渲染链路只覆盖 Cubism 3/4/5。直接说清楚，别让它静默失败。
    if (format === 'cubism2') {
      UI.toast('这是 Cubism 2 旧版模型，当前渲染链路还不支持（只支持 Cubism 3/4/5）', 'warn', 6000);
      return;
    }
    try {
      await avatar.loadModel(path);
      UI.toast('模型已切换', 'ok');
    } catch (e) {
      UI.toast(`模型加载失败：${e.message}`, 'err');
    }
  });

  // 导入完成后：把新模型报给用户，并提示可以直接用
  on('model:imported', (obj) => {
    const names = (obj.imported || []).map((m) => m.name);
    if (!names.length) return;
    UI.toast(`已导入 ${names.length} 个模型：${names.join('、')}`, 'ok', 5000);
  });

  on('model:uploaded', (obj) => {
    // 兼容两种返回：新接口给 dirs（数组，支持一次导入多个模型），旧接口给 dir
    const dirs = obj?.dirs || (obj?.dir ? [obj.dir] : []);
    if (dirs.length) UI.toast(`已存入项目：assets/models/${dirs.join('、')}`, 'ok', 4000);
  });

  on('ui:reset', () => {
    try { avatar?.dispose?.(); } catch (e) { console.warn('[main] 释放模型失败', e); }
    client.reset();
    UI.renderHistory([]);
    localStorage.removeItem(SESSION_KEY);
    // 必须开新会话：只发 reset 而不换 session id 的话，刷新页面旧历史又会回来，
    // 用户会以为「清空没生效」。
    client.startFreshSession();
    UI.toast('记忆已清空，已开新会话', 'ok');
  });

  // 设置里改完供应商/密钥后，用它让新配置立刻生效。
  // 连接参数（含密钥）只在建立连接时读一次，所以必须真的断开重连，
  // 否则会出现「明明填了却说没填」——之前那句提示让用户去点一个并不存在的按钮。
  on('ui:reconnect', () => {
    client.reconnect();
    UI.toast('正在用最新配置重连…', 'info');
  });

  on('ui:session-loaded', ({ id }) => {
    localStorage.setItem(SESSION_KEY, id);
    client.reconnect();
  });

  /* ---------- 模块（自定义接入） ---------- */
  on('modules:changed', ({ removed }) => {
    UI.toast(removed ? `已删除自定义模块 ${removed}` : '模块已更新', 'ok');
  });
  on('modules:error', ({ message }) => UI.toast(message, 'err'));

  on('ui:theme-changed', ({ id }) => UI.toast(`已切换皮肤：${id}`, 'ok', 1600));
  on('skin:error', ({ url, message }) => UI.toast(`皮肤脚本失败：${message}`, 'err', 5000));
}

/* ================================================================
   DOM 交互
   ================================================================ */

function wireDom() {
  const input = $('#input');
  const sendBtn = $('#btn-send');
  const micBtn = $('#btn-mic');
  const stopBtn = $('#btn-stop');

  // 点状态栏的耗时数字，展开/收起三段分解
  $('#latency')?.addEventListener('click', () => UI.toggleLatencyPanel());

  // 输入框自适应高度
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  });

  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendCurrentText();
    }
  });

  sendBtn?.addEventListener('click', sendCurrentText);

  // 麦克风：点击切换「开始/结束」录音。开始录音即打断当前发言（barge-in）
  micBtn?.addEventListener('click', toggleMic);

  stopBtn?.addEventListener('click', interrupt);

  // 视线跟随
  window.addEventListener('mousemove', (ev) => {
    const stage = $('#stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    lip.lookAt(clamp(nx, -1, 1), clamp(ny, -1, 1));
  });

  // 全局快捷键
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      UI.closeDrawer();
      interrupt();
      $('#latency-panel')?.setAttribute('hidden', '');   // Esc 顺手收起延迟面板
    }
    if (ev.code === 'Space' && ev.ctrlKey) { ev.preventDefault(); toggleMic(); }
  });

  // 主题按钮直接轮换皮肤（快速预览用）
  $('#btn-theme')?.addEventListener('click', async () => {
    const { THEMES } = await import('./themes.js');
    const cur = getIn('ui.theme', 'starlight');
    const idx = THEMES.findIndex((t) => t.id === cur);
    const next = THEMES[(idx + 1) % THEMES.length];
    applyTheme(next.id);
    document.querySelectorAll('#theme-grid .theme-card').forEach((c) => {
      c.classList.toggle('is-active', c.dataset.theme === next.id);
    });
    UI.toast(`皮肤：${next.name}`, 'ok', 1400);
  });

  window.addEventListener('error', (ev) => {
    console.error('[window error]', ev.error || ev.message);
  });
}

function sendCurrentText() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (!client.online) return UI.toast('还没连上后端', 'warn');
  input.value = '';
  input.style.height = 'auto';
  UI.beginTurn();          // 只开轮次，气泡等后端 user 事件回来再画（避免双源重复）
  turnStartedAt = performance.now();
  browserTtsFirstMs = 0;
  client.sendText(text);
}

/* ================================================================
   麦克风与识别
   ================================================================ */

async function toggleMic() {
  if (autoListening) {
    await stopAutoListening();
  } else if (recording) {
    await stopRecording();
  } else if (AutoRecorder.supported && getIn('voiceInput.auto', true)) {
    await startAutoListening();
  } else {
    await startRecording();
  }
}

/* ================================================================
   自动听（说一句自动发一句，不用再点麦克风）
   ================================================================ */

/** 开一句就打断它自己 —— 用户开口时数字人必须先闭嘴。 */
function interruptSpeakingFor() {
  if (speaker.busy) speaker.stopAll();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  UI.setStopVisible(false);
}

async function startAutoListening() {
  if (!client.online) return UI.toast('还没连上后端', 'warn');

  const thresholdFactor = getIn('voiceInput.thresholdFactor', 3.2);
  const silenceMs = getIn('voiceInput.silenceMs', 900);

  try {
    autoRecorder = new AutoRecorder({
      workletUrl: 'scripts/mic-worklet.js',
      vadOptions: { thresholdFactor, silenceMs, minUtteranceMs: 350, maxUtteranceMs: 15000 },
    });
  } catch (e) {
    return UI.toast(`自动断句不可用：${e.message}`, 'err', 5000);
  }

  // 数字人在说话时冻结判定：否则它自己的声音会被当成用户输入（自问自答）
  autoRecorder.vad.suppressed = () => speaker.busy;

  autoRecorder.vad.onLevel = (info) => emit('vad:level', info);
  autoRecorder.vad.onState = (state) => emit('vad:state', { state });
  autoRecorder.onUtterance = (info) => handleAutoUtterance(info);

  try {
    await autoRecorder.start();
  } catch (e) {
    const msg = e?.name === 'NotAllowedError'
      ? '麦克风权限被拒绝：请点地址栏左侧的图标允许'
      : String(e.message || e);
    UI.toast(`自动断句启动失败：${msg}`, 'err', 6000);
    autoRecorder = null;
    return;
  }

  autoListening = true;
  recording = true;                 // 复用「正在录音」这个状态位，好让按钮显示成录制中
  UI.setRecordingVisual(true);
  UI.setStatus('listening', '聆听中');
  UI.setStopVisible(true);
  UI.setVadInfo('聆听中（说完自动发送）', 'listening');

  // 这里刻意用「上传识别」：AudioWorklet 拿到的是原始采样，
  // 而 Web Speech API 只能听实时麦克风流、吃不到我们手里的 PCM，
  // 所以自动断句 + 浏览器本地识别这个组合在浏览器侧做不到。
  // 与其做一个"看起来本地其实没识别到"的假象，不如直接说清并走上传。
  UI.toast('自动断句已开启 · 说完自动发送（走上传识别）· 再点一次麦克风停止', 'ok', 5000);
}

async function stopAutoListening({ silent = false } = {}) {
  autoListening = false;
  recording = false;
  UI.setRecordingVisual(false);
  UI.setStopVisible(false);
  UI.drawVadMeter(false, false);
  UI.setVadInfo('已停止监听', 'idle');
  if (!silent) UI.setStatus('idle');

  if (autoRecorder) {
    const r = autoRecorder;
    autoRecorder = null;
    try { await r.release(); } catch (e) { console.warn('[main] 释放采集器失败', e); }
  }
}

/** 一句话说完了：送出这一段音频。 */
async function handleAutoUtterance({ blob, durationMs }) {
  if (!client.online) return UI.toast('还没连上后端', 'warn');
  if (durationMs < 300) return;   // VAD 里已经过滤过，这里再兜一层

  // 自动断句走的是 AudioWorklet 原始采样，拿不到 Web Speech 的中间结果，
  // 所以这条路径统一上传给后端识别。想省流量就在设置里关掉自动断句、走手动录音。
  UI.beginTurn();
  turnStartedAt = performance.now();
  browserTtsFirstMs = 0;
  browserTtsUsedLastTurn = false;
  client.sendAudio(blob, { mime: 'audio/wav', sampleRate: autoRecorder?.sampleRate || 48000 });
}

async function startRecording() {
  if (!client.online) return UI.toast('还没连上后端', 'warn');

  // 一开口就打断：这是数字人体感的关键，不是可选优化
  interrupt({ silent: true });

  // 录音起点：浏览器 TTS 的「开口→出声」时间要靠它算
  turnStartedAt = performance.now();
  browserTtsFirstMs = 0;
  browserTtsUsedLastTurn = false;

  const ok = await recorder.start();
  if (!ok) return;

  recording = true;
  UI.setRecordingVisual(true);
  UI.setStatus('listening', '聆听中…');
  UI.setStopVisible(true);

  if (useLocalAsr) {
    // 浏览器原生识别：音频不出本机，识别结果直接当文本发
    const started = browserAsr.start();
    if (!started) useLocalAsr = false;
  }
}

async function stopRecording() {
  recording = false;
  UI.setRecordingVisual(false);
  UI.setStatus('thinking', '处理中…');

  if (useLocalAsr && browserAsr) {
    browserAsr.stop();
    await recorder.stop();          // 录音仅用于本地识别，不需要上传
    const text = (browserAsr.finalText || '').trim();
    if (text) {
      UI.beginTurn();
      client.sendText(text);       // 气泡由后端 user 事件渲染
    } else {
      UI.setStatus('idle');
      UI.toast('没听清，再说一次？', 'warn');
    }
    return;
  }

  // 上传识别：整段录音发给后端
  const result = await recorder.stop();
  if (!result || result.duration < 0.35) {
    UI.setStatus('idle');
    return UI.toast('录音太短了', 'warn', 1600);
  }
  UI.beginTurn();
  UI.addSysBubble(`已发送 ${result.duration.toFixed(1)}s 录音，等待识别…`);
  client.sendAudio(result.blob, { mime: result.mime });
}

function interrupt({ silent = false } = {}) {
  speaker.stopAll();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (client.online) client.interrupt();
  UI.setStopVisible(false);
  if (!silent) UI.setStatus('interrupted', '已打断');
}

/* ================================================================
   浏览器原生 TTS（后端只发文本时）
   ================================================================ */

/**
 * 浏览器原生 TTS（后端只发文本时）。
 *
 * 只负责「发声」，**不负责渲染文本** —— 文本由 ws:segment 事件统一渲染。
 * 早先这里也调了一次 UI.appendSegment，结果是每句话在界面上出现两遍；
 * 排查耗时很久，因为监听器与模块实例都只有一份，看不出任何重复。
 * 记住这条规则：一个事件只允许有一个渲染者。
 */
function browserSpeak(text) {
  // 双保险：调用方已经判过一次，但这里是真正出声的地方，必须自己再判
  if (!getIn('voice.autoplay', false)) return;
  if (!('speechSynthesis' in window)) {
    console.warn('[main] 浏览器不支持语音合成，改为纯文字输出');
    return;
  }
  browserTtsUsedLastTurn = true;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'zh-CN';
  utter.rate = 1.05;
  utter.pitch = 1.0;

  utter.onstart = () => {
    UI.setStatus('speaking', '说话中');
    // 浏览器 TTS 没有分析器数据，用估算能量驱动口型（聊胜于无但不哑）
    startFakeEnergy();
  };
  utter.onend = () => {
    stopFakeEnergy();
    UI.setStatus('idle');
  };
  utter.onerror = () => { stopFakeEnergy(); UI.setStatus('idle'); };

  window.speechSynthesis.speak(utter);
}

let fakeEnergyTimer = 0;
function startFakeEnergy() {
  if (fakeEnergyTimer) return;
  // 借用 Speaker 的估算分支：让 lip 驱动有数据可读
  speaker.playing = true;
  const tick = () => {
    if (!speaker.playing) { fakeEnergyTimer = 0; return; }
    fakeEnergyTimer = requestAnimationFrame(tick);
  };
  fakeEnergyTimer = requestAnimationFrame(tick);
}
function stopFakeEnergy() {
  speaker.playing = false;
  if (fakeEnergyTimer) { cancelAnimationFrame(fakeEnergyTimer); fakeEnergyTimer = 0; }
}

/* ================================================================
   客户端工具（「能做」的前端部分）
   ================================================================ */

async function runClientTool(name, args) {
  try {
    switch (name) {
      case 'set_theme': {
        const { THEMES, applyTheme } = await import('./themes.js');
        const theme = THEMES.find((t) => t.id === args.theme_id || t.name === args.theme_id);
        if (!theme) {
          return { ok: false, content: `没有叫「${args.theme_id}」的皮肤。可选：${THEMES.map((t) => `${t.id}(${t.name})`).join('、')}` };
        }
        applyTheme(theme.id);
        return { ok: true, content: `已切换到「${theme.name}」皮肤` };
      }

      case 'set_expression': {
        const emotion = String(args.emotion || 'neutral');
        const intensity = Number(args.intensity ?? 1);
        lip.showEmotion(emotion, 3000);
        return { ok: true, content: `表情已切换为 ${emotion}（强度 ${intensity}）` };
      }

      case 'look_at_screen': {
        const text = await lookOnce({
          source: args.source === 'camera' ? 'camera' : 'screen',
          question: args.question || '',
        });
        return text
          ? { ok: true, content: text }
          : { ok: false, content: '没能取得画面（可能是权限被拒绝或不支持屏幕捕获）' };
      }

      default:
        return { ok: false, content: `前端不认识这个工具：${name}` };
    }
  } catch (e) {
    return { ok: false, content: `前端执行失败：${e.message}` };
  }
}

/* ================================================================
   杂项
   ================================================================ */

/* 注：早先这里有个 promptSaveModel()，用于「先本地试用、再问是否存进项目」。
   现在导入流程已经统一到「设置 → 形象 → 导入模型」（直接落盘 + 进度 + 结果清单），
   两条路径并存只会让人怀疑自己用的是哪一条，所以整段删掉。 */

function restoreConfigToServer() {
  const cfg = getConfig();
  const send = () => client.setConfig({
    persona_name: cfg.persona.name || undefined,
    persona_style: cfg.persona.style || undefined,
    // 后端只负责「要不要合成」；「要不要放出来」是前端的事（见 voice.autoplay）。
    // 两者分开是有意的：合成可以关闭以省一次请求，而播放默认必须是关的。
    tts_enabled: !!cfg.voice.autoplay,
    speak: cfg.voice.speak,
    mode: 'voice',
  });
  if (client.online) send();
  else on('app:ready', send);
}

function guessFromText(text) {
  if (!text) return 'neutral';
  if (/[哼哈]|笑|太棒|好耶|！/.test(text)) return 'happy';
  if (/抱歉|遗憾|难过|唉/.test(text)) return 'sad';
  if (/不行|不许|讨厌|别闹/.test(text)) return 'angry';
  if (/啊？|居然|什么/.test(text)) return 'surprised';
  if (/…|才不是/.test(text)) return 'shy';
  return 'neutral';
}

// 供外挂皮肤脚本从控制台调试用
window.dh = { client, speaker, recorder, lip, avatar: () => avatar, UI, emit, getIn, setIn };
