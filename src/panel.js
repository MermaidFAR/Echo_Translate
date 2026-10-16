import { translateTexts, getSettings, downloadBlob, showError } from './client.js';
const $ = selector => document.querySelector(selector); let controller;
try { const config = await getSettings(); $('#source').value = config.source; $('#target').value = config.target; } catch (error) { showError($('#status'), error); }
$('#run').onclick = async () => {
  const text = $('#text').value.trim(); if (!text) { showError($('#status'), new Error('请先输入原文。')); return; }
  controller = new AbortController(); $('#run').disabled = true; $('#cancel').disabled = false; $('#status').textContent = '处理中…';
  try {
    const [result] = await translateTexts([text], { source: $('#source').value, target: $('#target').value, mode: $('#mode').value,
      instruction: $('#instruction').value, signal: controller.signal });
    $('#output').textContent = result; $('#status').textContent = '完成。'; $('#status').dataset.status = 'ok';
  } catch (error) { showError($('#status'), error.name === 'AbortError' ? new Error('已取消。') : error); }
  finally { $('#run').disabled = false; $('#cancel').disabled = true; }
};
$('#cancel').onclick = () => controller?.abort();
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText($('#output').textContent); $('#status').textContent = '结果已复制。'; } catch (error) { showError($('#status'), error); } };
$('#download').onclick = () => downloadBlob(new Blob([$('#output').textContent], { type: 'text/plain;charset=utf-8' }), 'Echo_Translation.txt');
$('#add-terms').onclick = async () => {
  try {
    const terms = $('#output').textContent.split('\n').map(line => line.trim()).filter(line => /^[^=]+\s=\s.+$/.test(line));
    if (!terms.length) throw new Error('先使用“提取术语”任务生成“原词 = 译词”格式的结果。');
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.glossary = [...new Set([...(settings.glossary || '').split('\n'), ...terms])].filter(Boolean).join('\n');
    await chrome.storage.local.set({ settings }); $('#status').textContent = `已将 ${terms.length} 条术语加入本地术语库。`;
  } catch (error) { showError($('#status'), error); }
};
