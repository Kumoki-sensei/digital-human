"""能力工厂：把「供应商 id + 凭据」变成可直接调用的对象。

编排层只认 base.py 里的四个 Protocol，不认具体类名 —— 这样加供应商
（改注册表 + 必要时加一个 client 类）不会碰到业务代码。
"""

from __future__ import annotations

from ..provider_registry import CAP_ASR, CAP_LLM, CAP_TTS, CAP_VLM, ResolvedCredential, find
from .asr import BrowserASR, LocalWhisperASR, OpenAISpeechASR
from .base import ProviderError
from .llm import EchoLLM, OpenAICompatLLM
from .tts import BrowserTTS, OpenAICompatTTS, PiperTTS
from .vlm import NoneVLM, OpenAICompatVLM

_BUILDERS = {
    (CAP_LLM, "local"): EchoLLM,
    (CAP_LLM, "openai"): OpenAICompatLLM,
    (CAP_ASR, "browser"): BrowserASR,
    (CAP_ASR, "local-faster-whisper"): LocalWhisperASR,
    (CAP_ASR, "openai"): OpenAISpeechASR,
    (CAP_TTS, "browser"): BrowserTTS,
    (CAP_TTS, "local-piper"): PiperTTS,
    (CAP_TTS, "openai"): OpenAICompatTTS,
    (CAP_VLM, "none"): NoneVLM,
    (CAP_VLM, "openai"): OpenAICompatVLM,
}


def build(cred: ResolvedCredential):
    spec = find(cred.cap, cred.provider)
    if spec is None:
        raise ProviderError(f"未知供应商：{cred.cap}/{cred.provider}")

    # 声明式自定义模块：配置里带着「URL + 字段映射」，交给通用转发器。
    # 于是「我的接口长得跟 OpenAI 不一样」不再需要写 Python —— 这是模块化定制的关键一步。
    if spec.protocol == "generic-http":
        from ..core import custom_modules
        from .generic import GenericHTTP

        mapping = next(
            (s for s in custom_modules.load_all() if s.cap == cred.cap and s.id == cred.provider),
            None,
        )
        if mapping is None:
            raise ProviderError(
                f"自定义模块 {cred.provider} 找不到配置：请在网页「模块」面板里补全，"
                "或检查 data/custom_modules.json 是否被改坏了"
            )
        return GenericHTTP(cred, _mapping_to_dict(mapping))

    cls = _BUILDERS.get((cred.cap, spec.protocol))
    if cls is None:
        raise ProviderError(
            f"供应商 {cred.provider} 的协议 {spec.protocol} 尚无实现。"
            "常见原因：这是自定义模块，但 protocol 没设成 generic-http。"
        )
    return cls(cred)


def build_generic(cred: ResolvedCredential, mapping: dict):
    """直接按给定映射构造转发器（供「模块自检」用，不需要先落盘配置）。"""
    from .generic import GenericHTTP

    return GenericHTTP(cred, mapping or {})


def _mapping_to_dict(spec) -> dict:
    """把 CustomModuleSpec 摊平成转发器要的字典。

    用 asdict 而不是手写字段清单：以后给 spec 加字段，转发器自动就能拿到，
    不会出现「配置加了、转发器没跟上」这种静默失效。
    """
    from dataclasses import asdict

    d = asdict(spec)
    return {
        "request": d.get("request") or {},
        "response": d.get("response") or {},
        "chunk_text_path": d.get("chunk_text_path") or "",
        "stream": d.get("stream", True),
        "timeout_seconds": d.get("timeout_seconds", 60.0),
        "bypass_prefix": d.get("bypass_prefix", True),
    }


# 便捷函数，纯为调用处可读性
def build_llm(cred: ResolvedCredential):  return build(cred)
def build_asr(cred: ResolvedCredential):  return build(cred)
def build_tts(cred: ResolvedCredential):  return build(cred)
def build_vlm(cred: ResolvedCredential):  return build(cred)


__all__ = [
    "build", "build_llm", "build_asr", "build_tts", "build_vlm", "build_generic",
    "ProviderError",
]
