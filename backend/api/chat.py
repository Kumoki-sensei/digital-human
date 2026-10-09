"""WebSocket 对话通道 —— 整个数字人的实时主干。

连接内状态机（每个连接一份）：
    idle ──文本/音频──▶ running ──done/error──▶ idle
      ▲                    │
      └──── interrupt ─────┘
    轮次运行在独立 asyncio.Task 里，所以「打断」就是 cancel 这个任务：
    LLM 的流、TTS 的请求会一起断掉，这才是真正的 barge-in，
    而不是「等它念完再听你说」。

关于二进制帧：约定每个二进制帧都属于「最近一条带 mime 的 JSON 指令」。
    整段录音：先发 {"type":"audio_final",...}，紧接着一个二进制帧。
    分片录音：连续发 {"type":"audio_chunk"} + 二进制帧，收到 final:true 才开始识别。
    音频下行同理反向：audio_begin 之后紧跟一个二进制帧。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..core.brain import Brain
from ..core.persona import build_system_prompt
from ..core.session import Session, Message, store
from ..core.tools import register_builtin_tools, registry as tool_registry
from ..provider_registry import headers_to_overrides, merge_overrides, url_to_overrides
from ..providers.base import ProviderError

log = logging.getLogger(__name__)
router = APIRouter()

CLIENT_TOOL_TIMEOUT = 90.0

# 日志卫生：WS 的 query 里可能带着用户自带的密钥，任何日志都不能打印完整 URL。
# 需要排查时只打 session id 与「哪些能力被覆盖」。
SAFE_LOG_KEYS = ("session_id",)


class Connection:
    def __init__(self, ws: WebSocket, session_id: str | None):
        self.ws = ws
        self.session_id = session_id
        self.overrides: dict[str, dict[str, str]] = {}
        self.config = {
            "persona_name": settings.persona_name,
            "persona_style": settings.persona_style,
            "mode": "voice",
            "tts_enabled": True,
            "speak": True,
            "tool_names": None,
        }
        self.session = store.get(
            session_id, build_system_prompt(Session(session_id), name=settings.persona_name)
        )
        self.task: asyncio.Task | None = None
        self.audio_buf = bytearray()
        self.pending_audio_meta: dict | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()

    # -------------------------------------------------------- 发送

    async def send_event(self, ev) -> None:
        payload: dict = {"type": ev.type, **ev.data}
        async with self._send_lock:
            await self.ws.send_json(payload)
            if ev.binary:
                await self.ws.send_bytes(ev.binary)

    async def send(self, type_: str, **data) -> None:
        async with self._send_lock:
            await self.ws.send_json({"type": type_, **data})

    # -------------------------------------------------------- 轮次控制

    def cancel_turn(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()

    async def start_turn(self, **kwargs) -> None:
        self.cancel_turn()
        if self.task and not self.task.done():
            try:
                await self.task  # 等旧的彻底停下，避免两轮串音
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.task = asyncio.create_task(self._run_turn(**kwargs))

    def brain(self) -> Brain:
        register_builtin_tools()
        persona_name = self.config["persona_name"] or settings.persona_name
        persona_style = self.config["persona_style"] or settings.persona_style
        self.session.set_system(build_system_prompt(self.session, name=persona_name,
                                                    style=persona_style))
        return Brain(
            session=self.session,
            overrides=self.overrides,
            registry=_filtered_registry(self.config.get("tool_names")),
            client_runner=self._run_client_tool,
            persona_name=persona_name,
            persona_style=persona_style,
        )

    async def _run_turn(self, **kwargs) -> None:
        try:
            brain = self.brain()
            async for ev in brain.handle(**kwargs):
                await self.send_event(ev)
        except asyncio.CancelledError:
            await self._safe_send("status", phase="interrupted", detail="已打断")
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("轮次异常")
            await self._safe_send("error", message=f"内部错误：{e}")

    async def _safe_send(self, type_: str, **data) -> None:
        try:
            await self.send(type_, **data)
        except Exception:  # noqa: BLE001  连接已断，忽略
            pass

    async def _run_client_tool(self, call, args) -> dict:
        """把工具调用丢给前端执行，等它回报结果。"""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[call.id] = fut
        try:
            await self.send("tool_call", id=call.id, name=call.name, arguments=args)
            return await asyncio.wait_for(fut, timeout=CLIENT_TOOL_TIMEOUT)
        except asyncio.TimeoutError:
            return {"ok": False, "content": f"前端在 {CLIENT_TOOL_TIMEOUT:.0f}s 内没有回报结果"}
        finally:
            self.pending.pop(call.id, None)


def _filtered_registry(names: list[str] | None):
    """按前端指定裁剪可用工具；返回一个只读视图，不改全局注册表。"""
    if not names:
        return tool_registry
    from ..core.tools import ToolRegistry

    view = ToolRegistry()
    for t in tool_registry.all():
        if t.name in names:
            view.register(t)
    return view


# ------------------------------------------------------------ 消息分派

@router.websocket("/api/chat")
async def chat_ws(ws: WebSocket) -> None:
    await ws.accept()
    register_builtin_tools()
    query = ws.query_params
    conn = Connection(ws, query.get("session_id"))
    # 自带密钥两条通道：请求头（非浏览器客户端）与 URL 参数（浏览器 WS 无法设头）
    conn.overrides = merge_overrides(
        headers_to_overrides(ws.headers),
        url_to_overrides(query),
    )
    log.info(
        "WS 连接：session=%s，自带配置的能力=%s",
        conn.session.id, sorted(conn.overrides.keys()) or "无",
    )

    await conn.send(
        "ready",
        session_id=conn.session.id,
        persona_name=conn.config["persona_name"],
        providers={k: {"provider": v.get("provider", ""), "model": v.get("model", "")}
                   for k, v in conn.overrides.items()},
        tools=[t["name"] for t in tool_registry.describe()],
        history=conn.session.transcript()[-20:],
        created=conn.session.created,
    )

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            if (blob := msg.get("bytes")) is not None:
                await _handle_binary(conn, blob)
                continue

            raw = msg.get("text")
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await conn.send("error", message="不是合法 JSON")
                continue
            await _handle_json(conn, data)
    except WebSocketDisconnect:
        pass
    finally:
        conn.cancel_turn()
        for fut in list(conn.pending.values()):
            if not fut.done():
                fut.cancel()
        conn.session.save()


async def _handle_binary(conn: Connection, blob: bytes) -> None:
    meta = conn.pending_audio_meta
    conn.audio_buf.extend(blob)
    if meta is None:
        # 非流式：一个二进制帧即整段录音
        await _finish_audio(conn)
        return
    if meta.get("type") == "audio_final":
        await _finish_audio(conn)
    elif meta.get("final"):
        await _finish_audio(conn)
    else:
        await conn.send("status", phase="listening", detail=f"收音频… {len(conn.audio_buf)//1024}KB")


async def _finish_audio(conn: Connection) -> None:
    blob = bytes(conn.audio_buf)
    meta = conn.pending_audio_meta or {}
    conn.audio_buf = bytearray()
    conn.pending_audio_meta = None
    if not blob:
        await conn.send("error", message="收到空音频")
        return
    await conn.start_turn(
        audio=blob,
        audio_mime=meta.get("mime", "audio/webm"),
        speak=conn.config["speak"],
        tts_enabled=conn.config["tts_enabled"],
        mode=conn.config["mode"],
    )


async def _handle_json(conn: Connection, data: dict) -> None:
    t = data.get("type")

    if t == "ping":
        await conn.send("pong", t=time.time())
        return

    if t == "config":
        for k in ("persona_name", "persona_style", "mode", "tts_enabled", "speak", "tool_names"):
            if k in data and data[k] is not None:
                conn.config[k] = data[k]
        await conn.send("config_ack", config=conn.config)
        return

    if t == "text":
        text = (data.get("text") or "").strip()
        if not text:
            return
        await conn.start_turn(text=text, speak=conn.config["speak"],
                              tts_enabled=conn.config["tts_enabled"],
                              mode=conn.config["mode"])
        return

    if t in ("audio_final", "audio_chunk"):
        conn.pending_audio_meta = data
        if t == "audio_chunk" and data.get("final"):
            # 允许「先声明 final 再发最后一个二进制帧」的写法
            await conn.send("status", phase="listening", detail="等待音频结尾")
        return

    if t == "interrupt":
        conn.cancel_turn()
        await conn.send("status", phase="interrupted", detail="已打断")
        return

    if t in ("tool_result", "confirm_result"):
        rid = data.get("id")
        fut = conn.pending.get(rid or "")
        if fut and not fut.done():
            if t == "confirm_result":
                if data.get("approved"):
                    fut.set_result({"ok": True, "content": data.get("content") or "用户已确认",
                                    "data": {"approved": True}})
                else:
                    fut.set_result({"ok": False, "content": "用户拒绝了这次操作",
                                    "data": {"approved": False}})
            else:
                fut.set_result({"ok": bool(data.get("ok")), "content": data.get("content", ""),
                                "data": data.get("data", {})})
        else:
            await conn.send("error", message="没有待处理的工具请求（可能已超时）")
        return

    if t == "call_tool":
        # 前端主动调后端工具
        await _frontend_call_tool(conn, data)
        return

    if t == "reset":
        conn.session.clear()
        await conn.send("status", phase="idle", detail="记忆已清空")
        return

    await conn.send("error", message=f"未知消息类型：{t}")


async def _frontend_call_tool(conn: Connection, data: dict) -> None:
    rid = data.get("id") or uuid.uuid4().hex
    name = data.get("name", "")
    args = data.get("arguments") or {}
    tool = tool_registry.get(name)
    if tool is None or tool.side != "server" or tool.handler is None:
        await conn.send("tool_response", id=rid, ok=False, content=f"工具 {name} 不可用或不是后端工具")
        return
    try:
        res = await tool.handler(**args)
        await conn.send("tool_response", id=rid, ok=res.ok, content=res.content, data=res.data)
    except (ProviderError, TypeError) as e:
        await conn.send("tool_response", id=rid, ok=False, content=str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("前端调用工具失败")
        await conn.send("tool_response", id=rid, ok=False, content=f"执行失败：{e}")
