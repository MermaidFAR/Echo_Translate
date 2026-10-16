import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export async function playwrightRuntime() {
  try { return await import('playwright-core'); }
  catch {
    const runtime = process.env.ECHO_PLAYWRIGHT_PATH || path.join(process.env.USERPROFILE || process.env.HOME || '',
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    return createRequire(import.meta.url)(runtime);
  }
}

export async function launchExtension(extensionPath) {
  const { chromium } = await playwrightRuntime();
  const profile = await mkdtemp(path.join(tmpdir(), 'echo-translate-browser-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir())) throw new Error('测试配置目录超出临时目录边界。');
  const executablePath = process.env.ECHO_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--disable-background-networking', '--no-first-run',
        '--no-default-browser-check', '--disable-component-update'],
    });
    const browser = context.browser();
    const session = await browser.newBrowserCDPSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: extensionPath });
    const wakePage = await context.newPage();
    await wakePage.goto(`chrome-extension://${id}/pages/options.html`);
    const worker = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${id}/`))
      || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith(`chrome-extension://${id}/`), timeout: 20000 });
    return {
      context, worker, id,
      close: async () => { await context.close(); await rm(profile, { recursive: true, force: true }); },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
