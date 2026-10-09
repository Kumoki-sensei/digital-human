"""日志卫生：任何被写进日志的 URL 都必须先过滤掉凭据。

## 为什么需要这个文件

用户自带的 API 密钥是通过 **WebSocket 连接参数**传给后端的
（浏览器的 WebSocket 构造函数不能自定义请求头，这是标准限制）。

问题在于：uvicorn 的访问日志会把整条请求行打出来，包括 query string。
也就是说 —— **密钥会以明文出现在日志里**，而这个日志会被复制、粘贴、
上传到 issue、或者被别有用心的进程读到。

这个坑是实测撞上的（自己在后端日志里看到了完整的 sk-...）。

README 里早就写了「任何日志都不打印完整 URL」，但没有代码兜底，
光靠自觉是拦不住的。所以这里做机械化的过滤：所有日志记录在格式化前，
凡命中敏感参数名的值，一律替换成掩码。
"""

from __future__ import annotations

import logging
import re

#: 需要掩码的参数名（小写匹配）。宁可多列几个，也不要漏。
SENSITIVE_KEYS = ("key", "api_key", "apikey", "token", "secret", "password", "authorization")

#: 形如 `llm.key:sk-xxx` 或 `key=sk-xxx` 的片段
_PAIR_RE = re.compile(
    r"(?P<name>[A-Za-z0-9_\-]*(?:" + "|".join(SENSITIVE_KEYS) + r"))"
    r"\s*(?P<sep>[:=])\s*(?P<value>[^,&\s'\"]+)",
    re.IGNORECASE,
)

#: 裸的 sk- 风格密钥（服务商前缀），兜底用
_BARE_RE = re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}\b")

#: 形如 `p=llm.provider:deepseek,llm.base_url:https://...` 里的 URL 值（含密钥）
_URL_KEY_RE = re.compile(r"(https?://[^\s,]+?[?&](?:[A-Za-z0-9_\-]*(?:key|token|secret)=)[^\s,&]+)",
                         re.IGNORECASE)


def mask_secret(value: str) -> str:
    if not value:
        return "(none)"
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}…{value[-4:]}"


def scrub(text: str) -> str:
    """把一段文本里所有疑似凭据替换成掩码。"""
    if not text:
        return text
    out = _PAIR_RE.sub(lambda m: f"{m.group('name')}{m.group('sep')}{mask_secret(m.group('value'))}", text)
    out = _URL_KEY_RE.sub(
        lambda m: re.sub(r"((?:key|token|secret)=)([^&\s]+)",
                         lambda mm: mm.group(1) + mask_secret(mm.group(2)), m.group(1), flags=re.I),
        out,
    )
    out = _BARE_RE.sub(lambda m: mask_secret(m.group(0)), out)
    return out


class ScrubFormatter(logging.Formatter):
    """在格式化前清洗消息与参数（uvicorn 的访问日志走 %s 参数，也要洗）。

    另外给 uvicorn 特有的字段兜个底：`levelprefix` 由 uvicorn 的 formatter 注入，
    但这个类也可能被用在普通 logger 上 —— 缺字段时 logging 会直接抛
    "Formatting field not found in record"，把一个日志问题升级成功能故障。
    日志系统本身不该成为故障源，所以缺失就补空串。
    """

    def format(self, record: logging.LogRecord) -> str:
        if isinstance(record.msg, str):
            record.msg = scrub(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(
                    scrub(a) if isinstance(a, str) else a for a in record.args
                )
            elif isinstance(record.args, dict):
                record.args = {
                    k: (scrub(v) if isinstance(v, str) else v) for k, v in record.args.items()
                }
        if not hasattr(record, "levelprefix"):
            record.levelprefix = record.levelname
        return super().format(record)


def uvicorn_log_config(level: str = "info") -> dict:
    """uvicorn 的日志配置：保留默认格式，但接上清洗格式化器。"""
    fmt = "%(levelprefix)s %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {"()": ScrubFormatter, "fmt": fmt, "datefmt": datefmt},
            "access": {"()": ScrubFormatter, "fmt": fmt, "datefmt": datefmt},
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
            },
            "access": {
                "formatter": "access",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": level.upper(), "propagate": False},
            "uvicorn.error": {"level": level.upper()},
            "uvicorn.access": {"handlers": ["access"], "level": level.upper(), "propagate": False},
        },
    }
