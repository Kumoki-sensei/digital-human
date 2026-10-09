"""声明式自定义模块 —— 「私人定制走自己的 API」的主路径。

## 这个文件解决什么问题

之前要把自己的接口接进来，必须改 `provider_registry.py` 加一行、必要时再写一个
适配器类。**那叫补丁，不叫架构。** 这里让定制者只做两件事：

    1. 在网页「模块」面板里填一份 JSON（接口地址、模型名、请求字段怎么摆、响应字段怎么取）
    2. 填自己的密钥（密钥仍只留浏览器，见下）

就结束了 —— 不碰任何 Python 文件。

## 一份自定义模块长什么样

```json
{
  "cap": "llm",
  "id": "my-brain",
  "label": "我自己的大脑",
  "protocol": "generic-http",
  "base_url": "https://my-server.com/v1",
  "default_model": "my-model",
  "bypass_prefix": true,
  "request": {
    "url": "{base_url}/chat/completions",
    "method": "POST",
    "headers": { "Content-Type": "application/json" },
    "json": {
      "model": "{model}",
      "messages": "{messages}",
      "stream": true,
      "temperature": "{temperature}"
    },
    "stream": true,
    "stream_json_path": "choices.0.delta.content"
  },
  "response": { "text_path": "choices.0.message.content" }
}
```

要点：
    - `{...}` 是占位符，由转发器在调用时替换（{base_url} {model} {api_key} {messages} …）
    - **`bypass_prefix: true` 时不会自动补 /v1**，直接把 base_url 当完整前缀用
    - `stream=true` 走 SSE 逐行解析，`stream_json_path` 指到「这一行里哪一段是增量文本」
    - 不支持流式的接口就把 `stream` 设 false，用 `response.text_path` 一次取回

## 密钥怎么处理（重要）

`data/custom_modules.json` **只能存端点与字段映射，不该存密钥**，
并且写入前会自动剔除密钥字段以防手滑。

那密钥从哪来？仍然走原有通道：前端把它放进连接参数（`p=llm.key:...`），
后端只在此次连接的生命周期内持有。这样设计是因为——自定义模块配置文件会被
备份、会被拷给别人、会被塞进仓库；密钥一旦落进去，就一定会泄漏。
需要静态 token 的场景（例如某些自建服务用固定 Bearer），请让后端自己从环境变量读，
别写进这个文件。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..provider_registry import CAP_ASR, CAP_LLM, CAP_TTS, CAP_VLM, CAPS, ProviderSpec, add_custom_module

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
STORE = ROOT / "data" / "custom_modules.json"

SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,40}$")

#: 允许出现在配置文件里的字段（白名单）。密钥类字段一律不允许。
ALLOWED_FIELDS = (
    "cap", "id", "label", "protocol", "base_url", "default_model",
    "docs", "request", "response", "stream", "notes",
    "chunk_text_path", "bypass_prefix", "headers_from_env", "timeout_seconds",
)

FORBIDDEN_FIELDS = ("key", "api_key", "apikey", "token", "secret", "password", "authorization")

#: 自定义模块支持的协议
SUPPORTED_PROTOCOLS = ("generic-http", "openai")


@dataclass
class CustomModuleSpec:
    cap: str
    id: str
    label: str
    protocol: str = "generic-http"
    base_url: str = ""
    default_model: str = ""
    docs: str = ""
    request: dict[str, Any] = field(default_factory=dict)
    response: dict[str, Any] = field(default_factory=dict)
    stream: bool = True
    chunk_text_path: str = ""
    notes: list[str] = field(default_factory=list)
    bypass_prefix: bool = True
    headers_from_env: dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = 60.0

    def to_provider_spec(self) -> ProviderSpec:
        """转成注册表能吃的形态。注意 needs_key 恒为 True：
        自定义服务几乎都要鉴权，而密钥走前端通道，不落盘。"""
        return ProviderSpec(
            id=self.id,
            label=self.label,
            cap=self.cap,
            protocol=self.protocol,
            base_url=self.base_url,
            default_model=self.default_model,
            env_key="",
            docs=self.docs,
            needs_key=True,
            local=False,
        )

    def validate(self) -> list[str]:
        """返回问题列表（空 = 通过）。宁可拒绝，也不要让一个半配置的模块进注册表 —— 
        那样错误会推迟到对话时才炸，排查成本高得多。"""
        problems: list[str] = []
        if self.cap not in CAPS:
            problems.append(f"cap 必须是 {'/'.join(CAPS)} 之一，实得 {self.cap!r}")
        if not SAFE_ID.match(self.id or ""):
            problems.append(
                f"id 只能用小写字母/数字/下划线/短横线（2~41 位），实得 {self.id!r}"
            )
        if self.id in _RESERVED_IDS:
            problems.append(f"id {self.id!r} 与内置模块重名，换一个")
        if not (self.label or "").strip():
            problems.append("label（显示名）不能为空")
        if self.protocol not in SUPPORTED_PROTOCOLS:
            problems.append(
                f"protocol 目前支持 {'/'.join(SUPPORTED_PROTOCOLS)}；"
                "更复杂的协议请用「代码级适配器」（modules/ 目录）"
            )
        if not (self.base_url or "").strip() and self.protocol == "generic-http":
            problems.append("generic-http 必须填 base_url")
        if self.protocol == "generic-http":
            url = (self.request or {}).get("url", "")
            if not url:
                problems.append("request.url 不能为空（例如 {base_url}/chat/completions）")
            elif "http" not in url and not url.startswith("{"):
                problems.append("request.url 看起来既不是 URL 也没有占位符，检查一下")
            text_path = self.chunk_text_path or (self.response or {}).get("text_path", "")
            if not text_path:
                problems.append("必须给 chunk_text_path（流式）或 response.text_path（非流式），否则拿不到文本")
        return problems


#: 内置模块 id，避免自定义模块把它们顶掉
_RESERVED_IDS = {
    "echo", "openai", "deepseek", "siliconflow", "dashscope", "zhipu", "moonshot",
    "ollama", "custom", "browser", "faster-whisper", "piper", "none",
}


# ---------------------------------------------------------------- 存取

def _sanitize(raw: dict) -> dict:
    """白名单过滤 + 剔除任何疑似密钥字段。"""
    out: dict[str, Any] = {}
    dropped: list[str] = []
    for k, v in (raw or {}).items():
        lk = str(k).lower()
        if any(bad in lk for bad in FORBIDDEN_FIELDS):
            dropped.append(str(k))
            continue
        if k not in ALLOWED_FIELDS:
            dropped.append(str(k))
            continue
        out[k] = v
    if dropped:
        log.warning(
            "自定义模块配置里忽略了这些字段（白名单外或疑似密钥）：%s",
            ", ".join(sorted(set(dropped))),
        )
    return out


def _from_dict(raw: dict) -> CustomModuleSpec:
    data = _sanitize(raw)
    known = {f for f in CustomModuleSpec.__dataclass_fields__}
    clean = {k: v for k, v in data.items() if k in known}
    spec = CustomModuleSpec(**clean)
    # 字段类型兜底：配置文件是人手写的，什么都可能塞进来
    if not isinstance(spec.request, dict):
        spec.request = {}
    if not isinstance(spec.response, dict):
        spec.response = {}
    if not isinstance(spec.notes, list):
        spec.notes = []
    try:
        spec.timeout_seconds = float(spec.timeout_seconds)
    except (TypeError, ValueError):
        spec.timeout_seconds = 60.0
    return spec


def load_all() -> list[CustomModuleSpec]:
    if not STORE.exists():
        return []
    try:
        raw = json.loads(STORE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log.warning("自定义模块配置读取失败（按空处理）：%s", e)
        return []
    items = raw.get("modules", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    out: list[CustomModuleSpec] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        spec = _from_dict(it)
        problems = spec.validate()
        if problems:
            log.warning("跳过无效的自定义模块 %r：%s", spec.id, "；".join(problems))
            continue
        out.append(spec)
    return out


def save_all(specs: list[CustomModuleSpec]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "_comment": (
            "自定义模块配置。**不要在这里写密钥**（写入时会被自动剔除）。"
            "密钥请在前端「模块」面板里填写：它只存在浏览器 localStorage，"
            "连接时随请求传入，后端不落盘。"
        ),
        "modules": [asdict(s) for s in specs],
    }
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STORE)


# ---------------------------------------------------------------- 注册

def apply_to_registry(specs: list[CustomModuleSpec] | None = None) -> list[str]:
    """把配置里的模块注入注册表。幂等：同一 id 反复注入只保留最新一份。"""
    specs = specs if specs is not None else load_all()
    ids: list[str] = []
    for s in specs:
        add_custom_module(s.to_provider_spec())
        ids.append(f"{s.cap}/{s.id}")
    if ids:
        log.info("已装载 %d 个自定义模块：%s", len(ids), ", ".join(ids))
    return ids


def upsert(spec: CustomModuleSpec) -> None:
    specs = [s for s in load_all() if not (s.cap == spec.cap and s.id == spec.id)]
    specs.append(spec)
    save_all(specs)
    apply_to_registry(specs)


def remove(cap: str, module_id: str) -> bool:
    specs = load_all()
    kept = [s for s in specs if not (s.cap == cap and s.id == module_id)]
    if len(kept) == len(specs):
        return False
    save_all(kept)
    # 注册表里的旧条目也要摘掉：add_custom_module 只增不减，
    # 所以重新注入一遍「当前有效集合」，再让它把不属于自己的清掉。
    _rebuild_registry(kept)
    return True


def _rebuild_registry(specs: list[CustomModuleSpec]) -> None:
    """按给定集合重建自定义区（内置模块不受影响）。"""
    from ..provider_registry import clear_custom_modules

    clear_custom_modules()
    for s in specs:
        add_custom_module(s.to_provider_spec())


def from_payload(payload: dict) -> tuple[CustomModuleSpec | None, list[str]]:
    """把请求体转成 spec，返回 (spec, 问题列表)。"""
    spec = _from_dict(payload)
    problems = spec.validate()
    if problems:
        return None, problems
    return spec, []


def store_path() -> str:
    return str(STORE)
