/**
 * themes.js —— 换肤系统
 *
 * 三件事：
 *   1. 换 <html data-theme>，并切换对应的皮肤 CSS 文件（同一套令牌，不同文件）
 *   2. 写 --motion-scale，用一个滑杆统一控制全站动效强度
 *   3. 外挂 JS 皮肤（web/skins/*.skin.js）：动态加载模块，调用它的 onMount/onUnmount
 *
 * 为什么换皮肤文件而不是把四套皮肤塞进一个文件：你可以只改自己的那一个文件、
 * 单独 git diff、单独删掉，不会互相干扰。这也是你后面自己设计美化的入口。
 */

import { patch, getIn } from './config.js';
import { emit, $ } from './bus.js';

export const THEMES = [
  { id: 'starlight', name: '星辉白昼', file: 'styles/themes/starlight.css',
    swatches: ['#f6f7fc', '#5a6cff', '#9b5cff'] },
  { id: 'midnight', name: '深海午夜', file: 'styles/themes/midnight.css',
    swatches: ['#0a0d16', '#6c8cff', '#a86cff'] },
  { id: 'sakura', name: '樱花软糖', file: 'styles/themes/sakura.css',
    swatches: ['#fff6f8', '#ff6f9c', '#ff9f7a'] },
  { id: 'terminal', name: '终端绿', file: 'styles/themes/terminal.css',
    swatches: ['#050a06', '#2bff88', '#00d5ff'] },
  { id: 'paper', name: '纸感', file: 'styles/themes/paper.css',
    swatches: ['#f6f3ea', '#b4552d', '#c98a2e'] },
];

let skinModule = null;       // 当前加载的外挂皮肤模块
let skinId = '';

/** 供外挂皮肤使用的上下文：让它能在不改核心代码的前提下操作页面。 */
function skinContext() {
  return {
    document,
    root: document.documentElement,
    stage: $('#stage'),
    canvas: $('#live2d-canvas'),
    avatar: $('#avatar-container'),
    chat: $('#chat'),
    $, emit,
    /** 注册 raf 动画，卸载时自动停 */
    raf: makeRafRegistry(),
    /** 注册可被卸载的全局事件 */
    listen: makeListenerRegistry(),
    vars: { set: (name, value) => document.documentElement.style.setProperty(name, value) },
  };
}

function makeRafRegistry() {
  const handles = new Set();
  let running = true;
  const loop = (fn) => {
    const tick = () => {
      if (!running) return;
      try { fn(performance.now()); } catch (e) { console.warn('[skin] raf 回调抛错，已停止', e); return; }
      handles.add(requestAnimationFrame(tick));
    };
    handles.add(requestAnimationFrame(tick));
  };
  loop.stopAll = () => {
    running = false;
    for (const h of handles) cancelAnimationFrame(h);
    handles.clear();
  };
  return loop;
}

function makeListenerRegistry() {
  const bound = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    bound.push(() => target.removeEventListener(type, fn, opts));
  };
  listen.stopAll = () => { for (const off of bound) off(); bound.length = 0; };
  return listen;
}

export function applyTheme(id, { persist = true } = {}) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = theme.id;

  const link = $('#theme-stylesheet');
  if (link && !link.href.endsWith(theme.file)) link.href = theme.file;

  if (persist) patch({ ui: { theme: theme.id } });
  emit('theme:changed', theme);
  return theme;
}

export function applyMotionScale(scale) {
  const s = Math.max(0, Number(scale) || 0);
  document.documentElement.style.setProperty('--motion-scale', String(s));
  patch({ ui: { motion: s } });
}

export function applyFontSize(px) {
  document.documentElement.style.setProperty('--fs-base', `${px}px`);
  patch({ ui: { fontSize: Number(px) } });
}

export function applyReduceMotion(on) {
  // 直接压低动效缩放而不是加一堆 !important：让所有过渡一起变快/停
  applyMotionScale(on ? 0.001 : (getIn('ui.motion', 1) || 1));
  patch({ ui: { reduceMotion: !!on } });
}

/* ---------------------------------------------------------------- 外挂皮肤 */

export async function loadSkin(url) {
  await unloadSkin();
  if (!url) return null;
  try {
    const mod = await import(/* @vite-ignore */ new URL(url, location.href).href);
    const skin = mod.default ?? mod;
    if (!skin || typeof skin.onMount !== 'function') {
      throw new Error('皮肤模块必须 default 导出 { id, name, onMount(ctx), onUnmount(ctx) }');
    }
    skinModule = skin;
    skinId = skin.id || url;
    await skin.onMount(skinContext());
    patch({ ui: { skin: url } });
    emit('skin:mounted', { id: skinId, name: skin.name || skinId });
    return skin;
  } catch (e) {
    console.warn('[themes] 皮肤脚本加载失败：', e);
    emit('skin:error', { url, message: String(e.message || e) });
    return null;
  }
}

export async function unloadSkin() {
  if (!skinModule) return;
  try {
    await skinModule.onUnmount?.(skinContext());
  } catch (e) {
    console.warn('[themes] 皮肤卸载抛错（已忽略）：', e);
  }
  skinModule = null;
  const id = skinId;
  skinId = '';
  patch({ ui: { skin: '' } });
  if (id) emit('skin:unmounted', { id });
}

export function currentSkin() {
  return { id: skinId, name: skinModule?.name ?? '' };
}

/** 首次启动：把持久化的外观设置恢复到页面上。 */
export function initTheme() {
  applyTheme(getIn('ui.theme', 'starlight'), { persist: false });
  applyFontSize(getIn('ui.fontSize', 15));
  const reduce = getIn('ui.reduceMotion', false);
  if (reduce) {
    document.documentElement.style.setProperty('--motion-scale', '0.001');
  } else {
    applyMotionScale(getIn('ui.motion', 1));
  }
  const savedSkin = getIn('ui.skin', '');
  if (savedSkin) {
    // 用户上次挂过皮肤，静默恢复；失败不打扰
    loadSkin(savedSkin).catch(() => {});
  }
}
