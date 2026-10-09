#!/usr/bin/env python
"""下载 Live2D 官方 sample 模型（默认 Hiyori）到 assets/models/<名字>/。

数据源：GitHub 官方仓库 Live2D/CubismWebSamples 的 `Samples/Resources/<名字>/`，
通过 raw.githubusercontent.com 逐文件下载（不用 git clone，避免拉几百 MB 的仓库）。

⚠ 许可提醒：
    官方 sample 模型（Hiyori 等）**仅限个人学习与非商业用途**；
    商用请换成自有/已授权的模型，并遵守 Live2D 的授权条款。

用法：
    uv run python tools/fetch_sample_model.py                  # 下 Hiyori
    uv run python tools/fetch_sample_model.py --name Haru      # 换模型
    uv run python tools/fetch_sample_model.py --list           # 只列出要下哪些文件
    uv run python tools/fetch_sample_model.py --force          # 覆盖已存在的模型目录
    uv run python tools/fetch_sample_model.py --org Live2D --repo CubismWebSamples

退出码：
    0 = 成功（或目录已存在且未加 --force）
    2 = 网络/资源失败（打印手动下载指引，不抛异常）
    1 = 参数或文件系统层面的错误
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

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

#: 模型统一放这里
MODELS_DIR: Path = PROJECT_ROOT / "assets" / "models"

#: 临时文件统一放 <root>/_tmp/（.gitignore 已排除，清理器会定期回收）
TMP_ROOT: Path = PROJECT_ROOT / "_tmp"

#: 默认上游仓库与分支（org / repo / branch 都可用参数覆盖）
DEFAULT_ORG = "Live2D"
DEFAULT_REPO = "CubismWebSamples"
DEFAULT_BRANCH = "develop"

#: 上游仓库里放模型资源的位置
RESOURCE_DIR = "Samples/Resources"

#: 需要下载的后缀（白名单）与它们的用途
WANTED_SUFFIXES: tuple[tuple[str, str], ...] = (
    (".model3.json", "模型定义（含贴图/物理/动作的引用清单）"),
    (".moc3", "模型本体（二进制，必需）"),
    (".physics3.json", "物理演算（头发/衣服摆动）"),
    (".cdi3.json", "参数显示名"),
    (".pose3.json", "姿势/部件切换"),
    (".motion3.json", "动作（呼吸/待机/点击反馈）"),
    (".exp3.json", "表情"),
    (".png", "贴图"),
)

#: API 枚举失败时的兜底清单（按 <名字> 展开），够把模型跑起来
FALLBACK_TEMPLATE: tuple[str, ...] = (
    "{name}.model3.json",
    "{name}.moc3",
    "{name}.physics3.json",
    "{name}.cdi3.json",
    "{name}.pose3.json",
)

#: 贴图兜底（Hiyori 等官方样例的常见布局）
FALLBACK_TEXTURE_DIR = "{name}.2048"
FALLBACK_TEXTURE_COUNT = 2

LICENSE_NOTICE = """
[许可提醒] 官方 sample 模型仅限 **个人学习与非商业用途**。
           商用请改用自有或已获授权的模型；Live2D 与模型作者保留其权利。
           参考：https://www.live2d.com/en/learn/sample/
"""

USER_AGENT = "digital-human-fetch-model/0.1"


# ---------------------------------------------------------------------------
# 小工具
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
    所以这里用固定路径 + 每次运行前清空（幂等：不留垃圾、重复运行结果一致）。
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


def http_get(url: str, timeout: float) -> bytes:
    """GET 一个 URL，返回原始字节；失败抛异常（由调用方容错）。"""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        status = getattr(response, "status", 200)
        if status >= 400:
            raise urllib.error.HTTPError(url, status, "HTTP error", response.headers, None)
        return response.read()


def build_url(org: str, repo: str, branch: str, rel_path: str) -> str:
    """拼 raw.githubusercontent.com 直链（路径分段编码，兼容空格/中文）。"""
    quoted = "/".join(urllib.parse.quote(part) for part in rel_path.split("/"))
    return f"https://raw.githubusercontent.com/{org}/{repo}/{branch}/{quoted}"


def build_url_from(source: str, org: str, repo: str, branch: str, rel_path: str) -> str:
    """按来源类型拼直链。

    raw.githubusercontent.com 在部分网络下会被拦（读超时），所以同一份文件准备两条路：
      - "raw"     : 官方 raw 直链
      - "jsdelivr": jsDelivr 的 GitHub CDN 镜像（实测可用）
    """
    quoted = "/".join(urllib.parse.quote(part) for part in rel_path.split("/"))
    if source == "jsdelivr":
        return f"https://cdn.jsdelivr.net/gh/{org}/{repo}@{branch}/{quoted}"
    return f"https://raw.githubusercontent.com/{org}/{repo}/{branch}/{quoted}"


#: 文件下载的候选来源顺序（raw 优先，失败自动换 jsDelivr 镜像）
SOURCE_ORDER: tuple[str, ...] = ("raw", "jsdelivr")

#: 文件清单枚举（GitHub API）的候选地址
API_TREE_URL = "https://api.github.com/repos/{org}/{repo}/git/trees/{branch}?recursive=1"

#: 兜底：用 jsDelivr 的数据 API 逐层列目录（GitHub API 被限流时用）
DATA_API_URL = "https://data.jsdelivr.com/v1/packages/gh/{org}/{repo}@{branch}"


def safe_relative(path: str) -> Path | None:
    """把模型内部相对路径规整为安全的相对路径（拒绝绝对路径与 .. 逃逸）。"""
    cleaned = path.replace("\\", "/").lstrip("/")
    parts = [p for p in cleaned.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None
    return Path(*parts) if parts else None


def iter_refs(node: Any) -> Iterable[str]:
    """递归收集 model3.json 里所有字符串值（拿贴图/物理/动作的相对路径）。"""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from iter_refs(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_refs(item)


# ---------------------------------------------------------------------------
# 带镜像回退的抓取
# ---------------------------------------------------------------------------


def fetch_first(
    org: str, repo: str, branch: str, rel_path: str, timeout: float
) -> tuple[bytes, str]:
    """按 SOURCE_ORDER 依次尝试下载同一个文件，返回 (内容, 命中的来源名)。

    全部失败时抛出最后一个异常（由调用方转成指引，不向外崩）。
    """
    last_error: Exception | None = None
    for source in SOURCE_ORDER:
        url = build_url_from(source, org, repo, branch, rel_path)
        try:
            return http_get(url, timeout), source
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last_error = exc
    if last_error is None:                       # 逻辑上不会发生
        raise OSError("没有可用的下载来源")
    raise last_error


# ---------------------------------------------------------------------------
# 文件清单
# ---------------------------------------------------------------------------


def list_via_api(org: str, repo: str, branch: str, name: str, timeout: float) -> list[str]:
    """用 GitHub git/trees API 递归枚举模型目录下的全部文件（相对模型目录）。"""
    tree_url = API_TREE_URL.format(org=org, repo=repo, branch=urllib.parse.quote(branch))
    payload = json.loads(http_get(tree_url, timeout).decode("utf-8"))
    prefix = f"{RESOURCE_DIR}/{name}/"
    files: list[str] = []
    for item in payload.get("tree", []):
        path = str(item.get("path", ""))
        if item.get("type") != "blob" or not path.startswith(prefix):
            continue
        rel = path[len(prefix):]
        if rel.lower().endswith(tuple(s for s, _ in WANTED_SUFFIXES)):
            files.append(rel)
    return sorted(set(files))


def list_from_model3(
    org: str, repo: str, branch: str, name: str, timeout: float
) -> list[str]:
    """下载 model3.json 并按它引用的文件清单收集（API 不可用时的可靠退路）。"""
    rel = f"{RESOURCE_DIR}/{name}/{name}.model3.json"
    raw, source = fetch_first(org, repo, branch, rel, timeout)
    print(f"[清单] model3.json 来自 {source}")
    meta = json.loads(raw.decode("utf-8"))
    files: set[str] = {f"{name}.model3.json"}
    wanted_suffixes = tuple(s for s, _ in WANTED_SUFFIXES)
    for ref in iter_refs(meta):
        entry = safe_relative(ref)
        if entry is None:
            continue
        rel_str = entry.as_posix()
        if rel_str.lower().endswith(wanted_suffixes):
            files.add(rel_str)
    return sorted(files)


def fallback_files(name: str) -> list[str]:
    """最后的兜底清单：写死几个必需文件 + 常见贴图。"""
    files = [tmpl.format(name=name) for tmpl in FALLBACK_TEMPLATE]
    texture_dir = FALLBACK_TEXTURE_DIR.format(name=name)
    files += [f"{texture_dir}/texture_{i:02d}.png" for i in range(FALLBACK_TEXTURE_COUNT)]
    return files


def resolve_file_list(
    org: str, repo: str, branch: str, name: str, timeout: float
) -> tuple[list[str], str]:
    """依次尝试 API 枚举 -> model3.json 解析 -> 兜底清单。

    返回 (文件清单, 清单来源说明)。
    """
    for label, fn in (
        ("GitHub API 递归枚举", list_via_api),
        ("解析 model3.json 引用", list_from_model3),
    ):
        try:
            files = fn(org, repo, branch, name, timeout)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
            # ValueError 涵盖 json.JSONDecodeError（上游返回了非 JSON 内容时）
            print(f"[清单] {label} 不可用：{type(exc).__name__}: {exc}")
            continue
        if files:
            return files, label
        print(f"[清单] {label} 未返回任何文件，换下一种方式")

    print("[清单] 上游目录列举全部失败，使用内置兜底清单（可能不完整）")
    return fallback_files(name), "内置兜底清单"


# ---------------------------------------------------------------------------
# 指引
# ---------------------------------------------------------------------------


def print_guide(org: str, repo: str, branch: str, name: str, target: Path) -> None:
    """打印手动下载指引（网络失败时的兜底，不崩溃）。"""
    bar = "=" * 78
    # 预先拼好 Windows 风格的路径字符串：f-string 表达式里不写反斜杠/嵌套引号，
    # 这样在 Python 3.11 上也能解析（3.12 才允许 f-string 内使用反斜杠转义）。
    backslash = chr(92)
    win_resource_dir = RESOURCE_DIR.replace("/", backslash)
    inner = f"_tmp{backslash}CubismWebSamples{backslash}{win_resource_dir}{backslash}{name}"
    clone_src = '"' + inner + '"'
    target_str = '"' + str(target) + '"'
    print()
    print(bar)
    print("  自动下载失败 —— 请按下面步骤手动放好模型（这不是崩溃，是网络/上游问题）")
    print(bar)
    print(f"""
  1) 打开官方仓库里的模型目录
     https://github.com/{org}/{repo}/tree/{branch}/{RESOURCE_DIR}/{name}

  2) 逐个下载这些文件（保持相对路径不变；也可以整仓库下载后只拷这个目录）
       {name}.model3.json      模型定义
       {name}.moc3             模型本体（必需，几百 KB ~ 几 MB）
       {name}.physics3.json    物理演算（可选）
       {name}.cdi3.json        参数显示名（可选）
       {name}.pose3.json       姿势切换（可选）
       motions/*.motion3.json  动作（可选，想有待机动画就下）
       {name}.2048/texture_*.png   贴图（必需，注意放进子目录）

     如果 raw.githubusercontent.com 打不开，可以直接用 jsDelivr 镜像下同一个文件：
       https://cdn.jsdelivr.net/gh/{org}/{repo}@{branch}/{RESOURCE_DIR}/{name}/{name}.model3.json

  3) 目录结构应该是这样（放到本项目的 {target}）
     {target}
       {name}.model3.json
       {name}.moc3
       {name}.physics3.json
       {name}.2048/
         texture_00.png
         texture_01.png

  4) 也可以直接 git clone（仓库较大，约数百 MB）
     git clone --depth 1 --branch {branch} https://github.com/{org}/{repo}.git _tmp/CubismWebSamples
     Copy-Item -Recurse {clone_src} {target_str}

  5) 回到项目根跑一次自检确认
     uv run python tools/check_env.py
""")
    print(LICENSE_NOTICE.strip())
    print()
    print("  小贴士：raw.githubusercontent.com 在国内常被拦，挂代理或换镜像后重试；")
    print("          本脚本只会下载模型相关文件，不会碰仓库里其它内容。")
    print(bar)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def fetch_model(
    org: str,
    repo: str,
    branch: str,
    name: str,
    target: Path,
    force: bool,
    timeout: float,
    dry_run: bool,
) -> int:
    """执行下载流程，返回退出码。"""
    if target.exists() and not force:
        existing = sorted(p.name for p in target.iterdir()) if target.is_dir() else []
        print(f"[跳过] 已存在：{target}（{len(existing)} 个条目）")
        print("       要重新下载请加 --force。")
        return 0

    files, source = resolve_file_list(org, repo, branch, name, timeout)
    print(f"[清单] 共 {len(files)} 个文件（来源：{source}）：")
    for rel in files:
        print(f"       · {rel}")
    if dry_run:
        print()
        print("[dry-run] 只列清单，未下载任何文件。")
        return 0

    ensure_tmp_dir()
    # 暂存位置优先放在目标旁边（同盘、确定路径，受限环境下最稳），其次退回 _tmp/。
    # 固定路径而不是 mkdtemp：随机目录在沙箱/杀软下会被拒写（WinError 5）。
    stage_candidates: list[Path] = []
    if target.parent.name:
        stage_candidates.append(target.parent / f".fetch-stage-{name}")
    stage_candidates.append(TMP_ROOT / f"fetch-model-{name}-stage")
    stage_candidates.append(TMP_ROOT / "fetch-model-stage")
    try:
        tmp_dir = prepare_stage_dir(*stage_candidates)
    except OSError as exc:
        print(f"[错误] 无法在 {TMP_ROOT} 建临时目录：{type(exc).__name__}: {exc}", file=sys.stderr)
        print("       请确认项目内 _tmp/ 可写（这是沙箱/权限问题，不是网络问题），"
              "或改用手动下载（见下方指引）。", file=sys.stderr)
        print_guide(org, repo, branch, name, target)
        return 1
    staged_root = tmp_dir / name          # 先在临时目录里搭好整棵树
    try:
        staged_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"[错误] 无法在 {tmp_dir} 下建暂存目录：{type(exc).__name__}: {exc}", file=sys.stderr)
        print("       这是本地文件权限问题（沙箱/杀软/只读盘），与网络无关。", file=sys.stderr)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return 1
    failed: list[tuple[str, str]] = []
    total_bytes = 0
    wrote_any = False
    mirrored: list[str] = []              # 走了 jsDelivr 镜像的文件（raw 失败了）

    try:
        for rel in files:
            rel_path = f"{RESOURCE_DIR}/{name}/{rel}"
            dest = staged_root / rel
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                blob, used_source = fetch_first(org, repo, branch, rel_path, timeout)
                dest.write_bytes(blob)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
                failed.append((rel, f"{type(exc).__name__}: {exc}"))
                continue
            wrote_any = True
            total_bytes += len(blob)
            if used_source != SOURCE_ORDER[0]:
                mirrored.append(rel)
                print(f"       ↓ {rel}（{human_size(len(blob))}，经 {used_source} 镜像）")
            else:
                print(f"       ↓ {rel}（{human_size(len(blob))}）")
        if mirrored:
            print(f"[提示] {len(mirrored)} 个文件 raw.githubusercontent.com 不可达，"
                  f"已自动改用 jsDelivr 镜像拿到。")

        # 必需文件校验：.moc3 是模型本体，缺了就没法渲染
        moc3 = staged_root / f"{name}.moc3"
        model3 = staged_root / f"{name}.model3.json"
        if not moc3.is_file() or not model3.is_file():
            missing = [p.name for p in (moc3, model3) if not p.is_file()]
            failed.append(("、".join(missing), "必需文件缺失，无法渲染模型"))

        if failed:
            print()
            if not wrote_any:
                print("[失败] 一个文件都没下下来，先看下面的原因（网络不可达 / 镜像也不通 / 本地权限）。")
            else:
                print(f"[失败] {len(failed)} 个文件没拿到：")
            for rel, why in failed:
                print(f"       · {rel} -> {why}")
            print_guide(org, repo, branch, name, target)
            return 2

        # 原子落地：临时目录 -> assets/models/<name>
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)            # --force 走这里
        shutil.move(str(staged_root), str(target))

        count = sum(1 for p in target.rglob("*") if p.is_file())
        print()
        print(f"[完成] {target}")
        print(f"       文件 {count} 个，共 {human_size(total_bytes)}")
        print("       接着跑：uv run python tools/check_env.py")
        print()
        print(LICENSE_NOTICE.strip())
        return 0
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)   # 幂等：不留垃圾


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        prog="fetch_sample_model.py",
        description="下载 Live2D 官方 sample 模型（默认 Hiyori）到 assets/models/（仅限个人学习/非商业）",
    )
    parser.add_argument("--name", default="Hiyori", help="模型名（默认 Hiyori）")
    parser.add_argument("--org", default=DEFAULT_ORG, help=f"GitHub 组织（默认 {DEFAULT_ORG}）")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"仓库名（默认 {DEFAULT_REPO}）")
    parser.add_argument("--branch", default=DEFAULT_BRANCH, help=f"分支（默认 {DEFAULT_BRANCH}）")
    parser.add_argument("--force", action="store_true", help="目标目录已存在时覆盖重下")
    parser.add_argument("--dry-run", "-List", dest="dry_run", action="store_true",
                        help="只列出将要下载的文件清单，不下载（别名 -List：PowerShell 里 `--list` 会被当成 -List）")
    parser.add_argument("--timeout", type=float, default=30.0, help="单文件超时秒数（默认 30）")
    parser.add_argument("--target", default=None,
                        help=f"目标目录（默认 {MODELS_DIR.relative_to(PROJECT_ROOT).as_posix()}/<name>）")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """主入口。"""
    args = parse_args(argv)
    name = str(args.name).strip().strip("/\\")
    if not name or name in (".", ".."):
        print("[错误] --name 不合法", file=sys.stderr)
        return 1

    if args.target:
        candidate = Path(args.target)
        target = candidate if candidate.is_absolute() else (PROJECT_ROOT / candidate)
    else:
        target = MODELS_DIR / name

    print(LICENSE_NOTICE.strip())
    print()
    print(f"上游仓库：https://github.com/{args.org}/{args.repo}（分支 {args.branch}）")
    print(f"模型：{name}")
    print(f"目标目录：{target}")
    print()

    try:
        return fetch_model(
            org=args.org,
            repo=args.repo,
            branch=args.branch,
            name=name,
            target=target,
            force=args.force,
            timeout=args.timeout,
            dry_run=args.dry_run,
        )
    except OSError as exc:
        print(f"[错误] 文件操作失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
