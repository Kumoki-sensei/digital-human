"""音频小工具：不依赖 ffmpeg 的格式嗅探与分句。

为什么不用 ffmpeg：本机没装，而本阶段的核心路径（云端 ASR/TTS）不需要转码。
等到要跑本机 whisper / 特征提取时再装 —— 别为了一个可选依赖把主链路堵住。
"""

from __future__ import annotations

import re

SENT_END = "。！？!?…；;\n"
MIN_SENT_LEN = 6      # 太短的句子不值得单独合成一次
MAX_SENT_LEN = 80     # 太长的句子首字延迟又回来了，必要时强切


def sniff_mime(blob: bytes) -> str:
    head = blob[:16]
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"RIFF"):
        return "audio/wav"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "audio/mpeg"
    if head.startswith(b"fLaC"):
        return "audio/flac"
    if head.startswith(b"\x00\x00\x00") or b"ftyp" in head:
        return "audio/mp4"
    return "application/octet-stream"


class SentenceSplitter:
    """流式分句器：LLM 的 token 一段段喂进来，凑够一句就吐出去。

    这是把「首字延迟」压下来的关键零件 —— 不等整段回复，先合成第一句。
    """

    def __init__(self):
        self._buf = ""

    def push(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        while True:
            idx = _find_break(self._buf)
            if idx < 0:
                break
            seg = self._buf[: idx + 1].strip()
            self._buf = self._buf[idx + 1:]
            if seg:
                out += force_split(seg)
        # 缓冲区过长又迟迟不出现句末标点，强行切一刀，避免无限等待
        if len(self._buf) >= MAX_SENT_LEN:
            cut = self._buf[:MAX_SENT_LEN]
            self._buf = self._buf[MAX_SENT_LEN:]
            out += force_split(cut)
        return [s for s in out if s]

    def flush(self) -> list[str]:
        tail = self._buf.strip()
        self._buf = ""
        return force_split(tail) if tail else []


def _find_break(text: str) -> int:
    for i, ch in enumerate(text):
        if ch in SENT_END and i + 1 >= MIN_SENT_LEN:
            return i
    return -1


def force_split(text: str) -> list[str]:
    if len(text) <= MAX_SENT_LEN:
        return [text]
    parts: list[str] = []
    rest = text
    while len(rest) > MAX_SENT_LEN:
        # 优先在逗号处断，其次硬切
        cut = max(
            rest.rfind("，", 0, MAX_SENT_LEN),
            rest.rfind(",", 0, MAX_SENT_LEN),
            rest.rfind(" ", 0, MAX_SENT_LEN),
        )
        cut = cut if cut >= MIN_SENT_LEN else MAX_SENT_LEN
        parts.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        parts.append(rest)
    return [p for p in parts if p]


_EMOTION_HINTS = (
    ("happy", ("哈", "笑", "太好了", "开心", "！")),
    ("sad", ("抱歉", "难过", "遗憾", "唉")),
    ("angry", ("哼", "讨厌", "别", "不许")),
    ("shy", ("…", "才不是", "别乱说")),
    ("surprised", ("啊？", "什么", "居然")),
)


def guess_emotion(text: str) -> str:
    """极简情绪启发式，供前端表情使用。

    真正的情绪模块（M2）会换成分类模型或让 LLM 直接输出结构化标签，
    这里先给一个「够用且不撒谎」的粗略版本。
    """
    for emotion, keys in _EMOTION_HINTS:
        if any(k in text for k in keys):
            return emotion
    return "neutral"


def clean_for_tts(text: str) -> str:
    """去掉不该念出来的东西：markdown 记号、舞台提示、多余空白。"""
    t = re.sub(r"```.*?```", "，代码已略过，", text, flags=re.S)
    t = re.sub(r"\[(.*?)\]", r"\1", t)          # [动作] → 动作
    t = re.sub(r"[*_`#>~]+", "", t)
    t = re.sub(r"https?://\S+", "链接", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()
