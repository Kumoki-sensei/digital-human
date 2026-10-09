"""工具层：「能做」就落在这里。

两条执行路径：

    server  —— 后端直接干（查时间、查天气、读文件、调视觉模型、写笔记）
    client  —— 后端把请求丢给前端，前端干完回传（改皮肤、播放动作、
                读浏览器信息、调前端本地方便的能力）

写操作必须走「确认中心」：模型提出 → 前端弹确认 → 用户点头才真正执行。
原因是 LLM 会自作主张，而删文件/发消息这种操作不可撤销。

这里刻意只放「通用无副作用」工具的示例实现，业务工具（订单、工单、
知识库）请按同一形状追加，别把业务逻辑写进编排层。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import platform
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ..providers.base import FunctionSchema

log = logging.getLogger(__name__)


@dataclass
class ToolResult:
    ok: bool
    content: str
    data: dict = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    side: str = "server"          # server | client
    requires_confirm: bool = False
    handler: Callable[..., Awaitable[ToolResult]] | None = None

    def schema(self) -> FunctionSchema:
        return FunctionSchema(name=self.name, description=self.description, parameters=self.parameters)


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.side == "server" and tool.handler is None:
            raise ValueError(f"服务端工具 {tool.name} 必须提供 handler")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def schemas(self, names: list[str] | None = None) -> list[FunctionSchema]:
        tools = self.all() if names is None else [t for t in self.all() if t.name in names]
        return [t.schema() for t in tools]

    def describe(self) -> list[dict]:
        """给前端「能力清单」面板用。"""
        return [
            {
                "name": t.name,
                "description": t.description,
                "side": t.side,
                "requires_confirm": t.requires_confirm,
                "parameters": t.parameters,
            }
            for t in self.all()
        ]


registry = ToolRegistry()


# ---------------------------------------------------------------- 内置工具

async def _now(timezone: str = "local") -> ToolResult:
    now = dt.datetime.now()
    return ToolResult(
        ok=True,
        content=now.strftime("%Y-%m-%d %H:%M:%S %A"),
        data={"iso": now.isoformat(), "tz": timezone},
    )


async def _system_info() -> ToolResult:
    info = {
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "machine": platform.machine(),
    }
    return ToolResult(ok=True, content=f"运行环境：{info['os']}，Python {info['python']}", data=info)


async def _remember(note: str) -> ToolResult:
    """把一件事写进会话的「长期便签」，下次进上下文。"""
    from .session import store as _store  # 延迟导入避免环

    _store  # 占位：真正的写入由 brain 注入的会话完成，见 brain 的 tool 分发
    return ToolResult(ok=True, content=f"已记下：{note}", data={"note": note})


def register_builtin_tools() -> None:
    if registry.get("get_current_time"):
        return
    registry.register(Tool(
        name="get_current_time",
        description="获取当前日期与时间。当用户问「现在几点」「今天几号」时使用。",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        handler=_now,
    ))
    registry.register(Tool(
        name="get_system_info",
        description="获取数字人自身运行环境信息（操作系统、Python 版本）。",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        handler=_system_info,
    ))
    registry.register(Tool(
        name="set_theme",
        description=(
            "切换网页界面皮肤。当用户说「换个皮肤」「换个风格」「界面太暗了」时使用。"
            "可选皮肤 id 由前端提供。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "theme_id": {"type": "string", "description": "皮肤 id，例如 midnight / sakura / terminal"}
            },
            "required": ["theme_id"],
            "additionalProperties": False,
        },
        side="client",
    ))
    registry.register(Tool(
        name="set_expression",
        description="改变当前表情与情绪表现。可选值：neutral / happy / angry / sad / surprised / shy。",
        parameters={
            "type": "object",
            "properties": {"emotion": {"type": "string"}, "intensity": {"type": "number"}},
            "required": ["emotion"],
            "additionalProperties": False,
        },
        side="client",
    ))
    registry.register(Tool(
        name="look_at_screen",
        description="截取用户屏幕或摄像头画面并识别内容。仅在用户明确要求「看看我的屏幕/摄像头」时调用。",
        parameters={
            "type": "object",
            "properties": {
                "source": {"type": "string", "enum": ["screen", "camera"]},
                "question": {"type": "string", "description": "想问这张图的问题"},
            },
            "required": ["source"],
            "additionalProperties": False,
        },
        side="client",
        requires_confirm=True,  # 涉及隐私，必须用户点头
    ))
