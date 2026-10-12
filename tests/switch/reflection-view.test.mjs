import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { appendCard, archiveItems, hashFile } from '../../src/switch/archive.mjs';
import { runSwitchAction } from '../../src/switch/index.mjs';
import { writeGuiConfig } from '../../src/core/config-store.mjs';

const source = await fs.readFile(new URL('../../docs/switch-reflection-view.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('dv', 'input', 'document', 'requestAnimationFrame', source);
const id = 'nintendo-' + 'a'.repeat(64);
const secondId = 'nintendo-' + 'b'.repeat(64);
const view = 'Switch/_组件/switch-reflection';
const reflectionKey = 'switch_reflection_' + id;
const item = { id, capturedAt: '2026-10-07T12:31:14+08:00', kind: 'image' };
const header = `---\ntype: raw_switch_experience\nplatform: switch\nswitch_game_id: "0100abcd"\n${reflectionKey}: "已有的感想"\n---\n\n`;

function fixture() {
  const dom = new JSDOM('<main></main>');
  const file = { path: 'Switch/测试游戏.md' };
  let content = appendCard(header, item, 'Attachments/photo.jpg', view);
  content = appendCard(content, { ...item, id: secondId, capturedAt: '2026-10-08T12:31:14+08:00', kind: 'video' }, 'Attachments/video.mp4', view);
  const readMetadata = () => Object.fromEntries(content.split('---')[1].split('\n').filter((line) => line.includes(':')).map((line) => {
    const [key, ...parts] = line.split(':'); const raw = parts.join(':').trim();
    return [key, raw.startsWith('"') ? JSON.parse(raw) : raw];
  }));
  let beforeProcess;
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      read: async () => content,
      process: async (target, fn) => { assert.equal(target, file); beforeProcess?.(); content = fn(content); },
    },
    metadataCache: { getFileCache: () => ({ frontmatter: readMetadata() }) },
    fileManager: { processFrontMatter: async (target, fn) => {
      assert.equal(target, file);
      const before = readMetadata(); const after = { ...before }; fn(after);
      for (const [key, value] of Object.entries(after)) {
        if (value === before[key]) continue;
        const line = `${key}: ${JSON.stringify(value)}`;
        content = content.includes('\n' + key + ':') ? content.replace(new RegExp('^' + key + ':.*$', 'm'), line) : content.replace('\n---\n', '\n' + line + '\n---\n');
      }
    } },
  };
  async function render(input = { mediaId: id }, existingContainer) {
    const container = existingContainer || dom.window.document.createElement('div');
    dom.window.document.querySelector('main').append(container);
    const dv = { app, container, current: () => ({ file }), paragraph: (value) => { container.textContent = value; } };
    await execute(dv, input, dom.window.document, (fn) => fn());
    return container;
  }
  const button = (container, label) => [...container.querySelectorAll('button')].find((element) => element.textContent === label);
  async function click(container, label) {
    const target = button(container, label); assert.ok(target, label);
    target.click(); await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { dom, app, file, render, click, button, get content() { return content; }, set content(value) { content = value; }, set beforeProcess(fn) { beforeProcess = fn; }, metadata: readMetadata };
}

async function remove(f) {
  const container = await f.render();
  await f.click(container, '删除这条记录');
  await f.click(container, '确认删除');
  return container;
}

test('delete asks for confirmation, and cancel does not alter the record or reflection', async () => {
  const f = fixture(); const before = f.content; const container = await f.render();
  await f.click(container, '删除这条记录');
  assert.equal(container.querySelector('.switch-delete-confirmation').hidden, false);
  assert.equal(f.content, before);
  await f.click(container, '取消');
  assert.equal(container.querySelector('.switch-delete-confirmation').hidden, true);
  assert.equal(f.content, before);
});

test('delete preserves unsaved reflection and other cards, and restore brings back the original media', async () => {
  const f = fixture(); const container = await f.render();
  const area = container.querySelector('textarea');
  area.value = '**补写的感想**\n另一段 [[个人笔记]]';
  area.dispatchEvent(new f.dom.window.Event('input'));
  await f.click(container, '删除这条记录');
  await f.click(container, '确认删除');
  assert.equal(f.metadata()[reflectionKey], area.value);
  assert.ok(!f.content.includes(`%% switch-media:${id} %%`));
  assert.ok(f.content.includes(`%% switch-deleted:${id} `));
  assert.ok(f.content.includes(`%% switch-media:${secondId} %%`));
  assert.ok(f.content.includes('Attachments/video.mp4'));
  assert.ok(f.content.endsWith('%% switch-trash:end %%\n'));
  assert.equal(container.querySelector('[role="status"]').textContent, '已删除，可在笔记底部恢复');
  assert.equal(appendCard(f.content, item, 'Attachments/photo.jpg', view), f.content);
  const trash = await f.render({ recycleBin: true });
  assert.equal(trash.querySelector('summary').textContent, '已删除记录（1 条）');
  await f.click(trash, '恢复这条记录');
  assert.ok(f.content.includes(`%% switch-media:${id} %%`));
  assert.ok(f.content.includes('Attachments/photo.jpg'));
  assert.ok(!f.content.includes('%% switch-deleted:'));
  assert.ok(!f.content.includes('%% switch-trash:'));
  assert.equal(f.metadata()[reflectionKey], area.value);
});

test('new captures stay before the recycle bin and do not resurrect a deleted item', async () => {
  const f = fixture(); await remove(f);
  const newId = 'nintendo-' + 'c'.repeat(64);
  f.content = appendCard(f.content, { ...item, id: newId }, 'Attachments/new.jpg', view);
  assert.ok(f.content.indexOf(`%% switch-media:${newId} %%`) < f.content.indexOf('%% switch-trash:start %%'));
  assert.ok(!f.content.includes(`%% switch-media:${id} %%`));
  const trash = await f.render({ recycleBin: true });
  await f.click(trash, '恢复这条记录');
  assert.ok(f.content.includes(`%% switch-media:${newId} %%`));
});

test('video deletion and selective restore keep the other deleted record in the recycle bin', async () => {
  const f = fixture();
  f.content = f.content.replace('[!switch-media] 截图', '[!switch-media] 视频').replace('Attachments/photo.jpg', 'Attachments/first-video.mp4');
  await remove(f);
  const second = await f.render({ mediaId: secondId });
  await f.click(second, '删除这条记录');
  await f.click(second, '确认删除');
  const trash = await f.render({ recycleBin: true });
  assert.equal(trash.querySelector('summary').textContent, '已删除记录（2 条）');
  await f.click(trash, '恢复这条记录');
  assert.ok(f.content.includes('Attachments/first-video.mp4'));
  assert.ok(f.content.includes(`%% switch-media:${id} %%`));
  assert.ok(f.content.includes(`%% switch-deleted:${secondId} `));
  assert.ok(f.content.includes('%% switch-trash:start %%'));
  assert.equal(trash.querySelector('summary').textContent, '已删除记录（1 条）');
});

test('Dataview refreshes replace the same output instead of duplicating delete or restore controls', async () => {
  const f = fixture(); const editor = await f.render();
  await f.render({ mediaId: id }, editor);
  assert.equal(editor.querySelectorAll('.switch-reflection-editor').length, 1);
  await remove(f);
  const trash = await f.render({ recycleBin: true });
  await Promise.all([f.render({ recycleBin: true }, trash), f.render({ recycleBin: true }, trash)]);
  assert.equal(trash.querySelectorAll('.switch-deleted-records').length, 1);
  assert.equal(trash.querySelectorAll('button').length, 1);
});

test('concurrent edits and reflection conflicts abort deletion without overwriting user text', async () => {
  const f = fixture(); const container = await f.render();
  await f.click(container, '删除这条记录');
  f.beforeProcess = () => { f.content = f.content.replace('[!switch-memory] 2026-10-07', '[!switch-memory] 修改过的日期'); };
  await f.click(container, '确认删除');
  assert.ok(f.content.includes('修改过的日期'));
  assert.ok(f.content.includes(`%% switch-media:${id} %%`));
  assert.ok(!f.content.includes('%% switch-deleted:'));
  const second = fixture(); const controls = await second.render();
  const area = controls.querySelector('textarea'); area.value = '本地草稿';
  area.dispatchEvent(new second.dom.window.Event('input'));
  await second.click(controls, '删除这条记录');
  second.content = second.content.replace('"已有的感想"', '"其他设备的感想"');
  await second.click(controls, '确认删除');
  assert.equal(second.metadata()[reflectionKey], '其他设备的感想');
  assert.ok(second.content.includes(`%% switch-media:${id} %%`));
  assert.equal(area.value, '本地草稿');
});

test('repeat sync and new cloud upload aliases retain deletion, counts update, attachments remain recoverable', async (t) => {
  const f = fixture(); await remove(f);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-delete-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Switch'), { recursive: true });
  await fs.mkdir(path.join(vault, 'Attachments'), { recursive: true });
  const noteFile = path.join(vault, f.file.path);
  await fs.writeFile(noteFile, f.content);
  await fs.writeFile(path.join(vault, 'Attachments/photo.jpg'), 'image-content');
  const hash = await hashFile(path.join(vault, 'Attachments/photo.jpg'));
  const record = { hash, gameId: '0100abcd', capturedAt: item.capturedAt, kind: 'image', attachment: 'Attachments/photo.jpg' };
  const state = { version: 1, media: { [id]: record, [secondId]: { hash: 'other', gameId: '0100abcd' } }, games: { '0100abcd': { id: '0100abcd', name: '测试游戏', note: f.file.path } } };
  const alias = { ...item, id: 'nintendo-' + 'd'.repeat(64), hash, gameId: '0100abcd', source: 'nintendo_album', game: '测试游戏' };
  const config = { experienceDir: 'Switch', attachmentDir: 'Attachments', games: {}, reflectionView: view };
  assert.deepEqual(await archiveItems({ vault, config, items: [{ ...alias, id }, alias], state, saveState: async () => {} }), { imported: 0, duplicates: 2, stopped: false });
  assert.equal(state.media[alias.id].duplicateOf, id);
  assert.equal(await fs.readFile(noteFile, 'utf8'), f.content);
  assert.equal(await fs.readFile(path.join(vault, 'Attachments/photo.jpg'), 'utf8'), 'image-content');
  await fs.mkdir(path.join(vault, '.obsidian/switch-experience-sync'), { recursive: true });
  await fs.writeFile(path.join(vault, '.obsidian/switch-experience-sync/state.json'), JSON.stringify(state));
  await writeGuiConfig(root, { vaultDir: vault, switch: config });
  assert.equal((await runSwitchAction('status', {}, root)).imported, 1);
  const trash = await f.render({ recycleBin: true }); await f.click(trash, '恢复这条记录');
  await fs.writeFile(noteFile, f.content);
  assert.equal((await runSwitchAction('status', {}, root)).imported, 2);
});
