"""ASR（耳朵）实现。

三条路线，按「今天就能跑」到「效果最好」排序：

1. browser —— 浏览器原生识别。零成本零依赖，缺点是要前端在线且识别质量一般。
2. openai  —— 任何 OpenAI 兼容的 /audio/transcriptions（Whisper、SenseVoice、Paraformer…）。
3. local   —— 本机 faster-whisper。要装 ffmpeg + 额外依赖，但离线、免费、无隐私外泄。

后端对 browser 路线只做「落空标记」：真正的识别发生在前端，后端只接收文本。
"""

from __future__ import annotations

import asyncio
import logging

from ..provider_registry import ResolvedCredential
from .base import ASRResult, ProviderError
from .openai_compat import post_multipart

log = logging.getLogger(__name__)


class BrowserASR:
    """占位：识别由前端 Web Speech API 完成，后端不参与。"""

    cap = "asr"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm", sample_rate: int = 16000) -> ASRResult:
        raise ProviderError(
            "当前 ASR 用的是浏览器原生识别，音频应由前端本地转文字后再发送。"
            "若想走后端识别，请在设置里换成 OpenAI 兼容或本机 whisper。"
        )


class OpenAISpeechASR:
    cap = "asr"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm", sample_rate: int = 16000) -> ASRResult:
        if not audio:
            return ASRResult()
        ext = "webm" if "webm" in mime else ("wav" if "wav" in mime else "ogg")
        raw = await post_multipart(
            self.cred,
            "/audio/transcriptions",
            files={"file": (f"speech.{ext}", audio, mime or "application/octet-stream")},
            data={"model": self.cred.model, "response_format": "json"},
        )
        import json

        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
            return ASRResult(text=(obj.get("text") or "").strip(), language=obj.get("language", ""))
        except json.JSONDecodeError:
            return ASRResult(text=raw.decode("utf-8", "replace").strip())


class LocalWhisperASR:
    """faster-whisper 本机推理。首次使用会下载模型（默认 small，约 500MB）。"""

    cap = "asr"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred
        self._model = None
        self._lock = asyncio.Lock()

    def _load(self):
        if self._model is None:
            try:
                from faster_whisper import WhisperModel  # type: ignore
            except ImportError as e:  # pragma: no cover
                raise ProviderError(
                    "未安装 faster-whisper。请执行 `uv sync --extra local-asr`，"
                    "并确保系统已安装 ffmpeg。"
                ) from e
            log.info("加载本机 whisper 模型：%s（首次会下载）", self.cred.model)
            self._model = WhisperModel(self.cred.model or "small", device="auto", compute_type="int8")
        return self._model

    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm", sample_rate: int = 16000) -> ASRResult:
        if not audio:
            return ASRResult()

        def run() -> ASRResult:
            import io

            model = self._load()
            # faster-whisper 能直接解码 webm/ogg/wav（内部用 PyAV 解码，不强依赖 ffmpeg 可执行文件）
            segments, info = model.transcribe(
                io.BytesIO(audio), language=None, vad_filter=True, beam_size=1
            )
            text = "".join(seg.text for seg in segments).strip()
            return ASRResult(text=text, language=getattr(info, "language", "") or "",
                             duration=float(getattr(info, "duration", 0.0) or 0.0))

        async with self._lock:  # 本机模型不是线程安全的，串行化
            return await asyncio.to_thread(run)
