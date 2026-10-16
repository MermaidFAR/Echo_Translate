import { DEFAULTS, normalizeSettings, resolveEndpoint } from './settings.js';
import { translateTexts, downloadBlob, showError } from './client.js';
const form = document.querySelector('form'); const status = document.querySelector('#status');
function render(settings, key) {
  const value = normalizeSettings(settings);
  for (const name of Object.keys(DEFAULTS)) {
    const element = form.elements.namedItem(name); if (!element) continue;
    if (element.type === 'checkbox') element.checked = value[name];
    else element.value = Array.isArray(value[name]) ? value[name].join('\n') : value[name];
  }
  if (key !== undefined) document.querySelector('#apiKey').value = key;
  updateStyleControls();
}
function updateStyleControls() {
  const natural = document.querySelector('#translationStyle').value === 'natural';
  document.querySelector('#fontSize').disabled = natural;
  document.querySelector('#color').disabled = natural;
}
document.querySelector('#translationStyle').addEventListener('change', updateStyleControls);
function read() {
  const value = {};
  for (const name of Object.keys(DEFAULTS)) {
    const element = form.elements.namedItem(name); if (!element) continue;
    value[name] = element.type === 'checkbox' ? element.checked : typeof DEFAULTS[name] === 'number' ? Number(element.value) :
      Array.isArray(DEFAULTS[name]) ? element.value.split('\n').map(x => x.trim()).filter(Boolean) : element.value;
  }
  resolveEndpoint(value.baseUrl); return normalizeSettings(value);
}
async function save() {
  const value = read(); const key = document.querySelector('#apiKey').value.trim();
  const asrApiKey = document.querySelector('#asrApiKey').value.trim();
  await chrome.storage.local.set({ settings: value, apiKey: key, asrApiKey });
  status.dataset.status = 'ok'; status.textContent = '设置已保存。'; return value;
}
form.addEventListener('submit', async event => { event.preventDefault(); try { await save(); } catch (error) { showError(status, error); } });
document.querySelector('#test').onclick = async event => {
  event.target.disabled = true;
  try { await save(); status.textContent = '正在测试，将发送一句测试文本并计入 API 用量…';
    const result = await translateTexts(['Hello, world.'], { source: 'en', target: 'zh-CN' });
    status.textContent = `连接成功：${result[0]}`; status.dataset.status = 'ok';
  } catch (error) { showError(status, error); } finally { event.target.disabled = false; }
};
document.querySelector('#load-models').onclick = async () => {
  try { await save(); const response = await chrome.runtime.sendMessage({ type: 'models' });
    if (!response.ok) throw new Error(response.error);
    document.querySelector('#models').replaceChildren(...response.models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
    status.textContent = `已读取 ${response.models.length} 个模型；在模型输入框选择。`;
  } catch (error) { showError(status, error); }
};
document.querySelector('#clear-cache').onclick = async () => {
  try { const response = await chrome.runtime.sendMessage({ type: 'clearCache' }); if (!response.ok) throw new Error(response.error); status.textContent = '翻译缓存已清除。'; }
  catch (error) { showError(status, error); }
};
document.querySelector('#export').onclick = () => {
  try { downloadBlob(new Blob([JSON.stringify({ version: 1, settings: read() }, null, 2)], { type: 'application/json' }), 'Echo_Translate_Settings.json'); }
  catch (error) { showError(status, error); }
};
document.querySelector('#import').onchange = async event => {
  try { const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error('设置文件过大。');
    const data = JSON.parse(await file.text()); render(data.settings || data); status.textContent = '已导入预览；确认后点击保存。密钥保持当前值。'; }
  catch (error) { showError(status, error); } finally { event.target.value = ''; }
};
try { const data = await chrome.storage.local.get(['settings', 'apiKey', 'asrApiKey']); render(data.settings, data.apiKey || ''); document.querySelector('#asrApiKey').value = data.asrApiKey || ''; }
catch (error) { showError(status, error); }
