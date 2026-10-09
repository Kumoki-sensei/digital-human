"""四个能力接口的协议定义（结构化 Protocol，运行时零开销）。

约定：
    - 所有实现都是「构造函数吃 ResolvedCredential，调用方法吃业务参数」
    - 所有流式方法都是 async 生成器，产出的是纯数据（文本片段 / 音频字节）
    - 任何实现都不得读全局密钥、不得写日志打印 key
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Protocol, runtime_checkable


# ------------------------------------------------------------------ LLM

@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # 原样 JSON 字符串，由调用方解析


@dataclass
class LLMDelta:
    """LLM 流式事件：可能只有文字、只有工具调用、或两者都有。"""

    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None


@dataclass
class FunctionSchema:
    name: str
    description: str
    parameters: dict


@runtime_checkable
class LLMProvider(Protocol):
    cap = "llm"

    async def stream(
        self,
        messages: list[dict],
        *,
        tools: list[FunctionSchema] | None = None,
        temperature: float = 0.8,
        max_tokens: int = 1024,
    ) -> AsyncIterator[LLMDelta]: ...


# ------------------------------------------------------------------ ASR

@dataclass
class ASRResult:
    text: str = ""
    language: str = ""
    duration: float = 0.0


@runtime_checkable
class ASRProvider(Protocol):
    cap = "asr"

    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/webm", sample_rate: int = 16000
    ) -> ASRResult: ...


# ------------------------------------------------------------------ TTS

@dataclass
class TTSChunk:
    """一段合成好的音频。前端按序播放即得到连续语音。"""

    audio: bytes = b""
    mime: str = "audio/mpeg"
    text: str = ""
    final: bool = False


@runtime_checkable
class TTSProvider(Protocol):
    cap = "tts"

    async def synthesize(self, text: str, *, voice: str = "") -> AsyncIterator[TTSChunk]: ...


# ------------------------------------------------------------------ VLM

@dataclass
class VisionResult:
    text: str = ""


@runtime_checkable
class VLMProvider(Protocol):
    cap = "vlm"

    async def describe(self, image_data_url: str, *, prompt: str = "") -> VisionResult: ...


class ProviderError(RuntimeError):
    """能力调用失败，且失败原因可以安全地展示给用户（不含密钥）。"""
