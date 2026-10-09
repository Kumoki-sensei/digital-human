/**
 * live2d-framework-model.js —— 基于**官方 Cubism Web Framework** 的渲染器
 *
 * 为什么换成它（而不是继续修自写的 WebGL 渲染器）：
 *
 *   自写渲染器已经能把模型画出来，但部件遮罩（clipping mask）只做了个简化版 ——
 *   实测把遮罩开关来回切，画面几乎不变，说明遮罩基本没起作用。而像 whitecat 这类
 *   部件重叠度极高的模型（部件包围盒面积之和 = 画布的 1.94 倍），「谁盖住谁、
 *   谁只露一部分」全靠遮罩与绘制顺序决定；遮罩一失效，重叠的部件就互相切开 ——
 *   这就是「碎片化」的来源。
 *
 *   与其把官方那套遮罩（多层离屏 FBO + ping-pong + 遮罩矩阵）再实现一遍，不如直接用官方实现。
 *   官方 Framework 的编译产物早已在 `web/vendor/cubism/`（59 个 ESM 文件 + 着色器），
 *   Cubism Core 在 `assets/cubism/`，**不引入任何新依赖、不需要打包步骤**，
 *   前端仍然是「打开就能改的原生 JS」。
 *
 * 对外接口与旧渲染器一致（avatar.js 只需换一处 import）。
 *
 * ⚠️ 下面这些 API 名全部来自实测 dump，不是猜的（猜错过一轮，见 docs/live2d-render-fixes.md）：
 *   · 清单：getModelFileName（不是 getMocFileName）· getTextureFileName/Directory
 *   · 表情：expressionManager.startMotion(motion, autoDelete, time)（没有 addExpression）
 *   · 动作：motionManager.startMotionPriority(motion, autoDelete, priority)
 *   · 呼吸：breath.setParameters([new BreathParameterData(id, offset, peak, cycle, weight)])
 *   · 渲染器：bindTexture / setMvpMatrix / setRenderState / drawModel / setClippingMaskBufferSize
 */

const FRAMEWORK_BASE = '/vendor/cubism/';
const CORE_PATH = '/assets/cubism/live2dcubismcore.min.js';
const SHADER_DIR = FRAMEWORK_BASE + 'Shaders/WebGL/';

/** 已装配好的框架单例（整页一份） */
let frameworkPromise = null;

function msg(err) {
  return err && err.message ? err.message : String(err);
}

/** 读表单参数：排障开关用（?nodraw=1 只跑逻辑不绘制） */
function q(name) {
  try {
    return new URLSearchParams(globalThis.location && globalThis.location.search).has(name);
  } catch {
    return false;
  }
}

/**
 * 装配官方 Framework：加载 Cubism Core、导入模块、startUp + initialize。
 *
 * initialize() 之前 CubismIdManager 是 null，任何 getId 都会炸
 * （报 "Cannot read properties of null (reading 'getId')"）—— 这个坑踩过一次。
 */
export async function ensureFramework() {
  if (frameworkPromise) return frameworkPromise;

  frameworkPromise = (async () => {
    if (!window.Live2DCubismCore) await loadScript(CORE_PATH);
    if (!window.Live2DCubismCore) throw new Error('Cubism Core 没加载起来：' + CORE_PATH);

    const [fw, userModel, settingJson, m44, renderer, breath, pose, physics] = await Promise.all([
      import(FRAMEWORK_BASE + 'live2dcubismframework.js'),
      import(FRAMEWORK_BASE + 'model/cubismusermodel.js'),
      import(FRAMEWORK_BASE + 'cubismmodelsettingjson.js'),
      import(FRAMEWORK_BASE + 'math/cubismmatrix44.js'),
      import(FRAMEWORK_BASE + 'rendering/cubismrenderer_webgl.js'),
      import(FRAMEWORK_BASE + 'effect/cubismbreath.js'),
      import(FRAMEWORK_BASE + 'effect/cubismpose.js'),
      import(FRAMEWORK_BASE + 'physics/cubismphysics.js'),
    ]);

    const option = new fw.Option();
    option.loggingLevel = fw.LogLevel.LogLevel_Error;
    fw.CubismFramework.startUp(option);
    fw.CubismFramework.initialize();

    return {
      core: window.Live2DCubismCore,
      fw,
      CubismUserModel: userModel.CubismUserModel,
      CubismModelSettingJson: settingJson.CubismModelSettingJson,
      CubismMatrix44: m44.CubismMatrix44,
      CubismRenderer_WebGL: renderer.CubismRenderer_WebGL,
      CubismBreath: breath.CubismBreath,
      BreathParameterData: breath.BreathParameterData,
      CubismPose: pose.CubismPose,
      CubismPhysics: physics.CubismPhysics,
    };
  })();

  try {
    return await frameworkPromise;
  } catch (err) {
    frameworkPromise = null; // 失败不留坏单例，下次可重试
    throw err;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('脚本加载失败：' + src));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- 文件来源

/** 服务器路径：相对路径拼到模型所在目录 */
class HttpFs {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || '';
    this.kind = 'http';
  }

  resolve(p) {
    const s = String(p);
    if (/^(https?:)?\/\//.test(s) || s.startsWith('/')) return s;
    return this.baseUrl + s;
  }

  async readArrayBuffer(p) {
    const res = await fetch(this.resolve(p));
    if (!res.ok) throw new Error(`读取失败 ${p}（HTTP ${res.status}）`);
    return res.arrayBuffer();
  }

  async readJson(p) {
    const res = await fetch(this.resolve(p));
    if (!res.ok) throw new Error(`读取失败 ${p}（HTTP ${res.status}）`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON 解析失败 ${p}（${text.length} 字节）：${text.slice(0, 60)}`);
    }
  }

  async readBlob(p) {
    const res = await fetch(this.resolve(p));
    if (!res.ok) throw new Error(`读取失败 ${p}（HTTP ${res.status}）`);
    return res.blob();
  }
}

/**
 * 本地拖入的文件夹：纯内存映射，不上传、不落盘。
 *
 * 匹配时按「相对路径（含/不含顶层目录）/ 文件名」三级、且大小写不敏感 ——
 * model3.json 里写的可能是 `Texture/texture_00.png`，而用户目录里是
 * `texture/texture_00.png`，严格匹配会误报「文件缺失」。
 */
class MemoryFs {
  constructor(files, rootName) {
    this.kind = 'memory';
    this.map = new Map();
    this.rootName = rootName || '';
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name || '').replace(/\\/g, '/');
      if (!rel) continue;
      const parts = rel.split('/');
      const trimmed = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      for (const key of [rel.toLowerCase(), trimmed.toLowerCase(), parts[parts.length - 1].toLowerCase()]) {
        if (!this.map.has(key)) this.map.set(key, f);
      }
    }
  }

  #find(p, homeDir) {
    const clean = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    const home = String(homeDir || '').replace(/\\/g, '/');
    const candidates = [];
    if (home && clean.startsWith(home)) candidates.push(clean.slice(home.length));
    candidates.push(clean);
    for (const c of candidates) {
      const f = this.map.get(c.toLowerCase());
      if (f) return f;
    }
    return this.map.get(clean.split('/').pop().toLowerCase()) || null;
  }

  async readArrayBuffer(p, homeDir) {
    const f = this.#find(p, homeDir);
    if (!f) throw new Error(`本地文件里找不到：${p}`);
    return f.arrayBuffer();
  }

  async readJson(p, homeDir) {
    const f = this.#find(p, homeDir);
    if (!f) throw new Error(`本地文件里找不到：${p}`);
    const text = await f.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON 解析失败 ${p}：${text.slice(0, 60)}`);
    }
  }

  async readBlob(p, homeDir) {
    const f = this.#find(p, homeDir);
    if (!f) throw new Error(`本地文件里找不到：${p}`);
    return f;
  }
}

// ---------------------------------------------------------------- 模型

/** 已生成过的模型类（同一个基类只生成一次，保证 instanceof 稳定） */
const modelClasses = new WeakMap();

/**
 * 造出「继承官方 CubismUserModel」的模型类。
 *
 * 为什么用工厂而不是直接 `class X extends CubismUserModel`：
 * CubismUserModel 要等 Framework 装配完（异步）才拿得到，没法写在 extends 里。
 * 不继承它的后果很直接 —— `this.loadModel` 之类的方法根本不存在（踩过）。
 */
function getModelClass(Base) {
  let cls = modelClasses.get(Base);
  if (cls) return cls;

  cls = class FrameworkLive2DModel extends Base {
    static async load({ fs, modelJson, homeDir, name, canvas }) {
      const F = await ensureFramework();
      const model = new cls(F, { fs, homeDir, canvas, name });
      await model._setup(modelJson);
      return model;
    }

    constructor(F, { fs, homeDir, canvas, name }) {
      super();
      this._F = F;
      this._fs = fs;
      this._homeDir = homeDir || '';
      this._canvas = canvas;
      this.name = name || '';
      this._moc = null;
      this._renderer = null;
      this._setting = null;
      this._textures = [];
      this._expressionNames = [];
      this._expressionByName = new Map();
      this._motionGroups = [];
      this._motionByName = new Map();
      this._projection = new F.CubismMatrix44();
      this._viewSize = { w: 0, h: 0 };
      this._disposed = false;
      this._noDraw = q('nodraw');
      this._noPhysics = q('nophysics');
      /** 外部逐帧写入的参数（嘴型/视线/情绪），按 weight 合并 */
      this._overrides = new Map();
      this._currentExpression = '';
    }

    // 与旧渲染器同名同义的只读属性 -------------------------------

    get canvasWidth() {
      return this._model ? this._model.getCanvasWidth() : 0;
    }

    get canvasHeight() {
      return this._model ? this._model.getCanvasHeight() : 0;
    }

    get paramCount() {
      return this._model ? this._model.getParameterCount() : 0;
    }

    // ---------------------------------------------------------- 加载

    async _setup(modelJson) {
      const F = this._F;
      // 注意：CubismModelSettingJson 要的是**原始字节**（内部自己 JSON.parse），
      // 不是解析后的对象 —— 传对象进去会报 "Unexpected end of JSON input"。
      const manifestBuf = modelJson instanceof ArrayBuffer ? modelJson : null;
      if (!manifestBuf) throw new Error('模型清单必须是 ArrayBuffer');
      if (manifestBuf.byteLength === 0) throw new Error('模型清单是空的（读取失败？）');
      this._setting = new F.CubismModelSettingJson(manifestBuf, manifestBuf.byteLength);

      // ① moc3 → 建模型（官方 loadModel 内部会 saveParameters 并建 _modelMatrix）
      const mocFile = this._setting.getModelFileName();
      if (!mocFile) throw new Error('模型设置里没有 Moc 文件');
      const mocBuf = await this._read('arrayBuffer', mocFile);
      this.loadModel(mocBuf);
      if (!this._model) throw new Error('moc3 解析失败（' + mocFile + '）');

    // ② 贴图（可以在建渲染器之前先建好 OpenGL 纹理）
    const gl = this._gl();
    const texCount = this._setting.getTextureCount();
    for (let i = 0; i < texCount; i++) {
      const file = this._setting.getTextureFileName(i);
      const blob = await this._read('blob', file);
      const bmp = await createImageBitmap(blob);
      this._textures.push(this._createTexture(gl, bmp));
      bmp.close && bmp.close();
    }

    // ③ 渲染器：createRenderer 已经 initialize 过，只需要注入 gl + 加载着色器。
    //    顺序坑：官方 CubismUserModel.createRenderer() 会先建遮罩管理器再 initialize，
    //    而 startUp(gl) 只在「管理器已存在」时才 setGL —— 所以必须 createRenderer → startUp，
    //    中间不要再 initialize（会重建管理器、把刚注入的 gl 丢掉）。
    this.createRenderer(gl.canvas.width || 1, gl.canvas.height || 1);
    this._renderer = this.getRenderer();
    this._renderer.startUp(gl);
    // 保险：遮罩管理器是 initialize 时建的，万一没吃到 gl，这里补齐（不补的话
    // 画第一帧就炸在 setupClippingContext 的 gl.viewport 上）
    this._ensureClippingGl();
    this._renderer.loadShaders(SHADER_DIR);
    if (!this._renderer.gl) throw new Error('渲染器没能拿到 WebGL 上下文（startUp 未生效）');
    for (let i = 0; i < this._textures.length; i++) this._renderer.bindTexture(i, this._textures[i]);
    // 遮罩离屏缓冲尺寸：**不要动它**。
    // 曾经设成 1024 想让边缘更清晰，结果 82 个 drawable 会各开一块 1024×1024 的离屏 FBO，
    // 一进 drawModel 就把 GPU/主线程拖死（定时器停在第二帧）。官方默认值就够了。
    // 想调的话：值不要超过 1024，且要接受创建成本。

    // ④ 物理
    if (!this._noPhysics && this._setting.isExistPhysicsFile && this._setting.isExistPhysicsFile()) {
      try {
        // 注意：CubismPhysics.create 要**原始字节**（内部自己 JSON.parse），
        // 传解析好的对象会报 "Unexpected end of JSON input" —— 与 CubismModelSettingJson 同一个坑。
        const buf = await this._read('arrayBuffer', this._setting.getPhysicsFileName());
        this._physics = F.CubismPhysics.create(buf, buf.byteLength);
      } catch (err) {
        console.warn('[live2d] 物理加载失败（跳过）：' + msg(err));
      }
    }

    // ⑤ 姿态（部件显隐切换）：成对的部件（例：Mao 的 PartArmLA/LB 与 RA/RB，
    //    就是「举手」和「垂手」两套立绘）必须靠它互斥显示 —— 不生效就会同时画出来，
    //    表现是「长出四只手」。
    //
    //    坑：官方 CubismPose.create 要的是**原始字节**（内部自己 JSON.parse），
    //    传解析好的对象会抛 "Unexpected end of JSON input"。之前这里就是这么错的，
    //    而且被 try/catch 静默吞掉，于是 Mao / Hiyori 的举手/垂手两套立绘同时显示。
    if (this._setting.isExistPoseFile && this._setting.isExistPoseFile()) {
      try {
        const buf = await this._read('arrayBuffer', this._setting.getPoseFileName());
        this._pose = F.CubismPose.create(buf, buf.byteLength);
      } catch (err) {
        console.warn('[live2d] 姿态文件加载失败（成对部件会同时显示，例如两条手臂）：' + msg(err));
      }
    }

    // ⑥ 表情（官方：加载成 motion，再由管理器 startMotion 播放）
    this._expressionManager = new (await import(FRAMEWORK_BASE + 'motion/cubismexpressionmotionmanager.js')).CubismExpressionMotionManager();
    const exprCount = this._setting.getExpressionCount();
    for (let i = 0; i < exprCount; i++) {
      const exprName = this._setting.getExpressionName(i);
      const exprFile = this._setting.getExpressionFileName(i);
      try {
        const json = await this._read('json', exprFile);
        const motion = this.loadExpression(json.buffer, json.byteLength, exprName);
        if (motion) {
          this._expressionByName.set(exprName, motion);
          this._expressionFiles.push(exprName);
        }
      } catch (err) {
        console.warn('[live2d] 表情加载失败（' + exprName + '）：' + msg(err));
      }
    }

    // ⑦ 动作
    const mmod = await import(FRAMEWORK_BASE + 'motion/cubismmotionmanager.js');
    this._motionManager = new mmod.CubismMotionManager();
    const groupCount = this._setting.getMotionGroupCount();
    for (let g = 0; g < groupCount; g++) {
      const group = this._setting.getMotionGroupName(g);
      this._motionGroups.push(group);
      const count = this._setting.getMotionCount(group);
      for (let i = 0; i < count; i++) {
        const file = this._setting.getMotionFileName(group, i);
        try {
          const json = await this._read('json', file);
          const motion = this.loadMotion(json.buffer, json.byteLength, file);
          if (motion) {
            const fadeIn = this._setting.getMotionFadeInTimeValue(group, i);
            const fadeOut = this._setting.getMotionFadeOutTimeValue(group, i);
            if (fadeIn >= 0) motion.setFadeInTime(fadeIn);
            if (fadeOut >= 0) motion.setFadeOutTime(fadeOut);
            // 没有「addMotion」这个方法：直接按 group:index 存起来，播放时现取
            this._motionByName.set(group + ':' + i, motion);
          }
        } catch (err) {
          console.warn('[live2d] 动作加载失败（' + group + '#' + i + '）：' + msg(err));
        }
      }
    }

    // ⑧ 眨眼（官方 CubismEyeBlink，按 model3.json 的 Groups 自动眨眼）
    const ebm = await import(FRAMEWORK_BASE + 'effect/cubismeyeblink.js');
    this._eyeBlink = ebm.CubismEyeBlink.create(this._setting);
    // 呼吸：**自己算，不用 CubismBreath**。
    //
    // 为什么不用官方那个：实测它对同一个时间值反复求值会给出不同的、而且和
    // `sin(t/cycle)` 对不上的结果（同一 t 连续四次得到 -6.3762 / -6.3664 / -6.3564 /
    // -6.3464，而正确值是 +3.1485），参数被写进模型的同时还有状态在漂。
    // 后果就是 ParamAngleX/Z 在帧间乱跳 —— 画面观感是「人在抽搐」。
    // 呼吸本身就是个正弦，自己算完全确定，也不依赖内部状态。
    this._breathSpec = [
      { id: 'ParamAngleX', offset: 0, peak: 15, cycle: 6.5345, weight: 0.5 },
      { id: 'ParamAngleY', offset: 0, peak: 8, cycle: 3.5345, weight: 0.5 },
      { id: 'ParamAngleZ', offset: 0, peak: 10, cycle: 5.5345, weight: 0.5 },
      { id: 'ParamBodyAngleX', offset: 0, peak: 4, cycle: 15.5345, weight: 0.5 },
      { id: 'ParamBreath', offset: 0.5, peak: 0.5, cycle: 3.2345, weight: 1 },
    ].map((s) => ({ ...s, index: this._model.getParameterIndex(this._id(s.id)) }))
      .filter((s) => s.index >= 0);

    if (this._canvas) this.resize(this._canvas.width, this._canvas.height);
  }

  async _read(kind, file) {
    const home = this._homeDir || '';
    if (kind === 'json') return this._fs.readJson(file, home);
    if (kind === 'blob') return this._fs.readBlob(file, home);
    return this._fs.readArrayBuffer(file, home);
  }

  _gl() {
    if (!this._canvas) throw new Error('没有画布');
    const gl = this._canvas.getContext('webgl2') || this._canvas.getContext('webgl');
    if (!gl) throw new Error('拿不到 WebGL 上下文');
    return gl;
  }

  /**
   * 确保渲染器内部所有子管理器都拿到了 WebGL 上下文。
   *
   * 官方 `startUp(gl)` 只负责「已存在」的管理器（`if (this._x) this._x.setGL(gl)`），
   * 而遮罩管理器是在 `initialize()` 里创建的 —— 两者顺序稍有出入，管理器就会是
   * 「存在但没有 gl」的状态，画第一帧时在 `setupClippingContext` 的 `gl.viewport` 上炸掉。
   * 这里统一补一次，幂等。
   */
  _ensureClippingGl() {
    const gl = this._canvas ? this._canvas.getContext('webgl2') || this._canvas.getContext('webgl') : null;
    const r = this._renderer;
    if (!gl || !r) return;
    if (r.gl !== gl) r.gl = gl;
    for (const key of ['_drawableClippingManager', '_offscreenClippingManager']) {
      const mgr = r[key];
      if (!mgr) continue;
      if (mgr.gl !== gl && typeof mgr.setGL === 'function') mgr.setGL(gl);
      if (mgr.gl !== gl) mgr.gl = gl; // setGL 内部字段名不一致时兜底
    }
    if (r._rendererProfile && r._rendererProfile.gl !== gl && typeof r._rendererProfile.setGl === 'function') {
      r._rendererProfile.setGl(gl);
    }
    return true;
  }

  _createTexture(gl, bitmap) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  _id(str) {
    if (typeof str !== 'string') return str;
    return this._F.fw.CubismFramework.getIdManager().getId(str);
  }

  // ---------------------------------------------------------- 参数

  /**
   * 写参数。weight：1 = 完全接管（口型必须准），0.5 = 与动作/眨眼各占一半。
   * 值先记下来，update() 时统一合并 —— 否则会被后面的呼吸/物理覆盖。
   */
  setParameter(id, value, weight = 1) {
    if (!this._model) return;
    const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 1;
    this._overrides.set(id, { value: Number(value) || 0, weight: w });
  }

  getParameter(id) {
    if (!this._model) return 0;
    const idx = this._model.getParameterIndex(this._id(id));
    return idx >= 0 ? this._model.getParameterValueByIndex(idx) : 0;
  }

  getParameterIds() {
    if (!this._model) return [];
    const n = this._model.getParameterCount();
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = this._model.getParameterId(this._id(i));
      out.push(id && id.getString ? id.getString().s : String(id));
    }
    return out;
  }

  clearOverrides() {
    this._overrides.clear();
  }

  // ---------------------------------------------------------- 表情 / 动作

  getExpressionNames() {
    return this._expressionFiles.slice();
  }

  /** 空字符串 = 回到默认表情 */
  setExpression(name) {
    const want = String(name || '');
    if (want === this._currentExpression) return;
    this._currentExpression = want;
    if (!this._expressionManager) return;
    if (!want) {
      try {
        this._expressionManager.stopAllMotions();
      } catch (err) {
        /* 忽略：没有正在播放的表情时停止会抛错 */
      }
      return;
    }
    const motion = this._expressionByName.get(want);
    if (!motion) {
      console.warn('[live2d] 没有这个表情：' + want);
      return;
    }
    try {
      this._expressionManager.startMotion(motion, false, this._time());
    } catch (err) {
      console.warn('[live2d] 播放表情失败（' + want + '）：' + msg(err));
    }
  }

  getMotionGroups() {
    return this._motionGroups.slice();
  }

  /** 播一个动作；group 省略时用 Idle，index 省略时随机 */
  startMotion(group, index, priority = 3) {
    if (!this._motionManager) return false;
    const g = group || (this._motionGroups.includes('Idle') ? 'Idle' : this._motionGroups[0]);
    if (!g) return false;
    const total = this._setting ? this._setting.getMotionCount(g) : 0;
    if (!(total > 0)) return false;
    const i = Number.isFinite(index) ? ((index % total) + total) % total : Math.floor(Math.random() * total);
    const motion = this._motionByName.get(g + ':' + i);
    if (!motion) return false;
    return !!this._motionManager.startMotionPriority(motion, false, priority);
  }

  /** 手动眨一下（正常由官方 CubismEyeBlink 自动跑，这个接口是给外部强制用的） */
  blink() {
    this._blinkForced = this._time() + 0.12;
  }

  get autoIdle() {
    return this._motionGroups.includes('Idle');
  }

  // ---------------------------------------------------------- 逐帧

  resize(w, h) {
    const nw = Math.max(1, Math.floor(Number(w) || 1));
    const nh = Math.max(1, Math.floor(Number(h) || 1));
    this._viewSize = { w: nw, h: nh };
    if (this._renderer) this._renderer.setRenderTargetSize(nw, nh);
  }

  _time() {
    return performance.now() / 1000;
  }

  update(dtSeconds) {
    if (this._disposed || !this._model) return;
    // 排障开关 ?fixdt=1：用固定步长替代真实 dt。
    // 用途：页面被浏览器节流（后台 1Hz）时，真实 dt 会被 clamp 到 0.1s，
    // 采样出来的参数看起来「乱跳」——那是采样伪影，不是渲染问题。
    // 固定步长能把「动画本身是否平滑」和「帧率是否稳定」两件事分开看。
    const dt = this._fixDt ? 1 / 60 : Math.max(0, Math.min(0.1, Number(dtSeconds) || 0));
    const t = this._time();

    // 官方顺序：loadParameters（复位）→ 表情 → 动作 → 眨眼 → 呼吸 → 外部覆盖 → Core.update → 位姿/物理 → 绘制
    this._model.loadParameters();

    if (this._expressionManager) this._expressionManager.updateMotion(this._model, dt);

    if (this._motionManager) {
      if (this._motionManager.isFinished() && this._motionGroups.includes('Idle')) {
        this.startMotion('Idle', undefined, 1);
      }
      this._motionManager.updateMotion(this._model, dt);
    }

    if (this._eyeBlink) this._eyeBlink.updateParameters(this._model, dt);
    if (this._breathSpec) this._applyBreath(t);

    this._applyOverrides();

    // 物理与姿态都作用在参数上，必须在 Core 的 update 之前应用，
    // 否则它们的写入会被这一帧的 update「落下」——姿态尤其明显：
    // 它负责成对部件的互斥显隐（Mao 的举手臂/垂手臂），晚一帧就两组同时露出来。
    if (this._physics) this._physics.evaluate(this._model, dt);
    if (this._pose) this._pose.updateParameters(this._model, dt);

    this._model.update();

    this._draw();
  }

  /**
   * 呼吸：纯函数式计算，直接写参数。
   *
   * 每个分量是一条正弦（`offset + peak * sin(t / cycle)`），按 weight 与当前值混合。
   * 写入必须用 setParameterValueByIndex —— 它落到「当前值」，不依赖任何内部累计状态，
   * 所以帧间一定连续（官方 breathing updater 在这台机器上会漂，见构造函数的注释）。
   */
  _applyBreath(t) {
    const pending = new Map();
    for (const s of this._breathSpec) {
      const v = s.offset + s.peak * Math.sin(t / s.cycle);
      const prev = pending.get(s.index);
      if (prev === undefined) pending.set(s.index, { value: v, weight: s.weight });
      else pending.set(s.index, { value: prev.value + v, weight: Math.max(prev.weight, s.weight) });
    }
    for (const [index, o] of pending) {
      if (o.weight >= 1) this._model.setParameterValueByIndex(index, o.value, 1);
      else {
        const cur = this._model.getParameterValueByIndex(index);
        this._model.setParameterValueByIndex(index, cur * (1 - o.weight) + o.value * o.weight, 1);
      }
    }
  }

  _applyOverrides() {
    if (!this._overrides.size) return;
    for (const [id, o] of this._overrides) {
      const idx = this._model.getParameterIndex(this._id(id));
      if (idx < 0) continue;
      if (o.weight >= 1) {
        this._model.setParameterValueByIndex(idx, o.value, 1);
      } else {
        const cur = this._model.getParameterValueByIndex(idx);
        this._model.setParameterValueByIndex(idx, cur * (1 - o.weight) + o.value * o.weight, 1);
      }
    }
    this._overrides.clear();
  }

  _draw() {
    const w = this._viewSize.w;
    const h = this._viewSize.h;
    if (!(w > 1) || !(h > 1)) return;
    // 排障开关：?nodraw=1 只跑逻辑不画，用来分辨「卡在绘制」还是「卡在校验」
    if (this._noDraw) return;

    // 每帧确认一次（幂等、极便宜）：遮罩上下文丢过一次，症状是画到第一帧直接抛异常
    this._ensureClippingGl();

    const t0 = performance.now();
    this._drawCount = (this._drawCount || 0) + 1;
    if (globalThis.__dhDrawStats) {
      globalThis.__dhDrawStats.count = this._drawCount;
      globalThis.__dhDrawStats.lastStart = t0;
      globalThis.__dhDrawStats.pending = true;
    }

    const proj = this._projection;
    proj.loadIdentity();
    // 官方示例的宽高比修正：竖屏时横向压缩，保证整只模型落在视野里不被拉伸
    if (h > w) proj.scale(h / w, 1.0);
    if (this._modelMatrix) proj.multiplyByMatrix(this._modelMatrix);
    this._renderer.setMvpMatrix(proj);
    this._renderer.setRenderState(null, [0, 0, w, h]);
    this._renderer.drawModel(SHADER_DIR);

    if (globalThis.__dhDrawStats && globalThis.__dhDrawStats.pending) {
      globalThis.__dhDrawStats.pending = false;
      globalThis.__dhDrawStats.lastMs = Math.round(performance.now() - globalThis.__dhDrawStats.lastStart);
      globalThis.__dhDrawStats.maxMs = Math.max(globalThis.__dhDrawStats.maxMs || 0, globalThis.__dhDrawStats.lastMs);
    }

    this._pixelProbe();
  }

  /**
   * 首帧健康自检：画布中心取小块读回，统计非透明像素。
   *
   * avatar.js 靠 `canvas.__dhVisiblePixels` 判断「模型到底画出来没有」——
   * 没有这个数它会把正常渲染误判成失败、退回空状态（旧渲染器留下的约定，必须继续维护）。
   *
   * 只在开头 3 帧做：同步 readPixels 会打断 GPU 流水线（要等前面的命令全部完成），
   * 每帧都读会明显掉帧 —— 而掉帧看起来就是「抽一下」。
   */
  _pixelProbe() {
    const canvas = this._canvas;
    if (!canvas || this._probeFrames >= 3) return;
    this._probeFrames++;
    const gl = this._renderer && this._renderer.gl;
    if (!gl) return;
    const softW = canvas.width || 1;
    const softH = canvas.height || 1;
    const sw = Math.min(64, softW);
    const sh = Math.min(64, softH);
    const px = new Uint8Array(sw * sh * 4);
    try {
      gl.readPixels(
        Math.floor((softW - sw) / 2),
        Math.floor((softH - sh) / 2),
        sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, px,
      );
    } catch (err) {
      return; // 读回失败就当作没测到，下一帧再试
    }
    let visible = 0;
    for (let k = 3; k < px.length; k += 4) if (px[k] > 8) visible++;
    const prev = Number(canvas.__dhVisiblePixels) || 0;
    canvas.__dhVisiblePixels = Math.max(prev, visible);
    canvas.__dhPixelProbed = true;
    canvas.__dhModel = this;
    canvas.__dhRender = {
      backend: 'cubism-framework',
      drawn: this._drawCount || 0,
      view: [softW, softH],
      drawables: this._model ? this._model.getDrawableCount() : 0,
      visiblePixels: canvas.__dhVisiblePixels,
      glError: gl.getError(),
    };
  }

  // ---------------------------------------------------------- 释放

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      const gl = this._canvas ? this._canvas.getContext('webgl2') || this._canvas.getContext('webgl') : null;
      for (const tex of this._textures) if (gl && tex) gl.deleteTexture(tex);
      this._textures = [];
      if (this._renderer) {
        this._renderer.release();
        this._renderer = null;
      }
      if (this._pose) {
        this._F.CubismPose.delete(this._pose);
        this._pose = null;
      }
      if (this._physics) {
        this._F.CubismPhysics.delete(this._physics);
        this._physics = null;
      }
      this._eyeBlink = null;
      this._breathSpec = null;
      if (this._moc) {
        this._moc.release();
        this._moc = null;
      }
      if (this._model) {
        this._model.release();
        this._model = null;
      }
      this._motionManager = null;
      this._expressionManager = null;
    } catch (err) {
      console.warn('[live2d] 释放模型时出错（已忽略）：' + msg(err));
    }
  }
  };

  modelClasses.set(Base, cls);
  return cls;
}

/**
 * 拿到模型类（需要 Framework 已装配）。
 * 外部通常不需要直接用它 —— 用 `FrameworkLive2DLoader` 加载即可。
 */
export async function getFrameworkModelClass() {
  const F = await ensureFramework();
  return getModelClass(F.CubismUserModel);
}

// ---------------------------------------------------------------- Loader

/** 装载器：接口与旧 `Live2DLoader` 一致 */
export class FrameworkLive2DLoader {
  constructor({ corePath = CORE_PATH } = {}) {
    this.corePath = corePath;
  }

  /** 预加载 Cubism Core + Framework（页面启动时调一次，避免首次加载模型卡顿） */
  async ensureCore() {
    try {
      await ensureFramework();
      return true;
    } catch (err) {
      console.warn('[live2d] Framework 装配失败：' + msg(err));
      return false;
    }
  }

  /** 服务器上可用的模型列表 */
  async listModels() {
    const res = await fetch('/api/models/live2d');
    if (!res.ok) throw new Error('模型列表接口返回 ' + res.status);
    const data = await res.json();
    return Array.isArray(data.models) ? data.models : [];
  }

  /** 从服务器路径加载：'/assets/models/Hiyori/Hiyori.model3.json' */
  /** 从服务器路径加载：'/assets/models/Hiyori/Hiyori.model3.json' */
  async loadFromUrl(modelJsonUrl, { canvas } = {}) {
    const url = String(modelJsonUrl);
    const cut = url.lastIndexOf('/');
    const baseUrl = cut >= 0 ? url.slice(0, cut + 1) : '';
    const fs = new HttpFs(baseUrl);
    // 清单要原始字节（交给官方的 CubismModelSettingJson 自己解析）
    const manifest = await fs.readArrayBuffer(url.slice(cut + 1));
    const name = guessName(url);
    const cls = await getFrameworkModelClass();
    return cls.load({ fs, modelJson: manifest, homeDir: '', name, canvas });
  }

  /** 从本地文件加载（拖入 / <input type=file>）：纯内存映射 */
  async loadFromFiles(files, { canvas } = {}) {
    const list = Array.from(files || []);
    if (!list.length) throw new Error('loadFromFiles 需要文件列表');
    const manifest = pickManifest(list);
    if (!manifest) throw new Error('没找到 .model3.json（请选择整个模型文件夹）');
    const fs = new MemoryFs(list, rootNameOf(list));
    const rel = relativeOf(manifest);
    // 清单在子目录时，其余文件都相对它寻址
    const cut = rel.lastIndexOf('/');
    const homeDir = cut >= 0 ? rel.slice(0, cut + 1) : '';
    const name = guessName(rel);
    const manifestBuf = await manifest.arrayBuffer();
    const cls = await getFrameworkModelClass();
    return cls.load({ fs, modelJson: manifestBuf, homeDir, name, canvas });
  }
}

function pickManifest(files) {
  const ok = files.filter((f) => /\.model3?\.json$/i.test(f.name || ''));
  if (!ok.length) return null;
  ok.sort((a, b) => depthOf(relativeOf(a)) - depthOf(relativeOf(b)));
  return ok[0];
}

function depthOf(p) {
  return String(p).split('/').length;
}

function relativeOf(file) {
  const rel = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
  const parts = rel.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
}

function rootNameOf(files) {
  const rel = (files[0] && files[0].webkitRelativePath) || '';
  return rel ? rel.split('/')[0] : '';
}

/** 从路径猜显示名：'.../Hiyori/Hiyori.model3.json' → 'Hiyori' */
function guessName(url) {
  const clean = String(url).split('?')[0].replace(/\\/g, '/');
  const base = clean.split('/').pop() || clean;
  const fromFile = base.replace(/\.model3?\.json$/i, '');
  if (fromFile && fromFile !== 'model' && fromFile !== 'Model') return fromFile;
  const parts = clean.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : fromFile || 'model';
}
