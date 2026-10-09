# Live2D 渲染：从自写渲染器换到官方 Framework

> **当前状态**：渲染已改用**官方 Cubism Web Framework**（`web/scripts/live2d-framework-model.js`），
> whitecat 模型能画出**连贯完整的角色**。自写渲染器已停用，代码在 `_tmp/old-renderer/`。

> 这份文件同时保留了自写渲染器时期踩过的坑 —— 那些坑对理解 Cubism Core 的数据约定仍然有用
> （坐标空间、位标志、绘制顺序，三条都容易读错且不报错）。

## 零、最终方案（先看这段）

| 项 | 值 |
|---|---|
| 渲染后端 | 官方 Cubism Web Framework（已编译的 ESM，在 `web/vendor/cubism/`） |
| Cubism Core | `assets/cubism/live2dcubismcore.min.js` |
| 新依赖 | **0** |
| 打包步骤 | **不需要** |
| 入口文件 | `web/scripts/live2d-framework-model.js`（`FrameworkLive2DLoader` / `FrameworkLive2DModel`） |
| 对外接口 | 与旧渲染器完全一致，`avatar.js` 只改了一行 import |
| 回归验证页 | `web/dev/framework-model-check.html`（会 dump 官方 API 并真渲染一次） |
| 已接入 | 遮罩（完整官方实现）· 姿态 Pose · 物理 · 表情 · 动作 · 眨眼 · 呼吸 |

## 一、自写渲染器时期的五个真凶（历史，但坑还在）

| # | 问题 | 表现 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | 顶点单位与「世界」不一致 | `drawn=69`、`glError=0`，屏幕全空 | `canvasinfo` 是 2000×2000/PPU=2000，但 `vertexPositions` 落在 ±0.33/±0.44 —— 顶点是**模型单位**，不是像素。代码却把 ±0.33 当像素用，等于凭空放大成两倍多，几何被整个顶出画布（顶点包围盒映射到 563..1117，画布只有 840 宽） | 统一到模型单位：`modelW = CanvasWidth/PPU`、`modelH = CanvasHeight/PPU`，原点同样除以 PPU（whitecat = 1×1 的画布） |
| 2 | `constantFlags` 位定义凭直觉猜 | 整只模型 alpha 全灭 | 写的是 `flags & 0x02` 当「反转遮罩」。Core 的真实定义是 `0x01` 加法混合、`0x02` 乘法混合、`0x04` 双面、**`0x08` 才是反转遮罩**。于是每个加法混合部件都被反转到白纹理上（`mix(1,0,1)=0`） | 取 `0x08`；混合模式改用 `0x01`/`0x02` 位（`drawables.blendTypes` 这个字段在 Core v6 里根本不存在） |
| 3 | 乘法混合因子用错 | 阴影区域发黑或消失 | 着色器输出的是**预乘**色，`blendFunc(DST_COLOR, ONE_MINUS_SRC_ALPHA)` 会二次相乘 | 改 `blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)` |
| 4 | 绘制顺序没按 `renderOrders` 重排 | 模型像散开的碎片、五官被头发/衣服盖掉 | Core 的 `drawables` 数组**不是**按绘制顺序排的；`renderOrders` 挂在 **CoreModel** 上（`drawables.drawOrders` 是另一回事）。官方渲染器先排出一张顺序表再画 | 构造时建 `#drawOrder`：`order[renderOrders[i]] = i`，渲染循环按它取索引 |
| 5 | CSS 与 JS 状态撕裂 | 模型加载好了却永远停在「请把模型文件放进来」 | `empty-state.css` 用 `[data-mode]` 控制 canvas 显隐，而 `avatar.js` 只切 `is-empty`/`is-live2d` class。`index.html` 上静态写的是 `data-mode="empty"` → canvas 被 `display:none` → `clientWidth=0` → 尺寸不同步 → 一帧都不画 → 被判成「没画出画面」，自锁成死循环 | `#applyModeClasses()` 里一并 `setAttribute('data-mode', ...)` |

## 二、视口按「顶点包围盒」而不是画布做 contain

`canvasinfo` 的画布往往比模型本身大一圈（whitecat 画布 1×1、模型只占 0.66×0.905）。
按画布缩放会让形象在竖屏窗口里缩成一小块；按顶点包围盒 contain 才能站满窗口。
包围盒只在构造时量一次（`#measureVertexBounds()`），Cubism 的顶点虽随动作变化，但整体构图基本不动。

## 三、留在代码里的排查开关

都在 `web/scripts/live2d-loader.js` 的 `Live2DModel` 上，默认全关，排障时在控制台打开即可：

| 开关 | 作用 | 能分辨什么 |
|---|---|---|
| `debugSolidPaint` | 主着色器跳过纹理/遮罩，直接输出不透明红 | 红块出得来 = 几何+光栅化没问题，问题在纹理或 alpha |
| `debugIgnoreMask` | 跳过剪切遮罩采样 | 画面变化大 = 问题在遮罩 |
| `debugFreezePose` | 冻结 Core 变形（不写参数、不 update） | 形状不变 = 顶点数据问题；形状变正常 = 参数驱动问题 |
| `disableMask` | 完全不做遮罩 | 同 `debugIgnoreMask`，但连遮罩缓冲都不建 |

另外 `web/scripts/avatar.js` 在 `window.__dhAvatar` 上挂了实例，
`canvas.__dhRender` 里有每帧的绘制诊断（`drawn`/`orderRemapped`/`vertexBounds`/`glError`），
`canvas.__dhModel` 是模型实例的反向引用。

## 四、怎么判断「画出来了」

不要靠肉眼猜，用像素：

```js
const c = document.querySelector('#live2d-canvas');
c.__dhVisiblePixels;   // 中心 64×64 采样区里的非透明像素数（> 20 才算画出来了）
c.__dhCoverage;        // 整幅覆盖率（0~1，形象正常时大约 0.5 以上）
c.__dhRender;          // 绘制调用数、矩阵、顶点包围盒、GL 错误
```

覆盖率掉的常见原因，按可能性排序：
1. 模型被 contain 缩得比窗口小（canvasinfo 留白没排除）；
2. 遮罩把主体全裁掉了（用 `debugIgnoreMask` 一秒分辨）；
3. alpha 全灭（遮罩位定义或混合因子写错）。

## 五、碎片化：查到了什么、没查到什么

「模型画出来了，但看起来像一堆散开的部件（头、躯干、四肢错位分离）」是**另一个**问题，
和上面五个 bug 不是一回事。当前状态：**未定论**，但已经排除了一大片。

### 已排除（都有实测数据）

| 怀疑 | 验证方式 | 结果 |
|---|---|---|
| 顶点缓冲与 Core 不同步（陈旧/错位数据） | `__dhModel.diagnostic()` 把上传的缓冲与 Core 现值逐元素比对 | 3012 个采样点 **0 处不一致**，maxDelta = 0 |
| `vertexCounts[i]` 与实际数组长度不匹配（会让 pack 偏移整段错位） | 全 82 个 drawable 逐个比对 | **0 处不匹配** |
| 索引越界（会读到别的 drawable 的顶点 → 部件飞散） | 全 82 段索引取 max 与顶点数比对 | **0 处越界** |
| 参数驱动跑飞（动作/物理把参数写成极端值） | `debugFreezePose = true` 完全冻结变形后出图；以及 `?nophysics=1` 关掉物理演算 | 两种情况的像素分布都与正常状态**几乎一致** → 不是参数、也不是物理 |
| 遮罩把部件裁掉 | `debugIgnoreMask = true` 与正常状态对比覆盖率 | 覆盖率基本不变 → 不是遮罩 |
| 绘制顺序（部件互相盖错） | 按 `renderOrders` 重排前后对比 | 已修好（`orderRemapped: true`），但碎片感**依然存在** |

### 关键对照实验

| 模型 | 绘制调用 | 覆盖率 | 像素轮廓 |
|---|---|---|---|
| `Hiyori`（官方样例） | 125 | 0.28 | **连贯人形**：顶部深色头发团 → 中间脸与身体 → 下方两条腿 |
| `whitecat`（用户导入） | 69 | 0.56 | 头部厚实连贯，但**下半身与头发右侧呈分离小块**，底部两条腿间距过大 |

两个模型跑的是同一份渲染器、同一份 Core、同一套矩阵 —— Hiyori 正常，whitecat 碎。
所以**渲染器主链路不是碎片的成因**。

### 还没排除的嫌疑（下一步该查这些）

1. ~~**whitecat 的部件在画布空间里就是分离的**~~ —— **已推翻**。用 `partLayout()` 量了全部
   82 个部件的包围盒：**每个部件的「最近邻距离」都是 0**（82 个部件两两全部相交），
   没有任何孤立部件；82 个部件的中心有 51 个落在画布中央那一格。也就是说几何上它是
   一坨**紧密重叠**的完整模型，不是散开的零件堆。
   （注意 `worstPairs` 里 0.66 那种空隙是「任意两部件之间」的距离，不构成孤立证据。）
2. **渲染精细度不足**（当前最可能的解释）：
   - 82 个部件、重叠度 1.94（部件包围盒面积之和 = 画布面积的 1.94 倍）——
     这种模型极端依赖**遮罩**与**绘制顺序**决定「谁盖住谁、谁只露一部分」；
   - 实测把遮罩开关来回切（`debugIgnoreMask`），画面像素几乎没有变化 →
     该模型的遮罩在自写渲染器里基本没起作用；
   - whitecat 的 `model3.json` **没有** `Pose` 字段（Hiyori 有 `Hiyori.pose3.json`），
     所以「该隐藏的备用部件」不会被隐藏；
   - 没有动作、没有物理、部件边缘没有柔化 → 接缝肉眼可见，观感就是「碎」。
3. **对照组**：`Hiyori` 在同一渲染器下出连贯人形（125 个部件、覆盖率 0.28）。
   可用的客观指标是两模型的 `partLayout().nearestOverPart` 比值：若接近而观感差距大，
   说明差距在渲染精细度而不是几何布局。

### 建议的下一步

> **本节已被取代**：渲染器已经整体换成官方 Framework，碎片问题随之消失。
> 下面保留当时的推理，作为「为什么最后选择换而不是继续修」的记录。

- 先让用户切换成 `Hiyori` 或 `Mao` 亲眼确认（设置 → 形象 → 选择模型文件夹，或在
  `localStorage` 的 `dh.config.v1.avatar.model` 里改路径）。
- 若 Hiyori 看起来正常 → 问题锁定在 whitecat 模型/其人设上，可以继续查 `CubismPose`
  接入（第 2 条嫌疑）。
- 若要继续深挖 whitecat，最直接的手段是打开 `debugPartColors`（每个 drawable 一个颜色），
  看是哪几个部件、它们的索引号是多少。

## 六、最终结论：换掉自写渲染器（已完成）

**决定**：自写 WebGL 渲染器停止维护，渲染改用**官方 Cubism Web Framework**。
新文件 `web/scripts/live2d-framework-model.js`，旧文件移到 `_tmp/old-renderer/`。

### 换完之后又修的两个「静默失败」

换成官方 Framework 之后，还有两个模块**看起来加载了、实际没生效**，因为它们都被
`try/catch` 静默吞掉：

| 模块 | 现象 | 根因 | 修法 |
|---|---|---|---|
| `CubismPose`（姿态） | **Mao 长出四只手** —— 「手举起来」和「手放下去」两套立绘同时显示 | `CubismPose.create()` 要的是**原始字节**（内部自己 `JSON.parse`），传解析好的对象会抛 `Unexpected end of JSON input` | 改读 `arrayBuffer`：`create(buf, buf.byteLength)` |
| `CubismPhysics`（物理） | 头发/衣服完全不摆动（而且没人发现） | 同一个坑：`CubismPhysics.create()` 同样要原始字节 | 同上 |

**这两个必须一起记**：`CubismModelSettingJson` / `CubismPose` / `CubismPhysics` 三个
官方类的 `create` 都接受「字节」，不接受「对象」。而 `loadExpression` / `loadMotion`
要的是 `(ArrayBuffer, byteLength, name)` —— 这条规则不统一，只能靠实测确认。

### 姿态的验证方式（别看画面猜，读部件不透明度）

```js
const core = document.querySelector('#live2d-canvas').__dhModel._model._model || ...;
// Mao：PartArmLA/RA 应为 1，PartArmLB/RB 应为 0
for (let i = 0; i < core.parts.count; i++) {
  const id = core.parts.ids[i]._id;
  if (/Arm/.test(id)) console.log(id, core.parts.opacities[i]);
}
```

Mao 的 `pose3.json` 就是干这个的：

```json
{"Groups": [
  [{"Id": "PartArmLA"}, {"Id": "PartArmLB"}],
  [{"Id": "PartArmRA"}, {"Id": "PartArmRB"}]
]}
```

组内互斥 —— 一个显示，其余隐藏。实测修好后：`PartArmLA=1 / PartArmRA=1 / PartArmLB=0 / PartArmRB=0`。

### 顺便修正的执行顺序

物理与姿态都作用在参数/部件上，必须在 Core 的 `model.update()` **之前**应用，
否则这一帧的写入会被 update「落下」——姿态尤其明显，晚一帧就是两组同时露出来。
现在的顺序：`loadParameters → 表情 → 动作 → 眨眼 → 呼吸 → 外部覆盖 → 物理 → 姿态 → Core.update → 绘制`。

### 换的收益（实测对比）

碎片化的最后一块拼图是**部件遮罩**：whitecat 的 82 个部件重叠度 1.94 倍画布面积，
「谁盖住谁、谁只露一部分」全靠遮罩与绘制顺序。自写实现的遮罩是个简化版（实测开关
来回切画面不变，等于没生效），而官方那套是**多层离屏 FBO + ping-pong + 遮罩矩阵 +
高精度遮罩模式**——再实现一遍的代价，大于直接用它。

| | 自写渲染器 | 官方 Framework |
|---|---|---|
| whitecat 画面 | 部件分离、碎片感明显 | **连贯完整的角色**（ASCII 轮廓：顶部头发团 → 中部五官 → 下方双腿） |
| 遮罩 | 简化实现，实测无效 | 官方完整实现 |
| 姿态（Pose） | 未接入 | 已接入（Hiyori / Mao 实测生效：成对部件互斥显隐） |
| 物理 | 自写近似（PhysicsApprox） | 官方 `CubismPhysics`（实测生效） |
| 表达式 / 动作 | 自写 | 官方 `CubismExpressionMotionManager` / `CubismMotionManager` |
| 新依赖 | — | **0 个**（Framework 早已在 `web/vendor/cubism/`，Core 在 `assets/cubism/`） |
| 打包步骤 | — | **不需要**（原生 ESM，前端仍是打开就能改的 JS） |

### 换的过程中踩到的坑（都在 `live2d-framework-model.js` 注释里）

1. **类必须继承 `CubismUserModel`**：不继承的话 `this.loadModel` 一类方法根本不存在。
   而基类要等 Framework 异步装配完才拿到，所以只能用工厂函数动态造类。
2. **`CubismModelSettingJson` 要的是原始字节**，不是解析好的对象 —— 传对象进去报
   `Unexpected end of JSON input`。
3. **渲染器要显式 `startUp(gl)`**，否则内部 gl 为 null，第一帧就炸在 `bindFramebuffer`。
4. **遮罩管理器拿不到 gl**：官方 `startUp` 只对「已存在」的管理器 setGL，而遮罩管理器是
   `initialize()` 里建的；顺序稍差就是「存在但没 gl」，画第一帧炸在 `gl.viewport`。
   `_ensureClippingGl()` 负责补齐（幂等）。
5. **API 名字全部实测过**（猜错过一轮）：
   `getModelFileName`（不是 getMocFileName）· 表情用 `expressionManager.startMotion`（没有
   addExpression）· 动作用 `startMotionPriority(motion, autoDelete, priority)`（没有 addMotion）·
   呼吸用 `breath.setParameters([new BreathParameterData(...)])`（类名没有 Cubism 前缀）。
6. **不要把遮罩缓冲调到 1024**：82 个 drawable 会各开一块 1024² 离屏 FBO，成本高得没必要。
7. **不要每帧读像素**：同步 `readPixels` 会打断 GPU 流水线；自检只做开头 8 帧。
8. **页面隐藏时定时器会被节流到 ~1Hz**：调试时「帧数不涨」很可能不是卡死，先看
   `document.visibilityState`（这个坑浪费了半小时）。

## 七、还没做 / 已知边界

- 官方 Framework 的诊断页 `web/dev/framework-render.html` 与验证页
  `web/dev/framework-model-check.html` 保留，后者现在是新渲染器的回归验证入口。
- 遮罩缓冲用官方默认值（256）。想更清晰可以调到 512/1024，但要清楚 82 个 drawable
  会各开一块同等尺寸的离屏 FBO。
- 嘴型/视线/情绪仍由 `avatar.js` 逐帧写参数（`setParameter(id, value, weight)`），
  走的是官方 `setParameterValueByIndex`，语义与旧实现一致。
- 旧渲染器代码在 `_tmp/old-renderer/live2d-loader.js`，只作历史参考（会被清理器回收）。
