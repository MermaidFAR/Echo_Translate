# 工程约定

- 独立重建，不复制沉浸式翻译主体代码、图标、品牌、用户配置或凭据。
- 使用原生 JavaScript ES modules、Manifest V3，函数按职责直接命名。
- 翻译统一发往 service worker：`chrome.runtime.sendMessage({type:'translate',texts:[...],source:'auto',target:'zh-CN',context:'',mode:'translate',requestId:crypto.randomUUID()})`，成功返回 `{ok:true,translations:[...]}`，失败返回 `{ok:false,error:'...'}`。
- 可公开设置由 `{type:'settings'}` 获取，返回 `{ok:true,settings}`，不含 API 密钥。密钥只存 chrome.storage.local。
- 页面可通过 `src/client.js` 的 `translateTexts(texts, options)`、`getSettings()`、`downloadBlob(blob,name)`、`showError(element,error)` 共用函数接入。
- HTML 页面只使用本地脚本和样式，不使用内联脚本或远程执行代码。所有第三方依赖在构建时打包并保留许可。
- 不自动操作用户浏览器界面。使用 Node 和独立无头浏览器测试。
- 测试必须区分本地 mock 与真实 DeepSeek API；没有密钥不能声称真实模型已通过。
