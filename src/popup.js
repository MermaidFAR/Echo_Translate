import { getSettings, showError } from './client.js';
const status = document.querySelector('#status');
try { const settings = await getSettings(); document.querySelector('#connection').textContent = settings.hasKey ? `${settings.model} → ${settings.target}` : '请先在设置中填写自己的 DeepSeek API Key。'; }
catch (error) { showError(status, error); }
document.querySelectorAll('[data-action]').forEach(button => button.onclick = async () => {
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: button.dataset.action });
    if (!response?.ok) throw new Error(response?.error || '页面未响应。'); window.close();
  } catch (error) { showError(status, new Error('无法操作此页面。普通网页请刷新后重试；Chrome 内部页面不支持注入。')); }
});
document.querySelector('#capture').onclick = async () => {
  try { const response = await chrome.runtime.sendMessage({ type: 'captureViewport' }); if (!response.ok) throw new Error(response.error); window.close(); }
  catch (error) { showError(status, error); }
};
document.querySelector('#panel').onclick = async event => {
  event.preventDefault(); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await chrome.sidePanel.open({ tabId: tab.id }); window.close(); }
  catch { chrome.tabs.create({ url: chrome.runtime.getURL('pages/panel.html') }); }
};
