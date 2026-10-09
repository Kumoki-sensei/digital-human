"""LLM（大脑）实现：离线回声 / OpenAI 兼容 / 任意自定义。"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from ..provider_registry import ResolvedCredential
from .base import FunctionSchema, LLMDelta
from .openai_compat import stream_chat


def _to_wire(tools: list[FunctionSchema] | None) -> list[dict] | None:
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in tools
    ]


class OpenAICompatLLM:
    """任何说 OpenAI 协议的模型（含本地 Ollama / vLLM）。"""

    cap = "llm"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def stream(
        self,
        messages: list[dict],
        *,
        tools: list[FunctionSchema] | None = None,
        temperature: float = 0.8,
        max_tokens: int = 1024,
    ) -> AsyncIterator[LLMDelta]:
        async for d in stream_chat(
            self.cred, messages,
            tools=_to_wire(tools), temperature=temperature, max_tokens=max_tokens,
        ):
            yield d


class EchoLLM:
    """离线回声：没配密钥时也能把整条链路跑通、验证前端与协议。

    它不会假装自己很聪明 —— 只回一段可预期的文字，让延迟与打断逻辑可被测。
    """

    cap = "llm"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def stream(
        self,
        messages: list[dict],
        *,
        tools: list[FunctionSchema] | None = None,
        temperature: float = 0.8,
        max_tokens: int = 1024,
    ) -> AsyncIterator[LLMDelta]:
        user_text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                user_text = m.get("content") if isinstance(m.get("content"), str) else "[图片]"
                break
        reply = (
            f"（离线回声模式）我收到了：{user_text}。"
            "当前没有配置大模型密钥，所以我还不会自己思考。"
            "在右侧设置里选一个供应商、填入你自己的 API Key，我立刻就能开口。"
        )
        for ch in reply:
            yield LLMDelta(content=ch)
            await asyncio.sleep(0.012)
        yield LLMDelta(finish_reason="stop")
