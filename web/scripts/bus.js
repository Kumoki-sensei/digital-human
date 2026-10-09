/**
 * bus.js —— 极简事件总线 + DOM 小工具
 *
 * 为什么不用框架：这个前端的要求是「你能随手改」。原生 DOM + 一个 30 行的
 * 事件总线，比任何框架都更容易被看懂和替换。等你确定要上框架时，
 * 替换成本也只在 ui.js 与 main.js 两个文件内。
 */

const listeners = new Map();

/** 调试用：某个事件类型当前挂了几个监听器（正常应该都是 1）。 */
export function listenerCount(type) {
  return listeners.get(type)?.size ?? 0;
}

export function dumpListeners() {
  return Object.fromEntries([...listeners.entries()].map(([k, v]) => [k, v.size]));
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  listeners.get(type)?.delete(fn);
}

export function emit(type, payload) {
  for (const fn of listeners.get(type) ?? []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[bus] 处理 ${type} 的监听器抛错：`, e);
    }
  }
  for (const fn of listeners.get('*') ?? []) {
    try { fn({ type, payload }); } catch { /* 通配监听器失败不影响主流程 */ }
  }
}

/* ---------------------------------------------------------------- DOM 工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 文本节点安全插入：把纯文本按换行切成 <br>，绝不解析 HTML。 */
export function setText(node, text) {
  node.textContent = '';
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) node.append(document.createElement('br'));
    node.append(document.createTextNode(line));
  });
  return node;
}

export function clamp(v, lo = 0, hi = 1) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fmtTime(ts) {
  const d = new Date((ts ?? Date.now() / 1000) * 1000);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
