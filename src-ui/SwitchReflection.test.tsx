import source from '../docs/switch-reflection-view.js?raw';
import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

async function fixture() {
  const frontmatter: Record<string, string> = { type: 'raw_switch_experience', platform: 'switch' };
  const file = { path: 'Switch/测试游戏.md' };
  const app = { metadataCache: { getFileCache: () => ({ frontmatter }) }, vault: { getAbstractFileByPath: () => file }, fileManager: { processFrontMatter: vi.fn(async (_file: unknown, update: (fm: Record<string, string>) => void) => update(frontmatter)) } };
  const render = async () => {
    const container = document.createElement('div'); document.body.append(container);
    const dv = { app, container, current: () => ({ file }), paragraph: (message: string) => { container.textContent = message; } };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('dv', 'input', source)(dv, { mediaId: 'nintendo-' + 'a'.repeat(64) });
    return container;
  };
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  return { app, frontmatter, render, key: 'switch_reflection_nintendo-' + 'a'.repeat(64) };
}

it('edits the right-hand memory without a page editor and persists only its property on blur', async () => {
  const f = await fixture(); const container = await f.render();
  const area = container.querySelector('textarea')!;
  fireEvent.input(area, { target: { value: '我的真实感想\n第二行' } });
  fireEvent.blur(area);
  await waitFor(() => expect(f.frontmatter[f.key]).toBe('我的真实感想\n第二行'));
  expect(f.frontmatter.type).toBe('raw_switch_experience');
  expect(container.textContent).toContain('已保存');
  expect((await f.render()).querySelector('textarea')!.value).toBe('我的真实感想\n第二行');
});

it('keeps unsaved drafts through rerender and prevents overwriting another edit', async () => {
  const f = await fixture(); const first = await f.render();
  fireEvent.input(first.querySelector('textarea')!, { target: { value: '尚未保存的输入' } });
  const next = await f.render();
  expect(next.querySelector('textarea')!.value).toBe('尚未保存的输入');
  f.frontmatter[f.key] = '其他位置保存的内容';
  fireEvent.click(next.querySelector('button')!);
  await waitFor(() => expect(next.textContent).toContain('保存未完成'));
  expect(f.frontmatter[f.key]).toBe('其他位置保存的内容');
  expect(next.querySelector('textarea')!.value).toBe('尚未保存的输入');
});
