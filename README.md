# 数字人（名称待定）

一个能在网页里 **听你说话、用语音回答、调用工具做事、接你自己的模型密钥** 的数字人。
前端 Live2D + 原生三件套，后端 FastAPI，四个能力接口（LLM / ASR / TTS / VLM）全部可插拔。

> 状态：**M0 骨架已验收，M1 语音链路硬化进行中**。
> 文字对话、语音链路（浏览器原生识别 + 语音合成）、**自动断句（说完自动发送）**、
> 延迟仪表盘、换肤系统已完成；
> Live2D 渲染已接通官方 Cubism Web Framework，无模型时降级为「空状态引导」。
>
> **阶段怎么划分、每个阶段怎么算做完，以 [`docs/roadmap.md`](docs/roadmap.md) 为准**
> （M0 骨架 → M1 语音链路 → M2 形象 → M3 业务化 → M4 工程化 → M5 产品化）。
> 那份文档同时收了**踩坑记录**（含 Live2D 渲染的 14 条）与「待拍板」事项。
> 其中 M1 的算法层已完成，但**「真人真麦克风」的真机验证项全部未做**；
> M0 有一处欠账（确认中心闭环，`roadmap.md` 第五节 #1）。

---

## 一、先跑起来

```powershell
# 一次性：装依赖（本机 python 命令不可用，一律用 uv）
uv sync

# 启动
uv run python -m backend
#   → 网页 http://127.0.0.1:8000/
#   → 接口文档 http://127.0.0.1:8000/docs
```

不配任何密钥就能跑：大脑走「离线回声」，耳朵嗓子走浏览器原生能力。
想让它真会思考，打开网页右上角 ⚙ → 模型 → 选供应商、填你自己的 API Key。

环境自检（缺什么一目了然）：

```powershell
uv run python tools/check_env.py
```

---

## 二、四能力接口：这是整个后端的骨架

数字人 = 四个可替换的能力 + 一个把它们串起来的编排层。

| 能力 | 类比 | 默认实现 | 可换成的 |
|---|---|---|---|
| LLM | 大脑 | 离线回声 | OpenAI / DeepSeek / 硅基流动 / 百炼 / 智谱 / Kimi / Ollama 本机 |
| ASR | 耳朵 | 浏览器原生识别 | OpenAI Whisper / SenseVoice / 本机 faster-whisper |
| TTS | 嗓子 | 浏览器语音合成 | OpenAI TTS / CosyVoice / 本机 Piper |
| VLM | 眼睛 | 关闭 | GLM-4V / Qwen-VL / GPT-4o / 本机模型（走 Ollama） |

> 本机视觉**没有独立实现**（没有 llava 适配器）。要用本机视觉，走 Ollama 的 OpenAI 兼容接口。
> ASR/TTS 的本机实现是真的（faster-whisper / piper），但需要装 `ffmpeg` 与对应 extras，见第五节。

**任何说 OpenAI 协议的供应商都能插进来**（`backend/provider_registry.py` 里加一行即可），
也可以在网页设置里选「自定义」直接填 `base_url` + 模型名。

### 自带密钥是怎么走的（重要）

```
浏览器 localStorage ──(WS 连接参数 p=llm.provider:deepseek,llm.key:sk-xxx)──► 后端
                                                                        │
                                        仅本次连接生命周期内持有，不落盘、不进日志
```

- 为什么走 URL 参数：**浏览器的 `WebSocket` 构造函数无法自定义请求头**，这是标准限制。
- 代价要说清楚：密钥是**明文存在浏览器里**的，同机其他程序、浏览器扩展理论上可读。
  **自用可以，给别人用必须改成后端加密存储 + 鉴权**（见 roadmap 待拍板第 5 条）。
- 后端侧保证：任何日志都不打印完整 URL；错误信息里密钥只以 `sk-a…z9` 形式出现。

---

## 二点五、模块化：怎么把「你自己的 API」接进来

`build()` 里不再有「协议不支持就报错」这条死路。**任何 HTTP 接口都能接**，
方式是从易到难三层，按你的定制深度选：

| 层次 | 你要做什么 | 适合谁 |
|---|---|---|
| ① 预设供应商 | 只用现成的（OpenAI / DeepSeek / 硅基流动 / 百炼 / 智谱 / Kimi / Ollama） | 大多数人 |
| ② **声明式自定义模块** | 在网页「模块」面板填一份 JSON（地址 + 请求字段 + 响应字段） | 有自己 API 的人 |
| ③ 代码级适配器 | 写个 Python 类实现下面四个 Protocol 之一 | 协议方言特殊到没法声明式描述 |

**四个能力契约**（实现任意一个时都必须满足的数据形状）：

```
LLM  吃 messages[]，异步生成器吐 LLMDelta{content?, tool_calls?, finish_reason?}
ASR  吃 audio bytes，返回 ASRResult{text, language?, duration?}
TTS  吃一句文本，异步生成器吐 TTSChunk{audio, mime, text, final}
VLM  吃图片 data URL + prompt，返回 VisionResult{text}
```

### 例 1：对方讲 OpenAI 协议 → 一行配置

网页「模块」面板选 `llm`、填模板，改两处即可：

```json
{
  "cap": "llm", "id": "my-brain", "label": "我自己的大脑",
  "protocol": "generic-http",
  "base_url": "https://your-server.com/v1",
  "default_model": "your-model",
  "request": {
    "url": "{base_url}/chat/completions",
    "method": "POST",
    "json": { "model": "{model}", "messages": "{messages}", "stream": true }
  },
  "chunk_text_path": "choices.0.delta.content"
}
```

### 例 2：对方协议完全不一样 → 靠字段映射，仍然不写代码

给定一个新奇接口：URL 是 `/v2/ask`，参数叫 `q` 与 `history`，流式事件的文本在
`payload.token`：

```json
{
  "cap": "llm", "id": "weird-api", "label": "某私有服务",
  "protocol": "generic-http",
  "base_url": "https://weird.example.com",
  "request": {
    "url": "{base_url}/v2/ask",
    "method": "POST",
    "headers": { "X-App-Id": "digital-human", "Authorization": "Bearer {api_key}" },
    "json": { "q": "{last_user}", "history": "{messages}", "model": "{model}" }
  },
  "chunk_text_path": "payload.token"
}
```

可用占位符：`{base_url}` `{model}` `{api_key}` `{voice}` `{messages}` `{text}`
`{image}` `{prompt}` `{temperature}` `{max_tokens}`。
**只做字符串替换，不求值** —— 配置文件不该成为代码执行入口。

### 例 3：只想接到一个本地小服务

```json
{
  "cap": "tts", "id": "my-local-voice", "label": "本机嗓音服务",
  "protocol": "generic-http", "base_url": "http://127.0.0.1:5000",
  "request": {
    "url": "{base_url}/tts", "method": "POST",
    "json": { "text": "{text}", "speaker": "{voice}" }
  },
  "response": { "audio_path": "data.audio_base64" }
}
```

### 保存前先验证：探测接口

网页上有「探测连通性」按钮，对应 `POST /api/modules/probe`。它发**一次最小请求**
（LLM/VLM 用 `max_tokens=1`；非 POST 接口只验证可达性；ASR/TTS 不硬试合成，
因为空音频/空文本在各家行为不一致，硬试会大量误报），并把失败原因说成人话：

```
✅ 探测通过        状态码：200　耗时：49ms
❌ 探测未通过      状态码：404　原因：接口地址或模型名不存在，检查 request.url 与 base_url 是否重复拼接了 /v1
```

### 管理接口一览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/modules/catalog` | 能力契约 + 全部模块 + 分层结构（模块面板的数据源） |
| GET | `/api/modules/custom` | 已保存的自定义模块 |
| POST | `/api/modules/custom` | 新增/更新（白名单过滤，密钥字段会被剔除并记警告） |
| DELETE | `/api/modules/custom/{cap}/{id}` | 删除 |
| POST | `/api/modules/probe` | 探测：支持已保存模块，也支持**未保存的草稿** |

### 密钥边界（这条别改）

`data/custom_modules.json` **只存端点与字段映射**。白名单里根本没有
`key/token/secret/password` 这类字段，传了也会被剔除。
密钥仍然只走「浏览器 localStorage → 连接参数 → 后端即用即弃」这条通道。

理由很直接：配置文件会被备份、会被拷给别人、会被不小心提交。
密钥一旦落进去，就一定会泄漏。需要静态 token 的场景请让后端从环境变量读。

---

## 三、目录结构

```
backend/                     后端（一个 FastAPI 服务）
  provider_registry.py       四能力注册表 + 凭据三级解析（用户→服务端→默认）
  providers/                 base.py 四协议 · openai_compat.py 共用客户端
                             generic.py 通用 HTTP 转发器（把任意 API 接成模块）
                             llm.py / asr.py / tts.py / vlm.py 具体实现
  core/                      session.py 记忆 · tools.py 工具与确认中心
                             audio.py 流式分句 · brain.py 编排 · persona.py 人格
                             module_registry.py 能力契约与模块清单（架构视图的数据源）
                             custom_modules.py 声明式自定义模块（读写与校验）
  api/                       schema.py 协议唯一事实源 · chat.py WebSocket · routes.py HTTP
  main.py                    应用装配（含开发期禁缓存静态资源）
  log_hygiene.py             日志密钥清洗（同时挂到 uvicorn 默认日志与访问日志）
data/
  custom_modules.json        自定义模块配置（**不含密钥**，写入时自动剔除）
  sessions/                  会话记忆（每个 session 一个 JSON，原子落盘）
web/                         前端三件套（原生 ES Module，无构建步骤）
  index.html                 结构（品牌主页 + 对话台两块）
  styles/                    tokens.css 设计令牌（全站外貌的唯一事实来源）
                             layout.css 骨架 · components.css 组件
                             empty-state.css 空状态（**没有模型时显示什么，不画假形象**）
                             home.css 品牌主页 · themes/*.css 皮肤包
  scripts/                   main.js 接线 · ui.js 渲染 · bus.js 事件总线 · config.js 配置
                             client.js WebSocket 通道 · audio.js 声音 · vision.js 眼睛
                             themes.js 换肤 · home.js 品牌主页
                             vad.js 自动断句（算法与浏览器解耦，可离线单测）
                             mic-worklet.js AudioWorklet 原始 PCM 采集
                             avatar.js + live2d-framework-model.js + lip-sync.js + lip.js
                               —— Live2D 层：装载 / 官方 Framework 渲染 / 口型同步 / 口型驱动
  dev/vad-lab.html           VAD 离线自检台（23 条断言，不开麦克风也能验证判定逻辑）
  dev/framework-model-check.html · framework-render.html   Live2D 渲染的回归验证页
  skins/                     外挂 JS 皮肤（`*.skin.js`）—— 加载器已实现，**该目录尚未创建**
assets/
  cubism/                    Cubism Core 放这里（专有许可，不随仓库分发）
  models/                    Live2D 模型（不进 git）
tools/                       环境自检 check_env.py、Cubism Core 与示例模型下载脚本
scripts/dev.ps1              开发启动脚本
docs/roadmap.md              路线图：阶段划分 + 验收标准 + 踩坑记录 + 待拍板（唯一路线图文档）
docs/live2d-render-fixes.md  Live2D 渲染排障全过程（14 个坑）
```

---

## 四、几个不打算改的设计决定

1. **逐句 TTS，不做整段合成。**
   LLM 一边吐字，分句器一边凑句，凑够一句立刻合成一段音频推给前端播放。
   用户听到第一句话的时间 ≈ 首句合成时间，而不是整段回复的合成时间。

2. **打断是第一优先级，不是可选优化。**
   每轮对话跑在独立 asyncio 任务里，用户一开口就 cancel 掉：
   LLM 的 HTTP 流、TTS 请求一起断，不会出现「你已经在说话，她还在念上一段」的叠音。

2.5 **延迟是可观测的，不靠感觉。**
   每轮结束状态栏会显示总耗时，点开就是三段分解：**听懂(ASR) / 首字(LLM) / 首帧(TTS)**，
   外加每次工具的耗时与每个分句的合成时长。哪个数字最大，瓶颈就在哪：
   首字慢换 LLM，首帧慢换 TTS 或缩短句长，听懂慢换 ASR 或走本机。
   慢在哪看得见，才谈得上调优。

3. **写操作必须两段式确认。**
   模型提出 → 网页弹确认卡 → 用户点头才真正执行。LLM 会自作主张，
   而删文件、发消息这类操作不可撤销。要确认的工具在注册表里标 `requires_confirm`。

   > ⚠️ **这条目前只落实了一半**：模型发起的确认请求虽然会弹卡，但用户点「允许」后
   > **工具不会被执行**（后端从不登记待处理请求，前端也不负责执行）。
   > 唯一带确认的工具 `look_at_screen` 因此走模型调用时 100% 失效。
   > 这是 M0 的未竟项，详见 [`docs/roadmap.md` 第五节](docs/roadmap.md)。

4. **工具调用一轮最多 3 次往返。**
   没有上限时，一个绕不出来的模型会无限自我调用，账单和延迟一起爆炸。

5. **前端不用框架、不打包。**
   要求是「你能随手改」——原生 DOM + 一个 30 行事件总线，比任何框架都更好读懂。
   真要上框架时，需要改的只有 `ui.js` 和 `main.js`。

6. **一个事件只允许有一个渲染者。**
   这条是踩坑换来的，见下。

6.5 **能改一行配置的，不要逼人改代码。**
   定制化的门槛必须在「填 JSON」这一层，否则所谓模块化只是把耦合藏起来了。
   具体表现：预设供应商改注册表一行；自己的 API 填配置（见第三节）；只有协议方言
   特殊到无法声明时才写 Python 适配器。

7. **会发出声音的东西，默认必须是关的。**
   本项目的语音播报**默认静音**（`voice.autoplay: false`）：它不会自己开口，
   你打开网页、发消息，都只有文字。想听声音去 设置 → 人格 → 语音播报，
   勾上「自动播放语音」，改完立刻生效，随时可以用页面上的「停」打断。

   这条规则是被实践教育出来的：早期版本默认开启浏览器 TTS，
   用户一发消息网页就自己说话（还专挑安静的时候），把人吓一跳。
   默认开着一个会突然出声的功能，是纯粹的失礼。

   实现上分两个开关，别混淆：
   - 前端 `voice.autoplay` —— 「要不要放出来」
   - 后端 `tts_enabled` —— 「要不要合成」

   关掉前端那一个，后端的合成也会被一起关掉（省一次无用请求）。

8. **说话要能自动断句，别让用户按按钮。**
   `web/scripts/vad.js` 用 AudioWorklet 取原始采样做能量判定：静音持续到设定时长
   就认为你说完了，自动送出。算法与浏览器 API 完全解耦，所以能离线单测
   （`web/dev/vad-lab.html`，23 条断言）。两条硬规则：
   - **数字人播放时冻结判定**，否则它自己的声音会被当用户输入（自问自答）；
   - 冻结期间仍要继续估计噪声底，否则解除后阈值失真（这条是测试抓出来的）。
   设置 → 形象 → 语音采集里有实时电平表：能量曲线 + 阈值线 + 说话区间，
   灵敏度和判定时长都能调 —— 看不见阈值就调不动它。

   注意：麦克风采集是**需要你点一次麦克风才会启动**的，不会自动开麦。

9. **默认不预设人格。**
   名字与性格两栏默认**留空**，此时她只遵守一套中性行为规则
   （说话简短、不用 markdown、不编造、不假装做过事、写操作先确认）。
   没有昵称、没有口癖、没有亲疏设定。

   为什么这样设计：人格是最不该「默认」的东西。把一个创作者的个人口味
   硬编码进默认值，等于替使用者做了决定，而且他还得先找到哪里能改。
   正确做法是留空 —— 交付给谁，就由谁在 **设置 → 人格** 里填两栏决定：
   - **名字**：她会用它自称；留空时**不会自己编名字**，被问到会如实说还没设定
   - **性格与说话方式**：原样拼进系统提示词，可以写得很细

   想为整个部署定基调（而不是让每个使用者各自设），用环境变量
   `DH_PERSONA_NAME` / `DH_PERSONA_STYLE`。

   行为规则那一层建议不要删 —— 那不是人格，那是「别胡说八道」的底线。

---

## 五、换肤系统（你后面要做美化的地方）

- **设计令牌**：`web/styles/tokens.css` 是全站唯一外观事实来源。组件层不许出现硬编码色值。
- **皮肤包**：`web/styles/themes/*.css`，一个文件一套皮肤，只覆盖令牌。
  复制 `_template.css` 改颜色 → 在 `scripts/themes.js` 的 `THEMES` 数组里加一条即可。
- **热切换**：`<html data-theme="...">` + 切换 `<link>`，不刷新页面。内置 **5 套**，
  默认 `starlight`：
  `starlight`（星轨，默认）/ `midnight`（深海午夜）/ `sakura`（樱花软糖）/
  `terminal`（终端绿）/ `paper`（纸感）。
- **动效统一控制**：滑杆写 `--motion-scale`，全站过渡时长一起变；尊重系统「减少动态效果」。
- **JS 动态美化**：在 `web/skins/` 放 `*.skin.js`（加载器与 `raf` / `listen` 自动清理已实现，
  **但目前没有任何样例文件，`web/skins/` 目录也还没建** —— 要自己写一个再放进去）：

```js
export default {
  id: 'my-skin',
  name: '我的动态皮肤',
  onMount(ctx) {
    // ctx: { document, root, stage, canvas, avatar, chat, $, emit, raf, listen, vars }
    //   raf(fn)    注册动画循环，卸载时自动停
    //   listen(t,evt,fn)  注册事件，卸载时自动解绑
    //   vars.set('--x', v) 写 CSS 变量
    ctx.raf((t) => { /* 粒子、视差、跟随鼠标的光斑… */ });
  },
  onUnmount(ctx) { /* 清理（raf/listen 已自动清理） */ },
};
```

在设置 → 界面 → 外挂皮肤脚本 里填路径加载（例如你自建的 `skins/my.skin.js`）。

---

## 六、Live2D 现状

渲染走的是**官方 Cubism Web Framework**（`web/vendor/cubism/`，已编译好的 ESM，随仓库分发），
外层由 `live2d-framework-model.js` / `avatar.js` / `lip-sync.js` 封装。
不依赖 pixi，也不用 CDN，**新增依赖 0、打包步骤 0**。

> 历史：早期曾自写精简 WebGL 直用 Cubism Core 的 C API，反复画不出画面后放弃，
> 改走官方 Framework 一次跑通。踩过的 14 个坑有**一页速查**（`docs/roadmap.md` 6.2 节），
> 完整排障过程见 `docs/live2d-render-fixes.md`。

实测环境：Cubism Core v6.0.1 + 3 个官方示例模型（Hiyori / Mao / whitecat），
模型加载、贴图 UV、物理、动作、表情、遮罩、着色器均正常加载，Canvas 像素输出已验证。
**但「实机人工确认」还没做** —— 渲染是在开发机上跑通的，「稳定可看」还需真人过目一遍（属 M2）。

```powershell
uv run python tools/fetch_cubism.py          # 从官网取 Core（需同意许可）
uv run python tools/fetch_sample_model.py    # 取官方示例模型（仅限个人学习/非商业）
```

然后把模型放到 `assets/models/<名字>/`，或在网页里直接拖入模型文件夹
（拖入后会问你要不要存进项目，存了以后就能在列表里直接选）。

**没有模型时页面不会白屏**：自动降级为**空状态引导**（页面直接告诉你怎么把模型放进来），
**不画假形象**。同时形象位的 CSS 变量（`--mouth-open` / `--energy` / `--emotion`）照常输出，
所以没有模型时口型与情绪依然可被驱动。

> 渲染诊断：`avatar.js` 在模型加载后的第 N 帧做一次像素检测（`#canvasHasPixels`，
> 底层读 `__dhVisiblePixels`），连续无输出即自动降级为空状态。
> 控制台上可直接读这几个探针：
> `__dhAvatar`（实例）· `canvas.__dhFrames`（帧计数）· `canvas.__dhFps`（帧率统计）·
> `canvas.__dhDiag`（运行时状态）。

---

## 七、踩过的坑（别再踩第二次）

> 这里只列**最常撞到的几条**。完整记录（运行时 11 条 + Live2D 渲染 14 条 + git/换行/代理 4 条）
> 见 [`docs/roadmap.md` 第六节](docs/roadmap.md)，那是唯一的坑清单来源。

| 坑 | 表现 | 结论 |
|---|---|---|
| `MutableHeaders` 没有 `.pop()` | 静态资源全部 500 → 整个前端不加载 | Starlette 的 headers 只能 `del`，不能 `pop` |
| 前端资源被浏览器缓存 | 改完代码刷新看到的还是旧逻辑，排查方向全错 | 开发期一律 `no-cache`，`backend/main.py` 已强制 |
| 同一个事件被两个地方渲染 | 每句话在界面上出现两遍，而监听器和模块实例都只有一份 | **一个事件只允许一个渲染者** |
| `MediaRecorder` 的 webm 片段 | 部分浏览器 `decodeAudioData` 解不了 | `audio.js` 有 `<audio>` 兜底路径 |
| AudioContext 处于 suspended | 自动化环境（无人手势）里音频永远不出声、能量恒为 0 | 浏览器策略，真人点一次页面即可 |
| 重连有次数上限 | 后端重启后网页永久失联 | 改成无限重试 + 退避封顶，且回到前台/网络恢复立即重试 |

---

## 八、环境事实（本机实测，勿重复试错）

> 同见 [`docs/roadmap.md` 6.4 节](docs/roadmap.md)。

| 项 | 状态 |
|---|---|
| `python` 命令 | **不可用**（Store 存根），一律 `uv run python` |
| `uv` | 0.11.16 ✓，缓存需指向 D 盘（`UV_CACHE_DIR`，`scripts/dev.ps1` 已处理） |
| `node` / `pnpm` | v24.16.0 ✓ |
| `git` | ✓ 已配 SSH 免密（`~/.ssh/id_ed25519`，无口令）→ **具备非交互/定时推送能力** |
| `ffmpeg` | ✓ 已安装（WinGet），本机 ASR/TTS 与音频后处理可用 |
| GPU | RTX 3060 Laptop 6GB —— 能跑 faster-whisper small / Piper，**不建议**跑 7B 级别本地大模型 |

---

## 九、密钥与提交约定

- 所有凭据只从环境变量或「请求头/连接参数里用户自带的密钥」读取
- 代码里不得出现任何密钥字面量；`.env` 已在 `.gitignore` 中排除，配置项同步维护在 `.env.example`
- `assets/models/`、`*.moc3`、`*.onnx` 等大资产不进仓库
- 提交前自查：`git status` 中不应出现 `.env` / `*.key` / `credentials*`

## 十、接下来做什么

阶段划分、每阶段的验收标准、完整踩坑记录都在 [`docs/roadmap.md`](docs/roadmap.md)。按优先级：

1. **补 M0 的欠账** —— 确认中心闭环（用户点「允许」后工具没有被执行）。
   改动很小，但它堵着 M3 的「带副作用的工具」。
2. **M1 收尾** —— 4 项只能在真人 + 真麦克风上验的事：自动断句、真 barge-in、
   本机 ASR/TTS 端到端、音频格式协商下沉后端。
3. **M4 建议穿插执行，别排到最后** —— 当前 0 测试、0 CI。
   M1/M2 的难点全是「真机验证」，没有自动化兜底，每次改动都在赌。
4. **五个待拍板问题** —— 主战场 / 语音走本机还是云 / 形象来源 / 视觉用途 / 是否多用户。
   其中第 1 个卡 M3、第 3 个卡 M2，越晚定越返工。
