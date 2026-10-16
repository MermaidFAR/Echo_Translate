# Echo Translate

使用自己的 DeepSeek API 的独立 Chrome 扩展。源代码可直接修改，采用原生 JavaScript、Manifest V3 和本地打包的 PDF / OCR 开源组件。没有复制沉浸式翻译的主体代码、品牌、图标或用户配置。

[GitHub 源码](https://github.com/MermaidFAR/Echo_Translate) · [安装包与发布记录](https://github.com/MermaidFAR/Echo_Translate/releases) · [问题反馈](https://github.com/MermaidFAR/Echo_Translate/issues)

## 安装与接入

- 从 [Releases](https://github.com/MermaidFAR/Echo_Translate/releases) 下载 `Echo_Translate.zip` 并解压；本地构建后也可直接使用 `dist/Echo_Translate` 文件夹。
- 在 Chrome 打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的 `Echo_Translate` 文件夹。
- 打开扩展设置，填写自己的 DeepSeek API Key。默认 Base URL 为 `https://api.deepseek.com`，模型为 `deepseek-flash`；也可读取账户实际可用模型并切换。
- 点击“保存并测试连接”。这会发送一句测试文本，并计入自己的 API 用量。
- 普通网页刷新后即可翻译。初次验收时可暂时关闭同类扩展，避免多个翻译器同时修改页面。

要求 Chrome 120 或更新版本；本次运行验证使用本机 Chrome 155。现有沉浸式翻译的安装、账户、设置和密钥均未迁移或修改。当前浏览器仍需由用户手动安装此独立版本。

## 功能

### 0.1.1：自然阅读排版

默认使用“自然阅读”样式：译文跟随原网页字体、字号、字重、颜色和行高，正文采用段落间距，短标签采用行内显示。双语模式不再额外包裹原文节点，保留网页原有的直接子元素样式、链接和布局；一行多个作者或链接按所在文本容器处理，隐藏的 Title / Abstract 标签不再混入显示内容。与原文相同的结果不再重复展示。

正文译文默认保留细竖线，与文字样式分开控制；短标签和标题不重复加线。“强调译文”样式仍可选择自定义颜色和字号。升级现有安装时，在扩展管理页重新加载扩展，再刷新网页即可使用新样式。此版本只调整文字显示与排版；模型、翻译提示词和 API 缓存协议沿用 0.1.0。

运行排版测试后会生成 `evidence/screenshots/reading-natural.png` 等截图；其中中文为固定模拟译文，用于验证显示效果，不用于评价模型翻译质量。截图不进入源码仓库。

| 功能 | 操作与行为 |
|---|---|
| 网页双语 / 仅译文 | 工具栏或 Alt+A；按可见区域加载，支持动态新增段落和文本替换，恢复时保留原 DOM 节点与事件监听器 |
| 划词、词典与解释 | 选择文字后按钮，或网页右键；译文使用纯文本渲染 |
| 悬停翻译 | 设置中开启，按住 Alt 悬停文字 |
| 输入框翻译 | Alt+I 或右键；普通文本输入框直接替换并触发编辑事件，密码框排除；富文本编辑器提供可复制结果以保留编辑器结构 |
| 文本、AI 专家与写作 | 侧边栏 / 文本页面：翻译、解释、摘要、润色、拟写回复、自定义任务 |
| 术语与提示词 | 设置固定词表、附加翻译要求；侧边栏可提取术语并加入词表 |
| 视频已有字幕 | 工具栏“视频双语字幕”；读取原生 TextTrack 或 YouTube 字幕，支持手动导入、时间偏移、同步覆盖和 SRT / VTT 导出 |
| 图片、漫画与截图 | 本地 Tesseract OCR；可框选识别区域、校正识别文字、编辑译文框位置/大小/颜色/字号/竖排，导出 PNG / TXT |
| PDF | 提取文本层并预览；中文字体由用户上传或主动下载；导出原文页后跟对应译文页的 PDF |
| 文档 / 电子书 | TXT、Markdown、HTML、JSON、DOCX、EPUB；预览、取消后继续、双语或仅译文导出，保留可保留的文档资源与结构 |
| 字幕文件 | SRT、VTT、ASS / SSA、LRC；保持时间轴并导出 |
| 无字幕音频文件 | 可选连接自己的 OpenAI 兼容 ASR / 自托管 Whisper；生成带时间字幕后由 DeepSeek 翻译，支持本地播放与导出 |
| 实时音频 / 会议 | 用户主动选择共享音源，以 15 秒独立片段交给自有 ASR，再由 DeepSeek 翻译；可在目标网页叠加字幕并导出完整双语 SRT |
| 站点与本地数据 | 自动翻译域名、排除域名、显示模式、并发/批量/重试、缓存、设置导入导出 |

## 数据与网络

- DeepSeek 密钥、可选 ASR 密钥只保存在该扩展的 `chrome.storage.local`。设置导出不含密钥，内容脚本也拿不到密钥。
- 网页、文件和 OCR 识别文字按用户操作发送到配置的翻译 API。图片识别在本机执行；原始音频仅在主动点击“生成字幕”或主动选择共享音源开始实时字幕后，发往配置的 ASR。
- JavaScript、OCR Worker、WASM、PDF 组件均随扩展打包，不加载远程脚本。
- OCR 第一次选择某种语言时会从 Project Naptha 下载语言模型；PDF 中文字体只有点击下载按钮时才从 Noto 官方仓库下载。也可自己上传字体。
- 翻译缓存包含原文哈希和译文，保存在本机 IndexedDB，可在设置中清除。扩展没有官方会员、广告、遥测、云同步或托管模型额度依赖。
- 长翻译与 ASR 网络请求在离屏页面的专用 Worker 内执行，以免普通 Service Worker 的长 `fetch` 生命周期限制中断请求。

## 准确边界

这是独立重建工程，当前还不能声称与原版所有云服务、全部站点适配和精细排版逐项等价。

- PDF 导出为“原文页 + 译文页”，没有重建 BabelDOC / PDF Pro 的逐元素同版式翻译。扫描 PDF 需要 OCR；可以先将页面转为图片，在图片页识别处理。
- 图片背景覆盖采用可编辑色块与文字排版；不是复杂背景的智能擦除或图像修复。识别质量受语言模型、清晰度、竖排和艺术字体影响。
- 字幕支持有文本轨道的网站与 YouTube 已有字幕。登录、反爬、DRM、只在站点私有状态中的字幕不能保证自动读取，可使用字幕导入。没有逐个重写原版数百个站点的适配规则。
- 音频文件转写需要额外 ASR 服务；DeepSeek 文本 API 本身不提供语音识别。实时共享音频入口采用 15 秒分段与模型处理，存在相应延迟；真实共享选择器、会议与第三方 ASR 的效果仍需用户环境验收。
- DOCX / EPUB 保留容器和资源，复杂文本框、公式、数字签名与精细字形布局不能保证等价保留。
- 没有真实 API 密钥参与本次开发；本地模拟接口测试不能证明账户余额、真实模型输出质量或真实服务可达性。

## 开发与验证

```powershell
git clone https://github.com/MermaidFAR/Echo_Translate.git
cd Echo_Translate
npm ci
npm run check
npm run build
npm test
```

`npm test` 包含隔离无头 Chrome 的集成测试；单独复跑浏览器可用 `npm run test:browser`。浏览器测试需要 Playwright；当前优先复用 Codex 打包运行时，也可通过 `ECHO_PLAYWRIGHT_PATH` 指定现有安装，通过 `ECHO_CHROME_PATH` 指定 Chrome。测试创建临时独立用户目录，不操作日常浏览器。

源码入口：`src/background.js` 负责消息、请求和取消；`src/api.js` 负责分段、协议、并发和重试；`src/content.js` 负责网页；`src/documents.js` 和 `file-formats.js` 负责文档；`src/media.js`、`subtitles.js`、`audio.js` 负责媒体。`tools/build.mjs` 生成可安装文件夹及 ZIP，依赖版本固定在 lockfile。

REA 证据见 `evidence/rea-summary.json`、`evidence/artifact-observations.json` 和 `REA_Report.md`。第三方组件原始许可随构建产物存放于 `LICENSES/`，清单见 `THIRD_PARTY_NOTICES.txt`。

## 许可证

Echo Translate 自有代码采用 [MIT 许可证](LICENSE)，允许修改与再分发。本项目为独立实现，与沉浸式翻译及 DeepSeek 官方无隶属关系。

第三方组件保留各自许可证；REA 记录中的第三方名称、配置与有界引用仅用于记录分析依据，不纳入 Echo Translate 自有代码的授权范围。
