/**
 * ui.js —— 界面渲染层（只碰 DOM，不做业务决策）
 *
 * 划分原则：这个文件里只有「怎么显示」，没有「发生了什么」。
 * 点击麦克风该不该录音、什么时候打断，由 main.js 决定；
 * 设置面板改了值，也只是发一条事件出去，由 main.js 决定要不要重连。
 * 这样你改界面（或者换框架重写界面）不需要碰任何业务逻辑。
 */

import { $, $$, el, setText, emit, fmtTime, debounce, dumpListeners } from './bus.js';

// 模块实例标记：模块若被评估两遍，这里会自增，用来识别「两套状态」的幽灵 bug
window.__uiInstance = (window.__uiInstance || 0) + 1;
import {
  CAPS, CAP_LABEL, get as getConfig, patch, setIn, getIn, resetAll,
  credSummary, anyKeyStored, buildCredentialHeaders,
} from './config.js';
import { THEMES, applyTheme, applyFontSize, applyMotionScale, loadSkin, unloadSkin, currentSkin } from './themes.js';
import { client } from './client.js';

/* ================================================================
   状态栏 / Toast
   ================================================================ */

const PHASE_TEXT = {
  idle: '待机',
  listening: '聆听中',
  thinking: '思考中',
  speaking: '回答中',
  interrupted: '已打断',
  error: '出错',
};

export function setStatus(phase, detail = '') {
  const dot = $('#status-dot');
  const text = $('#status-text');
  if (!dot || !text) return;
  const normalized = PHASE_TEXT[phase] ? phase : 'idle';
  dot.dataset.state = normalized;
  text.textContent = detail || PHASE_TEXT[normalized];
}

export function setNetStatus(state, detail = '') {
  const dot = $('#status-dot');
  if (!dot) return;
  if (state === 'offline' || state === 'error') {
    dot.dataset.state = 'offline';
    $('#status-text').textContent = detail || (state === 'error' ? '连接失败' : '未连接');
  } else if (state === 'connecting') {
    dot.dataset.state = 'idle';
    $('#status-text').textContent = '连接中…';
  } else if (state === 'online') {
    dot.dataset.state = 'idle';
    $('#status-text').textContent = '已连接';
  }
}

export function setLatency(ms) {
  const node = $('#latency');
  if (!node) return;
  node.textContent = Number.isFinite(ms) ? `${ms}ms` : '—';
}

/**
 * 渲染「这一轮慢在哪」的三段分解。
 *
 * 为什么值得单独做一块 UI：你换模型、换供应商、装不装 ffmpeg 有没有用，
 * 全都只能靠这三个数字回答。没有它，调优就是凭感觉。
 * 注意 tts.first_frame_ms 在浏览器原生 TTS 下是「估算值」（Web Speech 拿不到音频流），
 * 所以标签里会注明，不假装精确。
 */
export function renderLatencyPanel(timing, { estimatedTts = false } = {}) {
  const panel = $('#latency-panel');
  if (!panel) return;
  if (!timing) { panel.hidden = true; return; }

  const asr = timing.asr?.ms;
  const llm = timing.llm?.first_token_ms;
  const tts = timing.tts?.first_frame_ms;
  const tools = timing.tools || [];
  const toolMs = tools.reduce((a, t) => a + (t.ms || 0), 0);

  const rows = [
    { key: 'asr', label: '听懂', ms: asr, provider: timing.asr?.provider, note: asr == null ? '文字输入，不需要识别' : '' },
    { key: 'llm', label: '首字', ms: llm, provider: timing.llm?.provider },
    { key: 'tts', label: '首帧', ms: tts, provider: timing.tts?.provider, note: estimatedTts ? '浏览器 TTS，此处为估算' : '' },
  ];
  if (tools.length) {
    rows.push({
      key: 'tool', label: '工具', ms: toolMs, provider: tools.map((t) => t.name).join(','),
    });
  }

  const max = Math.max(...rows.map((r) => r.ms || 0), 1);
  panel.innerHTML = '';

  for (const r of rows) {
    const row = el('div', { class: 'lat-row' });
    const head = el('div', { class: 'lat-row__head' });
    head.append(el('span', {}, [r.label + (r.note ? `（${r.note}）` : '')]));
    head.append(el('b', {}, [r.ms == null ? '—' : `${r.ms}ms`]));
    row.append(head);
    if (r.provider) row.append(el('div', { class: 'lat-row__provider' }, [r.provider]));

    const bar = el('div', { class: `lat-bar lat-bar--${r.key}` });
    const fill = el('i');
    fill.style.width = `${Math.round(((r.ms || 0) / max) * 100)}%`;
    bar.append(fill);
    row.append(bar);
    panel.append(row);
  }

  const foot = el('div', { class: 'latency-panel__foot' });
  // 过滤掉 0/1ms 的样本：那是纯本地回声，写进去只会让人以为「合成瞬时完成」
  const segs = (timing.segment_ms || []).filter((v) => v > 1);
  // 「听到 → 回话」这一行只在真的走了识别时才有意义（文字输入时它恒为 0）
  const heardLine = timing.asr?.ms != null && timing.heard_ms != null
    ? `｜听到 → 回话 ${timing.heard_ms}ms`
    : '';
  foot.append(el('div', {}, [`整轮 ${timing.total_ms ?? '—'}ms${heardLine}`]));
  if (segs.length) foot.append(el('div', {}, [`分句合成：${segs.join(' / ')} ms`]));
  if (estimatedTts) {
    foot.append(el('div', { class: 'note' }, [
      '浏览器 TTS 拿不到音频流，首帧是「开口→出声」的墙钟时间，偏保守。',
    ]));
  }
  foot.append(el('div', {}, [
    '数字最大的一段就是瓶颈。首字慢 → 换更快的 LLM；',
    '首帧慢 → 换 TTS 或缩短句长；听懂慢 → 换 ASR 或走本机识别。',
  ]));
  panel.append(foot);
  // 注意：这里不改 hidden。可见性由 show/hide 显式控制，
  // 否则用户刚收起面板，下一个事件又把它弹回来。
}

export function showLatencyPanel() { const p = $('#latency-panel'); if (p) p.hidden = false; }
export function hideLatencyPanel() { const p = $('#latency-panel'); if (p) p.hidden = true; }

export function toggleLatencyPanel() {
  const panel = $('#latency-panel');
  if (panel) panel.hidden = !panel.hidden;
}

export function toast(message, kind = 'info', ms = 3200) {
  const host = $('#toast-host');
  if (!host) return;
  const node = el('div', { class: 'toast', dataset: { kind } }, [String(message)]);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ================================================================
   对话渲染
   ================================================================ */

let currentTurn = null;     // 当前轮次的容器
let currentAiBubble = null; // 当前正在被追加文本的 AI 气泡
let currentText = '';       // 该气泡的完整目标文本
let caret = null;
let typeState = null;       // { node, full, raf } —— 打字机状态必须绑定到具体气泡

function chatRoot() { return $('#chat'); }

function clearHint() {
  $('#chat-hint')?.remove();
}

export function beginTurn(meta = {}) {
  const chat = chatRoot();
  if (!chat) return null;
  clearHint();
  currentTurn = el('div', { class: 'turn', dataset: { started: String(Date.now()) } });
  currentTurn.style.display = 'contents';  // 不引入额外盒模型层级，气泡仍按列排列
  chat.append(currentTurn);
  currentAiBubble = null;
  caret = null;
  typeState = null;
  scrollToBottom();
  return currentTurn;
}

function appendTo(node) {
  (currentTurn || chatRoot())?.append(node);
  scrollToBottom();
  return node;
}

export function addUserBubble(text, ts) {
  const b = el('div', { class: 'bubble bubble--user', title: ts ? fmtTime(ts) : '' });
  setText(b, text);
  return appendTo(b);
}

export function addSysBubble(text) {
  const b = el('div', { class: 'bubble bubble--sys' });
  setText(b, text);
  return appendTo(b);
}

export function addErrorBubble(text) {
  const b = el('div', { class: 'bubble bubble--err' });
  setText(b, `⚠ ${text}`);
  return appendTo(b);
}

/** 开始一段 AI 文字（后续 token/segment 会追加进这个气泡）。 */
export function beginAiBubble() {
  stopTypewriter();
  currentAiBubble = el('div', { class: 'bubble bubble--ai' });
  currentText = '';
  caret = el('span', { class: 'bubble__caret' });
  currentAiBubble.append(caret);
  appendTo(currentAiBubble);
  return currentAiBubble;
}

/**
 * 追加流式文本（文本模式）。
 *
 * 注意：打字机状态必须绑定到「具体的那个气泡节点」。早先的写法把状态放在模块级
 * 变量上，结果是一换气泡，上一个还在跑的打字机就把新气泡的文本又渲染了一遍，
 * 界面上会出现完全重复的两条气泡。
 */
export function appendToken(text) {
  if (!currentAiBubble) beginAiBubble();
  currentText += text;

  if (!getIn('ui.typewriter', true)) {
    setText(currentAiBubble, currentText);
    if (caret) currentAiBubble.append(caret);
    scrollToBottom();
    return;
  }
  startTypewriter(currentAiBubble, currentText);
}

/**
 * 一个完整分句（语音模式下也是 TTS 的单位）：直接整句显示，不走打字机。
 *
 * 铁律：**一个事件只允许有一个渲染者**。这条气泡文本由 ws:segment 渲染，
 * 其他任何地方（例如浏览器 TTS 的朗读逻辑）都不许再渲染一遍 ——
 * 曾经因为两处都渲染，界面上每句话出现两次，而监听器与模块实例都只有一份，
 * 排查了很久才找到。改动渲染路径前请先读这句。
 */
export function appendSegment(text) {
  stopTypewriter();
  // 判据用「DOM 里当前气泡是否已经有内容」——不能用模块级变量，
  // 因为变量与节点的一致性一旦错位，就会出现整段回复被渲染两遍的幽灵气泡。
  const hasEmptyBubble = currentAiBubble
    && !(currentAiBubble.textContent || '').replace(/\s/g, '');
  if (!hasEmptyBubble) beginAiBubble();   // 第一句复用刚建好的空气泡，后续句子另起一个
  currentText = text;
  setText(currentAiBubble, text);
  // 整句已经说完了，不留跳动光标 —— 光标是「还在生成」的信号，
  // 分句模式下它会一直挂在句尾，看起来像渲染残留。
  if (caret) { caret.remove(); caret = null; }
  scrollToBottom();
}

export function endAiBubble() {
  stopTypewriter();
  if (caret) { caret.remove(); caret = null; }
  currentAiBubble = null;
  currentText = '';
}

export function endTurn() {
  endAiBubble();
  currentTurn = null;
}

export function addToolCard({ name, arguments: args, ok, content, side = 'server' }) {
  if (!getIn('ui.showTools', true)) return null;
  const card = el('div', { class: 'tool-card', dataset: { ok: ok === false ? 'false' : 'true', side } });
  card.append(el('div', { class: 'tool-card__name' }, [`⚙ ${name}`]));
  const body = el('pre');
  const parts = [];
  if (args && Object.keys(args).length) parts.push(`参数 ${JSON.stringify(args, null, 1)}`);
  if (content) parts.push(`结果 ${content}`);
  setText(body, parts.join('\n') || '（无参数）');
  card.append(body);
  return appendTo(card);
}

export function addConfirmCard({ id, name, description, arguments: args }) {
  const card = el('div', { class: 'confirm-card', dataset: { id } });
  card.append(el('div', { class: 'confirm-card__title' }, [`需要你确认：${name}`]));
  card.append(el('div', { class: 'confirm-card__body' },
    [description || '', '\n参数：', JSON.stringify(args ?? {}, null, 1)].join('')));
  const actions = el('div', { class: 'confirm-card__actions' });
  const reject = el('button', { class: 'ghost-btn' }, ['拒绝']);
  const approve = el('button', { class: 'primary-btn' }, ['允许']);
  approve.addEventListener('click', () => { card.remove(); emit('confirm:answered', { id, approved: true }); });
  reject.addEventListener('click', () => { card.remove(); emit('confirm:answered', { id, approved: false }); });
  actions.append(reject, approve);
  card.append(actions);
  $('#confirm-area')?.append(card);
  return card;
}

function scrollToBottom() {
  const chat = chatRoot();
  if (!chat) return;
  // 用户手动往上翻看历史时不要强行拉回底部
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

/* ---------------- 打字机 ----------------
   状态绑定在具体的 (node, full) 上。任何一步发现「当前状态已不是自己」就立刻退出，
   这样旧气泡的打字机永远不会去改新气泡的文本。
   ---------------------------------------- */

function startTypewriter(node, full) {
  if (typeState && typeState.node === node) {
    typeState.full = full;           // 同一气泡继续追加，沿用已有进度
    return;
  }
  stopTypewriter();
  typeState = { node, full, raf: 0 };
  const step = () => {
    const st = typeState;
    if (!st || st.node !== node) return;          // 气泡已切换，退出
    const shown = (node.textContent || '').length - (caret ? 1 : 0);
    if (shown >= st.full.length) { st.raf = 0; return; }
    const next = st.full.slice(0, Math.min(st.full.length, shown + 2));
    setText(node, next);
    if (caret) node.append(caret);
    scrollToBottom();
    st.raf = requestAnimationFrame(step);
  };
  typeState.raf = requestAnimationFrame(step);
}

function stopTypewriter() {
  if (typeState?.raf) cancelAnimationFrame(typeState.raf);
  typeState = null;
}

/** 用历史记录重建对话区。 */
export function renderHistory(messages) {
  const chat = chatRoot();
  if (!chat) return;
  chat.innerHTML = '';
  if (!messages?.length) {
    chat.append(el('div', { class: 'chat__hint', id: 'chat-hint' },
      ['点右下角麦克风开始说话，或直接打字。首次使用请先在 ⚙ 设置里选模型。']));
    return;
  }
  beginTurn();
  for (const m of messages) {
    if (m.role === 'user') addUserBubble(m.content, m.ts);
    else if (m.role === 'assistant' && m.content) {
      beginAiBubble();
      appendSegment(m.content);
    } else if (m.role === 'tool') {
      addToolCard({ name: m.name || 'tool', content: m.content, ok: true });
    }
  }
  endTurn();
}

/* ================================================================
   设置面板
   ================================================================ */

let providerCache = null;

export function initSettings() {
  initSettingsNav();
  initSettingsSearch();
  initCollapsibles();
  initDrawerResize();
  initDrawerFooter();
  initModelPanel();
  initModulesPanel();
  initAvatarPanel();
  initThemePanel();
  initPersonaPanel();
  initAdvancedPanel();
  bindFieldSync();
}

/* ================================================================
   设置侧栏：左栏导航 / 折叠 / 搜索 / 宽度
   ================================================================ */

/** 由 initSettingsNav 赋值，供搜索跳转复用 */
let activatePane = () => {};
/** 由 initSettingsSearch 赋值，切分类时用来退出搜索态 */
let endSearch = () => {};

function initSettingsNav() {
  const list = $('#drawer-navlist');
  if (!list) return;

  const items = $$('#drawer-navlist .nav-item');

  activatePane = (paneId, { focus = false } = {}) => {
    const btn = items.find((b) => b.dataset.pane === paneId);
    if (!btn) return;

    items.forEach((t) => {
      const on = t === btn;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-current', on ? 'true' : 'false');
    });
    $$('.tabpane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === paneId));

    const title = $('#pane-title');
    const desc = $('#pane-desc');
    if (title) title.textContent = btn.dataset.title || '';
    if (desc) desc.textContent = btn.dataset.desc || '';

    // 折叠着的分类，切回来时把滚动位置重置——否则会停在上次的位置，看着像卡住了
    $('.drawer__body')?.scrollTo({ top: 0 });

    endSearch();

    // 模块页的数据是打开时才拉的，避免启动时白打一次请求
    if (paneId === 'modules' && !$('#module-list')?.dataset.loaded) refreshModulesPanel();

    if (focus) btn.focus();
  };

  list.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.nav-item');
    if (btn) activatePane(btn.dataset.pane);
  });

  // 上下方向键切换分类（原来那排纯文字 tab 完全没有键盘导航）
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const i = items.findIndex((b) => b.classList.contains('is-active'));
    const step = ev.key === 'ArrowDown' ? 1 : items.length - 1;
    activatePane(items[(i + step + items.length) % items.length].dataset.pane, { focus: true });
  });

  $('#btn-settings')?.addEventListener('click', openDrawer);
  $('#btn-close-drawer')?.addEventListener('click', closeDrawer);
  $('#scrim')?.addEventListener('click', closeDrawer);

  activatePane('models');
}

/* ---------------- 折叠：能力卡与分节 ---------------- */

function setCredCollapsed(card, collapsed) {
  card.classList.toggle('is-collapsed', collapsed);
  card.querySelector('.cred-card__head')?.setAttribute('aria-expanded', String(!collapsed));
}

function setSubsecCollapsed(subsec, collapsed) {
  subsec.classList.toggle('is-collapsed', collapsed);
  subsec.querySelector('.subsec__head')?.setAttribute('aria-expanded', String(!collapsed));
}

function initCollapsibles() {
  $$('.cred-card__head').forEach((head) => {
    head.addEventListener('click', () => {
      const card = head.closest('.cred-card');
      const willOpen = card.classList.contains('is-collapsed');
      // 手风琴：同时只展开一张，否则又回到「四张卡全展开、字段铺满几屏」的老样子
      card.parentElement.querySelectorAll(':scope > .cred-card').forEach((c) => {
        setCredCollapsed(c, c !== card || !willOpen);
      });
    });
  });

  $$('.subsec__head').forEach((head) => {
    head.addEventListener('click', () => {
      const sec = head.closest('.subsec');
      setSubsecCollapsed(sec, !sec.classList.contains('is-collapsed'));
    });
  });
}

/* ---------------- 搜索 ---------------- */

/** 取 label 自己的文字：把内部的输入框/下拉项摘掉，否则会把所有 option 文本都算进关键词。 */
function labelOwnText(label) {
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea, canvas, button, svg').forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

/** 补同义词，否则搜「密钥」「key」都找不到「API Key」这种字段名。 */
const SEARCH_ALIAS = {
  'API Key': '密钥 key apikey token 令牌 鉴权 认证',
  '接口地址': 'base url 端点 endpoint 地址 代理 网关',
  '供应商': 'provider 服务商 厂商 模型来源',
  '音色': 'voice 声音 发音人 说话人 嗓音',
  '灵敏度': '阈值 噪声 麦 拾音 收音',
  '说完判定时长': '静音 停顿 句尾 断句 时长',
  '自动断句': 'vad 说完 自动发送 免按 不用点',
  '口型同步': '嘴巴 lipsync 对口型',
  '口型幅度': '张嘴 幅度 lipsync 音量',
  '情绪幅度': '表情 情绪 emotion',
  '视线跟随鼠标': '眼神 目光 lookat 跟随 转头',
  '自动眨眼': '眼睛 blink 眨',
  '皮肤': '主题 换肤 theme 配色 外观',
  '动效强度': '动画 呼吸 流动 motion 特效',
  '气泡字号': '字体 大小 字号 font 文字',
  '打字机效果': '逐字 打字 typewriter',
  '名字': '昵称 persona name 称呼',
  '性格与说话方式': '人格 人设 提示词 persona style',
  '自动播放语音': '出声 发声 外放 autoplay tts 播放',
  '语音模式': '按句 边说边播 speak 流式',
  '运行时检查': '诊断 debug 环境 依赖',
};

function buildSearchIndex() {
  const out = [];

  $$('.tabpane').forEach((pane) => {
    const navBtn = $(`#drawer-navlist .nav-item[data-pane="${pane.dataset.pane}"]`);
    const paneName = navBtn?.dataset.title || pane.dataset.pane;

    const push = (target, text, group = '') => {
      if (!target || !text) return;
      out.push({
        target,
        label: text,
        group,
        pane: pane.dataset.pane,
        paneName,
        hay: `${paneName} ${group} ${text} ${SEARCH_ALIAS[text] || ''}`.toLowerCase(),
      });
    };

    pane.querySelectorAll('label').forEach((label) => {
      const card = label.closest('.cred-card');
      const subsec = label.closest('.subsec');
      const group = card?.querySelector('.cred-card__name')?.textContent.trim()
        || subsec?.querySelector('.subsec__title')?.textContent.trim()
        || '';
      // 聚焦到真正能操作的控件；文件选择框聚焦过去会把系统选择器弹出来，所以排除
      const control = label.querySelector('input:not([type="file"]), select, textarea');
      push(control || label, labelOwnText(label), group);
    });

    // 只有标题的小节（皮肤、导入模型…）也要能被搜到
    pane.querySelectorAll('h3').forEach((h) => push(h, h.textContent.trim()));
  });

  return out;
}

function initSettingsSearch() {
  const input = $('#settings-search');
  const box = $('#search-results');
  const main = $('#drawer-main');
  const list = $('#drawer-navlist');
  if (!input || !box || !main || !list) return;

  const index = buildSearchIndex();

  endSearch = () => {
    input.value = '';
    box.hidden = true;
    box.innerHTML = '';
    main.classList.remove('is-searching');
    list.classList.remove('is-dimmed');
  };

  const jumpTo = (hit) => {
    endSearch();
    activatePane(hit.pane);

    // 目标可能藏在折叠的能力卡 / 分节 / 高级字段里，先逐层打开再滚过去
    const card = hit.target.closest('.cred-card');
    if (card) setCredCollapsed(card, false);
    const subsec = hit.target.closest('.subsec');
    if (subsec) setSubsecCollapsed(subsec, false);
    const adv = hit.target.closest('details');
    if (adv) adv.open = true;

    requestAnimationFrame(() => {
      hit.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      hit.target.focus?.({ preventScroll: true });

      const flash = hit.target.closest('label, .cred-card, .subsec, h3') || hit.target;
      flash.classList.remove('is-flash');
      void flash.offsetWidth;      // 强制重排，让动画能重播
      flash.classList.add('is-flash');
      setTimeout(() => flash.classList.remove('is-flash'), 2400);
    });
  };

  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { endSearch(); return; }

    const hits = index.filter((it) => it.hay.includes(q)).slice(0, 12);
    box.innerHTML = '';
    if (!hits.length) {
      box.append(el('p', { class: 'search-empty' }, [`没有匹配「${input.value.trim()}」的设置项。`]));
    } else {
      for (const hit of hits) {
        const btn = el('button', {
          class: 'search-result',
          type: 'button',
          onclick: () => jumpTo(hit),
        }, [
          el('span', { class: 'search-result__path' }, [hit.group ? `${hit.paneName} · ${hit.group}` : hit.paneName]),
          el('span', { class: 'search-result__label' }, [hit.label]),
        ]);
        box.append(btn);
      }
    }
    box.hidden = false;
    main.classList.add('is-searching');
    list.classList.add('is-dimmed');
  };

  input.addEventListener('input', run);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { endSearch(); input.blur(); }
    if (ev.key === 'Enter') $('.search-result', box)?.click();
    if (ev.key === 'ArrowDown') { ev.preventDefault(); $('.search-result', box)?.focus(); }
  });
}

/* ---------------- 侧栏宽度：拖左边缘 / 双击复位 ---------------- */

function cssPx(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function initDrawerResize() {
  const handle = $('#drawer-resizer');
  const drawer = $('#drawer');
  if (!handle || !drawer) return;

  let currentW = Number(getIn('ui.drawerW', 640)) || 640;

  const apply = (w) => {
    currentW = Math.round(w);
    document.documentElement.style.setProperty('--drawer-w', `${currentW}px`);
  };
  apply(currentW);

  let startX = 0;
  let startW = 0;
  let dragging = false;

  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();          // 否则拖动过程中会把页面文字一起选中
    dragging = true;
    startX = ev.clientX;
    startW = currentW;
    drawer.classList.add('is-resizing');
    handle.classList.add('is-active');
    handle.setPointerCapture(ev.pointerId);
  });

  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const min = cssPx('--drawer-w-min', 460);
    // 右边至少要留住舞台 + 对话，否则调宽会把它们挤没
    const max = Math.max(min, window.innerWidth - cssPx('--panel-w', 460) - cssPx('--stage-min', 320));
    const next = Math.min(Math.max(startW + (startX - ev.clientX), min), max);
    apply(next);
  });

  const stop = (ev) => {
    if (!dragging) return;
    dragging = false;
    drawer.classList.remove('is-resizing');
    handle.classList.remove('is-active');
    handle.releasePointerCapture?.(ev.pointerId);
    setIn('ui.drawerW', currentW);
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);

  handle.addEventListener('dblclick', () => {
    apply(640);
    setIn('ui.drawerW', currentW);
  });
}

/* ---------------- 底部：恢复默认 / 重连后端 ---------------- */

function initDrawerFooter() {
  const reset = $('#btn-reset-settings');
  if (reset) {
    let armed = false;
    let disarmTimer = 0;
    reset.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        reset.classList.add('is-armed');
        reset.textContent = '再点一次确认';
        disarmTimer = setTimeout(() => {
          armed = false;
          reset.classList.remove('is-armed');
          reset.textContent = '恢复默认';
        }, 4000);
        return;
      }
      clearTimeout(disarmTimer);
      resetAll();
      location.reload();
    });
  }

  // 密钥只在建连时读一次，所以「改完不生效」是必然的 —— 得有个按钮让它立刻生效
  $('#btn-reconnect')?.addEventListener('click', () => emit('ui:reconnect'));
}

export function openDrawer() {
  $('#drawer')?.classList.add('is-open');
  $('#drawer')?.setAttribute('aria-hidden', 'false');
  $('#app')?.classList.add('is-drawer-open');
  const scrim = $('#scrim');
  if (scrim) scrim.hidden = false;
}

export function closeDrawer() {
  $('#drawer')?.classList.remove('is-open');
  $('#drawer')?.setAttribute('aria-hidden', 'true');
  $('#app')?.classList.remove('is-drawer-open');
  const scrim = $('#scrim');
  if (scrim) scrim.hidden = true;
}

/* ---------------- 模型（供应商与密钥） ---------------- */

async function initModelPanel() {
  await loadProviders();

  // 每个能力卡片里的下拉框绑定
  for (const cap of CAPS) {
    const card = $(`.cred-card[data-cap="${cap}"]`);
    if (!card) continue;

    card.addEventListener('input', (ev) => {
      const field = ev.target.dataset.field;
      if (!field) return;
      setIn(`providers.${cap}.${field}`, ev.target.value);
      markCredState(cap);
      markDirty();
    });

    card.querySelector('select[data-field="provider"]')?.addEventListener('change', (ev) => {
      // 换供应商时自动带出它的默认接口地址与模型（用户可再改）
      const spec = providerCache?.[cap]?.find((p) => p.id === ev.target.value);
      const baseInput = card.querySelector('input[data-field="base_url"]');
      const modelInput = card.querySelector('input[data-field="model"]');
      if (spec?.base_url && baseInput && !baseInput.value) {
        baseInput.value = spec.base_url;
        setIn(`providers.${cap}.base_url`, spec.base_url);
      }
      if (spec?.default_model && modelInput && !modelInput.value) {
        modelInput.placeholder = `留空用 ${spec.default_model}`;
      }
      markCredState(cap);
      markDirty();
    });

    markCredState(cap);
  }

  $('#key-warning').textContent = anyKeyStored()
    ? '注意：密钥以明文存在本机 localStorage，同机其他程序理论上可读；自用可以，给别人用请改成后端加密存储。'
    : '';

  $('#btn-test')?.addEventListener('click', testConnections);
}

export async function loadProviders() {
  try {
    const resp = await fetch('/api/providers');
    providerCache = await resp.json();
  } catch (e) {
    toast('读取供应商清单失败，后端可能没起来', 'err');
    return;
  }
  for (const cap of CAPS) {
    const select = $(`.cred-card[data-cap="${cap}"] select[data-field="provider"]`);
    if (!select) continue;
    const current = getIn(`providers.${cap}.provider`, '');
    select.innerHTML = '';
    select.append(el('option', { value: '' }, ['（用服务端默认）']));
    for (const spec of providerCache[cap] ?? []) {
      const label = spec.local ? `${spec.label}` : spec.label;
      select.append(el('option', { value: spec.id }, [label]));
    }
    select.value = current;
  }
}

function markCredState(cap) {
  const node = $(`.cred-state[data-state-for="${cap}"]`);
  if (!node) return;
  const s = credSummary(cap);
  node.textContent = s.provider + (s.hasKey ? ' · 已填密钥' : (s.configured ? ' · 无密钥' : ''));
  node.dataset.ok = String(!!s.configured);
}

/**
 * 设置在输入时就已写进 localStorage，不存在「忘记保存」这回事。
 * 所以这里不再是弹 toast（每次改都弹一下太吵），而是把右上角的状态徽章点亮一下 ——
 * 反馈还在，噪音没了。至于「要重连才生效」，那句话说一次就够了：它印在底部操作栏上。
 */
let saveStateTimer = 0;

const markDirty = debounce(() => {
  const node = $('#save-state');
  if (!node) return;
  node.dataset.state = 'flash';
  node.textContent = '已保存';
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    node.dataset.state = 'idle';
    node.textContent = '改完自动保存';
  }, 1600);
}, 500);

/**
 * 「测试连接」——**真的去调一次你的 LLM**。
 *
 * 早先这个按钮只检查后端进程与本机能力（ffmpeg / Cubism 之类），压根不碰你填的配置，
 * 于是会出现「测试连接一切正常，发消息却报密钥无效」这种自相矛盾的体验 ——
 * 那是我把「环境自检」和「配置验证」混成了一个按钮。
 * 配置类问题必须用真实调用验，否则测了个寂寞。
 */
async function testConnections() {
  const box = $('#test-log');
  if (!box) return;
  box.hidden = false;
  box.textContent = '正在测试…';
  const lines = [];

  // ---- 1) 真实调用 LLM（最重要，放最前面）----
  const llm = getIn('providers.llm', {}) || {};
  lines.push('━━ 大脑（LLM）真实调用测试 ━━');
  try {
    const resp = await fetch('/api/llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: llm.provider || '', model: llm.model || '',
        base_url: llm.base_url || '', key: llm.key || '',
      }),
    });
    const r = await resp.json().catch(() => ({}));
    const res = r.resolved || {};
    lines.push(`结果：${r.ok ? '✅ 成功' : '❌ 失败'}${r.ms != null ? `（${r.ms}ms）` : ''}`);
    // 回显「实际会用什么」：这是排查配置类问题最关键的信息
    lines.push(`  实际使用 →  供应商 ${res.provider || '?'} / 模型 ${res.model || '?'}`);
    lines.push(`  接口地址 →  ${res.base_url || '(未设置)'}`);
    lines.push(`  密钥 →      ${res.has_key ? `已生效（${res.key_hint}，来源：${
      res.key_source === 'user' ? '你填的' : res.key_source === 'server' ? '服务端 .env' : '—'}）` : '⚠ 没有拿到'}`);
    if (r.reply) lines.push(`  模型回了 →  ${JSON.stringify(r.reply)}`);
    if (r.message) lines.push(`  说明 →      ${r.message}`);
  } catch (e) {
    lines.push(`❌ 请求失败：${e.message}`);
  }

  // ---- 2) 前端本地配置概览 ----
  lines.push('');
  lines.push('━━ 你在网页里填的配置 ━━');
  for (const cap of CAPS) {
    const s = credSummary(cap);
    lines.push(`  ${CAP_LABEL[cap]}(${cap}) → ${s.provider}${s.model ? ' / ' + s.model : ''}${s.hasKey ? ' / 密钥已填' : ''}`);
  }

  // ---- 3) 后端与本机能力（环境自检，与配置无关）----
  lines.push('');
  lines.push('━━ 环境自检（与你的配置无关）━━');
  try {
    const h = await (await fetch('/api/health')).json();
    lines.push(`  后端在线：v${h.version}`);
    const rt = await (await fetch('/api/runtime')).json();
    lines.push(`  本机能力：${Object.entries(rt.ready).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join('  ')}`);
    if (!rt.ready.ffmpeg) lines.push('  提示：未装 ffmpeg —— 本机 ASR/TTS 与音频后处理不可用（云端链路不受影响）');
  } catch (e) {
    lines.push(`  后端不可达：${e.message}`);
  }

  lines.push('');
  lines.push('提示：改完密钥后请刷新页面。连接参数只在建立连接时读取一次，');
  lines.push('不重连的话新密钥不会生效（表现为「明明填了却说没填」）。');
  box.textContent = lines.join('\n');
}

/* ---------------- 形象 ---------------- */

function initAvatarPanel() {
  const c = getConfig().avatar;

  // ---- 自动断句（VAD）----
  const chkAuto = $('#chk-auto-vad');
  if (chkAuto) {
    chkAuto.checked = getIn('voiceInput.auto', true);
    chkAuto.addEventListener('change', () => {
      setIn('voiceInput.auto', chkAuto.checked);
      emit('ui:vad-option', { key: 'auto', value: chkAuto.checked });
    });
  }

  const rngThr = $('#rng-vad-threshold');
  if (rngThr) {
    rngThr.value = getIn('voiceInput.thresholdFactor', 3.2);
    rngThr.addEventListener('input', () => {
      const v = Number(rngThr.value);
      setIn('voiceInput.thresholdFactor', v);
      emit('ui:vad-option', { key: 'thresholdFactor', value: v });
    });
  }

  const rngSil = $('#rng-vad-silence');
  if (rngSil) {
    rngSil.value = getIn('voiceInput.silenceMs', 900);
    rngSil.addEventListener('input', () => {
      const v = Number(rngSil.value);
      setIn('voiceInput.silenceMs', v);
      emit('ui:vad-option', { key: 'silenceMs', value: v });
    });
  }

  const chkLip = $('#chk-lipsync');
  chkLip.checked = c.lipsync;
  chkLip.addEventListener('change', () => emit('ui:avatar-option', { key: 'lipsync', value: chkLip.checked }));

  const chkLook = $('#chk-lookat');
  chkLook.checked = c.lookAt;
  chkLook.addEventListener('change', () => emit('ui:avatar-option', { key: 'lookAt', value: chkLook.checked }));

  const chkBlink = $('#chk-blink');
  chkBlink.checked = c.blink;
  chkBlink.addEventListener('change', () => emit('ui:avatar-option', { key: 'blink', value: chkBlink.checked }));

  const rngMouth = $('#rng-mouth');
  rngMouth.value = c.mouthGain;
  rngMouth.addEventListener('input', () => emit('ui:avatar-option', { key: 'mouthGain', value: Number(rngMouth.value) }));

  const rngEmotion = $('#rng-emotion');
  rngEmotion.value = c.emotionGain;
  rngEmotion.addEventListener('input', () => emit('ui:avatar-option', { key: 'emotionGain', value: Number(rngEmotion.value) }));

  initModelImport();
}

/* ================================================================
   模型导入（拖入 / 选择文件夹 → 落盘到 assets/models/）
   ================================================================ */

/**
 * 从 drop 事件里取出「带目录结构」的文件列表。
 *
 * 为什么不能用 `e.dataTransfer.files`：拖入**文件夹**时它只给一个零字节的
 * "directory" 占位项，拿不到里面的任何文件。必须走 webkitGetAsEntry 递归遍历。
 * 这是"拖文件夹进来却什么都没发生"这类问题的唯一正解。
 *
 * 导出它也是为了能在控制台手工喂数据调试：ui.importModelEntries([{file, rel}])。
 */
export async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt?.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) {
    // 老浏览器/拖的是纯文件：退化成普通 FileList
    return Array.from(dt?.files ?? []).map((f) => ({ file: f, rel: f.name }));
  }

  const readDir = (dirEntry) => new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const all = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(all); return; }
      all.push(...batch);
      step();   // 某些浏览器一次只给 100 条，必须反复读到空
    }, () => resolve(all));
    step();
  });

  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) out.push({ file, rel: prefix + entry.name });
      return;
    }
    if (entry.isDirectory) {
      const kids = await readDir(entry);
      for (const k of kids) await walk(k, `${prefix}${entry.name}/`);
    }
  };

  for (const e of entries) await walk(e, '');
  return out;
}

/** 递归遍历完的文件里，挑出模型相关文件并给出概览。 */
function summarizePicked(entries) {
  const MODEL_RE = /\.(model3?\.json|moc3?|png|jpe?g|webp|motion3?\.json|exp3?\.json|physics3?\.json|pose3?\.json|cdi3\.json)$/i;
  const picked = entries.filter((e) => MODEL_RE.test(e.file.name));
  const manifests = picked.filter((e) => /\.model3?\.json$/i.test(e.file.name));
  return { picked, manifests, bytes: picked.reduce((a, e) => a + e.file.size, 0) };
}

function setImportProgress(show, ratio, text) {
  const wrap = $('#import-progress');
  const fill = $('#import-progress-fill');
  const label = $('#import-progress-text');
  if (!wrap) return;
  wrap.hidden = !show;
  if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  if (label && text != null) label.textContent = text;
}

function showImportResult(text) {
  const box = $('#import-result');
  if (!box) return;
  box.hidden = false;
  box.textContent = text;
}

/** 文件 → base64（分块，避免大文件把调用栈撑爆）。 */
async function fileToB64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function importModelEntries(entries, { overwrite = true } = {}) {
  const { picked, manifests, bytes } = summarizePicked(entries);
  if (!picked.length) {
    showImportResult(
      '❌ 没找到模型文件。\n'
      + '需要至少包含一个 *.model3.json（Cubism 3/4/5）或 *.model.json（Cubism 2），\n'
      + '以及对应的 .moc3/.moc 与贴图。\n'
      + `这次拖入的 ${entries.length} 个文件里没有匹配项。`,
    );
    return null;
  }

  const groups = new Set(picked.map((e) => (e.rel.includes('/') ? e.rel.split('/')[0] : '(根目录)')));
  showImportResult(
    `准备导入：${picked.length} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MB\n`
    + `识别到模型清单 ${manifests.length} 个（${manifests.map((m) => m.file.name).join('、') || '无'}）\n`
    + `将导入为 ${groups.size} 个目录：${[...groups].join('、')}`,
  );

  setImportProgress(true, 0.05, '读取文件…');
  const payload = [];
  let done = 0;
  for (const e of picked) {
    // 去掉顶层目录名：后端按第一段目录分组，顶层名保留与否不影响结果，
    // 但去掉后目录结构更干净（assets/models/<模型名>/...）
    const rel = e.rel.includes('/') ? e.rel.split('/').slice(1).join('/') : e.rel;
    payload.push({ path: rel, data: await fileToB64(e.file) });
    done++;
    setImportProgress(true, 0.05 + 0.65 * (done / picked.length),
      `打包中 ${done}/${picked.length}：${e.file.name}`);
  }

  setImportProgress(true, 0.75, '写入项目目录…');
  const resp = await fetch('/api/models/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: payload, overwrite }),
  });
  const obj = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setImportProgress(false, 0, '');
    showImportResult(`❌ 导入失败：${obj.detail || `HTTP ${resp.status}`}`);
    return null;
  }

  setImportProgress(true, 1, '完成');
  const list = (obj.imported || []).map(
    (m) => `  · ${m.name}（${m.format === 'cubism2' ? 'Cubism 2' : 'Cubism 3/4/5'}，${m.dir}）`,
  ).join('\n');
  showImportResult(
    `✅ 导入完成：${obj.saved} 个文件写入 ${(obj.dirs || []).join('、')}\n`
    + (list ? `识别到模型：\n${list}\n` : '')
    + (obj.skipped ? `跳过 ${obj.skipped} 个（类型不允许或已存在）\n` : '')
    + '下面列表里点「使用」即可切换。',
  );
  setTimeout(() => setImportProgress(false, 0, ''), 1200);

  emit('model:imported', obj);
  await refreshAvatarPanel();
  return obj;
}

function initModelImport() {
  const zone = $('#drop-zone');
  const input = $('#model-files');
  const pickBtn = $('#btn-pick-model');
  const zoneText = $('#drop-zone-text');

  if (input) {
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      // webkitdirectory 模式下 webkitRelativePath 自带目录结构
      await importModelEntries(files.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })));
      input.value = '';   // 允许重复导入同一个文件夹
    });
  }

  pickBtn?.addEventListener('click', () => input?.click());

  ['dragenter', 'dragover'].forEach((t) => zone?.addEventListener(t, (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('is-over');
    if (zoneText) zoneText.textContent = '松开即可导入';
  }));
  ['dragleave', 'drop'].forEach((t) => zone?.addEventListener(t, (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('is-over');
    if (zoneText) zoneText.textContent = '把模型文件夹拖到这里';
  }));

  zone?.addEventListener('drop', async (e) => {
    const entries = await filesFromDataTransfer(e.dataTransfer);
    if (!entries.length) {
      showImportResult('❌ 没读到任何文件。试试用下面的「选择文件夹…」按钮。');
      return;
    }
    await importModelEntries(entries);
  });

  // 空状态里的两个入口：
  //   ① 按钮 → 同一个隐藏的 file input
  //   ② 直接把文件夹拖到舞台/空状态区域 → 走同一套导入流程
  // 不接上的话，那块空状态就只是个提示牌，按钮是个摆设。
  $('#btn-empty-import')?.addEventListener('click', () => input?.click());

  const stage = $('#stage');
  const emptyBox = $('#avatar-empty');
  ['dragenter', 'dragover'].forEach((t) => stage?.addEventListener(t, (e) => {
    e.preventDefault();
    emptyBox?.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((t) => stage?.addEventListener(t, (e) => {
    e.preventDefault();
    emptyBox?.classList.remove('is-over');
  }));
  stage?.addEventListener('drop', async (e) => {
    if (e.target.closest?.('#drop-zone')) return;   // 设置面板里那个已经处理过
    const entries = await filesFromDataTransfer(e.dataTransfer);
    if (!entries.length) return;
    await importModelEntries(entries);
  });

  // 整页拖入也接住，避免浏览器直接打开文件把页面替换掉
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (e.target.closest?.('#drop-zone') || e.target.closest?.('#stage')) return;
    e.preventDefault();
  });
}

export async function refreshAvatarPanel() {
  const list = $('#model-list');
  if (!list) return;
  list.innerHTML = '<p class="note">正在探测…</p>';
  try {
    const data = await (await fetch('/api/models/live2d')).json();
    list.innerHTML = '';
    if (!data.cubism_core_ready) {
      list.append(el('p', { class: 'note warn' },
        ['未检测到 Cubism Core（assets/cubism/live2dcubismcore.min.js）。它来自官方 SDK 的 Core 目录，放进去后刷新页面。']));
    }
    if (!data.models?.length) {
      list.append(el('p', { class: 'note' },
        ['assets/models/ 下还没有模型。用下面的「导入模型」拖入文件夹，或跑 tools/fetch_sample_model.py 拿官方示例。']));
    }
    const current = getIn('avatar.model', '');
    for (const m of data.models) {
      const fmtLabel = m.format === 'cubism2' ? 'Cubism 2' : 'Cubism 3/4/5';
      const item = el('div', { class: 'list-item' }, [
        el('span', {}, [m.name]),
        el('span', { class: 'list-item__meta' }, [
          `${fmtLabel} · ${(Number(m.size || 0) / 1024 / 1024).toFixed(1)} MB`,
        ]),
      ]);
      const btn = el('button', { class: current === m.path ? 'primary-btn' : 'ghost-btn' },
        [current === m.path ? '使用中' : '使用']);
      btn.addEventListener('click', () => {
        setIn('avatar.model', m.path);
        emit('ui:load-model', { path: m.path, format: m.format });
        refreshAvatarPanel();
      });
      item.append(btn);
      list.append(item);
    }

    // 关键：有模型可用时，必须撤掉「还没有可用的模型」那句引导。
    // 否则会出现这种自相矛盾的界面 —— 列表里明明躺着 3 个模型，
    // 左边的空状态却让用户「把模型文件放进来」。实测让使用者以为是自己文件放错了。
    const box = $('#avatar-empty');
    const mode = $('#avatar-container')?.dataset.mode;
    if (box && mode === 'live2d') {
      box.hidden = true;                       // 形象已经在渲染，这张卡没有存在意义
    } else if (box && data.models?.length) {
      // 有模型但还没进入渲染：说明是渲染链路的问题，不是缺文件
      const titleEl = box.querySelector('.avatar-empty__title');
      const detailEl = box.querySelector('.avatar-empty__detail');
      if (titleEl) titleEl.textContent = '模型已就位，等待渲染';
      if (detailEl) {
        detailEl.textContent = `检测到 ${data.models.length} 个模型。在下面列表里点「使用」切换；`
          + '如果点完仍然看不到形象，那是渲染链路的问题（详见 docs/roadmap.md「已知未验证」），不是你的文件有问题。';
      }
      box.hidden = false;
    }
  } catch (e) {
    list.innerHTML = '';
    list.append(el('p', { class: 'note warn' }, [`探测失败：${e.message}`]));
  }

  const box = $('#runtime-box');
  if (box) {
    try {
      const rt = await (await fetch('/api/runtime')).json();
      box.textContent = Object.entries(rt.ready)
        .map(([k, v]) => `${v ? '✓' : '✗'} ${k}`)
        .join('\n');
    } catch {
      box.textContent = '后端不可达';
    }
  }
}

/* ---------------- 把模型存进项目 ---------------- */

/**
 * 把用户拖入的模型文件存到 assets/models/<目录名>/。
 *
 * 为什么要有这一步：纯浏览器本地加载每次刷新都要重新拖一遍文件，调试很烦。
 * 存进项目后，/api/models/live2d 会自动发现它，以后打开就在列表里。
 */
export async function uploadModelFiles(files, dirname) {
  const list = Array.from(files || []);
  const pick = list.filter((f) => /\.(json|moc3|png|jpg|jpeg|webp|txt)$/i.test(f.name));
  if (!pick.length) throw new Error('没有找到 moc3/json/贴图文件');

  // 目录名：优先用文件夹名，其次用 model3.json 的名字
  const modelJson = pick.find((f) => f.name.endsWith('.model3.json'));
  const derived = dirname
    || (pick[0].webkitRelativePath || '').split('/')[0]
    || (modelJson ? modelJson.name.replace('.model3.json', '') : 'model');

  const payload = [];
  let total = 0;
  for (const f of pick) {
    if (f.size > 32 * 1024 * 1024) throw new Error(`${f.name} 超过 32MB 单文件上限`);
    total += f.size;
    if (total > 200 * 1024 * 1024) throw new Error('这一包模型总大小超过 200MB 上限，请精简贴图');
    const buf = await f.arrayBuffer();
    // 大文件分块转 base64，一次 apply 会爆栈
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    payload.push({
      path: (f.webkitRelativePath || f.name).replace(/^[^/]+\//, ''),  // 去掉顶层目录名
      data: btoa(binary),
    });
  }

  const resp = await fetch('/api/models/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirname: derived, files: payload, overwrite: true }),
  });
  const obj = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(obj.detail || obj.message || `HTTP ${resp.status}`);
  emit('model:uploaded', obj);
  await refreshAvatarPanel();
  return obj;
}

/* ================================================================
   模块面板：架构视图 + 自定义模块接入
   ================================================================ */

/** 各能力的 JSON 模板。用户点「填入模板」时自动带上，省得从零写。 */
const DRAFT_TEMPLATES = {
  llm: {
    cap: 'llm', id: 'my-brain', label: '我自己的大脑',
    protocol: 'generic-http',
    base_url: 'https://your-server.com/v1',
    default_model: 'your-model',
    request: {
      url: '{base_url}/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      json: { model: '{model}', messages: '{messages}', stream: true, temperature: '{temperature}' },
    },
    chunk_text_path: 'choices.0.delta.content',
    response: { text_path: 'choices.0.message.content' },
  },
  vlm: {
    cap: 'vlm', id: 'my-eyes', label: '我自己的视觉',
    protocol: 'generic-http',
    base_url: 'https://your-server.com/v1',
    default_model: 'your-vl-model',
    request: {
      url: '{base_url}/chat/completions',
      method: 'POST',
      json: {
        model: '{model}',
        messages: [{ role: 'user', content: [
          { type: 'text', text: '{prompt}' },
          { type: 'image_url', image_url: { url: '{image}' } },
        ] }],
      },
    },
    response: { text_path: 'choices.0.message.content' },
  },
  asr: {
    cap: 'asr', id: 'my-ears', label: '我自己的识别',
    protocol: 'generic-http',
    base_url: 'https://your-server.com/v1',
    default_model: 'whisper-1',
    request: {
      url: '{base_url}/audio/transcriptions',
      method: 'POST',
      asr_mode: 'multipart',
      file_field: 'file',
      form: { model: '{model}' },
    },
    response: { text_path: 'text' },
  },
  tts: {
    cap: 'tts', id: 'my-voice', label: '我自己的嗓音',
    protocol: 'generic-http',
    base_url: 'https://your-server.com/v1',
    default_model: 'tts-1',
    request: {
      url: '{base_url}/audio/speech',
      method: 'POST',
      json: { model: '{model}', input: '{text}', voice: '{voice}' },
    },
    response: { audio_path: '' },
  },
};

let archCatalog = null;

function initModulesPanel() {
  const capSel = $('#cm-cap');
  const jsonArea = $('#cm-json');
  if (!capSel || !jsonArea) return;

  const putDraft = (cap) => {
    jsonArea.value = JSON.stringify(DRAFT_TEMPLATES[cap] || {}, null, 2);
  };

  $('#btn-cm-template')?.addEventListener('click', () => putDraft(capSel.value));
  capSel.addEventListener('change', () => {
    // 只在用户没改过内容时自动换模板，避免覆盖人家正在编辑的配置
    const cur = jsonArea.value.trim();
    const isTemplate = Object.values(DRAFT_TEMPLATES).some(
      (t) => cur === JSON.stringify(t, null, 2).trim()
    );
    if (!cur || isTemplate) putDraft(capSel.value);
  });

  $('#btn-cm-probe')?.addEventListener('click', async () => {
    const draft = parseDraft(jsonArea, $('#cm-result'));
    if (!draft) return;
    await callModulesProbe({ probe_draft: true, draft, key: $('#cm-key').value }, $('#cm-result'));
  });

  $('#btn-cm-save')?.addEventListener('click', async () => {
    const draft = parseDraft(jsonArea, $('#cm-result'));
    if (!draft) return;
    const box = $('#cm-result');
    showBox(box, '保存中…');
    try {
      const resp = await fetch('/api/modules/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const obj = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        showBox(box, `❌ 保存失败\n${obj.detail || JSON.stringify(obj, null, 2)}`);
        return;
      }
      showBox(box, `✅ 已保存：${draft.cap}/${draft.id}\n${obj.hint || ''}`);
      await refreshModulesPanel();
      await loadProviders();   // 让「模型」页的下拉立刻能看到它
    } catch (e) {
      showBox(box, `❌ ${e.message}`);
    }
  });

  // 首次打开面板时再拉数据（避免启动时多打一次请求）
  // —— 这个时机现在由 activatePane 负责，不再单独监听导航点击
}

function parseDraft(area, box) {
  try {
    const obj = JSON.parse(area.value);
    if (!obj || typeof obj !== 'object') throw new Error('顶层必须是对象');
    return obj;
  } catch (e) {
    showBox(box, `❌ JSON 解析失败：${e.message}\n\n提示：不要用单引号、不要留尾逗号。`);
    return null;
  }
}

function showBox(box, text) {
  if (!box) return;
  box.hidden = false;
  box.textContent = text;
}

async function callModulesProbe(payload, box) {
  showBox(box, '探测中…');
  try {
    const resp = await fetch('/api/modules/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const obj = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showBox(box, `❌ 探测被拒：${obj.detail || JSON.stringify(obj)}`);
      return null;
    }
    const lines = [
      obj.ok ? '✅ 探测通过' : '❌ 探测未通过',
      `状态码：${obj.status ?? '—'}　耗时：${obj.ms ?? '—'}ms`,
    ];
    if (obj.message) lines.push(`原因：${obj.message}`);
    if (obj.note) lines.push(`说明：${obj.note}`);
    if (obj.problems?.length) lines.push(`配置问题：${obj.problems.join('；')}`);
    showBox(box, lines.join('\n'));
    return obj;
  } catch (e) {
    showBox(box, `❌ ${e.message}`);
    return null;
  }
}

export async function refreshModulesPanel() {
  const layersBox = $('#arch-layers');
  const contractBox = $('#arch-contracts');
  const moduleBox = $('#module-list');
  const savedBox = $('#cm-saved');
  if (!layersBox) return;

  try {
    archCatalog = await (await fetch('/api/modules/catalog')).json();
  } catch (e) {
    layersBox.innerHTML = '';
    layersBox.append(el('p', { class: 'note warn' }, [`读取失败：${e.message}`]));
    return;
  }

  // ---- 分层 ----
  layersBox.innerHTML = '';
  for (const layer of archCatalog.layers || []) {
    layersBox.append(el('div', { class: 'arch-layer' }, [
      el('span', { class: 'arch-layer__name' }, [layer.name]),
      el('span', { class: 'arch-layer__role' }, [layer.role]),
      el('span', { class: 'arch-layer__dir' }, [layer.dir]),
    ]));
  }

  // ---- 能力契约 ----
  contractBox.innerHTML = '';
  for (const [cap, info] of Object.entries(archCatalog.capabilities || {})) {
    const c = info.contract;
    const card = el('div', { class: 'contract-card' });
    card.append(el('div', { class: 'contract-card__title' }, [`${c.label}（${cap}）`]));
    card.append(el('div', {}, [c.summary]));
    card.append(el('div', {}, [
      el('code', {}, [`入：${c.input_shape}`]),
      el('code', {}, [`出：${c.output_shape}`]),
    ]));
    if (c.rules?.length) {
      const ul = el('ul');
      for (const r of c.rules) ul.append(el('li', {}, [r]));
      card.append(ul);
    }
    contractBox.append(card);
  }

  // ---- 模块清单（按能力分组） ----
  moduleBox.innerHTML = '';
  for (const [cap, info] of Object.entries(archCatalog.capabilities || {})) {
    const group = el('div', { class: 'module-card' });
    group.append(el('div', { class: 'module-card__head' }, [
      el('strong', {}, [`${info.contract.label} · ${info.modules.length} 个实现`]),
    ]));
    moduleBox.append(group);
    for (const m of info.modules) {
      const card = el('div', {
        class: 'module-card',
        dataset: { origin: m.origin, local: String(!!m.local) },
      });
      const head = el('div', { class: 'module-card__head' }, [
        el('span', {}, [m.label]),
        el('span', { class: 'module-card__id' }, [m.id]),
      ]);
      card.append(head);
      const notes = el('div', { class: 'module-card__notes' });
      notes.append(el('span', { class: 'chip chip--info' }, [m.protocol]));
      if (m.origin === 'custom') notes.append(el('span', { class: 'chip chip--warn' }, ['自定义']));
      if (m.local) notes.append(el('span', { class: 'chip chip--ok' }, ['本机']));
      if (!m.needs_key) notes.append(el('span', { class: 'chip' }, ['免密钥']));
      card.append(notes);
      if (m.protocol_hint) card.append(el('div', { class: 'module-card__desc' }, [m.protocol_hint]));
      moduleBox.append(card);
    }
  }

  // ---- 已保存的自定义模块（可删） ----
  if (savedBox) {
    savedBox.innerHTML = '';
    const customs = archCatalog.custom || [];
    if (!customs.length) {
      savedBox.append(el('p', { class: 'note' }, ['还没有自定义模块']));
    }
    for (const m of customs) {
      const item = el('div', { class: 'list-item' }, [
        el('span', {}, [`${m.cap} / ${m.label}`]),
        el('span', { class: 'list-item__meta' }, [m.id]),
      ]);
      const btn = el('button', { class: 'ghost-btn' }, ['删除']);
      btn.addEventListener('click', async () => {
        const r = await fetch(`/api/modules/custom/${encodeURIComponent(m.cap)}/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
        if (r.ok) {
          emit('modules:changed', { removed: `${m.cap}/${m.id}` });
          await refreshModulesPanel();
          await loadProviders();
        } else {
          emit('modules:error', { message: '删除失败' });
        }
      });
      item.append(btn);
      savedBox.append(item);
    }
    if (archCatalog.store_path) {
      savedBox.append(el('p', { class: 'note' }, [`配置文件：${archCatalog.store_path}（密钥不会写进这里）`]));
    }
  }
  if (moduleBox) moduleBox.dataset.loaded = '1';
}

/* ---------------- 界面（换肤） ---------------- */

function initThemePanel() {
  const grid = $('#theme-grid');
  if (grid) {
    grid.innerHTML = '';
    const active = getIn('ui.theme', 'starlight');
    for (const t of THEMES) {
      const card = el('button', { class: `theme-card${t.id === active ? ' is-active' : ''}`, dataset: { theme: t.id } });
      const sw = el('div', { class: 'theme-card__swatches' });
      for (const color of t.swatches) sw.append(el('i', { style: { background: color } }));
      card.append(sw, el('span', { class: 'theme-card__name' }, [t.name]));
      card.addEventListener('click', () => {
        applyTheme(t.id);
        $$('#theme-grid .theme-card').forEach((c) => c.classList.toggle('is-active', c === card));
        emit('ui:theme-changed', { id: t.id });
      });
      grid.append(card);
    }
  }

  const rngMotion = $('#rng-motion');
  rngMotion.value = getIn('ui.motion', 1);
  rngMotion.addEventListener('input', () => applyMotionScale(rngMotion.value));

  const chkReduce = $('#chk-reduce-motion');
  chkReduce.checked = getIn('ui.reduceMotion', false);
  chkReduce.addEventListener('change', () => {
    document.documentElement.style.setProperty('--motion-scale', chkReduce.checked ? '0.001' : String(rngMotion.value));
    setIn('ui.reduceMotion', chkReduce.checked);
  });

  const chkType = $('#chk-typewriter');
  chkType.checked = getIn('ui.typewriter', true);
  chkType.addEventListener('change', () => setIn('ui.typewriter', chkType.checked));

  const chkTools = $('#chk-show-tools');
  chkTools.checked = getIn('ui.showTools', true);
  chkTools.addEventListener('change', () => setIn('ui.showTools', chkTools.checked));

  const rngFont = $('#rng-fontsize');
  rngFont.value = getIn('ui.fontSize', 15);
  rngFont.addEventListener('input', () => applyFontSize(rngFont.value));

  const skinInput = $('#skin-url');  skinInput.value = getIn('ui.skin', '');
  $('#btn-load-skin')?.addEventListener('click', async () => {
    const url = skinInput.value.trim();
    if (!url) return toast('先填一个皮肤脚本路径', 'warn');
    const skin = await loadSkin(url);
    toast(skin ? `皮肤已加载：${skin.name || skin.id}` : '皮肤加载失败，看控制台', skin ? 'ok' : 'err');
  });
  $('#btn-unload-skin')?.addEventListener('click', async () => {
    const had = currentSkin().id;
    await unloadSkin();
    toast(had ? '皮肤已卸载' : '当前没有挂载皮肤', had ? 'ok' : 'info');
  });
}

/* ---------------- 人格 ---------------- */

function initPersonaPanel() {
  const nameInput = $('#persona-name');
  const styleInput = $('#persona-style');
  const c = getConfig().persona;
  nameInput.value = c.name;
  styleInput.value = c.style;

  nameInput.addEventListener('input', () => { patch({ persona: { name: nameInput.value } }); markDirty(); });
  styleInput.addEventListener('input', () => { patch({ persona: { style: styleInput.value } }); markDirty(); });

  const chkAuto = $('#chk-autoplay');
  if (chkAuto) {
    chkAuto.checked = getIn('voice.autoplay', false);
    chkAuto.addEventListener('change', () => {
      patch({ voice: { autoplay: chkAuto.checked } });
      // 注意：发给后端的字段名是 tts_enabled，不是 autoplay。
      // autoplay 是前端的「要不要放出来」，tts_enabled 是后端的「要不要合成」；
      // 早先把 autoplay 直接发过去，后端不认识这个字段→配置没生效→勾了也没声音。
      emit('ui:voice-option', { key: 'tts_enabled', value: chkAuto.checked });
      emit('voice:autoplay-changed', { value: chkAuto.checked });
    });
  }

  const chkSpeak = $('#chk-speak');
  chkSpeak.checked = getIn('voice.speak', true);
  chkSpeak.addEventListener('change', () => {
    patch({ voice: { speak: chkSpeak.checked } });
    emit('ui:voice-option', { key: 'speak', value: chkSpeak.checked });
  });

  $('#btn-save-persona')?.addEventListener('click', () => {
    client.setConfig({
      persona_name: nameInput.value,
      persona_style: styleInput.value,
    });
    toast('人格已发送给后端，下一句生效', 'ok');
  });
}

/* ---------------- 高级 ---------------- */

async function initAdvancedPanel() {
  try {
    const data = await (await fetch('/api/tools')).json();
    const list = $('#tool-list');
    list.innerHTML = '';
    for (const t of data.tools) {
      const item = el('div', {
        class: 'list-item tool-item',
        dataset: { side: t.side, confirm: String(!!t.requires_confirm) },
      }, [
        el('span', {}, [`${t.side === 'client' ? '🌐' : '🖥'} ${t.name}`]),
        el('span', { class: 'list-item__meta' }, [
          (t.requires_confirm ? '需确认 · ' : '') + (t.side === 'client' ? '前端执行' : '后端执行'),
        ]),
      ]);
      item.title = t.description;
      list.append(item);
    }
  } catch {
    $('#tool-list').innerHTML = '<p class="note warn">读取工具清单失败</p>';
  }

  $('#btn-diag')?.addEventListener('click', async () => {
    const box = $('#diag-box');
    box.hidden = false;
    const info = {
      net: client.state,
      session: client.sessionId,
      theme: getIn('ui.theme'),
      motion: getIn('ui.motion'),
      skin: currentSkin().id,
      creds: Object.fromEntries(CAPS.map((c) => [c, credSummary(c)])),
      ua: navigator.userAgent,
      audioContext: !!(window.AudioContext || window.webkitAudioContext),
      speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      speechSynthesis: 'speechSynthesis' in window,
    };
    box.textContent = JSON.stringify(info, null, 2);
    console.info('[数字人诊断]', info);
  });

  $('#btn-reset')?.addEventListener('click', () => emit('ui:reset'));
}

export async function refreshSessions() {
  const list = $('#session-list');
  if (!list) return;
  try {
    const data = await (await fetch('/api/sessions')).json();
    list.innerHTML = '';
    if (!data.sessions?.length) {
      list.append(el('p', { class: 'note' }, ['还没有历史会话']));
      return;
    }
    for (const s of data.sessions.slice(0, 12)) {
      const item = el('div', { class: 'list-item' }, [
        el('span', {}, [s.last_user || '(空会话)']),
        el('span', { class: 'list-item__meta' }, [`${s.messages} 条`]),
      ]);
      const btn = el('button', { class: 'ghost-btn' }, ['载入']);
      btn.addEventListener('click', async () => {
        const detail = await (await fetch(`/api/sessions/${s.id}`)).json();
        renderHistory(detail.messages || []);
        emit('ui:session-loaded', { id: s.id });
        closeDrawer();
        toast(`已载入会话 ${s.id}（继续对话将沿用它的记忆）`, 'ok');
      });
      item.append(btn);
      list.append(item);
    }
  } catch (e) {
    list.innerHTML = '';
    list.append(el('p', { class: 'note warn' }, [`读取失败：${e.message}`]));
  }
}

/** 调试出口：看总线里每个事件挂了几个监听器（正常都应该是 1）。 */
export function debugListeners() {
  return dumpListeners();
}

/** 把配置里的值回填到所有 data-field 输入框（用于启动与皮肤切换后）。 */
function bindFieldSync() {
  for (const cap of CAPS) {
    const card = $(`.cred-card[data-cap="${cap}"]`);
    if (!card) continue;
    const values = getIn(`providers.${cap}`, {});
    card.querySelectorAll('[data-field]').forEach((input) => {
      const key = input.dataset.field;
      if (key === 'base_url' && input.tagName === 'INPUT') input.value = values.base_url || values.baseUrl || '';
      else if (input.tagName === 'SELECT') input.value = values[key] ?? '';
      else input.value = values[key] ?? '';
    });
  }
}

/* ================================================================
   杂项：麦克风按钮视觉、徽标、标题
   ================================================================ */

export function setRecordingVisual(on) {
  $('#btn-mic')?.classList.toggle('is-recording', !!on);
}

export function setPersonaTitle(name) {
  const node = $('#persona-title');
  if (node) node.textContent = name || '数字人';
}

export function setModeBadge(text) {
  const node = $('#mode-badge');
  if (node) node.textContent = text;
}

export function setStopVisible(on) {
  const stop = $('#btn-stop');
  const send = $('#btn-send');
  if (stop) stop.hidden = !on;
  if (send) send.style.display = on ? 'none' : '';
}

/** 把头像容器切到 live2d / empty 模式（empty = 空状态引导，不画假形象）。 */
export function setAvatarMode(mode) {
  const box = $('#avatar-container');
  if (box) box.dataset.mode = mode;
}

/**
 * 空状态时显示的原因：把内部标识符翻成人话 + 给出可执行的下一步。
 *
 * 早期这里直接甩 `cubism-core-missing` 这种英文标识符给用户 ——
 * 他既看不懂，也不知道该做什么。人话 + 下一步才是空状态该有的样子。
 */
const EMPTY_REASON_TEXT = {
  'no-models': {
    title: '还没有可用的模型',
    detail: '把 Live2D 模型文件夹拖到左侧区域，或在设置里点「选择文件夹」导入。',
  },
  'cubism-core-missing': {
    title: '缺少 Live2D 运行时',
    detail: '需要 assets/cubism/live2dcubismcore.min.js（官方 SDK 的 Core 文件）。放进去后刷新页面。',
  },
  'no-canvas': {
    title: '画布不可用',
    detail: '页面里没有找到渲染用的 canvas 元素。',
  },
};

export function setEmptyReason(reason, { everLoadedModel = false } = {}) {
  const raw = String(reason || '');
  const box = $('#avatar-empty');
  if (!box) return;

  const titleEl = box.querySelector('.avatar-empty__title');
  const detailEl = box.querySelector('.avatar-empty__detail');
  const techEl = box.querySelector('.avatar-empty__tech');

  const key = raw.split(':')[0].trim();
  const known = EMPTY_REASON_TEXT[key];
  const isLoadFailed = key.startsWith('model-load-failed');

  // 关键分支：模型明明载入成功过、却还是画不出来 —— 那是渲染引擎的问题，不是模型文件的问题。
  // 这时候继续提示「请把模型文件放进来」会把用户引向错方向：
  // 他会一遍遍换模型，而真正坏的是渲染链路（README/roadmap 里记的已知问题）。
  const isRenderFailure = everLoadedModel && !isLoadFailed
    && key !== 'no-models' && key !== 'cubism-core-missing' && key !== 'no-canvas';

  if (titleEl) {
    titleEl.textContent =
      isRenderFailure ? '模型已载入，但画面没画出来'
      : known ? known.title
      : isLoadFailed ? '模型加载失败'
      : '请把模型文件放进来';
  }
  if (detailEl) {
    detailEl.textContent =
      isRenderFailure
        ? '模型文件是好的（已成功解析），问题出在渲染链路上，属于已知问题、不是你操作有误。'
          + '详见 docs/roadmap.md 的「已知未验证」一节。'
      : known ? known.detail
      : isLoadFailed ? '这个模型没能载入。确认它包含 .model3.json 与同名 .moc3、贴图在同一目录下。'
      : '支持拖入模型文件夹，或在设置 → 形象里点「选择文件夹」导入。';
  }
  // 技术细节放最后一行：排查时用得上，平时不吓人
  if (techEl) {
    techEl.textContent = raw ? `（技术信息：${raw}）` : '';
    techEl.hidden = !raw;
  }
  box.hidden = false;
}

/** 退出前清理：卸载皮肤、停掉音频，避免留下跳动的动画。 */
export async function teardown() {
  await unloadSkin();
}

/* ================================================================
   VAD 电平表
   ----------------------------------------------------------------
   为什么值得画：自动断句的判定阈值是「自适应」的，看不见就调不动。
   这条曲线把「当前能量 / 当前阈值 / 说话区间」摊开，你一眼能看出
   阈值是不是太低（把呼吸当说话）或太高（轻声被判成静音）。
   ================================================================ */

const VAD_HISTORY = 260;
const vadLevels = [];   // 最近若干帧的 { level, thr }

export function pushVadLevel({ level, threshold, isSpeech }) {
  vadLevels.push({ level, thr: threshold, isSpeech });
  if (vadLevels.length > VAD_HISTORY) vadLevels.shift();
}

export function drawVadMeter(active, listening) {
  const canvas = $('#vad-canvas');
  if (!canvas || !canvas.clientWidth) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  // 参考线：把 0.3 RMS 当作满量程（正常说话约 0.1~0.25）
  const FULL = 0.3;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, h * frac);
    ctx.lineTo(w, h * frac);
    ctx.stroke();
  }

  if (!active || vadLevels.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${Math.round(11 * dpr)}px monospace`;
    ctx.fillText('未监听', 8 * dpr, h / 2);
    return;
  }

  const stepX = w / (VAD_HISTORY - 1);
  const yOf = (v) => h - Math.min(1, v / FULL) * (h - 4) - 2;
  const startIdx = VAD_HISTORY - vadLevels.length;

  // 说话区间用底色标出，一眼看出切分点
  for (let i = 0; i < vadLevels.length; i++) {
    if (!vadLevels[i].isSpeech) continue;
    ctx.fillStyle = 'rgba(53,200,138,0.10)';
    ctx.fillRect((startIdx + i) * stepX, 0, stepX + 1, h);
  }

  // 阈值线
  ctx.strokeStyle = 'rgba(242,177,61,0.85)';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  vadLevels.forEach((s, i) => {
    const x = (startIdx + i) * stepX;
    const y = yOf(s.thr);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  // 能量曲线
  ctx.strokeStyle = 'rgba(108,140,255,0.95)';
  ctx.lineWidth = 1.4 * dpr;
  ctx.beginPath();
  vadLevels.forEach((s, i) => {
    const x = (startIdx + i) * stepX;
    const y = yOf(s.level);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

export function setVadInfo(text, state = 'idle') {
  const node = $('#vad-info');
  if (!node) return;
  node.textContent = text;
  node.dataset.state = state;
}
