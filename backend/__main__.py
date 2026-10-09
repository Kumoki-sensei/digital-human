"""启动入口。

    uv run python -m backend          # 默认 127.0.0.1:8000
    uv run python -m backend --port 8080 --reload

也提供 `uv run digital-human` 这个 console 形式（见 pyproject 的 [project.scripts] 可选配置）。
"""

from __future__ import annotations

import argparse
import logging
import sys

import uvicorn


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="digital-human", description="数字人后端")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--reload", action="store_true", help="改代码自动重启（开发用）")
    parser.add_argument("--log-level", default=None)
    args = parser.parse_args(argv)

    from .config import settings

    host = args.host or settings.host
    port = args.port or settings.port
    level = args.log_level or settings.log_level

    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    print(f"\n  数字人后端 v0.1.0")
    print(f"  网页：  http://{host}:{port}/")
    print(f"  接口：  http://{host}:{port}/docs")
    print(f"  大脑：  {settings.default_provider('llm') or 'echo（离线回声）'}")
    print(f"  耳朵：  {settings.default_provider('asr') or 'browser（浏览器原生）'}")
    print(f"  嗓子：  {settings.default_provider('tts') or 'browser（浏览器原生）'}\n")

    from .log_hygiene import uvicorn_log_config

    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=args.reload,
        log_level=level,
        # 关键：访问日志里带着 WebSocket 连接参数，而用户自带的密钥就在那里。
        # 用带清洗的日志配置，否则密钥会明文写进日志（实测撞到过）。
        log_config=uvicorn_log_config(level),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
