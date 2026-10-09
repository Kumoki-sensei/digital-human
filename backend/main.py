"""FastAPI 应用装配 + 静态资源托管。

静态资源刻意由后端托管而不是让前端另起一个 dev server：
    数字人要在同一个 origin 上开麦克风、走 WebSocket、拖 Live2D 模型，
    跨域会平白多出一堆 CORS 与权限坑。前端不需要构建步骤，
    所以「后端顺带当静态服务器」是最省事且最稳的形态。
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import chat, routes
from .config import ROOT, settings

log = logging.getLogger(__name__)

WEB_DIR = ROOT / "web"
ASSETS_DIR = ROOT / "assets"

# 开发期必须禁止缓存的前端资源类型。
# 理由不是「性能」，而是「正确」：JS 被浏览器缓存住，你改完代码刷新看到的还是旧逻辑，
# 这种幽灵 bug 排查成本极高（本项目已经吃过一次亏）。
NO_CACHE_SUFFIXES = (".js", ".mjs", ".css", ".html", ".json", ".map")


class NoCacheStaticFiles(StaticFiles):
    """给前端静态资源加上禁止缓存的响应头；模型等大资产仍然走正常缓存。"""

    async def get_response(self, path: str, scope) -> Response:
        resp = await super().get_response(path, scope)
        if path.endswith(NO_CACHE_SUFFIXES):
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
            # 弱 ETag 会让刷新回 304，开发期直接去掉。
            # 注意 MutableHeaders 只支持 del，不支持 dict 的 pop —— 写 pop 会 500，
            # 而且是在静态资源上 500，表现成「整个前端不加载」，极易误判。
            if "etag" in resp.headers:
                del resp.headers["etag"]
        return resp


def create_app() -> FastAPI:
    app = FastAPI(
        title="数字人后端",
        version=__version__,
        description="能听 / 能说 / 能做 / 能聊 —— 可插拔的四能力数字人后端",
    )

    @app.on_event("startup")
    async def _load_custom_modules() -> None:
        """启动时把用户的自定义模块装进注册表。

        放启动而不是每次请求：注册表是进程级状态，每次请求重建会让
        「同名模块被覆盖」这类问题变成时序问题。配置改动通过 API 保存时会
        立即重新注入，所以这里只需处理冷启动。
        """
        from .core.custom_modules import apply_to_registry

        try:
            ids = apply_to_registry()
            log.info("启动完成：内置模块 + %d 个自定义模块", len(ids))
        except Exception:  # noqa: BLE001  配置坏了不能拖垮整个服务
            log.exception("自定义模块装载失败（已忽略，内置模块仍可用）")

    # 自用场景：允许任意来源（方便你以后把前端拆到 Vite 或另一个端口调试）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(routes.router)
    app.include_router(chat.router)

    # Live2D 运行时与模型：走 /assets/**，Cubism Core 必须能按相对路径被 moc3 加载。
    #
    # 这里也用 NoCacheStaticFiles：Core 与模型是我们会反复替换的开发资产，
    # 浏览器缓存住旧内核的后果非常隐蔽 —— 表现是「换了新模型却加载失败」
    # （旧 Cubism Core 解析不了新版 moc3，fromArrayBuffer 直接返回 null），
    # 而错误信息只会说「解析返回空」，完全指不到缓存这个真因。
    # 之前只给 / 和 /web 加了 no-cache，漏了这里，又被咬了一次。
    if ASSETS_DIR.exists():
        app.mount("/assets", NoCacheStaticFiles(directory=str(ASSETS_DIR)), name="assets")

    @app.get("/")
    async def index(request: Request):
        f = WEB_DIR / "index.html"
        if not f.exists():
            return JSONResponse({"error": "web/index.html 不存在"}, status_code=500)
        return FileResponse(
            f, headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
        )

    if WEB_DIR.exists():
        # html=True 让 /settings/ 这类目录路径也能落到 index.html
        app.mount("/", NoCacheStaticFiles(directory=str(WEB_DIR), html=True), name="web")
    else:  # pragma: no cover
        log.warning("web/ 目录不存在，前端不会启动")

    return app


app = create_app()
