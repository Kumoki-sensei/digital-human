"""编排大脑：把「听 → 想 → 说 → 做」串成一条事件流。

一次对话轮次（turn）的完整形状：

    音频/文本 → ASR → 写入记忆 → [工具循环] → 逐句 TTS → 结束

三个决定体感的设计点，改动前请先想清楚：

1. **逐句 TTS 而不是整段**：LLM 一边吐字，分句器一边凑句，凑够一句立刻合成一段音频
   推给前端播放。用户听到第一句话的时间 = 首个分句的合成时间，而不是整段回复的合成时间。

2. **可打断**：每轮跑在一个 asyncio.Task 里，前端发 interrupt 就 cancel。
   LLM 的 HTTP 流、TTS 的请求都会随取消一起断掉，不会出现「用户已经在说话，
   数字人还在念上一段」的尴尬叠音。

3. **工具调用有上限**：一轮里最多 3 次工具往返。没有这个上限，
   一个绕不出来的模型会无限自我调用，账单和延迟一起爆炸。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable

from ..provider_registry import CAP_ASR, CAP_LLM, CAP_TTS, ResolvedCredential, resolve
from ..providers import build, ProviderError
from ..providers.base import ASRResult, ToolCall
from .audio import SentenceSplitter, clean_for_tts, guess_emotion
from .session import Message, Session
from .tools import ToolRegistry, ToolResult, registry as default_registry

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 3

ClientToolRunner = Callable[[ToolCall, dict], Awaitable[dict]]
"""把客户端工具丢给前端执行：入参 (调用, 解析后的参数)，返回 {"ok": bool, "content": str, "data": dict}"""


@dataclass
class Event:
    """推给前端的一条事件。

    type 决定 data 的含义（见 api/schema.py）。
    binary 非空时，传输层会改发一个 WebSocket 二进制帧 —— 音频不经 base64，
    省掉 33% 的体积与一次编解码；前后端靠「先 JSON 元数据、紧随二进制」的
    顺序约定配对。
    """

    type: str
    data: dict
    binary: bytes | None = None


class Brain:
    def __init__(
        self,
        *,
        session: Session,
        overrides: dict[str, dict[str, str]],
        settings=None,
        registry: ToolRegistry | None = None,
        client_runner: ClientToolRunner | None = None,
        persona_name: str = "",
        persona_style: str = "",
    ):
        self.session = session
        self.overrides = overrides
        self.registry = registry or default_registry
        self.client_runner = client_runner
        self.persona_name = persona_name
        self.persona_style = persona_style

        from ..config import settings as default_settings

        self.settings = settings or default_settings

        self.cred = {
            cap: resolve(
                cap,
                header_overrides=overrides.get(cap),
                default_provider_getter=self.settings.default_provider,
            )
            for cap in (CAP_LLM, CAP_ASR, CAP_TTS, "vlm")
        }

    # ------------------------------------------------------------ 对外主入口

    async def handle(
        self,
        *,
        text: str = "",
        audio: bytes = b"",
        audio_mime: str = "audio/webm",
        mode: str = "voice",
        tts_enabled: bool = True,
        speak: bool = True,
    ) -> AsyncIterator[Event]:
        """跑完一轮对话，产出事件流。调用方负责把事件推给前端。"""
        t0 = time.perf_counter()
        # 分段计时：这是调优的唯一依据。
        # 没有这三个数，你无法判断该换 ASR、换 LLM 还是换 TTS —— 只能瞎猜。
        stats: dict[str, Any] = {"_turn_t0": t0}
        try:
            # ---------- 1. 听 ----------
            user_text = (text or "").strip()
            if not user_text and audio:
                yield Event("status", {"phase": "listening", "detail": "识别中"})
                ta = time.perf_counter()
                user_text = await self._transcribe(audio, audio_mime)
                stats["asr_ms"] = int((time.perf_counter() - ta) * 1000)
                yield Event("asr", {"text": user_text, "ms": stats["asr_ms"]})
            if not user_text:
                yield Event("error", {"message": "没有听到内容，请再说一次。"})
                return

            stats["heard_ms"] = int((time.perf_counter() - t0) * 1000)
            self.session.append(Message(role="user", content=user_text))
            yield Event("user", {"text": user_text})

            # ---------- 2. 想 + 做 ----------
            yield Event("status", {"phase": "thinking", "detail": "思考中"})
            async for ev in self._think_and_speak(speak=speak, tts_enabled=tts_enabled,
                                                 started=t0, stats=stats):
                yield ev

            yield Event("done", {
                "total_ms": int((time.perf_counter() - t0) * 1000),
                "session_id": self.session.id,
                "timing": self._timing_payload(stats, speaker=self.cred[CAP_LLM].provider,
                                               asr=self.cred[CAP_ASR].provider,
                                               tts=self.cred[CAP_TTS].provider),
            })
        except asyncio.CancelledError:
            yield Event("status", {"phase": "interrupted", "detail": "已打断"})
            raise
        except ProviderError as e:
            log.warning("能力调用失败：%s", e)
            yield Event("error", {"message": str(e)})
        except Exception as e:  # 兜底：任何未预期异常都不能让 WS 静默断掉
            log.exception("轮次处理失败")
            yield Event("error", {"message": f"内部错误：{type(e).__name__}: {e}"})

    @staticmethod
    def _timing_payload(stats: dict[str, Any], *, speaker: str, asr: str, tts: str) -> dict:
        """把埋点整理成前端能直接画图的形状，并顺手写一行服务端日志。"""
        payload = {
            "asr": {"provider": asr, "ms": stats.get("asr_ms")},
            "llm": {"provider": speaker, "first_token_ms": stats.get("llm_first_ms")},
            "tts": {"provider": tts, "first_frame_ms": stats.get("tts_first_ms")},
            "segment_ms": stats.get("segment_ms", []),
            "tools": stats.get("tools", []),
            "heard_ms": stats.get("heard_ms"),
        }
        log.info(
            "本轮耗时：听懂 %s｜首字 %s｜首帧 %s｜工具 %d 次",
            f"{payload['asr']['ms']}ms" if payload["asr"]["ms"] is not None else "-",
            f"{payload['llm']['first_token_ms']}ms" if payload["llm"]["first_token_ms"] is not None else "-",
            f"{payload['tts']['first_frame_ms']}ms" if payload["tts"]["first_frame_ms"] is not None else "-",
            len(payload["tools"]),
        )
        return payload

    # ------------------------------------------------------------ 内部实现

    async def _transcribe(self, audio: bytes, mime: str) -> str:
        asr = build(self.cred[CAP_ASR])
        res: ASRResult = await asr.transcribe(audio, mime=mime)
        return res.text.strip()

    async def _think_and_speak(self, *, speak: bool, tts_enabled: bool, started: float,
                               stats: dict[str, Any] | None = None):
        stats = stats if stats is not None else {}
        llm = build(self.cred[CAP_LLM])
        splitter = SentenceSplitter()
        tool_schemas = self.registry.schemas()
        first_token_ms: int | None = None

        for round_idx in range(MAX_TOOL_ROUNDS + 1):
            messages = self.session.window()
            pending_calls: list[ToolCall] = []
            spoken_this_round: list[str] = []
            assistant_text = ""

            async for delta in llm.stream(messages, tools=tool_schemas or None):
                if delta.content:
                    if first_token_ms is None:
                        first_token_ms = int((time.perf_counter() - started) * 1000)
                        stats["llm_first_ms"] = first_token_ms
                        yield Event("status", {"phase": "speaking", "detail": "回答中",
                                               "first_token_ms": first_token_ms})
                    assistant_text += delta.content
                    if not speak:
                        yield Event("token", {"text": delta.content})
                    else:
                        # 注意：分句用原文，清洗只作用于「已经切出来的一整句」。
                        # 反过来在流上做清洗会把 markdown 记号切碎、破坏分句。
                        for sent in splitter.push(delta.content):
                            cleaned = clean_for_tts(sent)
                            if not cleaned:
                                continue
                            spoken_this_round.append(cleaned)
                            stats["_seg_t0"] = time.perf_counter()
                            yield Event("segment", {"text": cleaned,
                                                    "emotion": guess_emotion(cleaned)})
                            if tts_enabled:
                                async for ev in self._speak(cleaned, stats):
                                    yield ev
                if delta.tool_calls:
                    pending_calls += delta.tool_calls

            # 收尾：把缓冲区里剩下的半句说完，否则最后一句话会被吞掉
            if speak:
                for sent in splitter.flush():
                    cleaned = clean_for_tts(sent)
                    if not cleaned:
                        continue
                    spoken_this_round.append(cleaned)
                    stats["_seg_t0"] = time.perf_counter()
                    yield Event("segment", {"text": cleaned, "emotion": guess_emotion(cleaned)})
                    if tts_enabled:
                        async for ev in self._speak(cleaned, stats):
                            yield ev

            # 没有任何工具调用 = 这一轮就是说完了
            if not pending_calls:
                if assistant_text.strip():
                    self.session.append(Message(role="assistant", content=assistant_text.strip()))
                return

            if round_idx >= MAX_TOOL_ROUNDS:
                yield Event("error", {"message": "工具调用次数超过上限，本轮结束。"})
                if assistant_text.strip():
                    self.session.append(Message(role="assistant", content=assistant_text.strip()))
                return

            # 有工具调用：先记下 assistant 这条（含工具意图），再逐个执行
            self.session.append(Message(
                role="assistant",
                content=assistant_text.strip(),
                name=json.dumps(
                    [{"id": c.id, "type": "function",
                      "function": {"name": c.name, "arguments": c.arguments}}
                     for c in pending_calls],
                    ensure_ascii=False,
                ),
            ))

            for call in pending_calls:
                yield Event("tool_call", {"id": call.id, "name": call.name,
                                          "arguments": _safe_json(call.arguments)})
                _tt = time.perf_counter()
                result = await self._run_tool(call)
                if isinstance(result, Event):      # 需要用户确认，本轮先停在这
                    yield result
                    return
                stats.setdefault("tools", []).append({
                    "name": call.name,
                    "ms": int((time.perf_counter() - _tt) * 1000),
                })
                yield Event("tool_result", {"id": call.id, "name": call.name,
                                            "ok": result.ok, "content": result.content})
                self.session.append(Message(
                    role="tool", content=result.content, name=call.name, tool_call_id=call.id
                ))

            # 工具结果已入上下文，再问模型一次，让它用自然语言收口
            yield Event("status", {"phase": "thinking", "detail": "整理工具结果"})

    async def _speak(self, sentence: str, stats: dict[str, Any] | None = None):
        stats = stats if stats is not None else {}
        tts = build(self.cred[CAP_TTS])
        voice = self.cred[CAP_TTS].voice
        first = True
        async for chunk in tts.synthesize(sentence, voice=voice):
            if first:
                first = False
                # 首帧时刻：TTS 是否够快，看的就是这个数，不是总值
                stats.setdefault("tts_first_ms", int((time.perf_counter() - stats.get("_turn_t0", time.perf_counter())) * 1000))
                if "_seg_t0" in stats:
                    stats.setdefault("segment_ms", []).append(
                        int((time.perf_counter() - stats.pop("_seg_t0")) * 1000)
                    )
            if chunk.mime == "text/browser-tts":
                # 合成交给浏览器：只发文本 + 一条指令
                yield Event("audio", {"mode": "browser", "text": sentence})
                continue
            # 先发元数据 JSON，紧随其后一个二进制帧承载音频本体
            yield Event("audio_begin", {"mime": chunk.mime, "text": sentence,
                                        "final": chunk.final}, binary=chunk.audio)

    async def _run_tool(self, call: ToolCall) -> ToolResult | Event:
        tool = self.registry.get(call.name)
        args = _safe_json(call.arguments)
        if tool is None:
            return ToolResult(ok=False, content=f"没有名为 {call.name} 的工具")

        if tool.side == "client":
            if self.client_runner is None:
                return ToolResult(ok=False, content="当前连接不支持客户端工具")
            if tool.requires_confirm:
                return Event("confirm_request", {
                    "id": call.id, "name": call.name,
                    "description": tool.description, "arguments": args,
                })
            res = await self.client_runner(call, args)
            if not res.get("ok"):
                return ToolResult(ok=False, content=res.get("content") or res.get("error", "前端执行失败"))
            return ToolResult(ok=True, content=res.get("content", "已完成"), data=res.get("data", {}))

        assert tool.handler is not None
        try:
            if tool.name == "remember":
                note = str(args.get("note", ""))
                self.session.add_vision_note("便签：" + note)
                return ToolResult(ok=True, content=f"已记下：{note}", data={"note": note})
            return await tool.handler(**args)
        except TypeError as e:
            return ToolResult(ok=False, content=f"参数不对：{e}")
        except Exception as e:
            log.exception("工具 %s 执行失败", call.name)
            return ToolResult(ok=False, content=f"工具执行失败：{e}")


def _safe_json(raw: str) -> dict:
    if not raw or not raw.strip():
        return {}
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {"value": obj}
    except json.JSONDecodeError:
        return {"_raw": raw[:200]}
