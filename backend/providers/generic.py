"""通用 HTTP 转发适配器 —— 把「任意 HTTP 接口」接成数字人模块。

## 定位

`providers/openai_compat.py` 假设对方讲 OpenAI 方言。
这个文件不假设任何方言：URL、请求体、响应字段全部由配置描述。
于是「我的服务长得跟 OpenAI 不一样」不必再写 Python —— 填映射即可。

针对自定义模块的每个能力，映射来自 `data/custom_modules.json`：

    llm / vlm  走 chat 形态（可选流式）
    asr        走上传形态（multipart 或 JSON+base64）
    tts        走合成形态（流式或一次性返回字节）

## 设计约束（改之前先读）

1. **不做隐式重试**。转发层的失败会如实抛出，重试由上层决定 ——
   在音频链路上偷偷重试会带来重复播报，比失败更难排查。
2. **不缓存响应**。数字人对话是有状态的，缓存等于说谎。
3. **不把密钥写进日志或错误信息**，异常里只出现掩码。
4. 占位符替换是**纯字符串替换**，不做表达式求值 —— 配置是给用户填的，
   不是给代码执行的；一旦支持求值，配置文件就变成了任意代码执行入口。
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx

from ..provider_registry import ResolvedCredential, mask_key
from .base import ASRResult, LLMDelta, ProviderError, TTSChunk, VisionResult

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=60.0, pool=10.0)


# ---------------------------------------------------------------- 小工具

def dig(obj: Any, path: str, default: Any = None) -> Any:
    """按 "choices.0.delta.content" 这样的路径取值。

    比 JSONPath 简单，但覆盖了实际接入中 95% 的场景，且不会引入依赖。
    路径为空时直接返回原对象（让调用方自己决定）。
    """
    if not path:
        return obj
    cur = obj
    for part in str(path).split("."):
        if part == "":
            continue
        if isinstance(cur, dict):
            if part not in cur:
                return default
            cur = cur[part]
        elif isinstance(cur, (list, tuple)):
            try:
                idx = int(part)
            except ValueError:
                return default
            if idx < 0 or idx >= len(cur):
                return default
            cur = cur[idx]
        else:
            return default
    return cur


def substitute(value: Any, ctx: dict[str, Any]) -> Any:
    """把配置里的 {占位符} 换成实际值，递归处理 dict/list。

    只做字符串替换，不求值 —— 配置不该成为代码执行入口。
    """
    if isinstance(value, str):
        out = value
        for k, v in ctx.items():
            token = "{" + k + "}"
            if token in out:
                # 整串就是一个占位符时保留原始类型（列表/对象要原样传下去，
                # 转成字符串再发给对方是最常见的一种"接不通"）
                if out == token:
                    return v
                out = out.replace(token, "" if v is None else str(v))
        return out
    if isinstance(value, dict):
        return {k: substitute(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, ctx) for v in value]
    return value


def build_ctx(cred: ResolvedCredential, mapping: dict, **extra: Any) -> dict[str, Any]:
    """构造占位符上下文。缺的值给空串而不是报错 —— 
    配置里多写了一个占位符，不应该让整个模块不可用。"""
    ctx: dict[str, Any] = {
        "base_url": cred.base_url,
        "model": cred.model,
        "api_key": cred.api_key,
        "voice": cred.voice or "",
        "provider": cred.provider,
        "temperature": 0.8,
        "max_tokens": 1024,
    }
    ctx.update(mapping.get("_ctx", {}) or {})
    ctx.update(extra)
    return ctx


def build_headers(mapping: dict, ctx: dict[str, Any]) -> dict[str, str]:
    req = mapping.get("request") or {}
    headers = substitute(req.get("headers") or {"Content-Type": "application/json"}, ctx)
    headers = {str(k): str(v) for k, v in headers.items()}
    # 如果配置里没显式放 Authorization，而模块需要密钥，就补一个标准 Bearer。
    # 放在这里而不是调用处，是因为「要不要鉴权」是配置表达的，不是代码猜的。
    if ctx.get("api_key") and not any(k.lower() == "authorization" for k in headers):
        headers["Authorization"] = f"Bearer {ctx['api_key']}"
    return headers


def explain(status: int, body: str, cred: ResolvedCredential) -> str:
    hint = {
        401: "鉴权失败：密钥无效或未填",
        403: "无权访问（可能未开通或未实名）",
        404: "接口地址或模型名不存在，检查 request.url 与 base_url 是否重复拼接了 /v1",
        429: "被限流或超出配额，稍后再试",
        500: "对方服务内部错误",
    }.get(status, "")
    snippet = (body or "").strip().replace("\n", " ")[:300]
    return (
        f"{cred.provider} 返回 HTTP {status}"
        f"{'（' + hint + '）' if hint else ''}"
        f"｜model={cred.model or '-'}｜key={mask_key(cred.api_key)}｜{snippet}"
    )


def _request_url(mapping: dict, ctx: dict[str, Any]) -> str:
    req = mapping.get("request") or {}
    url = substitute(req.get("url") or "{base_url}", ctx)
    url = str(url).strip()
    if not url:
        raise ProviderError("自定义模块没有配置 request.url")
    if not url.startswith("http"):
        raise ProviderError(f"自定义模块的 request.url 不是完整地址：{url[:80]}")
    return url


# ---------------------------------------------------------------- 主实现

class GenericHTTP:
    """声明式转发。一个类覆盖四种能力，靠 cap 分派调用形态。"""

    def __init__(self, cred: ResolvedCredential, mapping: dict):
        self.cred = cred
        self.cap = cred.cap
        self.mapping = mapping or {}
        self.timeout = httpx.Timeout(
            connect=10.0,
            read=float(self.mapping.get("timeout_seconds") or DEFAULT_TIMEOUT.read),
            write=60.0,
            pool=10.0,
        )

    # ------------------------------------------------------------ LLM

    async def stream(
        self,
        messages: list[dict],
        *,
        tools: list | None = None,
        temperature: float = 0.8,
        max_tokens: int = 1024,
    ) -> AsyncIterator[LLMDelta]:
        ctx = build_ctx(self.cred, self.mapping, messages=messages, temperature=temperature,
                        max_tokens=max_tokens, tools=tools or [])
        req = self.mapping.get("request") or {}
        want_stream = bool(req.get("stream", self.mapping.get("stream", True)))

        body = substitute(req.get("json") or req.get("body") or {}, ctx)
        headers = build_headers(self.mapping, ctx)
        url = _request_url(self.mapping, ctx)

        if not want_stream:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(url, headers=headers, json=body)
            if resp.status_code >= 400:
                raise ProviderError(explain(resp.status_code, resp.text, self.cred))
            try:
                obj = resp.json()
            except json.JSONDecodeError as e:
                raise ProviderError(f"对方返回的不是 JSON：{resp.text[:200]!r}") from e
            text = self._extract_text(obj)
            if text:
                yield LLMDelta(content=text)
            yield LLMDelta(finish_reason="stop")
            return

        # ---- 流式（SSE 或 NDJSON 都按「一行一个 JSON」处理）----
        path = self.mapping.get("chunk_text_path") or (req.get("stream_json_path") or "")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code >= 400:
                    raw = (await resp.aread()).decode("utf-8", "replace")
                    raise ProviderError(explain(resp.status_code, raw, self.cred))

                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = line[5:].strip() if line.startswith("data:") else line.strip()
                    if not data or data == "[DONE]":
                        if data == "[DONE]":
                            break
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        # 有些服务在流里混入心跳/注释行，跳过而不是报错
                        continue
                    piece = dig(obj, path) if path else None
                    if piece is None and not path:
                        piece = self._extract_text(obj)
                    if isinstance(piece, (dict, list)):
                        continue
                    if piece:
                        yield LLMDelta(content=str(piece))

        yield LLMDelta(finish_reason="stop")

    # ------------------------------------------------------------ VLM

    async def describe(self, image_data_url: str, *, prompt: str = "") -> VisionResult:
        ctx = build_ctx(self.cred, self.mapping, image=image_data_url, prompt=prompt)
        req = self.mapping.get("request") or {}
        body = substitute(req.get("json") or req.get("body") or {}, ctx)
        headers = build_headers(self.mapping, ctx)
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(_request_url(self.mapping, ctx), headers=headers, json=body)
        if resp.status_code >= 400:
            raise ProviderError(explain(resp.status_code, resp.text, self.cred))
        try:
            obj = resp.json()
        except json.JSONDecodeError as e:
            raise ProviderError(f"对方返回的不是 JSON：{resp.text[:200]!r}") from e
        return VisionResult(text=str(self._extract_text(obj) or "").strip())

    # ------------------------------------------------------------ ASR

    async def transcribe(self, audio: bytes, *, mime: str = "audio/webm",
                         sample_rate: int = 16000) -> ASRResult:
        if not audio:
            return ASRResult()
        req = self.mapping.get("request") or {}
        mode = str(req.get("asr_mode") or "multipart")

        ctx = build_ctx(
            self.cred, self.mapping,
            sample_rate=sample_rate,
            mime=mime,
            audio_b64=self._b64(audio),
        )
        headers = build_headers(self.mapping, ctx)
        url = _request_url(self.mapping, ctx)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            if mode == "json":
                # 有些服务要求 base64 塞 JSON，而不是 multipart
                body = substitute(req.get("json") or {"audio": "{audio_b64}", "model": "{model}"}, ctx)
                headers.setdefault("Content-Type", "application/json")
                resp = await client.post(url, headers=headers, json=body)
            else:
                field = str(req.get("file_field") or "file")
                extra = substitute(req.get("form") or {"model": "{model}"}, ctx)
                files = {field: (self._ext(filename_for(mime)), audio, mime or "application/octet-stream")}
                # multipart 时不能手工设 Content-Type，否则 boundary 会丢
                headers = {k: v for k, v in headers.items() if k.lower() != "content-type"}
                resp = await client.post(url, headers=headers, files=files, data=extra)

        if resp.status_code >= 400:
            raise ProviderError(explain(resp.status_code, resp.text, self.cred))
        try:
            obj = resp.json()
        except json.JSONDecodeError:
            # 有的服务直接回纯文本
            return ASRResult(text=resp.text.strip())
        path = (self.mapping.get("response") or {}).get("text_path", "")
        text = dig(obj, path) if path else obj.get("text")
        return ASRResult(text=str(text or "").strip())

    # ------------------------------------------------------------ TTS

    async def synthesize(self, text: str, *, voice: str = "") -> AsyncIterator[TTSChunk]:
        if not text.strip():
            return
        ctx = build_ctx(self.cred, self.mapping, text=text, voice=voice or self.cred.voice)
        req = self.mapping.get("request") or {}
        body = substitute(req.get("json") or req.get("body") or {}, ctx)
        headers = build_headers(self.mapping, ctx)
        url = _request_url(self.mapping, ctx)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            raise ProviderError(explain(resp.status_code, resp.text, self.cred))

        ctype = (resp.headers.get("content-type") or "").lower()
        blob = resp.content
        mime = "audio/mpeg"

        if "json" in ctype:
            try:
                obj = resp.json()
            except json.JSONDecodeError as e:
                raise ProviderError(f"TTS 返回了无法解析的 JSON：{blob[:200]!r}") from e
            path = (self.mapping.get("response") or {}).get("audio_path", "")
            b64 = dig(obj, path) if path else None
            if not b64:
                raise ProviderError("TTS 的 JSON 里找不到音频（配置 response.audio_path）")
            import base64

            blob = base64.b64decode(b64)
            mime = str(dig(obj, (self.mapping.get("response") or {}).get("mime_path", "")) or "audio/mpeg")
        else:
            mime = ctype.split(";")[0] or "audio/mpeg"

        step = 64 * 1024
        for i in range(0, len(blob), step):
            yield TTSChunk(
                audio=blob[i:i + step], mime=mime, text=text,
                final=(i + step >= len(blob)),
            )

    # ------------------------------------------------------------ 自检

    async def check(self) -> dict:
        """连通性自检：发一次最小请求，不消耗可观额度。

        行为要点：
          - **尊重配置里的 method**。早先这里无条件发 POST，指向一个 GET 接口时
            会稳定收到 405，然后被当成"模块不可用"报给用户 —— 一个纯粹的误报。
          - GET/HEAD 类接口没法带对话 payload，就只验证可达性；
            这一步的目标是回答「地址对不对、鉴权通不通」，不是跑通完整语义。
          - ASR/TTS 不做真实合成请求：空音频/空文本在各家行为不一致，硬试会大量误报。
        """
        import time

        req = self.mapping.get("request") or {}
        method = str(req.get("method") or "POST").upper()
        ctx = build_ctx(self.cred, self.mapping)
        url = _request_url(self.mapping, ctx)
        headers = build_headers(self.mapping, ctx)

        started = time.perf_counter()

        def elapsed() -> int:
            return int((time.perf_counter() - started) * 1000)

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=8.0, read=20.0, write=8.0, pool=8.0)
            ) as client:
                if method in ("GET", "HEAD"):
                    # 非 POST 接口：只问「这个地址在不在、鉴权过不过」
                    resp = await client.request(method, url, headers=headers)
                    ok = resp.status_code < 400
                    note = ""
                    if resp.status_code in (401, 403):
                        ok, note = False, "地址可达但鉴权失败（检查密钥或 header 映射）"
                    elif resp.status_code == 404:
                        note = "地址不存在（检查 request.url 与 base_url 拼接）"
                    return {
                        "ok": ok, "status": resp.status_code, "ms": elapsed(),
                        "note": note or "只验证了可达性与鉴权；语义是否正确要对话时才体现",
                        "message": "" if ok else explain(resp.status_code, resp.text, self.cred),
                    }

                if self.cap in ("llm", "vlm"):
                    body = substitute(req.get("json") or {}, ctx)
                    body = dict(body) if isinstance(body, dict) else {}
                    body["messages"] = [{"role": "user", "content": "ping"}]
                    body["max_tokens"] = 1
                    body["stream"] = False
                    resp = await client.post(url, headers=headers, json=body)
                    return {
                        "ok": resp.status_code < 400,
                        "status": resp.status_code,
                        "ms": elapsed(),
                        "message": "" if resp.status_code < 400 else explain(resp.status_code, resp.text, self.cred),
                    }

                # ASR / TTS：只探端点可达性
                resp = await client.request("OPTIONS", url)
                if resp.status_code in (404, 405):
                    resp = await client.head(url)
                return {
                    "ok": resp.status_code < 500,
                    "status": resp.status_code,
                    "ms": elapsed(),
                    "note": "ASR/TTS 只验证了端点可达；实际识别/合成能力要等真实调用",
                    "message": "" if resp.status_code < 500 else explain(resp.status_code, resp.text, self.cred),
                }
        except httpx.RequestError as e:
            return {
                "ok": False,
                "status": None,
                "ms": elapsed(),
                "message": f"连接失败：{type(e).__name__}: {e}",
            }

    # ------------------------------------------------------------ 内部

    def _extract_text(self, obj: Any) -> Any:
        """按配置取文本；没配就尝试几个最常见的位置。"""
        resp_cfg = self.mapping.get("response") or {}
        path = resp_cfg.get("text_path", "")
        if path:
            return dig(obj, path)
        # 常见位置兜底：OpenAI 风格 / 通用 output / 纯 text
        for candidate in ("choices.0.message.content", "choices.0.text", "output.text",
                          "output_text", "text", "result", "data.text"):
            v = dig(obj, candidate)
            if isinstance(v, str) and v:
                return v
        if isinstance(obj, str):
            return obj
        return None

    @staticmethod
    def _b64(blob: bytes) -> str:
        import base64

        return base64.b64encode(blob).decode("ascii")

    @staticmethod
    def _ext(filename_mime: str) -> str:
        return filename_for(filename_mime)


def filename_for(mime: str) -> str:
    m = (mime or "").lower()
    if "webm" in m:
        return "speech.webm"
    if "ogg" in m or "opus" in m:
        return "speech.ogg"
    if "wav" in m:
        return "speech.wav"
    if "mp4" in m or "aac" in m or "m4a" in m:
        return "speech.m4a"
    return "speech.bin"
