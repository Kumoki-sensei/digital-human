#!/usr/bin/env python
"""环境自检报告（纯标准库）。

用法：
    uv run python tools/check_env.py
    uv run python tools/check_env.py --quiet        # 只打印失败项与建议
    uv run python tools/check_env.py --json          # 机器可读（供 dev.ps1 / CI 用）

检查内容：
    1. Python 版本与解释器路径（要求 >= 3.11）
    2. 依赖是否可导入（必需：fastapi / uvicorn / httpx / pydantic / numpy；
       可选：faster_whisper / piper / cv2 / PIL）
    3. 可执行文件是否在 PATH（ffmpeg / ffprobe / git / node / uv）
    4. GPU（nvidia-smi，未装则跳过）
    5. 关键文件（.env / assets/cubism/live2dcubismcore.min.js / assets/models/*.model3.json）
    6. 端口 8000 是否被占用（socket 连接探测，不解析 netstat）

退出码：
    0 = 必需项全部通过；1 = 有必需项不通过。
    必需项 = Python 版本 + fastapi/uvicorn/httpx/pydantic 可导入。

注意：本机没有可用的 `python` 命令（指向 Windows Store 存根），请用 `uv run python`。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 控制台编码：Windows 上默认 GBK，中文表格会乱码（Python < 3.7 没有 reconfigure，忽略即可）
# ---------------------------------------------------------------------------
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
except (AttributeError, ValueError, OSError):
    pass

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

#: 项目根目录（本文件位于 <root>/tools/check_env.py）
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent

MIN_PYTHON: tuple[int, int] = (3, 11)

#: 必需依赖：导入失败即视为自检不通过
REQUIRED_MODULES: tuple[tuple[str, str], ...] = (
    ("fastapi", "Web 框架"),
    ("uvicorn", "ASGI 服务器"),
    ("httpx", "异步 HTTP 客户端（调云端 LLM/ASR/TTS）"),
    ("pydantic", "数据校验"),
)

#: 必需依赖（续）：numpy 属于默认依赖，但缺失也不阻塞最小可用
OPTIONAL_CORE_MODULES: tuple[tuple[str, str], ...] = (
    ("numpy", "数组运算（音频/视觉处理）"),
)

#: 可选 extras，对应 pyproject.toml 的 [project.optional-dependencies]
OPTIONAL_MODULES: tuple[tuple[str, str, str], ...] = (
    ("faster_whisper", "local-asr", "本机语音识别（推荐另装 ffmpeg）"),
    ("piper", "local-tts", "本机语音合成（piper-tts）"),
    ("cv2", "local-vision", "OpenCV，摄像头/画面处理"),
    ("PIL", "local-vision", "Pillow，图片处理"),
)

#: 需要探测的命令行工具：名字 -> (是否必需? 用途)
TOOLS: tuple[tuple[str, bool, str], ...] = (
    ("ffmpeg", False, "音频解码（本机 ASR 必需）"),
    ("ffprobe", False, "媒体信息探测"),
    ("git", False, "版本管理 / 拉取示例资源"),
    ("node", False, "前端构建（若做自定义 Live2D 前端）"),
    ("uv", False, "Python 环境与依赖管理（本机主力）"),
)

#: Windows 上的安装指引（每条建议都要能直接执行）
FIX_HINTS: dict[str, str] = {
    "python_version": (
        "Python 太旧：uv python install 3.11",
        "然后在项目根执行：uv sync --python 3.11",
    ),
    "ffmpeg": (
        "winget install --id Gyan.FFmpeg -e",
        "装完重开终端；校验：ffmpeg -version",
    ),
    "ffprobe": ("winget install --id Gyan.FFmpeg -e", "ffprobe 随 ffmpeg 一起装"),
    "git": ("winget install --id Git.Git -e", "或 https://git-scm.com/download/win"),
    "node": ("winget install --id OpenJS.NodeJS.LTS -e", "装完重开终端：node -v"),
    "uv": (
        "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"",
        "或 winget install --id astral-sh.uv -e",
    ),
    "numpy": ("uv sync", "numpy 是默认依赖，缺了说明环境不完整"),
    "deps": ("uv sync", "整份默认依赖一次装齐（本机 uv 缓存需在项目内）"),
    "cubism": (
        "uv run python tools/fetch_cubism.py --yes-i-agree-to-the-live2d-license",
        (
            "或手动去 https://www.live2d.com/download/cubism-sdk/download-web/ 下载，取 "
            "Core/live2dcubismcore.min.js 放到 assets/cubism/"
        ),
    ),
    "models": (
        "uv run python tools/fetch_sample_model.py",
        "或把自己的模型按 assets/models/<名字>/<名字>.model3.json 放进去",
    ),
    "env_file": (
        "Copy-Item .env.example .env",
        "然后编辑 .env 填密钥（.env 已被 .gitignore 排除，不会进仓库）",
    ),
    "port": (
        "uv run python -m backend --port 8010",
        "或找出占用进程：Get-NetTCPConnection -LocalPort 8000 | Select-Object OwningProcess",
    ),
    "uv_cache": (
        "$env:UV_CACHE_DIR=\"$PWD\\.uvcache\"",
        "本机 uv 默认缓存在 C 盘会被拒，脚本 scripts/dev.ps1 已自动设置",
    ),
}

STATUS_MARKS: dict[str, str] = {
    "ok": "通过",
    "warn": "警告",
    "bad": "失败",
    "skip": "跳过",
    "info": "留意",
}

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class Check:
    """一条检查结果。"""

    label: str           # 检查项名称
    status: str          # ok / warn / bad / skip / info（info = 需人工留意）
    detail: str = ""     # 详情
    required: bool = False
    extras: list[str] = field(default_factory=list)   # 其余补充行
    fixes: list[str] = field(default_factory=list)    # 可执行建议


@dataclass
class Report:
    """整份自检报告。"""

    project_root: str
    checks: list[Check] = field(default_factory=list)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    @property
    def failed_required(self) -> list[Check]:
        return [c for c in self.checks if c.required and c.status not in ("ok", "warn")]

    @property
    def exit_code(self) -> int:
        return 1 if self.failed_required else 0


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def _is_wide_char(ch: str) -> bool:
    """判断字符是否为宽字符（CJK 占 2 列），用于表格对齐。"""
    code = ord(ch)
    return (
        0x1100 <= code <= 0x115F
        or 0x2E80 <= code <= 0xA4CF
        or 0xAC00 <= code <= 0xD7A3
        or 0xF900 <= code <= 0xFAFF
        or 0xFE30 <= code <= 0xFE6F
        or 0xFF00 <= code <= 0xFF60
        or 0xFFE0 <= code <= 0xFFE6
        or 0x1F300 <= code <= 0x1FAFF
    )


def _display_width(text: str) -> int:
    """近似计算终端显示宽度（CJK 字符算 2 列）。"""
    return sum(2 if _is_wide_char(ch) else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    """按显示宽度右侧补空格。"""
    return text + " " * max(0, width - _display_width(text))


def _short(text: str, limit: int = 66) -> str:
    """过长文本截断，保持表格整齐。"""
    text = text.replace("\n", " ").replace("\r", " ")
    if _display_width(text) <= limit:
        return text
    out = ""
    for ch in text:
        if _display_width(out + ch) > limit - 1:
            break
        out += ch
    return out + "…"


def module_available(name: str) -> tuple[bool, str]:
    """检查模块是否可导入，返回 (可导入?, 版本或原因)。"""
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError) as exc:   # 有的包在 find_spec 阶段就会炸
        return False, f"查找失败：{exc}"
    if spec is None:
        return False, "未安装"
    try:
        module = __import__(name)
    except Exception as exc:  # noqa: BLE001 - 导入期任何异常都算不可用
        return False, f"导入报错：{type(exc).__name__}: {exc}"
    version = getattr(module, "__version__", None)
    if version is None:
        version = getattr(getattr(module, "version", None), "__version__", None)
    if version is None:
        try:  # 有些包把版本写在 importlib.metadata 里
            from importlib.metadata import version as _pkg_version

            version = _pkg_version(name)
        except Exception:  # noqa: BLE001
            version = None
    return True, str(version) if version else "已安装（版本未知）"


def run_quiet(cmd: Sequence[str], timeout: float = 8.0) -> tuple[int, str, str]:
    """执行命令并捕获输出，失败不抛异常。返回 (returncode, stdout, stderr)。"""
    try:
        proc = subprocess.run(
            list(cmd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return 127, "", "命令不存在"
    except subprocess.TimeoutExpired:
        return 124, "", f"超时（>{timeout:.0f}s）"
    except OSError as exc:
        return 126, "", f"无法执行：{exc}"
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def port_probe(host: str = "127.0.0.1", port: int = 8000, timeout: float = 0.4) -> tuple[bool, str]:
    """用 socket 连接探测端口（不依赖 netstat 文本解析）。

    返回 (是否被占用, 说明)。注意：沙箱环境可能禁止 connect（WSAEACCES），
    这种情况下会明确报「探测被拒绝」，而不是误报成端口被占用。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        code = sock.connect_ex((host, port))
        if code == 0:
            return True, "已被占用（可能有后端在跑）"
        try:
            err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
        except OSError:
            err = code
        if err in (13, 10013):          # EACCES / WSAEACCES：本进程不允许外连
            return False, "空闲（但本次 connect 被权限策略拒绝，可能在沙箱里运行）"
        return False, "空闲"


def read_env_names(path: Path) -> list[str]:
    """读取 .env 里已赋值的变量名（不打印值，避免泄露密钥）。"""
    names: list[str] = []
    try:
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            if key and value.strip():
                names.append(key)
    except OSError:
        return []
    return names


def human_size(num_bytes: int) -> str:
    """字节数转可读字符串。"""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}GB"


# ---------------------------------------------------------------------------
# 各项检查
# ---------------------------------------------------------------------------


def check_python(report: Report) -> None:
    """Python 版本与解释器路径。"""
    version = sys.version.split()[0]
    too_old = sys.version_info < MIN_PYTHON
    report.add(
        Check(
            label="Python 版本",
            status="bad" if too_old else "ok",
            detail=f"{version}（要求 >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}）",
            required=True,
            extras=[f"解释器：{sys.executable}"],
            fixes=list(FIX_HINTS["python_version"]) if too_old else [],
        )
    )
    # 本机 `python` 是 Windows Store 存根，这里顺带提示一下
    stub = shutil.which("python")
    if stub and "WindowsApps" in stub:
        report.add(
            Check(
                label="裸 python 命令",
                status="warn",
                detail="指向 Windows Store 存根，实际不可用",
                extras=[f"路径：{stub}"],
                fixes=["请统一用 uv run python，例如：uv run python tools/check_env.py"],
            )
        )
    # uv 缓存目录：本机默认缓存在 C 盘会被拒
    cache_dir = os.environ.get("UV_CACHE_DIR")
    report.add(
        Check(
            label="UV_CACHE_DIR",
            status="ok" if cache_dir else "warn",
            detail=cache_dir or "未设置（uv 会退回 C 盘默认缓存）",
            fixes=list(FIX_HINTS["uv_cache"]) if not cache_dir else [],
        )
    )


def check_modules(report: Report) -> None:
    """依赖导入检查。"""
    for name, desc in REQUIRED_MODULES:
        ok, info = module_available(name)
        report.add(
            Check(
                label=f"依赖 {name}",
                status="ok" if ok else "bad",
                detail=f"{info} · {desc}",
                required=True,
                fixes=list(FIX_HINTS["deps"]) if not ok else [],
            )
        )
    for name, desc in OPTIONAL_CORE_MODULES:
        ok, info = module_available(name)
        report.add(
            Check(
                label=f"依赖 {name}",
                status="ok" if ok else "warn",
                detail=f"{info} · {desc}",
                fixes=list(FIX_HINTS["numpy"]) if not ok else [],
            )
        )
    for name, extra, desc in OPTIONAL_MODULES:
        ok, info = module_available(name)
        report.add(
            Check(
                label=f"可选 {name}",
                status="ok" if ok else "skip",
                detail=f"{info} · {desc}（uv sync --extra {extra}）",
            )
        )


def check_tools(report: Report) -> None:
    """命令行工具是否在 PATH。"""
    for name, required, desc in TOOLS:
        path = shutil.which(name)
        if path:
            detail = path
            status = "ok"
            fixes: list[str] = []
        else:
            status = "bad" if required else "warn"
            detail = f"未找到 · {desc}"
            fixes = list(FIX_HINTS.get(name, (f"请安装 {name} 并加入 PATH",)))
        report.add(
            Check(label=f"工具 {name}", status=status, detail=detail,
                  required=required, fixes=fixes)
        )


def check_gpu(report: Report) -> None:
    """GPU 信息（nvidia-smi）。"""
    exe = shutil.which("nvidia-smi")
    if not exe:
        report.add(
            Check(
                label="GPU",
                status="skip",
                detail="未找到 nvidia-smi（非 NVIDIA 显卡或驱动未装）",
                fixes=["如有 NVIDIA 显卡：winget install --id Nvidia.GeForceExperience -e"],
            )
        )
        return
    code, out, err = run_quiet(
        [exe, "--query-gpu=name,memory.total", "--format=csv,noheader"], timeout=10
    )
    if code != 0:
        report.add(
            Check(label="GPU", status="warn",
                  detail=f"nvidia-smi 执行失败（{code}）：{_short(err or out, 48)}")
        )
        return
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    report.add(
        Check(
            label="GPU",
            status="ok" if lines else "warn",
            detail=lines[0] if lines else "无输出",
            extras=[f"第 {i + 2} 块：{ln}" for i, ln in enumerate(lines[1:])],
            fixes=[
                "6GB 显存够跑 faster-whisper small/base，large 系列需量化或走云 API",
            ] if lines else [],
        )
    )


def check_files(report: Report) -> None:
    """关键文件与资产存在性。"""
    env_file = PROJECT_ROOT / ".env"
    if env_file.is_file():
        keys = read_env_names(env_file)
        report.add(
            Check(label="文件 .env", status="ok",
                  detail=f"已存在，{len(keys)} 个变量已赋值（值不外显）")
        )
    else:
        report.add(
            Check(label="文件 .env", status="warn", detail="不存在，将走默认配置",
                  fixes=list(FIX_HINTS["env_file"]))
        )

    core = PROJECT_ROOT / "assets" / "cubism" / "live2dcubismcore.min.js"
    if core.is_file():
        size = core.stat().st_size
        report.add(
            Check(label="Cubism Core", status="ok" if size > 50_000 else "warn",
                  detail=f"{human_size(size)} · {core.relative_to(PROJECT_ROOT)}",
                  fixes=[] if size > 50_000 else
                  ["文件偏小（<50KB），可能下载不完整：重跑 fetch_cubism.py --force"])
        )
    else:
        report.add(
            Check(label="Cubism Core", status="warn",
                  detail="assets/cubism/live2dcubismcore.min.js 不存在（专有许可，需自行下载）",
                  fixes=list(FIX_HINTS["cubism"]))
        )

    models_dir = PROJECT_ROOT / "assets" / "models"
    found: list[str] = []
    if models_dir.is_dir():
        found = sorted(str(p.relative_to(models_dir)) for p in models_dir.rglob("*.model3.json"))
    if found:
        report.add(
            Check(label="Live2D 模型", status="ok",
                  detail=f"发现 {len(found)} 个模型",
                  extras=[f"· {m}" for m in found[:6]])
        )
    else:
        report.add(
            Check(label="Live2D 模型", status="warn",
                  detail="assets/models/ 下没有 *.model3.json",
                  fixes=list(FIX_HINTS["models"]))
        )


def check_port(report: Report, port: int = 8000) -> None:
    """端口占用探测。"""
    try:
        busy, why = port_probe("127.0.0.1", port)
    except OSError as exc:
        report.add(Check(label=f"端口 {port}", status="warn", detail=f"探测失败：{exc}"))
        return
    if busy:
        status = "warn"
    elif "权限策略拒绝" in why:
        status = "info"          # 端口本身空闲，只是本进程不允许外连
    else:
        status = "ok"
    report.add(
        Check(
            label=f"端口 {port}",
            status=status,
            detail=f"127.0.0.1:{port} {why}",
            fixes=list(FIX_HINTS["port"]) if busy else [],
        )
    )


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def print_report(report: Report, quiet: bool = False) -> None:
    """打印中文表格报告。"""
    bar = "=" * 78
    print(bar)
    print("  数字人项目 · 环境自检报告")
    print(f"  项目根目录：{report.project_root}")
    print(bar)

    label_width = max(
        [_display_width("检查项")] + [_display_width(c.label) for c in report.checks]
    )
    header = f"{_pad('检查项', label_width)}  状态  详情"
    print(header)
    print("-" * 78)

    hidden = 0
    for check in report.checks:
        if quiet and check.status in ("ok", "skip") and not check.fixes:
            hidden += 1
            continue
        mark = STATUS_MARKS.get(check.status, check.status)
        required_tag = "*" if check.required else " "
        line = f"{_pad(check.label, label_width)} {required_tag}{mark}  {_short(check.detail)}"
        print(line)
        for extra in check.extras:
            print(f"{' ' * label_width}   ·  {_short(extra)}")
    print("-" * 78)
    if hidden:
        print(f"（--quiet 模式隐藏了 {hidden} 条正常项）")

    passed = sum(1 for c in report.checks if c.status == "ok")
    warned = sum(1 for c in report.checks if c.status == "warn")
    failed = sum(1 for c in report.checks if c.status == "bad")
    skipped = sum(1 for c in report.checks if c.status == "skip")
    infos = sum(1 for c in report.checks if c.status == "info")
    print(f"合计 {len(report.checks)} 项：通过 {passed} · 警告 {warned} · "
          f"失败 {failed} · 跳过 {skipped} · 留意 {infos}     （* = 必需项）")

    suggestions: list[tuple[str, list[str]]] = [
        (c.label, c.fixes) for c in report.checks if c.fixes
    ]
    print()
    if suggestions:
        print("【建议清单】按顺序执行，命令可直接粘进 PowerShell：")
        for idx, (label, fixes) in enumerate(suggestions, 1):
            print(f"  {idx}. {label}")
            for fix in fixes:
                print(f"       > {fix}")
    else:
        print("【建议清单】没有待办项，环境齐活。")

    print()
    if report.exit_code == 0:
        print("结论：必需项全部通过，可以 `uv run python -m backend` 起步。")
    else:
        bad = "、".join(c.label for c in report.failed_required)
        print(f"结论：必需项未通过 -> {bad}")
    print(bar)


def print_json(report: Report) -> None:
    """机器可读输出（供 dev.ps1 / CI 使用）。"""
    payload: dict[str, Any] = {
        "project_root": report.project_root,
        "exit_code": report.exit_code,
        "checks": [
            {
                "label": c.label,
                "status": c.status,
                "detail": c.detail,
                "required": c.required,
                "extras": c.extras,
                "fixes": c.fixes,
            }
            for c in report.checks
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_report(port: int = 8000) -> Report:
    """跑完全部检查，返回报告对象。"""
    report = Report(project_root=str(PROJECT_ROOT))
    check_python(report)
    check_modules(report)
    check_tools(report)
    check_gpu(report)
    check_files(report)
    check_port(report, port=port)
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        prog="check_env.py",
        description="数字人项目环境自检（纯标准库，输出中文报告）",
    )
    parser.add_argument("--port", type=int, default=8000, help="要探测的后端端口（默认 8000）")
    parser.add_argument("--quiet", action="store_true", help="只显示警告/失败项与建议")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出（便于脚本消费）")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """主入口：返回退出码（0 全部必需项通过，1 否则）。"""
    args = parse_args(argv)
    report = build_report(port=args.port)
    if args.json:
        print_json(report)
    else:
        print_report(report, quiet=args.quiet)
    return report.exit_code


if __name__ == "__main__":
    sys.exit(main())
