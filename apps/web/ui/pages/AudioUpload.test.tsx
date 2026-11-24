// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioUpload } from './AudioUpload.js';

let container: HTMLDivElement;
let root: Root;
async function interact(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Plain HTTP exposes getRandomValues, but not randomUUID.
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await interact(() => {
    root.render(<AudioUpload />);
  });
});
afterEach(async () => {
  await interact(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((el) => el.textContent.trim() === label);
async function choose(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type=file]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await interact(() => {
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('lets users reorder and remove files before uploading one meeting', async () => {
  await choose([new File(['first'], 'first.mp3'), new File(['second'], 'second.wav')]);
  expect(container.querySelector('ol')?.textContent).toMatch(/first.mp3.*second.wav/);
  const up = container.querySelector<HTMLButtonElement>('button[aria-label="Move second.wav up"]');
  expect(up).not.toBeNull();
  await interact(() => {
    up?.click();
  });
  expect(container.querySelector('ol')?.textContent).toMatch(/second.wav.*first.mp3/);
  await interact(() => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove first.mp3"]')?.click();
  });
  expect(container.querySelector('ol')?.textContent).not.toContain('first.mp3');
  expect(button('Upload and transcribe')).toBeDefined();
});

it('blocks oversized files in the browser before making a request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const file = new File(['x'], 'too-big.mp3');
  Object.defineProperty(file, 'size', { value: 10_000_001 });
  await choose([file]);
  expect(container.querySelector('[role=alert]')?.textContent).toContain('10 MB');
  expect(button('Upload and transcribe')?.disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('retries a failed finalization using the same meeting ID without sending files again', async () => {
  let finishCalls = 0;
  let filesSent = 0;
  const ids: string[] = [];
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    if (path === '/api/audio-uploads') {
      if (typeof init.body !== 'string') throw new Error('Expected JSON body');
      const body = JSON.parse(init.body) as { id: string };
      ids.push(body.id);
      return new Response(
        JSON.stringify({ id: body.id, status: finishCalls ? 'ended' : 'uploading' }),
      );
    }
    if (path.includes('/files/')) {
      filesSent++;
      return new Response('{"ok":true}');
    }
    if (path.endsWith('/finish')) {
      finishCalls++;
      return new Response(
        finishCalls === 1
          ? '{"error":"Queue unavailable. Retry the upload."}'
          : JSON.stringify({ id: ids[0], status: 'ended' }),
        { status: finishCalls === 1 ? 503 : 202 },
      );
    }
    throw new Error('Unexpected request: ' + path);
  });
  await choose([new File(['audio'], 'meeting.mp3')]);
  await interact(() => {
    button('Upload and transcribe')?.click();
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Queue unavailable');
  await interact(() => {
    button('Retry upload')?.click();
  });
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(filesSent).toBe(1);
  expect(window.location.hash).toBe(`#/meetings/${ids[0]}`);
});
