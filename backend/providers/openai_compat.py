"""OpenAI 兼容协议的共用客户端。

为什么只做这一层就够用：市面上绝大多数云服务商（OpenAI、DeepSeek、硅基流动、
百炼、智谱、Kimi、Ollama、vLLM、各类中转）都实现了同一套 /chat/completions
与 /audio/* 接口。把差异收进几个 URL 与字段名里，用户换供应商就只是改配置。

安全：api_key 只进请求头，异常信息里也只出现掩码。
"""

from __future__ import annotations

import base64
import json
from typing import AsyncIterator

import httpx

from ..provider_registry import ResolvedCredential, mask_key
from .base import LLMDelta, ProviderError, ToolCall

DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=30.0, pool=10.0)


def auth_headers(cred: ResolvedCredential) -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if cred.api_key:
        h["Authorization"] = f"Bearer {cred.api_key}"
    return h


def _explain(status: int, body: str, cred: ResolvedCredential) -> str:
    """把上游错误翻译成人话，且绝不回显密钥。"""
    hint = {
        401: "鉴权失败：密钥无效或未填",
        402: "账户余额不足",
        403: "无权访问该模型（可能未开通或未实名）",
        404: "接口地址或模型名不存在，检查 base_url 是否少了 /v1",
        429: "被限流或超出配额，稍后再试",
    }.get(status, "")
    snippet = (body or "").strip().replace("\n", " ")[:300]
    return (
        f"{cred.provider} 返回 HTTP {status}"
        f"{'（' + hint + '）' if hint else ''}"
        f"｜model={cred.model or '-'}｜key={mask_key(cred.api_key)}｜{snippet}"
    )


async def stream_chat(
    cred: ResolvedCredential,
    messages: list[dict],
    *,
    tools: list[dict] | None = None,
    temperature: float = 0.8,
    max_tokens: int = 1024,
) -> AsyncIterator[LLMDelta]:
    """流式对话。逐块产出文本增量，工具调用在结束时一次性给出。"""
    if not cred.base_url:
        raise ProviderError(f"{cred.provider} 未配置 base_url")
    payload: dict = {
        "model": cred.model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    # 工具调用按 index 累积（OpenAI 流式协议就是这么碎的）
    pending: dict[int, dict] = {}

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        async with client.stream(
            "POST", f"{cred.base_url}/chat/completions",
            headers=auth_headers(cred), json=payload,
        ) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode("utf-8", "replace")
                raise ProviderError(_explain(resp.status_code, body, cred))

            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                ch = choices[0]
                delta = ch.get("delta") or {}
                text = delta.get("content") or ""
                for tc in delta.get("tool_calls") or []:
                    idx = tc.get("index", 0)
                    slot = pending.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
                finish = ch.get("finish_reason")
                if text or finish:
                    yield LLMDelta(content=text, finish_reason=finish)

    if pending:
        calls = [
            ToolCall(id=v["id"] or f"call_{i}", name=v["name"], arguments=v["arguments"] or "{}")
            for i, v in sorted(pending.items())
            if v["name"]
        ]
        if calls:
            yield LLMDelta(tool_calls=calls, finish_reason="tool_calls")


async def post_multipart(
    cred: ResolvedCredential,
    path: str,
    *,
    files: dict,
    data: dict,
) -> bytes:
    headers = {}
    if cred.api_key:
        headers["Authorization"] = f"Bearer {cred.api_key}"
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        resp = await client.post(f"{cred.base_url}{path}", headers=headers, files=files, data=data)
    if resp.status_code >= 400:
        raise ProviderError(_explain(resp.status_code, resp.text, cred))
    return resp.content


async def post_json(cred: ResolvedCredential, path: str, payload: dict) -> httpx.Response:
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        resp = await client.post(
            f"{cred.base_url}{path}", headers=auth_headers(cred), json=payload
        )
    if resp.status_code >= 400:
        raise ProviderError(_explain(resp.status_code, resp.text, cred))
    return resp


def to_data_url(image_bytes: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"
