# 词域 · Wordrealm

背单词 + AI 语法题的英语学习应用。**纯本地、离线可用、无后端。**

## 当前进度

- ✅ **W1**：项目骨架 + 词库 + 单词卡 + FSRS 调度 + 三档评分
- ✅ **W3**：AI 语法题（12 考点）+ 题库缓存 + 错题本 + 考点统计
- ⬜ W2：听音选词、更细的统计图表
- ⬜ W4：错题回流分析（AI 读取错题本 → 生成针对性专项题）

## 快速开始

```bash
npm install
npm run etl      # 从 ecdict.csv 生成词库（只需跑一次）
npm run dev      # 启动开发服务器
```

打开终端提示的地址（通常是 <http://127.0.0.1:5180/>）。

**语法题需要配一个 API Key**：右上角「⚙ 设置 → AI 语法题」。任何 OpenAI 兼容接口都行，
推荐 DeepSeek（`platform.deepseek.com` 申请）。Key 只存在本地 IndexedDB 里。

### ⚠️ 不要双击打开 index.html

**双击 index.html 必然得到一片空白页**，这不是 bug。

原因：项目根目录的 `index.html` 里写的是 `<script src="/src/main.tsx">`，
需要 Vite 实时编译 TypeScript。用 `file://` 协议打开时，浏览器会直接执行这行，
既拿不到编译结果，也会被 CORS 策略拦住 ES 模块。
另外 `file://` 下的 IndexedDB 在不同浏览器里行为不一致。

**必须通过 HTTP 访问**：

| 方式 | 命令 | 用途 |
|---|---|---|
| 开发模式 | `npm run dev` | 改代码即时热更新，**日常用这个** |
| 预览生产构建 | `npm run build` 然后 `npm run preview` | 验证打包版本 |

### 其他常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 显示"打不开本地数据库" | 无痕/隐私模式，或浏览器禁止了站点存储 | 换普通窗口打开 |
| 首次打开要等几秒 | 正在往 IndexedDB 导入 9,382 个词 | 只需一次，之后瞬开 |
| 发音没声音 | 系统缺英文语音包 | 设置里可看检测到的语音数量 |

## 词库

**9,382 词**，来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License, © Linwei）。

筛选规则（见 `tools/etl.mjs`）：

```
纯字母单词  ∩  有中文释义  ∩  命中 8 种考试标签  ∩  词频 2001–20000
```

**为什么词频下限是 2001 而不是 0**：`ielts` 标签涵盖全部基础词，按词频排序取前 30 名
会得到 `in, on, say, as, go, get...`——一个雅思词都没有。必须先排除词频前 2000 的
"已会词"，剩下的才是真正的雅思核心词。

### 实测踩过的坑

| 字段 | 实际情况 | 处理 |
|---|---|---|
| `pos` | **全表为空**（README 说有，实际 0 条） | 从 `translation` 的词性前缀提取，覆盖 99.4% |
| `detail` | **全表为空** | 没有例句，留给 AI 后补 |
| `phonetic` | 混用西里尔 `ә`(U+04D9) 和旧式 `i:` | **弃用**，发音一律走浏览器 TTS |
| `frq` | 全表仅 5.5% 覆盖，但考试词覆盖 93% | 可用，且是分档的关键依据 |
| `exchange` | 仅 12.5% 词条有 | 用于词族聚类（213 组） |

## 架构

```
src/
├── db/
│   ├── types.ts       数据模型
│   ├── db.ts          Dexie 表结构 + 查询（含 todayKey / shiftDayKey）
│   └── dataSource.ts  种子数据加载（浏览器吃 JSON，Node 走全局注入）
├── systems/
│   ├── fsrs.ts        FSRS 包装：Date ↔ 时间戳、状态映射、三档评分
│   ├── tts.ts         浏览器语音合成
│   └── grammar/       W3：AI 语法题
│       ├── types.ts     12 个考点 + 题目/错题模型
│       ├── prompt.ts    出题 prompt（质量的关键都在这）
│       ├── parse.ts     容错解析 + 校验 + 截断抢救
│       ├── provider.ts  AI 客户端（超时/错误分类/分批）
│       └── bank.ts      题库缓存调度（批量预生成）
├── store/
│   ├── useStore.ts       背单词状态机
│   └── useGrammarStore.ts 语法题状态机
├── components/        Today / Learn / Done / Grammar / Mistakes / Settings
└── data/seeds.json    ETL 产物（2.6MB，独立 chunk）
```

### 关键设计决定

**1. FSRS 的 `Card` 用 `Date` 对象，IndexedDB 不能直接存。**
所以 `StoredFsrsCard` 是持久化表示（时间戳），`toFsrsCard` / `fromFsrsCard` 负责转换。
`review()` 必须接收同一个 `now`，否则 `elapsed_days` 会有跨天误差。

**2. 评"忘记"的卡会重新入队到本次会话末尾**（Anki 的做法），
而不是等到下一轮。所以 `Learn` 组件的进度条分母会变化。

**3. 语法题是"批量预生成 + 缓存"，不是"做一题调一次 API"。**
一次调用生成 20 道存进 IndexedDB，做题时零延迟、可离线。调用量差 10 倍以上。

**4. 限定 12 个考点枚举，不让 AI 自由发挥。**
否则错题无法按考点聚合，W4 的"薄弱点分析"就无从谈起。

**5. 强制 `trap` 字段（学生最可能误选哪个、为什么）。**
这是 prompt 里性价比最高的一条约束：模型必须先想清楚错因，解析才有针对性，
而不是干巴巴一句"正确答案是 B"。

## 视觉方案：清新二次元

配色与规则都写在 `src/styles.css` 顶部的注释里。核心原则：

1. 底色是极浅的薄荷→天蓝→樱粉渐变，白色卡片浮在上面
2. **装饰只出现在「顶栏 / 空状态 / 小结页」，学习区一律纯白**——这是"不妨碍学习"的硬约束
3. 正文用深蓝灰 `#2d3a4d` 而非纯黑，长时间阅读不刺眼
4. 可爱感靠：大圆角、马卡龙点缀色、吉祥物，而不是花哨背景

主色天蓝 `#5bb8e8`，点缀薄荷绿 / 奶黄 / 樱粉。
语义色（对/错/模糊）保持足够对比度，没有为了"柔和"而调浅。

### 吉祥物

`public/art/` 下三张图由 **Qwen-Image 3.0**（DashScope）生成：

| 文件 | 用途 |
|---|---|
| `avatar.png` | 顶栏圆头像 |
| `reading.png` | 加载中 / 空状态 |
| `cheer.png` | 完成小结 |

**白底处理**：Qwen-Image 输出的是白底方图，没有透明通道。
用 `mix-blend-mode: multiply` 让白色"消失"、彩色保留——比抠图稳，也不会露出方形边界。
代价是浅色会被轻微压淡，所以配了 `filter: saturate/contrast` 补偿，且只能放在浅色背景上。

## 在 iPhone 上使用

**线上地址：<https://caelori.github.io/wordrealm/>**

### 添加到主屏幕

1. 用 **Safari** 打开上面的地址（必须是 Safari，Chrome 无法添加到主屏）
2. 等页面首次导入词库完成（几秒）
3. 点底部**分享按钮** → **添加到主屏幕** → 命名「词域」
4. 之后从主屏图标启动，全屏运行、离线可用

### ⚠️ 数据安全（务必读）

**iOS Safari 会在空间紧张或长期不访问时清理本地存储。** 学习进度是攒出来的，
被清掉等于白学。所以：

- 应用会主动申请持久化存储，但 iOS 不保证授予
- **请定期在「设置 → 数据与备份」导出备份**，尤其在这些时候：
  - 换设备 / 重装浏览器之前
  - 长时间（几周）不打算学习之前
- 备份默认**不含 API Key**，分享出去也安全

### 这不是原生 App

GitHub Actions 只能构建部署网页，产出的是 **PWA**，不是 `.ipa`。
真正的 iOS 原生应用必须用 Xcode + macOS 构建并签名，Windows 上做不到。

| | PWA（当前方案） | 原生 App |
|---|---|---|
| 主屏图标 / 全屏 / 离线 | ✅ | ✅ |
| 上架 App Store | ❌ | ✅ |
| 需要 Mac + 开发者账号 | 不需要 | 需要 |
| 数据被系统清理的风险 | ⚠️ 有 | 无 |

## 部署

推送到 `main` 会自动触发 GitHub Actions 构建并部署到 Pages。

**⚠️ 这个网络环境封了 `github.com`，`git push` 用不了**（但 `api.github.com` 可用）。
所以推送走 Git Data API：

```powershell
$env:GH_TOKEN = "<your_pat>"   # 需要 repo + workflow 两个 scope
node tools/gh-push.mjs          # blob -> tree -> commit -> 更新分支
node tools/gh-pages.mjs --watch # 盯部署状态
node tools/gh-logs.mjs          # 失败时拉具体步骤日志
```

### 端到端验收

```powershell
node tools/verify-page.mjs https://caelori.github.io/wordrealm/ 90000
```

会新建一个干净的 CDP target，收集网络与控制台事件，断言关键资源可达，并截图。
**这次的线上白屏就是靠它定位的**——它会明确告诉你哪个资源 404 或 MIME 不对。

启动带 CDP 的浏览器（只需一次）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --disable-gpu --remote-debugging-port=9333 `
  --user-data-dir=D:\ewg_cdp about:blank
```

## ⚠️ 实测踩坑记录

这些都是**真跑过才发现的**，不是推测：

| 问题 | 现象 | 处理 |
|---|---|---|
| **JSON 模块导入在生产失效** | 线上白屏：`Failed to fetch dynamically imported module`。Vite 打包时剥掉了 `import(url, { with: { type: 'json' } })` 的 import attribute，浏览器按普通模块脚本加载 `application/json`，触发严格 MIME 校验 | 词库移到 `public/data/` 作静态资源，运行时 `fetch` 取。dev 与生产走同一条路径 |
| **立绘路径写死成绝对路径** | 线上 `/art/avatar.png` 全部 404（请求到了域名根目录而不是 `/wordrealm/`） | 新增 `src/systems/assets.ts`，用 `new URL(rel, document.baseURI)` 解析 |
| **base 配置自伤** | 为适配 Pages 把 base 写死 `/wordrealm/`，结果本地 `npm run preview` 全部 404 | 改用相对 base `./`，dev / preview / Pages 三种环境同时成立 |
| **脚本里写死 Windows 路径** | CI ENOENT：`D:\English words game/package-lock.json` | 全部改为 `import.meta.url` 推导根目录 |
| **lock 文件跨平台不同步** | `npm ci` 报缺 `esbuild@0.28.2` 及全部平台包。原因一是 `vite-node` 拉进第二个 vite 大版本，二是 esbuild 的平台包是 optionalDependencies，npm 会剔除本平台自身的包 | 移除 `vite-node`，自写 40 行 loader 替代；CI 用 `npm install` 并新增 `check-lock.mjs` |
| **提交信息里的 `>` 被当重定向** | PowerShell 里 `git commit -m "... -> ..."` 直接报错，但 `git push` 「成功」推了旧提交，**修复代码根本没上去** | 提交信息改用文件：`git commit -F msg.txt`。并且**推送后必须核对远端 HEAD** |
| **`--virtual-time-budget` 会让 IndexedDB 卡死** | 无头浏览器截图时应用永远停在"打不开本地数据库"，我一度误判成产品 bug | 用 CDP 截图，靠轮询 DOM 判断就绪，**绝不加这个参数** |
| **模型名已失效** | DeepSeek `/models` 只返回 `deepseek-flash`、`deepseek-v4-pro`，老的 `deepseek-chat` 不存在了 | 默认值改为 `deepseek-flash`，并做成可填写 |
| **响应被 max_tokens 截断** | 生成 8 道题时 JSON 中途断裂，前 7 道完好的题被一并丢弃，白费一次调用 | `salvageTruncatedArray()` 按括号配对抢救；`MAX_TOKENS` 提到 16000 |
| **零冠词写成空字符串** | 出冠词题时模型把"不加冠词"输出成 `""`，被当空值过滤，选项只剩 3 个 → 整题废弃 | 统一规整为 `∅`，并在 prompt 里明确要求 |
| **一条脏数据把整个应用打白屏** | 错题本里某条记录 `stem` 为 undefined，`MistakeCard` 崩溃导致 React 卸载整棵树 | 组件内防御性取值 + **加 `ErrorBoundary` 兜底** |
| **flex 高度链没打通** | 卡片垂直位置算错，偏在一侧、另一侧留大片空白 | `#root > * { align-self: stretch }` |
| **模型速度差 4 倍** | 同样 8 道题：`deepseek-flash` 26 秒，`deepseek-v4-pro` 111 秒 | 默认用 flash |
| **ECDICT 的 `pos`/`detail` 全表为空** | README 说有，实际 0 条 | 词性从 `translation` 前缀提取；例句留给 AI |
| **ECDICT 音标是西里尔 `ә`** | 混用 U+04D9 与真 IPA，2450 条里只有 45 条是对的 | 弃用，发音一律走 TTS |
| **词频排序会毁掉词表** | `ielts` 标签涵盖全部基础词，前 30 名是 `in/on/say/as/go` | 先排除词频前 2000 才筛 |

> **最大的教训**：这一轮我三次说"修好了"，三次都错了。
> 原因都是**只在本地验证就下结论**——本地是 Windows、根路径、dev server，
> 而线上是 Linux、子目录、静态托管。差异全在环境上。
> 后来改用 `tools/verify-page.mjs` 对**真实 URL** 做端到端断言，才一次定位干净。

## 界面截图与验收工具

```bash
# 启动带 CDP 的无头 Edge（只需一次）
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --disable-gpu --remote-debugging-port=9333 `
  --user-data-dir=D:\ewg_cdp about:blank

node tools/shoot-ui.mjs <名字> <路径> "<就绪表达式>" [毫秒] [宽] [高] [要点的标签]
node tools/shoot-quiz.mjs 答错          # 语法答题页
node tools/shoot-learn.mjs              # 单词卡页
node tools/cdp-seed-demo.mjs            # 灌演示数据（题库 + 错题本）
```

截图落在 `_shots/`。这套工具是这次改 UI 时建的——
**没有它就只能"盲改 CSS"**，因为截图工具原本会卡在加载页。

## 测试

```bash
npx tsc --noEmit                                            # 类型检查
node --experimental-strip-types tools/test-fsrs.mts         # 排程算法（14 项）
npx vite-node tools/test-grammar.mts                        # 解析鲁棒性（60+ 项）
npx vite-node tools/test-integration.mts                    # 单词端到端（50 项）
npx vite-node tools/test-grammar-integration.mts            # 语法端到端（60 项）
```

前两个用 `fake-indexeddb` 在 Node 里跑真实数据层，覆盖
首次导入 → 计数 → 取队列 → 评分调度 → 统计 → 连签 → 重复导入保护，
以及题库 → 作答 → 错题本 → 考点统计 → 重做攻克。

`test-grammar.mts` 专门用**真实 LLM 会返回的脏格式**打解析层：
markdown 围栏、前后闲聊、尾随逗号、全角引号、裸数组、截断 JSON，
以及 15 种非法题目（选项数不对、答案越界、缺 trap……）。

> 用 `vite-node` 而不是裸 `node`：Node 的 ESM 要求显式扩展名，而源码用的是
> Vite 风格的无扩展名导入。`vite-node` 让测试跑在与浏览器一致的模块解析下。

## 已知问题 / 待办

- 单词例句：ECDICT 没有，需要 AI 预生成后缓存
- 口语发音评分：`speechSynthesis` 只能朗读，不能评分
- 词表还缺 CEFR 等级、语义分组
- `seeds.json` 2.6MB（gzip 后约 770KB），首次加载需要下载
