# Live2D 运行时文件（不随仓库分发）

Live2D Cubism Core（`live2dcubismcore.min.js`）与 SDK 属于 **Live2D Inc. 的专有许可软件**，
不可以提交进本仓库。请自行下载并放到本目录，网页才能加载 Live2D 模型：

## 1. Cubism Core（必需，约 200KB）

- 官方下载页：https://www.live2d.com/download/cubism-sdk/download-web/
- 取 Web 版压缩包里的 `Core/live2dcubismcore.min.js`
- 放到：`assets/cubism/live2dcubismcore.min.js`

也可以直接跑仓库自带的脚本自动下载（脚本会提示你去官网确认同意许可）：

```powershell
uv run python tools/fetch_cubism.py
```

## 2. Cubism Web Framework（可选）

若只想先用「官方 sample 模型」把画面跑起来，框架文件已通过 npm 无法直连时，
可从同一个压缩包里取 `Framework/` 下的 `dist/` 与 `src/`，放到：

```
assets/cubism/framework/
```

## 3. 模型放哪

```
assets/models/<你的模型名>/<模型名>.model3.json
                               <模型名>.moc3
                               *.physics3.json / *.cdi3.json / textures/
```

网页设置面板里可以直接拖入整个模型文件夹（浏览器会本地加载，不上传），
或在 `.env` / 设置里写默认模型路径。

> 商用请注意授权：官方 sample 模型仅限个人学习与非商业用途。
