"""VLM（眼睛）实现：任何 OpenAI 兼容的多模态模型。"""

from __future__ import annotations

from ..provider_registry import ResolvedCredential
from .base import ProviderError, VisionResult
from .openai_compat import post_json


class NoneVLM:
    cap = "vlm"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def describe(self, image_data_url: str, *, prompt: str = "") -> VisionResult:
        raise ProviderError("视觉能力未开启：请在设置里选择 GLM-4V / Qwen-VL / GPT-4o 之类多模态模型")


class OpenAICompatVLM:
    cap = "vlm"

    def __init__(self, cred: ResolvedCredential):
        self.cred = cred

    async def describe(self, image_data_url: str, *, prompt: str = "") -> VisionResult:
        ask = prompt or "简要描述这张图里有什么，重点说与对话有关的信息，不要客套。"
        payload = {
            "model": self.cred.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ask},
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                }
            ],
            "stream": False,
        }
        resp = await post_json(self.cred, "/chat/completions", payload)
        obj = resp.json()
        choices = obj.get("choices") or []
        if not choices:
            raise ProviderError(f"视觉模型没有返回内容：{str(obj)[:200]}")
        msg = choices[0].get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):  # 少数服务返回分片数组
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        return VisionResult(text=(content or "").strip())
