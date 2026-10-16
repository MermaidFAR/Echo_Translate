# 沉浸式翻译 1.33.3：REA 与独立重建记录

## 结论与交付口径

目标是用户提供的 `chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh/options.html#services/deepseek-BVM3Qlra`。本机安装包确认是沉浸式翻译 1.33.3，Manifest V3。用户明确选择独立、可维护的重建工程，翻译使用自己的 DeepSeek 官方协议接口。

原版已经内置 DeepSeek 自定义 API。独立版本因此重建功能与数据链路，没有修改原安装包或移植其会员判断。PDF、图片、无字幕音频等必须独立处理，不能把复制客户端文件称为已经重建官方云服务。

## 原始证据

静态目标目录：`C:/Users/FAR/AppData/Local/Google/Chrome/User Data/Default/Extensions/bpoadfkcbjbfhfodiogcnhhhpibjhbnh/1.33.3_0`。

REA 父记录：`ev_805c789f26886fc0ace868d486473ac46771ff1721bcb5b63f0bb38186f114a2`；摘要记录：`ev_f8583c827cd58fcaf8f996cd430d424fcd7b768948cf36fe1913a7a08f493538`；目录摘要 SHA-256：`efb25cfe6fb3391431ee4833e701a61b9aeca7b0cf36a79a8c041133b30058a0`。

REA 读取 53 个相关文件、约 27.2 MB 文本，解析 20 个 JavaScript 文件，解析失败数为 0。大压缩包的语义关系构建受父结果预算限制，应用覆盖为 partial、语义覆盖为 partial/truncated，保留 11 个应用未知范围、5997 个语义未知项。这些是静态分析统计，不是“原软件已运行通过”。已保存工具的完整摘要投影；没有将约 2 GB 的语义父图作为工程依赖复制。

CodeGraph 检查确认该安装包未建立索引，按工具明确返回的降级要求读取文件。首次升级检查发现本机 1.6.1、有 1.6.2 可更新；本次未升级或初始化索引。

## 主要观察

| 判断 | 直接证据 | 强度与边界 |
|---|---|---|
| 有自有 DeepSeek 接口 | `default_config.json` 的 `/translationServices/deepseek`：provider=custom，接口 `https://api.deepseek.com/chat/completions`，模型 deepseek-flash / deepseek-v4-pro | 安装包静态配置；没有读取用户当前服务实例或实际密钥 |
| 自定义服务可用于网页、AI 专家/术语、已有字幕、输入框、悬停 | `options.js` 的 `services.consent.supportFeatures` 及中文资源；DeepSeek supportFeatures 另列 aiWriting、selectionTranslation | 静态 UI 声明与默认能力标识，不等于所有站点已测试 |
| 基础 PDF 是远程应用 | `pdf/index.html:45–49` iframe 指向 `https://app.immersivetranslate.com/pdf?file=emptyfile`；`pdf/extension-entry.js:24–32` 向 iframe 传入 PDF Blob | 本地包不包含完整独立 PDF 应用 |
| 多种文件功能导向官方应用 | options 配置包含 PDF Pro、BabelDOC、EPUB / 字幕构建器的官方应用 URL | 无法从扩展静态文件取得服务端实现 |
| AI 无字幕生成有独立登录与额度链 | options 的 aiSubtitleLogin / QuotaExceeded 处理及资源文本 | 与已有字幕文本翻译是不同流程 |
| 图片不是只换翻译 URL | 包含 Tesseract / WASM / ONNX 资源，同时有图片/漫画登录、额度与套餐文案 | 包含本地识别组件，但不能证明独立完整擦除、排版和所有识别链路 |
| 给定 hash 是配置实例候选 | 已查打包资源未出现 deepseek-BVM3Qlra | 有界未命中；未读存储，仍是推断 |

证据定位脚本 `evidence/Capture_Artifact.mjs` 记录核心文件 SHA-256、精确字符偏移、实际行号及短片段；没有复制浏览器运行时状态。

## 重建架构

- 内容脚本提取普通网页文字并显示双语，保留原节点；恢复时还原原节点，而非重新生成源 HTML。
- 所有翻译由后台统一配置，经专用离屏网络 Worker 发往用户 API。分段编号映射、限并发、临时错误重试、缓存和取消在公共层实现。
- 设置公开响应不含翻译密钥或 ASR 密钥；配置导出也不含密钥。内容渲染使用 textContent，避免将模型输出作为脚本或 HTML 执行。
- 文件处理在本地解析；DOCX / EPUB 保留资源容器，PDF 使用 PDF.js、pdf-lib 与用户提供字体。图片使用本地 Tesseract，然后将文字发给 DeepSeek。
- 视频字幕支持浏览器文本轨道和只读 YouTube 字幕桥接；无字幕文件与用户主动选择的实时共享音频可连接独立 ASR；实时分段为 15 秒。没有伪装成 DeepSeek 能接收音频。

## 验证与剩余范围

0.1.1 根据用户截图修复文字显示：文字继承页面字体与行高，保留可独立开关的段落细竖线，合并行内链接所在容器，保留原 DOM 层级，压缩短标签的双语显示。新增论文页面排版测试覆盖作者整行、隐藏描述、链接事件与直接子元素选择器、深色背景继承、相同文本去重，以及可选强调样式。此次没有改变模型、翻译提示词或缓存协议；没有进行翻译质量比较。

验证结果与覆盖以 `evidence/validation.json` 为准。测试使用本地模拟 DeepSeek / ASR 服务与独立无头浏览器，不包含真实模型质量验收。

已通过的纯函数与文档 DOM 用例覆盖接口地址、分段往返、编号去重、缓存、并发、401、取消、协议错配回退、字幕时间轴、JSON 数据形状、Markdown 代码排除、ZIP 路径/解压限制、DOCX / EPUB 容器导出、取消后继续。

实际 Chrome 首轮验证发现 MV3 拒绝 `worker-src blob:`，已改为本地 Worker；发现 WorkerGlobalScope 原生 fetch 被当对象成员调用导致 Illegal invocation，已绑定全局接收者；发现整段 textContent 替换漏触发重新翻译，已补失效和重译路径。这些是运行中发现的根因，不是只看 Node mock 得出的结论。

不把当前版本称为原版完全等价复刻：PDF 同版式重排、复杂背景智能擦除、全部站点专用适配仍有明确缺口；实时音频已提供用户主动共享、分段 ASR 与翻译入口，真实会议音源和第三方 ASR 仍待现场验收。没有真实 Key，因此用户安装后仍需在设置页执行真实 API 连接测试。具体功能、安装与限制见 README。

协议核验采用 [DeepSeek 官方入口](https://api-docs.deepseek.com/)、[JSON 输出文档](https://api-docs.deepseek.com/guides/json_mode/)；长请求生命周期依据 [Chrome 官方 Service Worker 文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。
