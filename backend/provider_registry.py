"""四个能力接口 + 每接口的供应商注册表。

为什么要「注册表」而不直接把密钥写死在代码里：
    数字人项目换供应商是常态（价格、延迟、合规、某个模型突然下线）。
    只要供应商说 OpenAI 兼容协议，这里加一行就能用，
    用户也能在网页设置里填自己的 base_url + key 走同一套代码路径。

自带密钥的传递方式（重要）：
    前端把密钥放进请求头 x-provider-* 发过来，后端只在此次请求的生命周期内持有，
    不写文件、不进数据库、不打日志（见 mask_key 的用途）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# ---------------------------------------------------------------- 能力常量

CAP_LLM = "llm"
CAP_ASR = "asr"
CAP_TTS = "tts"
CAP_VLM = "vlm"

CAPS = (CAP_LLM, CAP_ASR, CAP_TTS, CAP_VLM)

# 请求头前缀：x-provider-llm-key / x-provider-tts-base-url ...
HEADER_PREFIX = "x-provider-"


@dataclass(frozen=True)
class ProviderSpec:
    """一个供应商的静态描述。"""

    id: str
    label: str
    cap: str
    protocol: str  # openai | browser | none | piper（决定用哪套客户端实现）
    base_url: str = ""
    default_model: str = ""
    env_key: str = ""  # 服务端兜底密钥所在的环境变量名
    docs: str = ""
    needs_key: bool = True
    local: bool = False  # 本机推理（不联网、不吃月费，但吃显卡/CPU）


def _specs() -> list[ProviderSpec]:
    s: list[ProviderSpec] = []

    # ---------------- LLM（大脑）----------------
    s += [
        ProviderSpec("echo", "离线回声（无需密钥）", CAP_LLM, "local",
                     default_model="echo-1", needs_key=False),
        ProviderSpec("openai", "OpenAI", CAP_LLM, "openai",
                     "https://api.openai.com/v1", "gpt-4o-mini", "OPENAI_API_KEY",
                     "https://platform.openai.com/docs/api-reference"),
        ProviderSpec("deepseek", "DeepSeek", CAP_LLM, "openai",
                     "https://api.deepseek.com/v1", "deepseek-chat", "DEEPSEEK_API_KEY",
                     "https://platform.deepseek.com/api-docs"),
        ProviderSpec("siliconflow", "硅基流动 SiliconFlow", CAP_LLM, "openai",
                     "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct",
                     "SILICONFLOW_API_KEY", "https://docs.siliconflow.cn"),
        ProviderSpec("dashscope", "阿里云百炼 DashScope", CAP_LLM, "openai",
                     "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "qwen-plus", "DASHSCOPE_API_KEY",
                     "https://help.aliyun.com/zh/model-studio"),
        ProviderSpec("zhipu", "智谱 GLM", CAP_LLM, "openai",
                     "https://open.bigmodel.cn/api/paas/v4", "glm-4-flash", "ZHIPU_API_KEY",
                     "https://open.bigmodel.cn/dev/api"),
        ProviderSpec("moonshot", "月之暗面 Kimi", CAP_LLM, "openai",
                     "https://api.moonshot.cn/v1", "moonshot-v1-8k", "MOONSHOT_API_KEY",
                     "https://platform.moonshot.cn/docs"),
        ProviderSpec("ollama", "Ollama（本机）", CAP_LLM, "openai",
                     "http://127.0.0.1:11434/v1", "qwen2.5:7b", "",
                     "https://ollama.com", needs_key=False, local=True),
        ProviderSpec("custom", "自定义（OpenAI 兼容）", CAP_LLM, "openai", "", "", "", ""),
    ]

    # ---------------- ASR（耳朵）----------------
    s += [
        ProviderSpec("browser", "浏览器原生识别（零成本）", CAP_ASR, "browser",
                     default_model="browser-native", needs_key=False),
        ProviderSpec("openai", "OpenAI Whisper", CAP_ASR, "openai",
                     "https://api.openai.com/v1", "whisper-1", "OPENAI_API_KEY"),
        ProviderSpec("siliconflow", "硅基流动（SenseVoice）", CAP_ASR, "openai",
                     "https://api.siliconflow.cn/v1", "FunAudioLLM/SenseVoiceSmall",
                     "SILICONFLOW_API_KEY"),
        ProviderSpec("dashscope", "阿里云百炼（Paraformer）", CAP_ASR, "openai",
                     "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "paraformer-realtime-v2", "DASHSCOPE_API_KEY"),
        ProviderSpec("faster-whisper", "本机 faster-whisper", CAP_ASR, "local-faster-whisper",
                     default_model="small", needs_key=False, local=True,
                     docs="需安装 ffmpeg 与 `uv sync --extra local-asr`"),
        ProviderSpec("custom", "自定义（OpenAI 兼容）", CAP_ASR, "openai", "", "", ""),
    ]

    # ---------------- TTS（嗓子）----------------
    s += [
        ProviderSpec("browser", "浏览器语音合成（零成本）", CAP_TTS, "browser",
                     default_model="browser-native", env_key=""),
        ProviderSpec("openai", "OpenAI TTS", CAP_TTS, "openai",
                     "https://api.openai.com/v1", "gpt-4o-mini-tts", "OPENAI_API_KEY"),
        ProviderSpec("siliconflow", "硅基流动（CosyVoice）", CAP_TTS, "openai",
                     "https://api.siliconflow.cn/v1", "FunAudioLLM/CosyVoice2-0.5B",
                     "SILICONFLOW_API_KEY"),
        ProviderSpec("dashscope", "阿里云百炼（CosyVoice）", CAP_TTS, "openai",
                     "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "cosyvoice-v1", "DASHSCOPE_API_KEY"),
        ProviderSpec("piper", "本机 Piper", CAP_TTS, "local-piper",
                     default_model="zh_CN-huayan-medium", needs_key=False, local=True,
                     docs="需 `uv sync --extra local-tts`，模型放 assets/models/piper/"),
        ProviderSpec("custom", "自定义（OpenAI 兼容）", CAP_TTS, "openai", "", "", ""),
    ]

    # ---------------- VLM（眼睛）----------------
    s += [
        ProviderSpec("none", "关闭视觉", CAP_VLM, "none", needs_key=False),
        ProviderSpec("zhipu", "智谱 GLM-4V", CAP_VLM, "openai",
                     "https://open.bigmodel.cn/api/paas/v4", "glm-4v-flash", "ZHIPU_API_KEY"),
        ProviderSpec("dashscope", "通义千问 VL", CAP_VLM, "openai",
                     "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "qwen-vl-plus", "DASHSCOPE_API_KEY"),
        ProviderSpec("openai", "OpenAI 视觉", CAP_VLM, "openai",
                     "https://api.openai.com/v1", "gpt-4o-mini", "OPENAI_API_KEY"),
        ProviderSpec("siliconflow", "硅基流动（Qwen2.5-VL）", CAP_VLM, "openai",
                     "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-VL-7B-Instruct",
                     "SILICONFLOW_API_KEY"),
        ProviderSpec("ollama", "Ollama 本机视觉", CAP_VLM, "openai",
                     "http://127.0.0.1:11434/v1", "llava", "", needs_key=False, local=True),
        ProviderSpec("custom", "自定义（OpenAI 兼容）", CAP_VLM, "openai", "", "", ""),
    ]
    return s


REGISTRY: list[ProviderSpec] = _specs()

#: 用户自定义模块（声明式，来自 data/custom_modules.json）。
#: 与内置分开存：内置是代码里写死的常量，自定义是运行时增删的运行态数据，
#: 混在一起会让「重新加载配置」变成一件需要小心的事。
CUSTOM_REGISTRY: list[ProviderSpec] = []


def add_custom_module(spec: ProviderSpec) -> None:
    """注册（或覆盖）一个自定义模块。同一 cap+id 只保留一份。"""
    global CUSTOM_REGISTRY
    CUSTOM_REGISTRY = [
        x for x in CUSTOM_REGISTRY if not (x.cap == spec.cap and x.id == spec.id)
    ]
    CUSTOM_REGISTRY.append(spec)


def clear_custom_modules() -> None:
    global CUSTOM_REGISTRY
    CUSTOM_REGISTRY = []


def list_specs(cap: str | None = None) -> list[ProviderSpec]:
    """给前端设置面板用的供应商清单（不含任何密钥值）。"""
    all_specs = list(REGISTRY) + list(CUSTOM_REGISTRY)
    if cap is None:
        return all_specs
    return [x for x in all_specs if x.cap == cap]


def find(cap: str, provider_id: str) -> ProviderSpec | None:
    # 自定义优先：同一个 id 若被用户重定义过，应该用用户那份
    for x in CUSTOM_REGISTRY:
        if x.cap == cap and x.id == provider_id:
            return x
    for x in REGISTRY:
        if x.cap == cap and x.id == provider_id:
            return x
    return None


@dataclass
class ResolvedCredential:
    """一次调用的最终参数：来自「用户自带」或「服务端兜底」。"""

    cap: str
    provider: str
    model: str
    base_url: str
    api_key: str
    voice: str = ""
    source: str = "default"  # user | server | default | none

    @property
    def masked(self) -> str:
        return mask_key(self.api_key)


def mask_key(key: str) -> str:
    """日志里唯一允许出现的密钥形态。"""
    if not key:
        return "(none)"
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}…{key[-4:]}"


def resolve(
    cap: str,
    *,
    header_overrides: Mapping[str, str] | None = None,
    env: Mapping[str, str] | None = None,
    default_provider_getter=None,
) -> ResolvedCredential:
    """把「用户请求头 → 服务端环境变量 → 内置默认」三级合并成最终凭据。

    header_overrides 里期待这些键（HTTP 头已小写化、下划线换连字符）：
        provider, model, base-url, key, voice
    """
    env = env if env is not None else os.environ
    h = {k.lower(): v for k, v in (header_overrides or {}).items() if v}

    provider = h.get("provider") or (
        default_provider_getter(cap) if default_provider_getter else ""
    ) or _env(env, f"DH_{cap.upper()}_PROVIDER") or _fallback_provider(cap)

    spec = find(cap, provider) or find(cap, _fallback_provider(cap))
    if spec is None:  # 理论上不可达
        return ResolvedCredential(cap, provider, "", "", "", source="none")

    model = (
        h.get("model")
        or _env(env, f"DH_{cap.upper()}_MODEL")
        or spec.default_model
        or _custom_default(cap, spec.id, "default_model")
    )
    base_url = (
        h.get("base-url")
        or _env(env, f"DH_{cap.upper()}_BASE_URL")
        or spec.base_url
        or _custom_default(cap, spec.id, "base_url")
    ).rstrip("/")

    user_key = h.get("key", "")
    env_key = _env(env, spec.env_key) if spec.env_key else ""
    env_key = env_key or _env(env, f"DH_{cap.upper()}_API_KEY")
    api_key = user_key or env_key

    source = "user" if user_key else ("server" if env_key else ("n/a" if not spec.needs_key else "none"))
    voice = h.get("voice") or _env(env, f"DH_{cap.upper()}_VOICE") or ""

    return ResolvedCredential(
        cap=cap, provider=spec.id, model=model, base_url=base_url,
        api_key=api_key, voice=voice, source=source,
    )


def _env(env: Mapping[str, str], name: str) -> str:
    return (env.get(name) or "").strip() if name else ""


def _custom_default(cap: str, provider_id: str, field: str) -> str:
    """自定义模块的 base_url / model 从它的配置文件里取。

    为什么要有这条兜底：ProviderSpec 只带得动「标识」，映射细节在
    data/custom_modules.json 里。resolve() 必须能读到 base_url，
    否则用户在前端选了自定义模块、却没在表单里重复填一遍地址时，
    这里会拿到空串 → 请求发不出去 → 表现为「选了没反应」。
    """
    try:
        from .core.custom_modules import load_all
    except ImportError:
        return ""
    for s in load_all():
        if s.cap == cap and s.id == provider_id:
            return str(getattr(s, field, "") or "")
    return ""


def _fallback_provider(cap: str) -> str:
    return {
        CAP_LLM: "echo",
        CAP_ASR: "browser",
        CAP_TTS: "browser",
        CAP_VLM: "none",
    }[cap]


def headers_to_overrides(headers: Mapping[str, str]) -> dict[str, dict[str, str]]:
    """把请求头里的 x-provider-<cap>-<field> 拆成 {cap: {field: value}}。

    不用正则魔法，只做白名单解析 —— 免得哪天某个反代加了奇怪的头发过来被误读。
    """
    fields = ("provider", "model", "base-url", "key", "voice")
    out: dict[str, dict[str, str]] = {}
    for raw_name, raw_value in headers.items():
        name = raw_name.lower()
        if not name.startswith(HEADER_PREFIX):
            continue
        rest = name[len(HEADER_PREFIX):]
        for cap in CAPS:
            if rest.startswith(cap + "-"):
                field = rest[len(cap) + 1:]
                if field in fields and raw_value:
                    out.setdefault(cap, {})[field] = raw_value.strip()
    return out


def url_to_overrides(query: Mapping[str, str]) -> dict[str, dict[str, str]]:
    """URL 查询串版本的自带密钥通道。

    为什么需要它：浏览器的 WebSocket 构造函数**无法自定义请求头**，
    所以前端从网页发起的连接只能把配置塞进 URL。
    代价是这个 query 里会出现密钥 —— 因此后端必须保证：
        1) 永不记录 WS 的完整 URL（见 api/chat.py 的日志规范）
        2) 只在连接生命周期内持有，不落盘

    格式：?p=llm.provider:deepseek,llm.key:sk-xxx&p=tts.provider:openai
    （用逗号分隔是因为同一个 cap 可能有多个字段，而重复的 query key 解析行为各家框架不一致）
    """
    out: dict[str, dict[str, str]] = {}
    raw_values = query.getlist("p") if hasattr(query, "getlist") else [query.get("p")]
    for raw in raw_values:
        if not raw:
            continue
        for pair in raw.split(","):
            if ":" not in pair:
                continue
            path, value = pair.split(":", 1)
            path, value = path.strip(), value.strip()
            if "." not in path or not value:
                continue
            cap, field = path.split(".", 1)
            field = field.replace("_", "-")
            if cap in CAPS and field in ("provider", "model", "base-url", "key", "voice"):
                out.setdefault(cap, {})[field] = value
    return out


def merge_overrides(*sources: Mapping[str, Mapping[str, str]]) -> dict[str, dict[str, str]]:
    """合并多来源覆盖，后者优先（URL 参数优先于请求头，前端显式选择优先于代理注入）。"""
    out: dict[str, dict[str, str]] = {}
    for src in sources:
        for cap, fields in (src or {}).items():
            out.setdefault(cap, {}).update(fields)
    return out
