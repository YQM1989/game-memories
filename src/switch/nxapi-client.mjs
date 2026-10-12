import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCallback } from './account.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NXAPI_VERSION = '1.6.1-next.257';
const CLIENT = '71b963c1b7b6d119';
const CACHE_PREFIX = '__SWITCH_PRIVATE_CACHE__';
const DIAGNOSTIC_PREFIX = '__SWITCH_DIAGNOSTIC__';
const SAFE_STAGES = new Set(['Nintendo 账号授权', 'Nintendo 账号资料', '认证服务登录', '相册认证', 'Nintendo 相册登录', '相册列表', '相册请求加密', '相册响应解密', '客户端服务配置']);
const SAFE_CODES = new Set(['invalid_request', 'invalid_grant', 'invalid_client', 'invalid_token', 'insufficient_scope', 'incompatible_client', 'unsupported_version', 'unsupported_platform', 'unauthorised', 'unauthorized_client', 'request_parameter_not_set', 'unsupported_grant_type', 'service_unavailable']);

export function requireAlbumConsent(config) {
  if (config.thirdPartyConsent !== true) throw new Error('请先同意第三方认证的数据流向，再连接 Nintendo 账号。');
}

export async function verifyBundledClient(projectRoot = root) {
  const helper = path.join(projectRoot, 'tools/nxapi-client');
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(helper, 'node_modules/nxapi/package.json'), 'utf8'));
    if (!pkg.version.startsWith(NXAPI_VERSION + '+') && pkg.version !== NXAPI_VERSION) throw new Error('version');
    await fs.access(path.join(helper, 'node_modules/nxapi/bin/nxapi.js'));
    await fs.access(path.join(projectRoot, 'src/switch/nxapi-preload.mjs'));
    return helper;
  } catch { throw new Error('应用自带的 Switch 客户端缺失或版本不匹配，请重新安装应用。'); }
}

export function bundledAlbumClient(config, credentials = {}, options = {}) {
  const cache = { ...credentials };
  const projectRoot = options.projectRoot || root;
  const now = options.now || Date.now;
  async function listMedia({ shouldStop = async () => false } = {}) {
    requireAlbumConsent(config);
    if (!cache.sessionToken) throw new Error('请先在 Settings 连接 Nintendo 账号。');
    if (cache.cooldownUntil > now()) throw new Error('账号服务冷却中，请稍后再同步。');
    if (await shouldStop()) return [];
    const helper = await verifyBundledClient(projectRoot);
    const environment = {
      PATH: process.env.PATH || '',
      NXAPI_DATA_PATH: path.join(path.dirname(process.env.STEAM_GUI_CONFIG_FILE || path.join(projectRoot, '.steam-experience-sync/config.json')), 'nxapi-private-memory'),
      NXAPI_DEBUG_FILE: '0', NXAPI_SKIP_UPDATE_CHECK: '1',
      NXAPI_USER_AGENT: 'game-memories/0.2.1 (+https://github.com/YQM1989/game-memories)',
    };
    for (const key of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (process.env[key]) environment[key] = process.env[key];
    const output = await new Promise((resolve, reject) => {
      const child = (options.spawn || spawn)(process.execPath, [
        '--import', path.join(projectRoot, 'src/switch/nxapi-preload.mjs'),
        path.join(helper, 'node_modules/nxapi/bin/nxapi.js'), 'nso', 'album', '--json',
      ], { cwd: helper, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', stopped = false, expired = false, oversized = false;
      const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, options.timeoutMs || 180000);
      const poll = setInterval(async () => { try { if (await shouldStop()) { stopped = true; child.kill('SIGTERM'); } } catch {} }, 250);
      const take = (kind, chunk) => {
        if (kind === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
        if (stdout.length + stderr.length > 8 * 1024 * 1024) { oversized = true; child.kill('SIGTERM'); }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => take('out', chunk));
      child.stderr.on('data', (chunk) => take('err', chunk));
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timeout); clearInterval(poll); reject(new Error('无法启动应用自带的 Switch 客户端。')); });
      child.on('close', (code) => { clearTimeout(timeout); clearInterval(poll); resolve({ stdout, stderr, code, stopped, expired, oversized }); });
      // Only a pipe carries credentials; never command arguments or ordinary settings.
      child.stdin.end(JSON.stringify({ sessionToken: cache.sessionToken, cache: cache.nxapiCache || [] }));
    });
    let media;
    for (const line of output.stdout.split('\n')) {
      try {
        if (line.startsWith(CACHE_PREFIX)) {
          const next = JSON.parse(line.slice(CACHE_PREFIX.length));
          if (Array.isArray(next)) cache.nxapiCache = next;
        } else {
          const data = JSON.parse(line);
          if (Array.isArray(data?.media)) media = data.media;
        }
      } catch {}
    }
    if (output.stopped) return [];
    if (output.expired) throw new Error('相册读取超时，已停止后台客户端，请稍后重试。');
    if (output.oversized) throw new Error('相册客户端返回数据过大，已停止处理。');
    const diagnostics = output.stderr.split('\n').filter((line) => line.startsWith(DIAGNOSTIC_PREFIX)).flatMap((line) => {
      try {
        const data = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length));
        if (!SAFE_STAGES.has(data.stage)) return [];
        return [{ stage: data.stage, status: Number.isInteger(data.status) ? data.status : undefined, networkError: data.networkError === true, code: SAFE_CODES.has(data.code) ? data.code : undefined, retryAfterSeconds: Number.isFinite(data.retryAfterSeconds) && data.retryAfterSeconds > 0 && data.retryAfterSeconds < 86400 ? data.retryAfterSeconds : undefined }];
      } catch { return []; }
    });
    options.onDiagnostics?.(diagnostics);
    if (output.code !== 0 || !media) {
      if (/NintendoAccountSessionTokenExpiredError|NintendoAccountSessionTokenInvalidError/.test(output.stderr)) throw new Error('Nintendo 授权已过期或被撤销，请重新连接账号。');
      if (output.stderr.includes('RateLimitError')) { cache.cooldownUntil = now() + 15 * 60 * 1000; throw new Error('账号认证次数过多，已暂停请求，请稍后重试。'); }
      const failure = diagnostics.find((item) => item.networkError || item.status >= 400);
      if (failure?.status === 429) cache.cooldownUntil = now() + (failure.retryAfterSeconds || 900) * 1000;
      const message = failure?.networkError ? `${failure.stage}连接失败，请检查网络后重试。` : failure ? `${failure.stage}失败（HTTP ${failure.status}${failure.code ? `，${failure.code}` : ''}），未自动重试。` : '相册客户端未返回有效列表，未下载或写入笔记。';
      cache.lastAuthError = { message, at: new Date(now()).toISOString() };
      throw new Error(message);
    }
    cache.lastAlbumAt = new Date(now()).toISOString();
    delete cache.lastAuthError;
    return media;
  }
  return {
    credentials: cache,
    listMedia,
    async checkService() {
      requireAlbumConsent(config);
      await verifyBundledClient(projectRoot);
      if (!cache.sessionToken) return { ok: true, message: '应用自带的 Switch 客户端已就绪，请连接 Nintendo 账号。' };
      const media = await listMedia();
      return { ok: true, message: `账号与相册连接正常，当前相册 ${media.length} 条记录。` };
    },
    async completeLogin(callback, pending) {
      requireAlbumConsent(config);
      const code = validateCallback(callback, pending, now());
      let response;
      try {
        response = await (options.fetch || fetch)('https://accounts.nintendo.com/connect/1.0.0/api/session_token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NASDKAPI; Android' },
          body: new URLSearchParams({ client_id: CLIENT, session_token_code: code, session_token_code_verifier: pending.verifier }).toString(),
        });
      } catch { throw new Error('Nintendo 网页授权连接失败，请检查网络。'); }
      if (!response.ok) throw new Error(`Nintendo 网页授权失败（HTTP ${response.status}），请重新打开登录网页。`);
      const data = await response.json().catch(() => ({}));
      if (!data.session_token) throw new Error('Nintendo 未返回有效授权，未覆盖原登录信息。');
      for (const key of Object.keys(cache)) delete cache[key];
      cache.sessionToken = data.session_token;
      await listMedia();
      return { ok: true, message: 'Nintendo 账号已连接，可以一键同步游戏回忆。' };
    },
  };
}
