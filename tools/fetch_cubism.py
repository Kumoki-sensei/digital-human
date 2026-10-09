#!/usr/bin/env python
"""下载 Live2D Cubism Core（Web 版运行时）到 assets/cubism/。

    取官方直连下载的 `live2dcubismcore.min.js` 并放到：
        assets/cubism/live2dcubismcore.min.js
    网页端只有拿到这个文件才能解析 .moc3 模型。

⚠ 许可提醒（重要）：
    Cubism Core / Cubism SDK 是 Live2D Inc. 的 **专有许可软件**，不随本仓库分发。
    下载即表示你同意其许可条款；商业用途请自行确认授权范围。
    官方下载页：https://www.live2d.com/download/cubism-sdk/download-web/
    因此本脚本必须显式加 `--yes-i-agree-to-the-live2d-license` 才会真正联网下载。

用法：
    uv run python tools/fetch_cubism.py --yes-i-agree-to-the-live2d-license
    uv run python tools/fetch_cubism.py --yes-i-agree-to-the-live2d-license --force
    uv run python tools/fetch_cubism.py --guide      # 只看人工下载指引，不联网
    uv run python tools/fetch_cubism.py --url <直链> --yes-i-agree-to-the-live2d-license

退出码：
    0 = 成功（或文件已存在且未加 --force）
    2 = 所有候选直链都失败（或缺少许可确认）-> 打印人工下载指引
    1 = 参数/环境层面的错误
"""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.error
import urllib.request
from collections.abc import Iterator, Sequence
from pathlib import Path

# 控制台编码：Windows 上默认 GBK，中文提示会乱码（旧 Python 无 reconfigure，忽略即可）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
except (AttributeError, ValueError, OSError):
    pass

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent

#: 目标文件（相对项目根）
TARGET_REL: Path = Path("assets") / "cubism" / "live2dcubismcore.min.js"

#: 临时文件统一放在 <root>/_tmp/（见 .gitignore，清理器会定期回收）
TMP_ROOT: Path = PROJECT_ROOT / "_tmp"

LICENSE_FLAG = "--yes-i-agree-to-the-live2d-license"

LICENSE_NOTICE = f"""
[许可提醒] Cubism Core / Cubism SDK 属于 Live2D Inc. 的专有许可软件，**不能随仓库分发**。
           继续下载即视为你已阅读并同意 Live2D 的许可条款；商用请自行确认授权。
           官方页面：https://www.live2d.com/download/cubism-sdk/download-web/
           脚本的自动下载走的是 npm CDN（jsDelivr / unpkg）上的 live2dcubismcore 包，
           它只是同一份 Core 的再分发渠道；想 100% 走官方渠道请看下方的官网人工指引。
           确认可用 `{LICENSE_FLAG}` 跳过本提醒（脚本仍需该参数才会下载）。
"""

#: 候选直链清单（顺序 = 可用性排序，实测于 2026-02）：
#:   · cdn.jsdelivr.net / unpkg  —— 实测可下（150,388 字节，含 Live2DCubismCore 字样）
#:   · raw.githubusercontent.com —— 本机常被拦（读超时），排后面兜底
#:   · Live2D 官网下载页          —— 需要人机交互，脚本无法直连，只能人工下载
#: 说明：npm 上的 `live2dcubismcore` 包只是 Core 的再分发渠道，同样是 Live2D 的许可软件，
#:       因此脚本仍然强制要求 --yes-i-agree-to-the-live2d-license。想 100% 走官方渠道，
#:       请按人工指引从官网下载页取文件。官方直链经常变动，全部失败时脚本打印指引并以
#:       退出码 2 结束，不会崩溃。
CANDIDATE_URLS: tuple[tuple[str, str], ...] = (
    (
        "npm CDN jsDelivr（live2dcubismcore 包）",
        "https://cdn.jsdelivr.net/npm/live2dcubismcore@latest/live2dcubismcore.min.js",
    ),
    (
        "npm CDN unpkg（live2dcubismcore 包）",
        "https://unpkg.com/live2dcubismcore@latest/live2dcubismcore.min.js",
    ),
    (
        "npm CDN jsDelivr（锁定 1.0.2，避免 latest 变动）",
        "https://cdn.jsdelivr.net/npm/live2dcubismcore@1.0.2/live2dcubismcore.min.js",
    ),
    (
        "Live2D 官方 GitHub 仓库（develop，实测多为 404）",
        "https://raw.githubusercontent.com/Live2D/CubismWebFramework/develop/Core/live2dcubismcore.min.js",
    ),
    (
        "jsDelivr 镜像官方 GitHub 仓库（常见 404，兜底）",
        "https://cdn.jsdelivr.net/gh/Live2D/CubismWebFramework@develop/Core/live2dcubismcore.min.js",
    ),
)

#: 体积与内容校验
MIN_BYTES: int = 50 * 1024
MAGIC_MARKER: str = "Live2DCubismCore"

USER_AGENT = "digital-human-fetch-cubism/0.1 (+https://www.live2d.com/)"


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def human_size(num_bytes: int) -> str:
    """字节数转可读字符串。"""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB"):
        if size < 1024 or unit == "MB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}MB"


def ensure_tmp_dir() -> Path:
    """确保 _tmp/ 存在并返回它。"""
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    return TMP_ROOT


def prepare_stage_dir(*candidates: Path) -> Path:
    """准备一个干净的暂存目录，返回第一个能用的；全都不可用时抛 OSError。

    为什么不用 tempfile.mkdtemp：部分受限环境（沙箱/安全软件）只允许写
    「源码里出现过的确定路径」，随机后缀目录会被拒绝（Windows 上是 WinError 5）。
    所以用固定路径 + 每次运行前清空（幂等：不留垃圾）。
    """
    last_error: OSError | None = None
    for candidate in candidates:
        try:
            if candidate.exists():
                shutil.rmtree(candidate, ignore_errors=True)
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError as exc:
            last_error = exc
    raise last_error if last_error else OSError("没有可用的暂存目录")


def download_to(url: str, dest: Path, timeout: float = 30.0) -> int:
    """把 url 下载到 dest（普通写，调用方负责原子替换）。返回字节数。"""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with urllib.request.urlopen(request, timeout=timeout) as response:
        status = getattr(response, "status", 200)
        if status >= 400:
            raise urllib.error.HTTPError(url, status, "HTTP error", response.headers, None)
        with dest.open("wb") as handle:
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                handle.write(chunk)
    return written


def looks_valid(path: Path) -> tuple[bool, str]:
    """校验下载结果：体积 > 50KB 且内容含 Live2DCubismCore 字样。"""
    if not path.is_file():
        return False, "文件不存在"
    size = path.stat().st_size
    if size <= MIN_BYTES:
        return False, f"体积仅 {human_size(size)}（要求 > {human_size(MIN_BYTES)}）"
    try:
        head = path.read_bytes()[:4 * 1024 * 1024].decode("utf-8", errors="ignore")
    except OSError as exc:
        return False, f"读取失败：{exc}"
    if MAGIC_MARKER not in head:
        return False, f"内容里找不到 {MAGIC_MARKER} 字样（可能下到了 HTML 错误页）"
    return True, f"{human_size(size)}，含 {MAGIC_MARKER}"


def iter_candidates(extra_url: str | None) -> Iterator[tuple[str, str]]:
    """产出 (来源说明, URL)；--url 指定的地址优先。"""
    if extra_url:
        yield "命令行 --url 指定", extra_url
    yield from CANDIDATE_URLS


# ---------------------------------------------------------------------------
# 指引
# ---------------------------------------------------------------------------


def print_guide(target: Path, attempts: Sequence[tuple[str, str]]) -> None:
    """打印人工下载指引（所有直链失败时的兜底，绝不崩溃）。"""
    bar = "=" * 78
    print()
    print(bar)
    print("  自动下载失败 —— 请按下面步骤手动放好文件（这不是错误，官方直链常变）")
    print(bar)
    print(f"""
  1) 打开官方下载页
     https://www.live2d.com/download/cubism-sdk/download-web/
     （页面上的 "Cubism SDK for Web" 下载按钮，需要同意 Live2D 许可协议）

  2) 解压下载到的压缩包，从里面取出这个文件
     Core/live2dcubismcore.min.js
     （约 200KB，别拿 Core/*.d.ts 或 Framework/ 里的东西）

  3) 把它放到本项目的这个路径（目录不存在就自己建）
     {target}

  4) 校验（PowerShell，两个条件都要满足）
     (Get-Item "{target}").Length -gt 50KB
     Select-String -Path "{target}" -Pattern "Live2DCubismCore" -Quiet

  5) 回到项目根跑一次自检确认
     uv run python tools/check_env.py
""")
    if attempts:
        print("  本次尝试过的地址（供排查用，可能只是网络不通）：")
        for name, url in attempts:
            print(f"    · {name}\n      {url}")
        print()
        print("  小贴士：如果是公司网络/代理拦了 raw.githubusercontent.com，")
        print("          可以挂代理后重试，或直接走上面的手动下载。")
    print(bar)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def fetch(target: Path, extra_url: str | None, force: bool, timeout: float) -> int:
    """执行下载流程，返回退出码。"""
    if target.is_file() and not force:
        ok, info = looks_valid(target)
        print(f"[跳过] 已存在：{target}（{info}）")
        print("       要重新下载请加 --force。")
        return 0

    ensure_tmp_dir()
    attempts: list[tuple[str, str]] = []
    try:
        # 固定暂存路径（不用 mkdtemp：随机目录在受限环境下会被拒写）
        tmp_dir = prepare_stage_dir(
            TMP_ROOT / "fetch-cubism-stage",
            TMP_ROOT / "fetch-cubism-stage-alt",
        )
    except OSError as exc:
        print(f"[错误] 无法在 {TMP_ROOT} 建临时目录：{type(exc).__name__}: {exc}", file=sys.stderr)
        print("       请确认项目内 _tmp/ 可写（沙箱/权限问题），或改用手动下载（见下方指引）。",
              file=sys.stderr)
        print_guide(target, ())
        return 1
    try:
        denied = False
        for name, url in iter_candidates(extra_url):
            attempts.append((name, url))
            staged = tmp_dir / "live2dcubismcore.min.js"
            print(f"[尝试] {name}")
            print(f"       {url}")
            try:
                size = download_to(url, staged, timeout=timeout)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
                print(f"       -> 失败：{type(exc).__name__}: {exc}")
                if isinstance(exc, PermissionError):
                    denied = True
                staged.unlink(missing_ok=True)
                continue

            ok, info = looks_valid(staged)
            if not ok:
                print(f"       -> 下载到 {human_size(size)} 但校验不通过：{info}（已丢弃）")
                staged.unlink(missing_ok=True)
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(staged), str(target))   # 临时文件 -> 目标，原子替换
            print(f"       -> 成功：{info}")
            print()
            print(f"[完成] 已写入 {target}")
            print("       接着跑：uv run python tools/check_env.py")
            return 0

        if denied:
            print()
            print("[提示] 出现 PermissionError（拒绝访问）：可能是沙箱策略拦了网络/写盘，"
                  "不是地址本身有问题。")
            print("       在受限环境里请直接在真实终端重跑本脚本，或按下面步骤手动下载。")
        print_guide(target, attempts)
        return 2
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)   # 幂等：不留垃圾


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        prog="fetch_cubism.py",
        description="下载 Live2D Cubism Core（专有许可，不随仓库分发）到 assets/cubism/",
        epilog=f"提示：不带 {LICENSE_FLAG} 时脚本不会联网，只打印许可提醒与人工指引。",
    )
    parser.add_argument(
        LICENSE_FLAG,
        dest="agree",
        action="store_true",
        help="确认你已阅读并同意 Live2D 的许可条款（必须显式给出才会下载）",
    )
    parser.add_argument("--force", action="store_true", help="已存在时覆盖重下")
    parser.add_argument("--url", default=None, help="自定义直链（优先于内置候选列表）")
    parser.add_argument("--timeout", type=float, default=30.0, help="单个地址的超时秒数（默认 30）")
    parser.add_argument("--guide", action="store_true", help="只打印人工下载指引，不联网")
    parser.add_argument(
        "--target",
        default=None,
        help=f"目标文件路径（默认 {TARGET_REL.as_posix()}）",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """主入口。"""
    args = parse_args(argv)
    if args.target:
        candidate = Path(args.target)
        # 相对路径按项目根解析，避免受调用时 cwd 影响
        target = candidate if candidate.is_absolute() else (PROJECT_ROOT / candidate)
    else:
        target = PROJECT_ROOT / TARGET_REL

    print(LICENSE_NOTICE.strip())
    print()
    print(f"目标文件：{target}")

    if args.guide:
        print_guide(target, ())
        return 2

    if not args.agree:
        print()
        print(f"[暂停] 未提供 {LICENSE_FLAG}，为尊重 Live2D 的许可，脚本不自动下载。")
        print("       确认同意后重跑：")
        print(f"         uv run python tools/fetch_cubism.py {LICENSE_FLAG}")
        print_guide(target, ())
        return 2

    try:
        return fetch(target, args.url, args.force, args.timeout)
    except OSError as exc:                      # 磁盘/权限类问题
        print(f"[错误] 文件操作失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
