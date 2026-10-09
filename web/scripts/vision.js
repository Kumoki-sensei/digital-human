/**
 * vision.js —— 「眼睛」：截屏 / 摄像头取一帧 → 交给后端的多模态模型
 *
 * 隐私立场（写死在代码里，不是文档里的口号）：
 *   - 摄像头与屏幕**都不是常开的**。用户每次要求「看看」时，才取一帧。
 *   - 取帧前必须经过确认卡片（由 brain 的 requires_confirm 触发）。
 *   - 图像处理方式固定为「等比缩放到 768px 长边再 JPEG 压缩」——
 *     原图上传又慢又贵，而多模态模型对明细度的需求远没那么高。
 *   - 不落盘、不缓存，用完即弃。
 */

import { emit } from './bus.js';
import { buildCredentialHeaders } from './config.js';
import { client } from './client.js';

const MAX_EDGE = 768;
const JPEG_QUALITY = 0.82;

let cameraStream = null;

/** 等比缩放 + 压缩，返回 data URL。 */
export function frameToDataUrl(source, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  const sw = source.videoWidth || source.width;
  const sh = source.videoHeight || source.height;
  if (!sw || !sh) throw new Error('这一帧没有可用尺寸');

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 本地截屏：getDisplayMedia 需要用户手势触发，所以必须由点击链路调用。 */
export async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('这个浏览器不支持屏幕捕获（需要 Chrome/Edge 且是 https 或 localhost）');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: false,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 350)); // 等首帧稳定，否则可能拍到黑屏
    return frameToDataUrl(video);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** 摄像头取一帧。流默认关闭，取完立刻释放。 */
export async function captureCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持摄像头');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 400)); // 摄像头首帧偏暗，等一下
    return frameToDataUrl(video);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** 打开预览流（给「常开模式」预留；当前 UI 不主动用，避免隐私争议）。 */
export async function openCameraPreview(videoEl) {
  closeCameraPreview();
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  videoEl.srcObject = cameraStream;
  videoEl.muted = true;
  await videoEl.play();
  return cameraStream;
}

export function closeCameraPreview() {
  try { cameraStream?.getTracks().forEach((t) => t.stop()); } catch { /* 已释放 */ }
  cameraStream = null;
}

/** 把一张 data URL 交给后端多模态模型。 */
export async function describeImage(dataUrl, prompt = '') {
  const resp = await fetch('/api/vision', {
    method: 'POST',
    headers: buildCredentialHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ image: dataUrl, prompt }),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const obj = await resp.json();
      detail = obj.detail || obj.message || detail;
    } catch { /* 保持默认信息 */ }
    throw new Error(detail);
  }
  const obj = await resp.json();
  return obj.text || '';
}

/** 统一的「看一眼」入口：截图 → 识别 → 结果回灌给对话。 */
export async function lookOnce({ source = 'screen', question = '' } = {}) {
  emit('vision:start', { source });
  try {
    const dataUrl = source === 'camera' ? await captureCamera() : await captureScreen();
    const text = await describeImage(dataUrl, question);
    emit('vision:result', { source, text });
    // 把看到的东西作为一条用户消息交给大脑，让它接着说
    const preface = source === 'camera' ? '（我刚刚看了一眼摄像头）' : '（我刚刚看了一眼屏幕）';
    client.sendText(`${preface}${question ? `问题是：${question}。` : ''}我看到的画面内容：${text}`);
    return text;
  } catch (e) {
    emit('vision:error', { source, message: String(e.message || e) });
    return null;
  } finally {
    emit('vision:end', { source });
  }
}

export function visionAvailable() {
  return !!(navigator.mediaDevices?.getDisplayMedia || navigator.mediaDevices?.getUserMedia);
}
