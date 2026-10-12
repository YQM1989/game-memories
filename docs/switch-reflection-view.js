/* Game Experience Sync: independent Switch reflection editor */
const mediaId = String(input?.mediaId || '');
const notePath = dv.current()?.file?.path;
const file = notePath && dv.app.vault.getAbstractFileByPath(notePath);
const metadata = file && dv.app.metadataCache.getFileCache(file)?.frontmatter;
const renderToken = {};
dv.container.__switchReflectionRender = renderToken;
const validId = (id) => /^(?:nintendo|local)-[a-f0-9]{64}$/.test(id);
const deletedPattern = /^%% switch-deleted:((?:nintendo|local)-[a-f0-9]{64}) ([^\r\n ]+) %%\r?$/gm;
const trashPattern = /^%% switch-trash:start %%\r?\n[\s\S]*?^%% switch-trash:end %%\r?\n?/gm;
const getCard = (content, id) => {
  const markers = content.split(`%% switch-media:${id} %%`).length - 1;
  if (markers !== 1) throw new Error('记录标识已改变，请重新打开笔记后操作。');
  const match = new RegExp(`^%% switch-media:${id} %%\\r?\\n(?:>[^\\n]*(?:\\n|$))+`, 'm').exec(content);
  if (!match || !match[0].includes('[!switch-memory]') || !match[0].includes('[!switch-media]')) throw new Error('记录格式已改变，未修改笔记。');
  return match[0];
};
const getDeleted = (content) => [...content.matchAll(deletedPattern)].map((match) => {
  const saved = JSON.parse(decodeURIComponent(match[2]));
  if (!validId(match[1]) || typeof saved.card !== 'string' || getCard(saved.card, match[1]) !== saved.card) throw new Error('删除记录不完整，请从备份恢复。');
  return { ...saved, id: match[1], marker: match[0] };
});
const footer = (view) => `%% switch-trash:start %%\n\`\`\`dataviewjs\nawait dv.view(${JSON.stringify(view)}, {recycleBin: true});\n\`\`\`\n%% switch-trash:end %%\n`;
const addFooter = (content, view) => content.includes('%% switch-trash:start %%') ? content : content + (content.endsWith('\n') ? '\n' : '\n\n') + footer(view);

if (!file || metadata?.type !== 'raw_switch_experience' || metadata?.platform !== 'switch' || (!input?.recycleBin && !validId(mediaId))) {
  dv.paragraph('感想编辑区域暂不可用，请重新打开这份 Switch 游戏笔记。');
} else if (input?.recycleBin) {
  try {
    const content = await dv.app.vault.read(file);
    if (dv.container.__switchReflectionRender !== renderToken) return;
    const deleted = getDeleted(content);
    dv.container.replaceChildren();
    if (deleted.length) {
      const details = document.createElement('details');
      details.className = 'switch-deleted-records';
      const summary = document.createElement('summary');
      summary.textContent = `已删除记录（${deleted.length} 条）`;
      details.append(summary);
      const hint = document.createElement('p');
      hint.textContent = '这些记录不再显示，同步也不会重新导入。附件和感想仍保留，可恢复。';
      details.append(hint);
      for (const record of deleted) {
        const row = document.createElement('div');
        row.className = 'switch-deleted-row';
        const label = document.createElement('span');
        label.textContent = record.title || '已删除的游戏回忆';
        const restore = document.createElement('button');
        restore.textContent = '恢复这条记录';
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        row.append(label, restore, status);
        details.append(row);
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          try {
            await dv.app.vault.process(file, (current) => {
              const saved = getDeleted(current).find((item) => item.id === record.id);
              if (!saved || saved.marker !== record.marker || current.includes(`%% switch-media:${record.id} %%`)) throw new Error('记录已在其他位置更新。');
              const after = current.replace(saved.marker + (current.includes(saved.marker + '\r\n') ? '\r\n' : '\n'), saved.card);
              return getDeleted(after).length ? after : after.replace(trashPattern, '');
            });
            status.textContent = '已恢复';
            row.remove();
            summary.textContent = `已删除记录（${details.querySelectorAll('.switch-deleted-row').length} 条）`;
            if (!details.querySelector('.switch-deleted-row')) details.remove();
          } catch { status.textContent = '恢复未完成，请检查同步冲突后重试。'; restore.disabled = false; }
        });
      }
      dv.container.replaceChildren(details);
    }
  } catch { dv.paragraph('已删除记录暂时无法读取，未修改笔记。'); }
} else {
  const key = 'switch_reflection_' + mediaId;
  const saved = typeof metadata[key] === 'string' ? metadata[key] : '';
  // Keep in-progress drafts across Dataview refreshes, without persistent browser storage.
  const drafts = dv.app.__switchReflectionDrafts || (dv.app.__switchReflectionDrafts = new Map());
  const draftKey = notePath + ':' + mediaId;
  let draft = drafts.get(draftKey);
  if (!draft || draft.value === draft.saved) draft = { value: saved, saved, focused: false, start: 0, end: 0 };
  drafts.set(draftKey, draft);
  const wrapper = document.createElement('div');
  wrapper.className = 'switch-reflection-editor';
  const area = document.createElement('textarea');
  area.className = 'switch-reflection-input';
  area.setAttribute('aria-label', '我的感想');
  area.placeholder = '点击这里，写下这一刻的回忆…';
  area.value = draft.value;
  const toolbar = document.createElement('div');
  toolbar.className = 'switch-reflection-tools';
  const save = document.createElement('button');
  save.textContent = '保存感想';
  const remove = document.createElement('button');
  remove.textContent = '删除这条记录';
  remove.className = 'switch-delete-record';
  remove.style.color = 'var(--text-error)';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.textContent = draft.value === draft.saved ? '离开输入框自动保存' : '尚未保存';
  const confirmation = document.createElement('div');
  confirmation.className = 'switch-delete-confirmation';
  confirmation.hidden = true;
  const hint = document.createElement('p');
  hint.textContent = '删除这一条截图／视频及感想？可在笔记底部「已删除记录」恢复。';
  const confirm = document.createElement('button');
  confirm.textContent = '确认删除';
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  confirmation.append(hint, confirm, cancel);
  toolbar.append(save, remove, status);
  wrapper.append(area, toolbar, confirmation);
  dv.container.replaceChildren(wrapper);
  let saving = null;
  let acting = false;
  let expectedCard;
  async function commit() {
    if (saving) { if (!await saving) return false; return commit(); }
    if (area.value === draft.saved) { status.textContent = '已保存'; return true; }
    save.disabled = true;
    const value = area.value;
    saving = (async () => {
      try {
        await dv.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const current = typeof frontmatter[key] === 'string' ? frontmatter[key] : '';
          if (current !== draft.saved) throw new Error('这条感想已在其他位置更新。');
          frontmatter[key] = value;
          frontmatter.updated = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        });
        draft.saved = value;
        status.textContent = draft.value === value ? '已保存' : '尚未保存';
        return true;
      } catch {
        status.textContent = '保存未完成，输入内容仍保留；请检查同步冲突或重新打开笔记。';
        return false;
      }
    })();
    try { return await saving; } finally { saving = null; save.disabled = acting; }
  }
  area.addEventListener('input', () => {
    draft.value = area.value; draft.start = area.selectionStart; draft.end = area.selectionEnd;
    draft.focused = true; draft.lastInput = Date.now(); status.textContent = '尚未保存';
  });
  area.addEventListener('focus', () => { draft.focused = true; });
  area.addEventListener('blur', () => { draft.focused = false; if (!acting) commit(); });
  area.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
  });
  save.addEventListener('click', commit);
  // Clicking delete should not trigger a separate blur-save that rebuilds the confirmation.
  for (const button of [remove, confirm, cancel]) button.addEventListener('mousedown', (event) => event.preventDefault());
  remove.addEventListener('click', async () => {
    try {
      expectedCard = getCard(await dv.app.vault.read(file), mediaId);
      confirmation.hidden = false;
      remove.disabled = true;
    } catch { status.textContent = '记录暂不可删除，请重新打开笔记。'; }
  });
  cancel.addEventListener('click', () => { confirmation.hidden = true; remove.disabled = false; });
  confirm.addEventListener('click', async () => {
    if (acting || !expectedCard) return;
    acting = true;
    confirm.disabled = true; save.disabled = true; area.disabled = true;
    draft.focused = false;
    try {
      if (!await commit()) throw new Error('感想未保存。');
      await dv.app.vault.process(file, (current) => {
        const card = getCard(current, mediaId);
        if (card !== expectedCard || getDeleted(current).some((item) => item.id === mediaId)) throw new Error('记录已改变。');
        const view = JSON.parse(/await dv\.view\(("(?:\\.|[^"\\])*")/.exec(card)?.[1] || 'null');
        if (typeof view !== 'string' || !view) throw new Error('组件位置无法确认。');
        const title = /\[!switch-memory\] ([^\r\n]+)/.exec(card)?.[1] || '';
        const record = encodeURIComponent(JSON.stringify({ card, title, deletedAt: new Date().toISOString() }));
        return addFooter(current.replace(card, `%% switch-deleted:${mediaId} ${record} %%\n`), view);
      });
      status.textContent = '已删除，可在笔记底部恢复';
      wrapper.closest('.callout[data-callout="switch-memory"]')?.remove();
    } catch {
      status.textContent = '删除未完成，记录与感想保留；请检查同步冲突后重试。';
      acting = false; confirm.disabled = false; save.disabled = false; area.disabled = false;
    }
  });
  if (draft.focused && Date.now() - (draft.lastInput || 0) < 5000) requestAnimationFrame(() => {
    if (area.isConnected) { area.focus(); area.setSelectionRange(draft.start, draft.end); }
  });
}
