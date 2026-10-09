"""HTTP 接口：健康检查、供应商清单、会话管理、工具清单、视觉、静态资源。

设计取舍：
    - 这里的接口都是「管理面」，对话走 WebSocket（api/chat.py）
    - 响应里永不出现任何密钥值，只出现 mask_key 之后的形态
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from .. import __version__
from ..config import ROOT, settings
from ..core import custom_modules as custom_mod
from ..core import module_registry as modules
from ..core.module_registry import catalog as module_catalog
from ..core.persona import build_system_prompt
from ..core.session import Session, store
from ..core.tools import register_builtin_tools, registry as tool_registry
from ..provider_registry import (
    CAP_LLM,
    CAP_VLM,
    CAPS,
    ResolvedCredential,
    find,
    headers_to_overrides,
    list_specs,
    resolve,
)
from ..providers import build, build_generic, ProviderError

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

WEB_DIR = ROOT / "web"
ASSETS_DIR = ROOT / "assets"


# ---------------------------------------------------------------- 基础

@router.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "version": __version__,
        "persona": settings.persona_name,
        "defaults": settings.default_providers,
        "cwd": str(ROOT),
    }


@router.get("/providers")
async def providers() -> dict:
    """给前端设置面板用的供应商清单（按能力分组）。"""
    out: dict[str, list[dict]] = {}
    for spec in list_specs():
        out.setdefault(spec.cap, []).append({
            "id": spec.id,
            "label": spec.label,
            "protocol": spec.protocol,
            "base_url": spec.base_url,
            "default_model": spec.default_model,
            "needs_key": spec.needs_key,
            "local": spec.local,
            "docs": spec.docs,
            "env_key": spec.env_key,
        })
    return out


@router.get("/tools")
async def tools() -> dict:
    register_builtin_tools()
    return {"tools": tool_registry.describe()}


@router.get("/config/protocol")
async def protocol() -> dict:
    from .schema import PROTOCOL_DOC

    return PROTOCOL_DOC


# ---------------------------------------------------------------- 模块（架构视图 + 自定义接入）
#
# 这一组接口是「模块化定制」的对外契约：
#   看：GET /api/modules/catalog     —— 系统由哪些可替换模块组成，各自契约是什么
#   加：POST /api/modules/custom     —— 填一份 JSON 就把自己的 API 接进来
#   删：DELETE /api/modules/custom/{cap}/{id}
#   验：POST /api/modules/probe      —— 保存前先探一下通不通

@router.get("/modules/catalog")
async def modules_catalog() -> dict:
    """完整的能力契约 + 模块清单 + 分层结构。前端「模块」面板直接渲染。"""
    data = module_catalog()
    data["custom"] = [_spec_public(m) for m in custom_mod.load_all()]
    data["store_path"] = custom_mod.store_path()
    return data


def _spec_public(spec) -> dict:
    """自定义模块的公开形态（不含任何密钥 —— 配置里本来也不允许存）。"""
    from dataclasses import asdict

    d = asdict(spec)
    d["origin"] = "custom"
    return d


@router.get("/modules/custom")
async def custom_modules_list() -> dict:
    return {
        "modules": [_spec_public(m) for m in custom_mod.load_all()],
        "store_path": custom_mod.store_path(),
        "allowed_fields": list(custom_mod.ALLOWED_FIELDS),
        "supported_protocols": list(custom_mod.SUPPORTED_PROTOCOLS),
    }


@router.post("/modules/custom")
async def custom_modules_upsert(payload: dict = Body(...)) -> dict:
    """新增/更新一个自定义模块。写入前做白名单过滤与校验。

    **密钥不会落盘**：白名单里根本没有 key/token 这类字段，
    传了也会被 `_sanitize` 剔除并记一条警告。
    """
    spec, problems = custom_mod.from_payload(payload)
    if spec is None:
        # detail 用字符串而不是结构体：FastAPI 对非字符串 detail 的序列化行为
        # 会让 curl/PowerShell 这类客户端拿到空 body，排查时看不到原因。
        raise HTTPException(400, "配置有问题，未保存：" + "；".join(problems))
    custom_mod.upsert(spec)
    log.info("自定义模块已保存：%s/%s（%s）", spec.cap, spec.id, spec.protocol)
    return {
        "ok": True,
        "module": _spec_public(spec),
        "store_path": custom_mod.store_path(),
        "hint": "刷新页面即可在对应能力的供应商列表里看到它；密钥请在供应商卡片里单独填（只留浏览器）",
    }


@router.delete("/modules/custom/{cap}/{module_id}")
async def custom_modules_delete(cap: str, module_id: str) -> dict:
    if cap not in CAPS:
        raise HTTPException(400, f"cap 必须是 {'/'.join(CAPS)} 之一")
    removed = custom_mod.remove(cap, module_id)
    if not removed:
        raise HTTPException(404, f"没有找到自定义模块 {cap}/{module_id}")
    return {"ok": True, "removed": f"{cap}/{module_id}"}


@router.post("/modules/probe")
async def modules_probe(payload: dict = Body(...)) -> dict:
    """探测一个模块现在通不通。

    支持两种用法：
      1. 探测已保存的预设/自定义模块：{"cap":"llm","provider":"deepseek","key":"sk-..."}
      2. 保存前试跑一份草稿配置：{"probe_draft": true, "draft": {...}, "key": "..."}
    密钥只用于本次请求，不落盘、不入日志（错误信息里只出现掩码）。
    """
    import time

    draft_payload = payload.get("draft") or {}
    is_draft = bool(payload.get("probe_draft"))

    # 草稿模式下 cap 在 draft 里，已保存模块模式下 cap 在顶层 ——
    # 早先这里只从顶层读，于是草稿探测永远因为「cap 为空」被拒，
    # 报出的原因跟真实情况完全无关（典型的"错误信息指向错误的方向"）。
    cap_raw = draft_payload.get("cap") if is_draft else payload.get("cap")
    cap = str(cap_raw or "").strip()

    log.info(
        "模块探测：cap=%r draft=%s keys=%s",
        cap, is_draft, sorted(payload.keys()),
    )
    if cap not in CAPS:
        raise HTTPException(
            400,
            f"cap 必须是 {'/'.join(CAPS)} 之一"
            + ("（草稿模式下请把 cap 放在 draft 里）" if is_draft else ""),
        )
    key = str(payload.get("key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    provider = str(payload.get("provider") or "")

    # ---- 草稿模式：配置还没保存，也要能验证 ----
    if is_draft:
        # 注意：校验对象是 payload["draft"]，不是整个 payload ——
        # 外层还带着 probe_draft/key 这类字段，整包丢给校验器会被白名单过滤光，
        # 结果是 cap 变空、校验失败，报出一个与真实原因无关的错。
        draft = draft_payload
        spec, problems = custom_mod.from_payload(draft)
        if spec is None:
            return {"ok": False, "problems": problems,
                    "message": "草稿配置本身就不合法，先修它：" + "；".join(problems)}
        cred = ResolvedCredential(
            cap=spec.cap, provider=spec.id, model=model or spec.default_model,
            base_url=(base_url or spec.base_url).rstrip("/"), api_key=key, source="user" if key else "none",
        )
        mapping = _draft_mapping(spec)
        started = time.perf_counter()
        try:
            result = await build_generic(cred, mapping).check()
        except ProviderError as e:
            result = {"ok": False, "message": str(e)}
        result["ms"] = result.get("ms") or int((time.perf_counter() - started) * 1000)
        result["draft"] = True
        return result

    # ---- 已保存模块 ----
    if not provider:
        raise HTTPException(400, "要么给 provider（已保存模块），要么用 probe_draft + draft")
    cred = resolve(cap, header_overrides={
        k: v for k, v in (("provider", provider), ("model", model),
                          ("base-url", base_url), ("key", key)) if v
    })
    if not cred.base_url:
        return {"ok": False, "message": f"{provider} 没有配置 base_url，无法探测"}

    # generic-http 走「真实最小请求」，其它协议只做地址可达性判断 ——
    # 用最小真实请求去探 ASR/TTS 各家行为不一致，硬试会大量误报。
    started = time.perf_counter()
    try:
        saved = find(cap, cred.provider)
        if saved is not None and saved.protocol == "generic-http":
            mapping = next(
                (m for m in custom_mod.load_all() if m.cap == cap and m.id == cred.provider), None
            )
            if mapping is None:
                return {"ok": False, "message": "这个自定义模块的配置读不到了，建议删掉重建"}
            result = await build_generic(cred, _draft_mapping(mapping)).check()
        else:
            result = await _probe_reachability(cred)
    except ProviderError as e:
        result = {"ok": False, "message": str(e)}
    result["ms"] = result.get("ms") or int((time.perf_counter() - started) * 1000)
    return result


def _draft_mapping(spec) -> dict:
    """把草稿 spec 转成转发器要的映射（与 build() 里那份保持一致）。"""
    from dataclasses import asdict

    d = asdict(spec)
    return {
        "request": d.get("request") or {},
        "response": d.get("response") or {},
        "chunk_text_path": d.get("chunk_text_path") or "",
        "stream": d.get("stream", True),
        "timeout_seconds": d.get("timeout_seconds", 60.0),
        "bypass_prefix": d.get("bypass_prefix", True),
    }


@router.post("/llm/test")
async def llm_test(payload: dict = Body(default={})) -> dict:
    """**真实**测一次 LLM 连通性：发一个 max_tokens=1 的最小请求。

    为什么必须单独做这个接口：网页上原来那个「测试连接」只检查后端进程和本机能力
    （ffmpeg / Cubism 之类），根本不碰你填的 LLM 配置 —— 于是会出现
    「测试连接显示一切正常，发消息却报密钥无效」这种自相矛盾的体验。
    配置类问题必须用真实调用去验，否则测了个寂寞。

    密钥只用于本次请求，不落盘、不写日志（错误信息里只出现掩码）。
    """
    import time

    cap = "llm"
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    base_url = str(payload.get("base_url") or "").strip()
    key = str(payload.get("key") or "").strip()

    cred = resolve(cap, header_overrides={
        k: v for k, v in (
            ("provider", provider), ("model", model),
            ("base-url", base_url), ("key", key),
        ) if v
    })

    # 回显「实际会用什么」——这是排查配置类问题最关键的信息：
    # 用户以为留空就不生效，其实有供应商默认值兜底；也可能反过来，以为填了但没传进来。
    resolved = {
        "provider": cred.provider,
        "model": cred.model,
        "base_url": cred.base_url,
        "key_source": cred.source,           # user | server | none
        "has_key": bool(cred.api_key),
        "key_hint": cred.masked,
    }

    if cred.provider == "echo":
        return {
            "ok": True,
            "resolved": resolved,
            "message": "当前是「离线回声」模式：不会调用任何云端模型。"
                       "要接真实模型，请在供应商里选一个并填入自己的密钥。",
        }
    if not cred.api_key:
        return {
            "ok": False,
            "resolved": resolved,
            "message": "没有拿到密钥。两种常见原因："
                       "① 密钥填了但连接已建立（改完请刷新页面让它重连）；"
                       "② 该供应商需要密钥而你留空了。",
        }
    if not cred.base_url:
        return {"ok": False, "resolved": resolved, "message": "这个供应商没有 base_url，无法调用"}

    started = time.perf_counter()
    try:
        llm = build(cred)
        text = ""
        async for delta in llm.stream(
            [{"role": "user", "content": "ping"}], temperature=0, max_tokens=1
        ):
            text += delta.content or ""
            if len(text) >= 4:
                break
        return {
            "ok": True,
            "resolved": resolved,
            "ms": int((time.perf_counter() - started) * 1000),
            "reply": text[:40],
            "message": "调用成功，这个配置可以直接用。",
        }
    except ProviderError as e:
        return {
            "ok": False,
            "resolved": resolved,
            "ms": int((time.perf_counter() - started) * 1000),
            "message": str(e),
        }
    except Exception as e:  # noqa: BLE001
        return {
            "ok": False,
            "resolved": resolved,
            "ms": int((time.perf_counter() - started) * 1000),
            "message": f"{type(e).__name__}: {e}",
        }


async def _probe_reachability(cred: ResolvedCredential) -> dict:
    """非 generic-http 模块的轻量探测：HEAD/GET 一下 base_url。"""
    import httpx

    headers = {}
    if cred.api_key:
        headers["Authorization"] = f"Bearer {cred.api_key}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=8.0, read=12.0, write=8.0, pool=8.0)) as client:
            resp = await client.get(cred.base_url, headers=headers)
        # 401/403 说明地址通了、只是没带对凭据 —— 对「地址是否有效」这个目的来说算通过
        ok = resp.status_code < 500 or resp.status_code in (401, 403)
        return {
            "ok": ok,
            "status": resp.status_code,
            "message": "" if ok else f"地址可达但返回 HTTP {resp.status_code}，检查 base_url 是否少了 /v1",
            "note": "只验证了地址可达性；真正的调用能力在对话时才会体现",
        }
    except httpx.RequestError as e:
        return {"ok": False, "status": None,
                "message": f"连接失败：{type(e).__name__}: {e}"}


# ---------------------------------------------------------------- 会话

@router.get("/sessions")
async def sessions() -> dict:
    d = ROOT / "data" / "sessions"
    items = []
    if d.exists():
        for f in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
            try:
                raw = json.loads(f.read_text(encoding="utf-8"))
                msgs = raw.get("messages", [])
                last_user = next((m["content"] for m in reversed(msgs) if m.get("role") == "user"), "")
                items.append({
                    "id": raw.get("id", f.stem),
                    "updated": raw.get("updated", 0),
                    "messages": len(msgs),
                    "last_user": (last_user or "")[:80],
                })
            except (json.JSONDecodeError, OSError):
                continue
    return {"sessions": items}


@router.get("/sessions/{session_id}")
async def session_detail(session_id: str) -> dict:
    s = store.get(session_id, build_system_prompt(Session(session_id), name=settings.persona_name))
    return {"id": s.id, "messages": s.transcript(), "vision_notes": s.vision_notes}


@router.delete("/sessions/{session_id}")
async def session_delete(session_id: str) -> dict:
    s = Session(session_id)
    if s.path.exists():
        s.path.unlink()
        return {"ok": True, "deleted": s.id}
    return {"ok": False, "message": "不存在"}


# ---------------------------------------------------------------- 视觉（眼睛）

@router.post("/vision")
async def vision(payload: dict = Body(...)) -> dict:
    """接收一张图（data URL 或 base64）并让多模态模型描述它。

    单独的 HTTP 接口而不是只走 WebSocket：截图/摄像头这类调用是「一问一答」，
    不需要流式，独立接口更好调试（curl 就能测）。
    """
    cred = resolve(CAP_VLM, header_overrides=headers_to_overrides(_pseudo_headers(payload)))
    if not cred.base_url:
        raise HTTPException(400, "视觉能力未配置：请在设置里选一个多模态供应商并填模型")
    if cred.source == "none":
        raise HTTPException(401, "该视觉供应商需要 API Key，但没收到（前端应带上 x-provider-vlm-key）")

    image = payload.get("image", "")
    if not image:
        raise HTTPException(400, "缺少 image")
    data_url = _to_data_url(image)

    vlm = build(cred)
    try:
        res = await vlm.describe(data_url, prompt=payload.get("prompt", ""))
    except ProviderError as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True, "text": res.text, "provider": cred.provider, "model": cred.model}


def _pseudo_headers(payload: dict) -> dict[str, str]:
    """POST body 里也能带供应商覆盖项，键名与请求头一致（如 vlm_key）。"""
    out: dict[str, str] = {}
    for cap in ("llm", "asr", "tts", "vlm"):
        for field in ("provider", "model", "base_url", "key", "voice"):
            v = payload.get(f"{cap}_{field}")
            if v:
                out[f"x-provider-{cap}-{field.replace('_', '-')}"] = str(v)
    return out


def _to_data_url(image: str) -> str:
    if image.startswith("data:"):
        return image
    try:
        base64.b64decode(image, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "image 既不是 data URL 也不是合法 base64")
    return f"data:image/jpeg;base64,{image}"


# ---------------------------------------------------------------- 形象资源

#: Live2D 模型清单文件的两种格式。
#:   *.model3.json → Cubism 3/4/5（新版，我们主力支持）
#:   *.model.json  → Cubism 2（旧版，很多开源/游戏提取模型是这个格式）
#: 两者的 moc 文件扩展名也不同（.moc3 vs .moc），前端渲染路径不一样，
#: 所以清单里必须把 format 标出来，不能一律当新模型处理。
MODEL_MANIFEST_PATTERNS = (
    ("cubism4", "*.model3.json"),
    ("cubism2", "*.model.json"),
)


def _is_hidden_path(rel: str) -> bool:
    """判断相对路径里是否有「隐藏/备份」目录段。

    为什么需要：运维时经常要把一个模型临时移走（改名成 `X.__hidden` 或 `.bak`），
    但 rglob 会照样钻进去，于是「移走的模型仍然出现在列表里」——
    这种"我明明移走了它还在"的错觉很难查。
    以 `.` 开头、或含 `.__` / `.bak` / `.disabled` 的目录段一律跳过。
    """
    for seg in rel.split("/"):
        if seg.startswith("."):
            return True
        low = seg.lower()
        if ".__" in low or low.endswith((".bak", ".disabled", ".off", ".old")):
            return True
    return False


def _scan_models() -> list[dict]:
    """扫 assets/models，返回两种格式的模型清单（含格式标记）。"""
    root = ASSETS_DIR / "models"
    found: list[dict] = []
    if not root.exists():
        return found
    seen_dirs: set[str] = set()
    for fmt, pattern in MODEL_MANIFEST_PATTERNS:
        for f in sorted(root.rglob(pattern)):
            rel_dir = f.parent.relative_to(root).as_posix()
            if _is_hidden_path(rel_dir):
                continue
            key = f"{fmt}:{rel_dir}"
            if key in seen_dirs:
                continue
            seen_dirs.add(key)
            try:
                size = sum(p.stat().st_size for p in f.parent.rglob("*") if p.is_file())
            except OSError:
                size = f.stat().st_size
            found.append({
                "name": f.parent.name or rel_dir,
                "dir": rel_dir,
                "manifest": f.name,
                "path": "/" + f.relative_to(ROOT).as_posix(),
                "format": fmt,
                "size": size,
            })
    return sorted(found, key=lambda x: (x["format"], x["name"]))


@router.get("/models/live2d")
async def live2d_models() -> dict:
    """扫 assets/models 找可用模型（同时支持 Cubism 2 与 3/4/5 的清单格式）。"""
    models = _scan_models()
    return {
        "models": models,
        "counts": {
            "total": len(models),
            "cubism4": sum(1 for m in models if m["format"] == "cubism4"),
            "cubism2": sum(1 for m in models if m["format"] == "cubism2"),
        },
        "cubism_core_ready": (ASSETS_DIR / "cubism" / "live2dcubismcore.min.js").exists(),
        "cubism2_core_ready": (ASSETS_DIR / "cubism" / "live2d.min.js").exists(),
    }


@router.get("/runtime")
async def runtime() -> dict:
    """前端用来判断「哪些能力现在真的可用」——避免做出做不到的承诺。"""
    ready = {
        "cubism_core": (ASSETS_DIR / "cubism" / "live2dcubismcore.min.js").exists(),
        "local_asr": _module_exists("faster_whisper"),
        "local_tts": _module_exists("piper"),
        "ffmpeg": _which("ffmpeg") is not None,
    }
    return {"ready": ready, "defaults": settings.default_providers}


MAX_MODEL_FILE = 32 * 1024 * 1024      # 单个文件上限
MAX_MODEL_TOTAL = 200 * 1024 * 1024    # 一次上传总量上限

# 路径白名单：只允许这些后缀落盘。模型目录是纯静态资源，不该出现可执行内容。
# 注意包含 .moc —— Cubism 2 旧模型的二进制主体，不含它就没法兼容老模型。
ALLOWED_MODEL_SUFFIX = (
    ".json", ".moc", ".moc3",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    ".physics3.json", ".cdi3.json", ".pose3.json", ".exp3.json",
    ".motion3.json", ".model3.json", ".model.json",
    ".txt", ".md", ".exp.json", ".physics.json", ".pose.json", ".motion.json",
)


def _model_subdir(rel_parts: list[str], model_root: tuple[str, ...],
                  root_manifests: list[str] | None = None) -> str:
    """算出某个文件应该落进哪个模型目录。

    规则：**以模型清单（*.model3.json / *.model.json）为锚点**。

    为什么要这么绕：前端为了目录干净会把顶层文件夹名去掉，
    于是 `Hiyori/Hiyori.model3.json` 变成 `Hiyori.model3.json`（落在根），
    而 `Hiyori/Hiyori.2048/texture_00.png` 变成 `Hiyori.2048/texture_00.png` ——
    若简单按第一段目录分组，同一个模型会被拆成三个目录（实测踩到过）。

    三种情况：
      · 清单带目录（拖入时保留顶层名）→ 用清单所在目录
      · 清单在根级且只有一个 → 用清单文件名推目录名
      · 清单在根级且有多个（一次导入多个模型）→ 用**目录名与清单名的前缀匹配**归属，
        匹配不上就落到清单名最长的那个（避免把文件丢进错误的模型）
    """
    if model_root:
        head = list(model_root)
        if rel_parts[: len(head)] == head:
            return head[0]
        return rel_parts[0] if len(rel_parts) > len(head) else head[0]

    dirs = [d for d in (root_manifests or []) if d]
    if not dirs:
        return rel_parts[0] if len(rel_parts) > 1 else "default"
    if len(dirs) == 1:
        return dirs[0]

    # 多模型：用该文件所在目录/文件名，去和各个清单名比对
    probe = rel_parts[0] if len(rel_parts) > 1 else rel_parts[0].split(".")[0]
    probe_low = probe.lower()
    for d in sorted(dirs, key=len, reverse=True):
        dl = d.lower()
        # 双向包含：HQ.model3.json 与 HQ.2048/、HQ/、HQ.motion3.json 都能对上
        if dl in probe_low or probe_low in dl:
            return d
    return max(dirs, key=len)


@router.post("/models/upload")
async def upload_model(payload: dict = Body(...)) -> dict:
    """导入 Live2D 模型到 assets/models/。

    两种提交形态：
      1. **多个模型**（推荐）：files[].path 带相对路径，形如 `Hiyori/Hiyori.model3.json`，
         服务端以**模型清单所在目录**为锚点自动分组 —— 一次拖入十个模型也能各自成目录。
      2. **单个模型**：显式给 dirname，所有文件都落到该目录下。

    为什么不再强制要求 dirname：前端用 webkitdirectory 或拖入文件夹时，
    每个文件都带 webkitRelativePath，目录结构本身已经表达了「哪些文件属于同一个模型」。
    再让用户额外填一个目录名，既多余又容易把两个模型混进同一目录。

    安全约束（别删）：
        - 相对路径不许有 `..`、不许绝对路径；每段目录名都做字符白名单
        - 文件后缀白名单（模型目录是纯静态资源，不该出现可执行内容）
        - 单文件与总量双上限，防止一次请求把磁盘写满
        - 落盘前再校验一次最终路径必须在 assets/models 之内
    """
    files = payload.get("files") or []
    overwrite = bool(payload.get("overwrite", True))
    explicit_dir = str(payload.get("dirname", "")).strip()

    if not files:
        raise HTTPException(400, "没有要保存的文件")
    if explicit_dir and not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff][A-Za-z0-9_\-\u4e00-\u9fff .]{0,63}", explicit_dir):
        raise HTTPException(400, "目录名只能含中英文/数字/下划线/短横线/点，且不超过 64 字符")

    models_root = (ASSETS_DIR / "models").resolve()
    models_root.mkdir(parents=True, exist_ok=True)

    # ---- 先归一化所有相对路径，并找出模型清单的公共父目录（作为落盘基准）----
    normalized: list[tuple[list[str], dict]] = []
    for item in files:
        rel_in = str(item.get("path", "")).replace("\\", "/").lstrip("/")
        if not rel_in or item.get("data") is None:
            continue
        parts = [p for p in rel_in.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise HTTPException(400, f"非法相对路径：{rel_in}")
        normalized.append((parts, item))

    manifests: list[list[str]] = [
        parts for parts, _ in normalized
        if parts and parts[-1].lower().endswith((".model3.json", ".model.json"))
    ]
    model_root: tuple[str, ...] = ()
    if manifests:
        # 取所有清单路径的最长公共父目录；只剩文件名时为空（说明清单在批次根下）
        common = list(manifests[0][:-1])
        for m in manifests[1:]:
            parent = m[:-1]
            n = 0
            while n < len(common) and n < len(parent) and common[n] == parent[n]:
                n += 1
            common = common[:n]
        model_root = tuple(common)

    # 清单若落在根级（前端剥掉了顶层文件夹名），用清单文件名推目录名；
    # 多个清单就是一次导入了多个模型，交给 _model_subdir 做前缀归属
    root_manifests: list[str] = []
    for m in manifests:
        if len(m) == 1:
            name = re.sub(r"\.(model3?\.json|model\.json)$", "", m[0], flags=re.I) or "model"
            if name not in root_manifests:
                root_manifests.append(name)

    skipped: list[str] = []
    saved: list[str] = []
    dirs_touched: set[str] = set()
    total = 0

    for parts, item in normalized:
        rel_in = "/".join(parts)
        if not rel_in.lower().endswith(ALLOWED_MODEL_SUFFIX):
            skipped.append(rel_in)
            continue

        subdir = explicit_dir or _model_subdir(parts, model_root, root_manifests)
        for seg in [subdir] + parts[:-1]:
            if seg and not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff][A-Za-z0-9_\-\u4e00-\u9fff .]{0,63}", seg):
                raise HTTPException(400, f"目录名含非法字符：{seg}")

        rel_norm = f"{subdir}/{rel_in}"
        try:
            blob = base64.b64decode(item.get("data"), validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(400, f"{rel_in} 的 base64 数据不合法") from e
        if len(blob) > MAX_MODEL_FILE:
            raise HTTPException(413, f"{rel_in} 超过单文件上限 {MAX_MODEL_FILE // 1024 // 1024}MB")
        total += len(blob)
        if total > MAX_MODEL_TOTAL:
            raise HTTPException(413, "本次导入总量超过上限，请分批导入")

        dest = (models_root / rel_norm).resolve()
        if models_root not in dest.parents:
            raise HTTPException(400, f"非法落盘路径：{rel_norm}")
        if dest.exists() and not overwrite:
            skipped.append(rel_in + "（已存在）")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        # 先写 .part 再原子替换：中途失败不会留下半个模型文件骗过扫描器
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(blob)
        tmp.replace(dest)
        saved.append(rel_norm)
        dirs_touched.add(subdir)

    if not saved:
        raise HTTPException(
            400,
            "没有可保存的模型文件。检查是否包含 .model3.json / .model.json / .moc3 / .moc 与贴图；"
            + (f"被跳过的文件：{', '.join(skipped[:5])}" if skipped else ""),
        )

    # 导入完直接把扫描结果回给前端，省一次往返，也让「导入后立刻能选」更直观
    models = _scan_models()
    imported = [m for m in models if m["dir"].split("/")[0] in dirs_touched or m["dir"] in dirs_touched]
    return {
        "ok": True,
        "dirs": sorted(dirs_touched),
        "saved": len(saved),
        "skipped": len(skipped),
        "skipped_files": skipped[:8],
        "bytes": total,
        "imported": imported,
        "models": models,
    }


def _module_exists(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _which(cmd: str) -> str | None:
    import shutil

    return shutil.which(cmd)
