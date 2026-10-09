"""前后端协议定义 —— 改协议先改这里，两边都以此为唯一事实来源。

传输：WebSocket /api/chat?session_id=xxx

客户端 → 服务端
    {"type":"config",  ...}                 会话级设置（人格、语音开关、模式）
    {"type":"text",    "text":"..."}        发送文字
    {"type":"audio_final","mime":"...","sample_rate":16000}  紧随其后一个二进制帧 = 整段录音
    {"type":"audio_chunk","final":true,...}  分片录音：每个二进制帧追加到缓冲，final 时开始识别
    {"type":"interrupt"}                    打断当前轮次
    {"type":"tool_result","id":"...","ok":true,"content":"..."}   客户端工具执行完毕回报
    {"type":"confirm_result","id":"...","approved":true}          用户对写操作的确认结果
    {"type":"call_tool","id":"...","name":"...","arguments":{}}   前端主动调后端工具
    {"type":"reset"}                        清空记忆
    {"type":"ping"}

服务端 → 客户端（均为 JSON；audio_begin 后紧跟一个二进制帧承载音频）
    ready            连接就绪，带会话 id 与当前配置
    status           阶段变化 {phase: listening|thinking|speaking|interrupted, detail}
    asr              识别结果 {text, ms}
    user             用户输入回显 {text}
    token            流式文字增量 {text}（文本模式）
    segment          一个分句完成 {text, emotion}
    audio            指令帧 {mode:"browser", text}  → 请前端用浏览器语音合成朗读
    audio_begin      音频元数据 {mime, text, final}  → 紧随二进制帧
    tool_call        模型请求调用工具 {id, name, arguments}
    tool_result      工具执行结果 {id, name, ok, content}
    confirm_request  需要用户确认 {id, name, description, arguments}
    done             本轮结束 {total_ms, session_id}
    error            出错 {message}
    pong
    config_ack       设置已生效
    tool_response    前端 call_tool 的回复 {id, ok, content, data}
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ------------------------------------------------------------ 客户端消息

class ConfigMessage(BaseModel):
    type: Literal["config"]
    persona_name: str | None = None
    persona_style: str | None = None
    mode: Literal["voice", "text"] = "voice"
    tts_enabled: bool = True
    speak: bool = True
    tool_names: list[str] | None = None   # 限制本轮可用工具；None = 全部


class TextMessage(BaseModel):
    type: Literal["text"]
    text: str


class AudioFinalMessage(BaseModel):
    type: Literal["audio_final"]
    mime: str = "audio/webm"
    sample_rate: int = 16000


class AudioChunkMessage(BaseModel):
    type: Literal["audio_chunk"]
    final: bool = False
    mime: str = "audio/webm"
    sample_rate: int = 16000


class InterruptMessage(BaseModel):
    type: Literal["interrupt"]


class ToolResultMessage(BaseModel):
    type: Literal["tool_result"]
    id: str
    ok: bool = True
    content: str = ""
    data: dict = Field(default_factory=dict)


class ConfirmResultMessage(BaseModel):
    type: Literal["confirm_result"]
    id: str
    approved: bool = False
    content: str = ""


class CallToolMessage(BaseModel):
    type: Literal["call_tool"]
    id: str = ""
    name: str
    arguments: dict = Field(default_factory=dict)


class ResetMessage(BaseModel):
    type: Literal["reset"]


class PingMessage(BaseModel):
    type: Literal["ping"]


# ------------------------------------------------------------ 服务端事件

class ReadyEvent(BaseModel):
    type: Literal["ready"] = "ready"
    session_id: str
    persona_name: str
    providers: dict[str, dict]
    tools: list[dict]


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    phase: str
    detail: str = ""
    first_token_ms: int | None = None


class AsrEvent(BaseModel):
    type: Literal["asr"] = "asr"
    text: str
    ms: int = 0


class TokenEvent(BaseModel):
    type: Literal["token"] = "token"
    text: str


class SegmentEvent(BaseModel):
    type: Literal["segment"] = "segment"
    text: str
    emotion: str = "neutral"


class AudioBeginEvent(BaseModel):
    type: Literal["audio_begin"] = "audio_begin"
    mime: str
    text: str = ""
    final: bool = True


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    total_ms: int
    session_id: str


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


# ------------------------------------------------------------ 文档用

PROTOCOL_DOC: dict[str, Any] = {
    "client_to_server": [
        "config", "text", "audio_final", "audio_chunk", "interrupt",
        "tool_result", "confirm_result", "call_tool", "reset", "ping",
    ],
    "server_to_client": [
        "ready", "status", "asr", "user", "token", "segment", "audio",
        "audio_begin", "tool_call", "tool_result", "confirm_request",
        "done", "error", "pong", "config_ack", "tool_response",
    ],
}
