"""统一配置：环境变量 + .env + 用户请求头覆盖。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    """极简 .env 加载器：不覆盖已存在的真实环境变量。"""
    p = path or (ROOT / ".env")
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "info"
    #: 默认空 = 不带人格。想定制就在网页「设置 → 人格」里填两栏，
    #: 或用 DH_PERSONA_NAME / DH_PERSONA_STYLE 为整个部署定基调。
    persona_name: str = ""
    persona_style: str = ""
    default_providers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        return cls(
            host=os.getenv("DH_HOST", "127.0.0.1"),
            port=int(os.getenv("DH_PORT", "8000")),
            log_level=os.getenv("DH_LOG_LEVEL", "info"),
            persona_name=os.getenv("DH_PERSONA_NAME", ""),
            persona_style=os.getenv("DH_PERSONA_STYLE", ""),
            default_providers={
                cap: os.getenv(f"DH_{cap.upper()}_PROVIDER", "")
                for cap in ("llm", "asr", "tts", "vlm")
            },
        )

    def default_provider(self, cap: str) -> str:
        return self.default_providers.get(cap, "")


settings = Settings.from_env()
