"""模块元数据层 —— 让"这个系统由哪些可替换模块组成"变成可查询、可探测、可扩展的一等公民。

## 为什么要单独做这一层

数字人的四个能力（LLM / ASR / TTS / VLM）本身是可替换的，但如果"有哪些实现、
各自怎么接、现在通不通"只能靠读源码回答，那这套架构就没法交给别人定制。
这一层把三件事变成数据：

    能力契约（capability）  每个能力的数据形状与调用语义
    模块描述（ModuleInfo）  一个具体实现的元数据：协议、端点、字段映射、限制
    健康探测（probe）       现在通不通，不通是哪种不通

## 三层接入方式（从易到难，覆盖不同层次的定制者）

    1. **预设供应商**：改一行注册表即可（本项目自带的那批）
    2. **声明式自定义模块**：用户填 JSON（URL + 字段映射），**不改代码**
       —— 这是"私人定制走自己的 API"的主路径，见 custom_modules.py
    3. **代码级适配器**：把 Python 类放进 modules/ 目录，实现下面四个 Protocol 之一

    `build()` 对未知协议不再直接报错，而是回落到通用转发适配器
    （backend/providers/generic.py），把「写代码」这一步变成「填配置」。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from ..provider_registry import CAP_ASR, CAP_LLM, CAP_TTS, CAP_VLM, ProviderSpec

# ---------------------------------------------------------------- 能力契约

@dataclass(frozen=True)
class CapabilityContract:
    """一个能力的对外契约：数据形状、语义、实现时必须遵守的规则。"""

    cap: str
    label: str
    summary: str
    input_shape: str
    output_shape: str
    streaming: bool
    rules: list[str] = field(default_factory=list)


CAPABILITY_CONTRACTS: list[CapabilityContract] = [
    CapabilityContract(
        cap=CAP_LLM,
        label="大脑 · LLM",
        summary="吃对话消息，流式吐文字增量与工具调用。",
        input_shape="{messages: [{role, content}], tools?: [function schema], temperature, max_tokens}",
        output_shape="LLMDelta 流：{content?: str, tool_calls?: [{id, name, arguments}], finish_reason?}",
        streaming=True,
        rules=[
            "必须是异步生成器，逐块产出增量；不要等整段生成完再一次性返回（首字延迟会毁掉体感）",
            "工具调用按 OpenAI 的流式协议碎片化返回时，适配器要负责拼装完整后再产出",
            "不要把密钥写进日志；错误信息里密钥只允许出现掩码形式",
        ],
    ),
    CapabilityContract(
        cap=CAP_ASR,
        label="耳朵 · ASR",
        summary="吃一段音频字节，返回识别文本。",
        input_shape="audio: bytes（webm/ogg/wav）、mime、sample_rate",
        output_shape="ASRResult {text, language?, duration?}",
        streaming=False,
        rules=[
            "音频是从浏览器整段送来的；如需本机解码，优先用能直接吃容器的库，别强依赖 ffmpeg 可执行文件",
            "识别失败要抛 ProviderError 并给人话原因（例如「未安装依赖」而不是堆栈）",
        ],
    ),
    CapabilityContract(
        cap=CAP_TTS,
        label="嗓子 · TTS",
        summary="吃一句文本，流式吐音频字节。",
        input_shape="text: str（调用方已按句切分）、voice?: str",
        output_shape="TTSChunk 流：{audio: bytes, mime, text, final}",
        streaming=True,
        rules=[
            "编排层会「按句」调用你，所以单次调用只需合成一句话，不必自己切分长文",
            "mime 要如实标注（audio/mpeg、audio/wav…），前端据此解码",
            "若合成交回浏览器（如 speechSynthesis），mime 用 text/browser-tts 这个特殊标记",
        ],
    ),
    CapabilityContract(
        cap=CAP_VLM,
        label="眼睛 · VLM",
        summary="吃一张图（data URL）与一个提问，返回描述文本。",
        input_shape="image: data URL、prompt?: str",
        output_shape="VisionResult {text}",
        streaming=False,
        rules=[
            "图像来自用户屏幕或摄像头，属于隐私数据：不得落盘、不得转存第三方",
            "只做「看一眼就答」，不要在这里做长期缓存",
        ],
    ),
]


def contract_for(cap: str) -> CapabilityContract | None:
    for c in CAPABILITY_CONTRACTS:
        if c.cap == cap:
            return c
    return None


# ---------------------------------------------------------------- 模块描述

#: 协议 → 内置实现类所在的模块（仅用于展示「怎么接进来的」）
PROTOCOL_HINT = {
    "openai": "走 OpenAI 兼容协议（/chat/completions 或 /audio/*），字段可映射",
    "openai-simple": "OpenAI 兼容的简化变体",
    "local": "本机离线实现，不联网",
    "browser": "由浏览器侧完成，后端只发指令",
    "none": "该能力关闭",
    "local-faster-whisper": "本机 faster-whisper 推理",
    "local-piper": "本机 Piper 合成",
    "generic-http": "声明式自定义模块：按字段映射转发到任意 HTTP 接口",
    "python": "代码级适配器：实现 Protocol 的 Python 类",
}


@dataclass
class ModuleInfo:
    """一个具体实现模块的完整描述。前端「模块面板」直接渲染它。"""

    cap: str
    id: str
    label: str
    protocol: str
    origin: str = "builtin"          # builtin | custom（用户自定义）| adapter（代码级）
    base_url: str = ""
    default_model: str = ""
    needs_key: bool = True
    local: bool = False
    docs: str = ""
    env_key: str = ""
    #: 声明式字段映射（自定义模块用），None 表示走协议内置实现
    mapping: dict[str, Any] | None = None
    #: 已知限制，例如「不支持工具调用」「并发上限」
    notes: list[str] = field(default_factory=list)

    def to_public(self) -> dict:
        """给前端的形态：**绝不包含任何密钥**。"""
        d = asdict(self)
        d["protocol_hint"] = PROTOCOL_HINT.get(self.protocol, "")
        return d

    @classmethod
    def from_spec(cls, spec: ProviderSpec) -> "ModuleInfo":
        notes: list[str] = []
        if spec.local:
            notes.append("本机推理：不联网、不吃月费，但占用本机算力")
        if not spec.needs_key:
            notes.append("不需要密钥")
        return cls(
            cap=spec.cap,
            id=spec.id,
            label=spec.label,
            protocol=spec.protocol,
            origin="builtin",
            base_url=spec.base_url,
            default_model=spec.default_model,
            needs_key=spec.needs_key,
            local=spec.local,
            docs=spec.docs,
            env_key=spec.env_key,
            notes=notes,
        )


def catalog() -> dict[str, Any]:
    """完整的能力与模块清单。前端的架构视图就吃这个。"""
    from ..provider_registry import list_specs

    caps: dict[str, Any] = {}
    for contract in CAPABILITY_CONTRACTS:
        modules = [ModuleInfo.from_spec(s).to_public() for s in list_specs(contract.cap)]
        caps[contract.cap] = {
            "contract": asdict(contract),
            "modules": modules,
        }
    return {
        "capabilities": caps,
        "protocols": PROTOCOL_HINT,
        "layers": [
            {"name": "前端", "role": "Live2D / 三件套 / 换肤 / 采集", "dir": "web/"},
            {"name": "传输", "role": "WebSocket 双向事件流 + HTTP 管理面", "dir": "backend/api/"},
            {"name": "编排", "role": "会话记忆、逐句 TTS、工具循环、打断", "dir": "backend/core/"},
            {"name": "模块", "role": "四能力可替换实现 + 自定义接入", "dir": "backend/providers/"},
            {"name": "适配", "role": "协议方言与字段映射，把任意 API 接成模块", "dir": "backend/providers/generic.py"},
        ],
    }
