import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TYPES = new Map([['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.mp4', 'video']]);
const MAX_BYTES = 256 * 1024 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>!|]/g, '\\$&');
const safeName = (value) => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '未命名游戏';
const slash = (value) => value.split(path.sep).join('/');

export function hasGameIdentity(content, id) {
  const value = /^switch_game_id:\s*([^\n]+)$/m.exec(content)?.[1].trim();
  return value === id || value === JSON.stringify(id) || value === `'${id}'`;
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function vaultPath(vault, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error('笔记和附件目录必须是仓库内的相对路径。');
  const root = await fs.realpath(vault);
  const target = path.resolve(root, relative);
  const inside = (candidate) => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(target) || target === root) throw new Error('输出路径不能离开 Obsidian 仓库。');
  let parent = target;
  while (true) {
    try {
      if (!inside(await fs.realpath(parent))) throw new Error('输出路径的符号链接指向仓库外部。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      parent = path.dirname(parent);
    }
  }
  return target;
}

export function captureFromFilename(filename, timezone = '+08:00') {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}(?:[-_]|\.)/.exec(filename);
  if (!match || !/^[+-](?:0\d|1[0-4]):(?:00|15|30|45)$/.test(timezone)) return null;
  const [, year, month, day, hour, minute, second] = match;
  const calendar = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const date = new Date(calendar + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== calendar) return null;
  return calendar + timezone;
}

export async function scanAlbum(albumDir, options = {}) {
  if (!albumDir || !path.isAbsolute(albumDir)) throw new Error('请选择已经导出的相册绝对路径。');
  const root = await fs.realpath(albumDir);
  const items = [];
  const skipped = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (await options.shouldStop?.()) return;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      const kind = TYPES.get(path.extname(entry.name).toLowerCase());
      if (!entry.isFile() || !kind) continue;
      const capturedAt = captureFromFilename(entry.name, options.filenameTimezone);
      if (!capturedAt) { skipped.push({ file: slash(path.relative(root, file)), reason: '文件名没有有效拍摄日期' }); continue; }
      const info = await fs.stat(file);
      if (!info.size || info.size > MAX_BYTES) { skipped.push({ file: entry.name, reason: '文件为空或超过 256 MiB' }); continue; }
      const relativeDir = path.relative(root, directory);
      const folders = relativeDir.split(path.sep).filter((part) => part && part.toLowerCase() !== 'album' && !/^\d+$/.test(part));
      const gameName = folders.at(-1);
      const idMatch = /-([a-f\d]{32})(?:L)?(?:[-_.]|$)/i.exec(entry.name);
      const gameId = idMatch ? idMatch[1].toLowerCase() : gameName ? `local-${digest(gameName).slice(0, 20)}` : null;
      if (!gameId) { skipped.push({ file: entry.name, reason: '无法识别所属游戏，请先放入按游戏命名的文件夹' }); continue; }
      const hash = await hashFile(file);
      items.push({ id: `local-${hash}`, hash, gameId, game: gameName || `待确认游戏 ${gameId.slice(0, 8)}`, capturedAt, kind, sourceFile: file, originalName: entry.name });
    }
  }
  await walk(root);
  items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  return { items, skipped };
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('同步状态无法读取，请检查备份后恢复；未自动覆盖。'); }
}

export async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function copyVerified(source, target, hash) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.stat(target);
    if (await hashFile(target) !== hash) throw new Error('已有附件内容与导入记录不一致，未覆盖附件。');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${process.pid}.part`;
  try {
    await fs.copyFile(source, temporary, 1);
    if (await hashFile(temporary) !== hash) throw new Error('源文件在复制过程中发生变化，请重新导入。');
    // link fails if the destination appeared during the copy; never overwrite it.
    await fs.link(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

const hero = (game, cover) => `%% switch-hero:start %%\n${cover ? `![[${cover}]]\n\n` : ''}> [!switch-game] ${text(game.name)}\n> Nintendo Switch 2 · ${text(game.id)}${cover ? '' : ' · 尚未选择海报'}\n%% switch-hero:end %%`;

async function importCover(vault, config, gameId, source) {
  if (!path.isAbsolute(source)) throw new Error('海报必须使用本地图片的绝对路径。');
  const extension = path.extname(source).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(extension)) throw new Error('海报请选择本地 JPG 或 PNG 图片。');
  const info = await fs.stat(source);
  if (!info.isFile() || !info.size || info.size > 32 * 1024 * 1024) throw new Error('海报为空或超过 32 MiB。');
  const coverHash = await hashFile(source);
  const cover = `${config.attachmentDir}/${digest(gameId).slice(0, 20)}/cover-${coverHash}${extension}`;
  await copyVerified(source, await vaultPath(vault, cover), coverHash);
  return cover;
}

async function updatePresentations(vault, config, state, beforeWrite) {
  for (const game of Object.values(state.games)) {
    const override = config.games?.[game.id];
    if (!override) continue;
    const name = override.name?.trim() || game.name;
    const cover = override.coverFile ? await importCover(vault, config, game.id, override.coverFile) : game.cover;
    if (name === game.name && cover === game.cover) continue;
    const note = await vaultPath(vault, game.note);
    const before = await fs.readFile(note, 'utf8');
    if (!hasGameIdentity(before, game.id)) throw new Error('笔记的游戏标识已修改，未更新海报。');
    const after = before.replace(/^game: .*$/m, `game: ${JSON.stringify(name)}`)
      .replace(/%% switch-hero:start %%[\s\S]*?%% switch-hero:end %%/, hero({ ...game, name }, cover));
    if (after !== before) await writeNote(note, before, after, { beforeWrite });
    state.games[game.id] = { ...game, name, cover };
  }
}

function initialNote(game, cover) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  return `---\ntype: raw_switch_experience\nstatus: raw\ndomain: "我是谁"\ncreated: ${today}\nupdated: ${today}\ntags: []\nplatform: switch\ngame: ${JSON.stringify(game.name)}\nswitch_game_id: ${JSON.stringify(game.id)}\ncssclasses: switch-experience\n---\n\n${hero(game, cover)}\n`;
}

export function mediaCard(item, attachment, reflectionView) {
  const time = item.capturedAt.slice(11, 19);
  const reflection = reflectionView ? `> > [!switch-reflection] 我的感想\n> > \`\`\`dataviewjs\n> > await dv.view(${JSON.stringify(reflectionView)}, {mediaId: ${JSON.stringify(item.id)}});\n> > \`\`\`\n` : '> > [!switch-reflection] 我的感想\n> > 在 Obsidian 里写下这一刻的回忆。\n';
  return `%% switch-media:${item.id} %%\n> [!switch-memory] ${item.capturedAt.slice(0, 10)} ${time}\n> > [!switch-media] ${item.kind === 'video' ? '视频' : '截图'}\n> > ![[${attachment}]]\n>\n${reflection}`;
}

export function appendCard(content, item, attachment, reflectionView) {
  if (content.includes(`%% switch-media:${item.id} %%`) || content.includes(`%% switch-deleted:${item.id} `)) return content;
  const trashStart = content.indexOf('%% switch-trash:start %%');
  if (trashStart >= 0) {
    return appendCard(content.slice(0, trashStart), item, attachment, reflectionView).trimEnd() + '\n\n' + content.slice(trashStart);
  }
  const date = item.capturedAt.slice(0, 10);
  const heading = `## ${date}`;
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) return `${content.trimEnd()}\n\n${heading}\n\n${mediaCard(item, attachment, reflectionView)}`;
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  // Existing text is preserved, including earlier reflections and other dates.
  return `${lines.slice(0, end).join('\n').trimEnd()}\n\n${mediaCard(item, attachment, reflectionView)}\n${lines.slice(end).join('\n')}`;
}

export async function writeNote(file, before, after, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await options.beforeWrite?.(file);
  if (before === null) {
    await fs.writeFile(file, after, { flag: 'wx' });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, after, { flag: 'wx' });
    const current = await fs.readFile(file, 'utf8');
    if (current !== before) throw new Error('笔记正在被编辑，已停止写入；请保存笔记后重新同步。');
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function noteLocation(vault, directory, game, knownPath) {
  if (knownPath) return vaultPath(vault, knownPath);
  let relative = `${directory}/${safeName(game.name)}.md`;
  let file = await vaultPath(vault, relative);
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (!hasGameIdentity(existing, game.id)) {
      relative = `${directory}/${safeName(game.name)}-${digest(game.id).slice(0, 8)}.md`;
      file = await vaultPath(vault, relative);
      try {
        const candidate = await fs.readFile(file, 'utf8');
        if (!hasGameIdentity(candidate, game.id)) throw new Error('同名笔记存在，未覆盖，请检查游戏映射。');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

export async function archiveItems({ vault, config, items, state, saveState, shouldStop = async () => false, beforeWrite }) {
  vault = await fs.realpath(vault);
  await vaultPath(vault, config.experienceDir);
  await vaultPath(vault, config.attachmentDir);
  const result = { imported: 0, duplicates: 0, stopped: false };
  if (await shouldStop()) return { ...result, stopped: true };
  await updatePresentations(vault, config, state, beforeWrite);
  await saveState(state);
  for await (const item of items) {
    if (await shouldStop()) { result.stopped = true; break; }
    const override = config.games?.[item.gameId] || {};
    const game = { id: item.gameId, name: override.name?.trim() || item.game };
    if (state.media[item.id]) { result.duplicates++; continue; }
    const identical = Object.entries(state.media).find(([, record]) => record.hash === item.hash &&
      (item.source !== 'nintendo_album' || (record.gameId === game.id && record.capturedAt === item.capturedAt && record.kind === item.kind)));
    if (identical) {
      if (item.source === 'nintendo_album') {
        const [id, record] = identical;
        state.media[item.id] = { ...record, source: item.source, duplicateOf: record.duplicateOf || id, uploadedAt: item.uploadedAt, expiresAt: item.expiresAt };
        await saveState(state);
      }
      result.duplicates++;
      continue;
    }
    const extension = path.extname(item.sourceFile).toLowerCase();
    const attachment = `${config.attachmentDir}/${digest(game.id).slice(0, 20)}/${item.hash}${extension}`;
    const mediaFile = await vaultPath(vault, attachment);
    await copyVerified(item.sourceFile, mediaFile, item.hash);
    let cover = state.games[game.id]?.cover || '';
    if (override.coverFile && !cover) {
      cover = await importCover(vault, config, game.id, override.coverFile);
    }
    const note = await noteLocation(vault, config.experienceDir, game, state.games[game.id]?.note);
    let before = null;
    try { before = await fs.readFile(note, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before !== null && !hasGameIdentity(before, game.id)) throw new Error('笔记的游戏标识已修改，未追加素材。');
    let content = before ?? initialNote(game, cover);
    if (cover && content.includes('%% switch-hero:start %%')) {
      content = content.replace(/%% switch-hero:start %%[\s\S]*?%% switch-hero:end %%/, hero(game, cover));
    }
    const after = appendCard(content, item, attachment, config.reflectionView);
    if (before !== after) await writeNote(note, before, after, { beforeWrite });
    state.media[item.id] = { hash: item.hash, gameId: game.id, capturedAt: item.capturedAt, kind: item.kind, attachment, originalName: item.originalName, source: item.source || 'local_album', ...(item.source === 'nintendo_album' ? { uploadedAt: item.uploadedAt, expiresAt: item.expiresAt } : {}) };
    state.games[game.id] = { ...state.games[game.id], ...game, cover, note: slash(path.relative(vault, note)) };
    await saveState(state);
    result.imported++;
  }
  return result;
}
