import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGuiConfig, writeGuiConfig } from '../core/config-store.mjs';
import { acquireWorkerLock, isWorkerLockActive, releaseWorkerLock } from '../core/worker-lock.mjs';
import { archiveItems, atomicWrite, readJson, scanAlbum, vaultPath } from './archive.mjs';
import { beginNintendoLogin, downloadMedia, normaliseAccountMedia, persistentCredentials } from './account.mjs';
import { bundledAlbumClient, requireAlbumConsent } from './nxapi-client.mjs';
import { installReflectionView } from './reflection-editor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMPTY_STATE = () => ({ version: 1, games: {}, media: {}, lastRunAt: null, lastResult: null, lastError: null });

async function readPayload() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('设置数据过大。');
  }
  return raw ? JSON.parse(raw) : {};
}

export async function runSwitchAction(action, payload = {}, projectRoot = root, options = {}) {
  let full = await readGuiConfig(projectRoot);
  const credentials = options.credentials;
  if (['account-status', 'login-start', 'login-finish', 'disconnect', 'check-service'].includes(action)) {
    if (!credentials) throw new Error('账号操作请在桌面应用中进行，登录信息由本机钥匙串保管。');
    if (action === 'account-status') return { connected: Boolean(credentials.sessionToken && (credentials.lastAlbumAt || credentials.coralToken)), sessionAuthorised: Boolean(credentials.sessionToken), lastAuthError: credentials.lastAuthError || null, pending: Boolean(credentials.pending && Date.now() - credentials.pending.createdAt < 5 * 60 * 1000) };
    if (action === 'disconnect') {
      for (const key of Object.keys(credentials)) delete credentials[key];
      return { ok: true, message: '本机登录信息已移除；已归档的游戏回忆保留。' };
    }
    requireAlbumConsent(full.switch);
    if (action === 'login-start') {
      const pending = beginNintendoLogin();
      const { url, ...privateState } = pending;
      credentials.pending = privateState;
      return { ok: true, url, message: '在 Nintendo 官方网页登录后，右键复制「使用此账号」按钮的链接，粘贴到这里。授权链接只在本机处理，不要发到聊天中。' };
    }
    const client = (options.accountClient || bundledAlbumClient)(full.switch, credentials, { projectRoot });
    try {
      if (action === 'check-service') return await client.checkService();
      return await client.completeLogin(String(payload.callback || ''), credentials.pending);
    } finally {
      for (const key of Object.keys(credentials)) delete credentials[key];
      Object.assign(credentials, persistentCredentials(client.credentials));
      if (action === 'login-finish') delete credentials.pending;
    }
  }
  if (action === 'save-settings') {
    const input = payload.switch || {};
    // Nintendo credentials never belong in the shared JSON settings.
    const settings = {
      source: input.source === 'account' ? 'account' : 'local',
      nxapiClientId: String(input.nxapiClientId || '').trim(),
      nxapiClientVersion: String(input.nxapiClientVersion || '').trim(),
      thirdPartyConsent: input.thirdPartyConsent === true,
      albumDir: String(input.albumDir || ''),
      experienceDir: String(input.experienceDir || full.switch.experienceDir),
      attachmentDir: String(input.attachmentDir || full.switch.attachmentDir),
      filenameTimezone: String(input.filenameTimezone || '+08:00'),
      games: full.switch.games,
    };
    if (settings.albumDir && !path.isAbsolute(settings.albumDir)) throw new Error('相册目录请填写绝对路径。');
    const vaultDir = String(payload.vaultDir || '');
    if (vaultDir) {
      await vaultPath(vaultDir, settings.experienceDir);
      await vaultPath(vaultDir, settings.attachmentDir);
      await fs.mkdir(await vaultPath(vaultDir, settings.experienceDir), { recursive: true });
      await fs.mkdir(await vaultPath(vaultDir, settings.attachmentDir), { recursive: true });
    }
    await writeGuiConfig(projectRoot, { ...full, vaultDir, switch: settings });
    return { ok: true, message: 'Switch 设置已保存。' };
  }
  if (action === 'save-game') {
    const id = String(payload.id || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('游戏标识无效。');
    const coverFile = String(payload.coverFile || '');
    if (coverFile && (!path.isAbsolute(coverFile) || !/\.(jpg|jpeg|png)$/i.test(coverFile))) throw new Error('海报请选择本地 JPG 或 PNG 图片的绝对路径。');
    if (coverFile) await fs.access(coverFile);
    full.switch.games[id] = { name: String(payload.name || '').trim(), coverFile };
    await writeGuiConfig(projectRoot, full);
    return { ok: true, message: '游戏名称和海报已保存，下次导入时应用。' };
  }
  if (!full.vaultDir) {
    if (action === 'status') return { configured: false, running: false, games: [], imported: 0, lastRunAt: null, lastResult: null, lastError: null };
    throw new Error('请先保存 Obsidian 仓库根目录。');
  }
  const vault = await fs.realpath(full.vaultDir);
  const stateDir = await vaultPath(vault, '.obsidian/switch-experience-sync');
  const stateFile = await vaultPath(vault, '.obsidian/switch-experience-sync/state.json');
  const lockFile = await vaultPath(vault, '.obsidian/switch-experience-sync/worker.lock');
  const stopFile = await vaultPath(vault, '.obsidian/switch-experience-sync/stop-worker');
  const logFile = await vaultPath(vault, '.obsidian/switch-experience-sync/worker.log');
  const state = await readJson(stateFile, EMPTY_STATE());
  if (action === 'status') {
    const deleted = new Set();
    for (const game of Object.values(state.games)) {
      try {
        const content = await fs.readFile(await vaultPath(vault, game.note), 'utf8');
        for (const match of content.matchAll(/^%% switch-deleted:((?:nintendo|local)-[a-f0-9]{64}) /gm)) deleted.add(match[1]);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const savedMedia = Object.entries(state.media).filter(([id, item]) => !item.duplicateOf && !deleted.has(id)).map(([, item]) => item);
    return {
      configured: true,
      running: await isWorkerLockActive(lockFile, { staleMs: Number.MAX_SAFE_INTEGER }),
      source: full.switch.source,
      imported: savedMedia.length,
      games: Object.values(state.games).map((game) => ({ ...game, count: savedMedia.filter((item) => item.gameId === game.id).length, name: full.switch.games[game.id]?.name || game.name, coverFile: full.switch.games[game.id]?.coverFile || '' })),
      lastRunAt: state.lastRunAt, lastResult: state.lastResult, lastError: state.lastError,
    };
  }
  if (action === 'logs') {
    try { return (await fs.readFile(logFile, 'utf8')).split('\n').slice(-200).join('\n'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  if (action === 'stop') {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stopFile, '', { mode: 0o600 });
    return { ok: true, message: '停止请求已发送，当前文件完成后退出。' };
  }
  if (action === 'install-style') {
    await installReflectionView(vault, full.switch, projectRoot);
    const source = path.join(projectRoot, 'docs/obsidian-switch-experience.css');
    const target = await vaultPath(vault, '.obsidian/snippets/switch-experience.css');
    let old = null;
    try { old = await fs.readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const css = await fs.readFile(source, 'utf8');
    if (old !== null && old !== css) {
      if (!old.startsWith('/* Game Experience Sync: Switch */')) throw new Error('同名 CSS 已存在且不是本应用生成的，未覆盖。');
      await fs.copyFile(target, `${target}.${Date.now()}.bak`, 1);
    }
    if (old !== css) await atomicWrite(target, css);
    const appearanceFile = await vaultPath(vault, '.obsidian/appearance.json');
    const appearance = await readJson(appearanceFile, {});
    const enabled = appearance.enabledCssSnippets || [];
    if (!Array.isArray(enabled)) throw new Error('Obsidian 外观配置的样式列表无效，未修改。');
    if (!enabled.includes('switch-experience')) {
      try { await fs.copyFile(appearanceFile, `${appearanceFile}.${Date.now()}.bak`, 1); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicWrite(appearanceFile, JSON.stringify({ ...appearance, enabledCssSnippets: [...enabled, 'switch-experience'] }, null, 2));
    }
    return { ok: true, message: 'Switch 样式已安装并启用；Obsidian 打开后会读取。' };
  }
  if (!['preview', 'sync'].includes(action)) throw new Error('不支持的 Switch 操作。');
  const account = full.switch.source === 'account';
  if (account) {
    requireAlbumConsent(full.switch);
    if (!credentials?.sessionToken) throw new Error('请先在 Settings 连接 Nintendo 账号。');
  }
  const collect = async (shouldStop) => {
    if (!account) return scanAlbum(full.switch.albumDir, full.switch);
    const client = (options.accountClient || bundledAlbumClient)(full.switch, credentials, { projectRoot });
    try { return { items: normaliseAccountMedia(await client.listMedia({ shouldStop }), full.switch.filenameTimezone), skipped: [] }; }
    finally { Object.assign(credentials, persistentCredentials(client.credentials)); }
  };
  if (action === 'preview') {
    const scan = await collect();
    const groups = new Map();
    for (const item of scan.items) {
      const game = groups.get(item.gameId) || { id: item.gameId, name: full.switch.games[item.gameId]?.name || item.game, count: 0 };
      game.count++;
      groups.set(item.gameId, game);
    }
    return { games: [...groups.values()], total: scan.items.length, skipped: scan.skipped };
  }
  const lock = await acquireWorkerLock(lockFile, { staleMs: Number.MAX_SAFE_INTEGER });
  if (!lock.acquired) throw new Error('Switch 导入正在运行，请等待完成。');
  try {
    await fs.unlink(stopFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const reflectionView = await installReflectionView(vault, full.switch, projectRoot);
    const shouldStop = async () => { try { await fs.access(stopFile); return true; } catch { return false; } };
    const scan = account ? await collect(shouldStop) : await scanAlbum(full.switch.albumDir, { ...full.switch, shouldStop });
    const staging = await vaultPath(vault, '.obsidian/switch-experience-sync/downloads');
    const items = account ? (async function* () {
      for (const item of scan.items) {
        if (await shouldStop()) break;
        if (state.media[item.id]) { yield { ...item, hash: state.media[item.id].hash }; continue; }
        const data = await (options.downloadMedia || downloadMedia)(item, staging, shouldStop);
        try { yield { ...item, ...data }; }
        finally { await fs.unlink(data.sourceFile).catch(() => {}); }
      }
    })() : scan.items;
    const result = await archiveItems({
      vault, config: { ...full.switch, reflectionView }, items, state,
      saveState: (next) => atomicWrite(stateFile, JSON.stringify(next, null, 2)),
      shouldStop,
    });
    if (await shouldStop()) result.stopped = true;
    state.lastRunAt = new Date().toISOString();
    state.lastResult = { ...result, skipped: scan.skipped };
    state.lastError = null;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2));
    const message = result.stopped ? `已停止，同步新增 ${result.imported} 项。` : result.imported === 0 && scan.skipped.length === 0 ? `没有新增内容，已检查 ${scan.items.length} 条相册记录。` : `同步完成，新增 ${result.imported} 项，已存在 ${result.duplicates} 条记录，无法识别 ${scan.skipped.length} 项。`;
    await fs.appendFile(logFile, `${state.lastRunAt} ${message}\n`, { mode: 0o600 });
    return { ok: true, message, ...state.lastResult };
  } catch (error) {
    state.lastError = error.message;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2));
    throw error;
  } finally { await releaseWorkerLock(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = await readPayload();
  const native = process.argv.includes('--native-bridge');
  const credentials = native ? input.credentials || {} : undefined;
  try {
    const result = await runSwitchAction(process.argv[2] || 'status', native ? input.payload || {} : input, root, { credentials });
    console.log(JSON.stringify(native ? { result, credentials: persistentCredentials(credentials) } : result));
  } catch (error) {
    if (native) console.log(JSON.stringify({ error: error.message, credentials: persistentCredentials(credentials) }));
    else { console.error(error.message); process.exitCode = 1; }
  }
}
