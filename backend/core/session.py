"""会话记忆：滚动窗口 + 落盘 JSON。

为什么不用数据库：一期是单用户本地跑，一个 JSON 文件足够、可读、可手改。
多用户或上量时再换 SQLite —— 接口形状已经按「列表 + 追加」设计好了，替换成本低。

落盘策略：
    - 每次追加消息后立即落盘（对话很短，I/O 不是瓶颈，丢消息的代价更大）
    - 文件放 data/sessions/<id>.json，data/ 已在 .gitignore 中
    - session id 做白名单校验，防止路径穿越（外来 id 一律当作不可信输入）
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
ROOT = Path(__file__).resolve().parent.parent.parent
SESSIONS_DIR = ROOT / "data" / "sessions"

MAX_TURNS_KEPT = 24  # 送进模型的最近轮数（user+assistant 合计），控制 token 成本


@dataclass
class Message:
    role: str                      # system | user | assistant | tool
    content: str = ""
    name: str = ""
    tool_call_id: str = ""
    ts: float = field(default_factory=time.time)

    def to_wire(self) -> dict:
        d: dict = {"role": self.role, "content": self.content}
        if self.role == "tool" and self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
            d["name"] = self.name
        if self.role == "assistant" and self.name:
            d["tool_calls"] = json.loads(self.name)  # 见 brain 里的存法说明
        return d


class Session:
    def __init__(self, session_id: str | None = None, system_prompt: str = ""):
        self.id = session_id if (session_id and SAFE_ID.match(session_id)) else self._new_id()
        self.created = time.time()
        self.messages: list[Message] = []
        self.vision_notes: list[str] = []   # 「眼睛」看到的东西，压缩后注入上下文
        if system_prompt:
            self.messages.append(Message(role="system", content=system_prompt))
        self._load()

    @staticmethod
    def _new_id() -> str:
        return f"s{uuid.uuid4().hex[:12]}"

    # ------------------------------------------------------------ 路径

    @property
    def path(self) -> Path:
        return SESSIONS_DIR / f"{self.id}.json"

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return  # 坏文件不阻塞对话，直接当新会话
        if self.messages:
            saved = [Message(**m) for m in raw.get("messages", [])]
            head = self.messages[0]
            self.messages = [head] + [m for m in saved if m.role != "system"]
        else:
            self.messages = [Message(**m) for m in raw.get("messages", [])]
        self.vision_notes = list(raw.get("vision_notes", []))

    def save(self) -> None:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": self.id,
            "created": self.created,
            "updated": time.time(),
            "messages": [asdict(m) for m in self.messages],
            "vision_notes": self.vision_notes[-8:],
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)  # 原子替换，避免写一半崩了留下坏文件

    # ------------------------------------------------------------ 记忆

    def append(self, msg: Message, *, persist: bool = True) -> None:
        self.messages.append(msg)
        if persist:
            self.save()

    def set_system(self, prompt: str) -> None:
        if self.messages and self.messages[0].role == "system":
            self.messages[0].content = prompt
        else:
            self.messages.insert(0, Message(role="system", content=prompt))
        self.save()

    def window(self, limit: int = MAX_TURNS_KEPT) -> list[dict]:
        """给模型看的上下文：system + 最近 N 条，且保证不以悬空的 tool 消息开头。"""
        system = [m for m in self.messages if m.role == "system"]
        rest = [m for m in self.messages if m.role != "system"][-limit:]
        while rest and rest[0].role == "tool":
            rest.pop(0)
        return [m.to_wire() for m in system + rest]

    def transcript(self) -> list[dict]:
        return [{"role": m.role, "content": m.content, "ts": m.ts} for m in self.messages]

    def add_vision_note(self, note: str) -> None:
        if note:
            self.vision_notes.append(f"[{time.strftime('%H:%M')}] {note}")
            self.vision_notes[:] = self.vision_notes[-8:]

    def clear(self) -> None:
        head = self.messages[:1] if self.messages and self.messages[0].role == "system" else []
        self.messages = head
        self.vision_notes = []
        self.save()


class SessionStore:
    """进程内会话池（单用户场景够用；多用户时换成带过期的外部存储）。"""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def get(self, session_id: str | None, system_prompt: str) -> Session:
        if session_id and session_id in self._sessions:
            return self._sessions[session_id]
        s = Session(session_id, system_prompt)
        self._sessions[s.id] = s
        s.save()
        return s


store = SessionStore()
