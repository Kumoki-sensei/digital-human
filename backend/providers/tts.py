"""TTS（嗓子）实现。

关键设计：**按句合成**。等整段话合成完再播，用户会先听到 2~5 秒静音，
那种延迟在体感上不是「慢」而是「死」。编排层把回复切成句子，一句一合一段播，
首字延迟就压到单句合成时间内。

各家返回格式不一样，这里做收敛：
    - OpenAI 系：直接返回音频二进制（mp3/opus/aac/flac/wav/pcm）
    - DashScope CosyVoice：返回 JSON，音频在 output.audio.data（base64）
    - 自定义兼容：先按二进制猜，不是音频就尝试按 JSON 解
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import AsyncIterator

import httpx

from ..provider_registry import ResolvedCredential
from .base import ProviderError, TTSChunk
from .openai_compat import DEFAULT_TIMEOUT, auth_headers

log = logging.getLogger(__name__)

_AUDIO_MAGIC = ((b"ID3", "audio/mpeg"), (b"\xff\xfb", "audio/mpeg"), (b"\xff\xf3", "audio/mpeg"),
                (b"OggS", "audio/ogg"), (b"RIFF", "audio/wav"), (b"fLaC", "audio/flac"))


def sniff_audio(blob: bytes) -> str:
    for magic, mime in _AUDIO_MAGIC:
        if blob.startswith(magic):
            return mime
    return "audio/mpeg"


class BrowserTTS:
    """合成交给浏览器 speechSynthesis，后端只发文本。"""

    cap = "tts"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def synthesize(self, text: str, *, voice: str = "") -> AsyncIterator[TTSChunk]:
        # 后端不做音频，发一个「请前端本地朗读」的标记块
        yield TTSChunk(audio=b"", mime="text/browser-tts", text=text, final=True)


class OpenAICompatTTS:
    cap = "tts"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    def _payload(self, text: str, voice: str) -> dict:
        return {
            "model": self.cred.model,
            "input": text,
            "voice": voice or self.cred.voice or "alloy",
            "response_format": "mp3",
        }

    async def synthesize(self, text: str, *, voice: str = "") -> AsyncIterator[TTSChunk]:
        if not text.strip():
            return
        payload = self._payload(text, voice)
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(
                f"{self.cred.base_url}/audio/speech",
                headers=auth_headers(self.cred), json=payload,
            )
        if resp.status_code >= 400:
            from .openai_compat import _explain

            raise ProviderError(_explain(resp.status_code, resp.text, self.cred))

        ctype = (resp.headers.get("content-type") or "").lower()
        body = resp.content
        if "json" in ctype:
            # 有些兼容层把音频包在 JSON 里
            try:
                obj = json.loads(body.decode("utf-8", "replace"))
            except json.JSONDecodeError as e:
                raise ProviderError(f"TTS 返回了无法解析的 JSON：{body[:200]!r}") from e
            b64 = (((obj.get("output") or {}).get("audio") or {}).get("data")) or obj.get("audio")
            if not b64:
                raise ProviderError(f"TTS 返回 JSON 中找不到音频字段：{str(obj)[:200]}")
            body = base64.b64decode(b64)
            mime = "audio/mpeg"
        else:
            mime = sniff_audio(body)

        # 分片发送：前端边收边播，不必等整段
        step = 64 * 1024
        for i in range(0, len(body), step):
            piece = body[i:i + step]
            yield TTSChunk(audio=piece, mime=mime, text=text,
                           final=(i + step >= len(body)))


class PiperTTS:
    """本机 Piper：轻量、实时、离线，中文音质够用。"""

    cap = "tts"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def synthesize(self, text: str, *, voice: str = "") -> AsyncIterator[TTSChunk]:
        if not text.strip():
            return
        model_name = voice or self.cred.model or "zh_CN-huayan-medium"

        def run() -> bytes:
            try:
                from piper import PiperVoice  # type: ignore
            except ImportError as e:  # pragma: no cover
                raise ProviderError(
                    "未安装 piper-tts。请执行 `uv sync --extra local-tts`，"
                    "并把 .onnx 模型放到 assets/models/piper/。"
                ) from e
            from pathlib import Path

            root = Path(__file__).resolve().parent.parent.parent / "assets" / "models" / "piper"
            onnx = root / f"{model_name}.onnx"
            if not onnx.exists():
                raise ProviderError(f"找不到本机 Piper 模型：{onnx}")
            import io
            import wave

            voice_obj = PiperVoice.load(str(onnx))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                voice_obj.synthesize(text, wf)
            return buf.getvalue()

        wav = await asyncio.to_thread(run)
        yield TTSChunk(audio=wav, mime="audio/wav", text=text, final=True)
