/**
 * home.js —— starspec 主页（品牌引导页）的进入逻辑
 *
 * 职责只有一件事：把首页的「进入控制台」按钮接线好，
 * 点击后平滑淡出首页、露出下面的对话工作台。
 * 不在这里碰对话/音频/设置 —— 那些仍由 main.js 负责。
 */

import { $ } from './bus.js';

let entered = false;

/** 淡出首页并释放对键盘/点击的遮挡。 */
function enterApp() {
  if (entered) return;
  entered = true;
  const home = $('#home');
  if (!home) return;

  // 进入的同时完成一次用户手势：解锁后续可能的音频/模型加载需要的一次授权
  home.classList.add('is-leaving');

  const t = Number(getComputedStyle(home).transitionDuration?.replace('s', '')) * 1000 || 450;
  setTimeout(() => home.remove(), t);
}

/** 首次启动调用：把「进入」控制台接好。 */
export function initHome() {
  const home = $('#home');
  const btn = $('#btn-enter');
  if (!home) return;

  btn?.addEventListener('click', enterApp);
}