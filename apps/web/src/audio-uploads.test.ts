import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviders } from '@openminutes/calendar';
import { LocalStorage, SettingsStore, type JobName, type JobPayloads } from '@openminutes/core';
import { audioFiles, eq, meetings } from '@openminutes/db';
import { createTestDatabase } from '@openminutes/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('audio uploads', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>;
  let storage: LocalStorage;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let queueFails = false;
  const sent: { name: JobName; payload: JobPayloads[JobName] }[] = [];
  const mp3 = Buffer.from('ID3a small audio fixture');
  const json = { 'content-type': 'application/json' };
  beforeAll(async () => {
    test = await createTestDatabase();
    storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'audio-uploads-')));
    const settings = new SettingsStore(test.db, 'a-long-enough-test-secret');
    app = createApp({
      db: test.db,
      storage,
      settings,
      secret: 'a-long-enough-test-secret',
      calendarProviders: createProviders(),
      version: '1',
      queue: {
        send: (name, payload) => {
          if (queueFails) return Promise.reject(new Error('Queue unavailable'));
          sent.push({ name, payload });
          return Promise.resolve();
        },
      },
    });
    const response = await app.request('/api/setup', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ password: 'correct horse battery' }),
    });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  });
  afterAll(async () => {
    await test.close();
    await rm(storage.root, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request('/api/audio-uploads' + path, {
      ...init,
      headers: new Headers([['cookie', cookie], ...new Headers(init.headers).entries()]),
    });
  const start = (id: string, files = [{ name: 'first.mp3', size: mp3.length }]) =>
    request('', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id, title: 'Uploaded meeting', files }),
    });
  const put = (id: string, index: number, body: Buffer = mp3) =>
    request(`/${id}/files/${index}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
  const finish = (id: string) => request(`/${id}/finish`, { method: 'POST', headers: json });

  it('requires authentication for starting, sending files, and finishing', async () => {
    const id = randomUUID();
    for (const [path, method] of [
      ['', 'POST'],
      [`/${id}/files/0`, 'PUT'],
      [`/${id}/finish`, 'POST'],
    ] as const) {
      expect(
        (await app.request('/api/audio-uploads' + path, { method, headers: json })).status,
      ).toBe(401);
    }
  });

  it('creates one meeting, preserves order, and makes retries idempotent', async () => {
    const id = randomUUID();
    const files = [
      { name: 'z-last-name.mp3', size: mp3.length },
      { name: 'a-first-name.mp3', size: mp3.length },
    ];
    expect((await start(id, files)).status).toBe(201);
    expect((await start(id, files)).status).toBe(200);
    expect((await finish(id)).status).toBe(409);
    expect((await put(id, 1)).status).toBe(200);
    expect((await put(id, 0)).status).toBe(200);
    expect((await put(id, 0)).status).toBe(200);
    expect((await finish(id)).status).toBe(202);
    expect((await finish(id)).status).toBe(200);
    const rows = await test.db.select().from(meetings).where(eq(meetings.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Uploaded meeting',
      platform: 'imported',
      status: 'ended',
    });
    const audio = await test.db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.meetingId, id))
      .orderBy(audioFiles.path);
    expect(audio.map((f) => f.path)).toEqual([
      `meetings/${id}/uploads/0000.mp3`,
      `meetings/${id}/uploads/0001.mp3`,
    ]);
    expect(await readFile(storage.absolutePath(audio[0]?.path ?? 'missing'))).toEqual(mp3);
    expect(
      sent.filter((job) => 'meetingId' in job.payload && job.payload.meetingId === id),
    ).toHaveLength(1);
    expect((await put(id, 0)).status).toBe(409);
    expect((await start(id, [{ name: 'changed.wav', size: 12 }])).status).toBe(409);
  });

  it('accepts exactly 10 MB per file and 100 MB per meeting, rejects one byte over', async () => {
    const exact = Array.from({ length: 10 }, (_, i) => ({ name: `${i}.mp3`, size: 10_000_000 }));
    expect((await start(randomUUID(), exact)).status).toBe(201);
    expect((await start(randomUUID(), [{ name: 'big.mp3', size: 10_000_001 }])).status).toBe(413);
    expect((await start(randomUUID(), [...exact, { name: 'extra.mp3', size: 1 }])).status).toBe(
      413,
    );
    const id = randomUUID();
    expect((await start(id, [{ name: 'exact.mp3', size: 10_000_000 }])).status).toBe(201);
    const bytes = Buffer.alloc(10_000_000);
    mp3.copy(bytes);
    expect((await put(id, 0, bytes)).status).toBe(200);
    expect((await put(id, 0, Buffer.concat([bytes, Buffer.from('x')]))).status).toBe(413);
  });

  it('rejects empty, unsupported, forged, and truncated files without accepting them', async () => {
    for (const files of [[], [{ name: 'x.exe', size: 20 }], [{ name: 'x.mp3', size: 0 }]]) {
      expect((await start(randomUUID(), files)).status).toBe(400);
    }
    const id = randomUUID();
    await start(id);
    expect(await put(id, 0, Buffer.alloc(mp3.length))).toHaveProperty('status', 422);
    expect(await put(id, 0, Buffer.from('ID3'))).toHaveProperty('status', 422);
    expect(await put(id, 2)).toHaveProperty('status', 404);
    expect((await finish(id)).status).toBe(409);
    expect((await put(id, 0)).status).toBe(200);
    expect((await finish(id)).status).toBe(202);
  });

  it('can retry finishing after the queue fails without losing files or creating another meeting', async () => {
    const id = randomUUID();
    await start(id);
    await put(id, 0);
    queueFails = true;
    try {
      expect((await finish(id)).status).toBe(503);
    } finally {
      queueFails = false;
    }
    expect((await finish(id)).status).toBe(202);
    expect(await test.db.select().from(meetings).where(eq(meetings.id, id))).toHaveLength(1);
  });

  it('canonicalizes uppercase IDs before deriving paths and queuing work', async () => {
    const id = randomUUID().toUpperCase();
    const response = await start(id);
    expect(await response.json()).toMatchObject({ id: id.toLowerCase() });
    expect((await put(id, 0)).status).toBe(200);
    expect((await finish(id)).status).toBe(202);
    const files = await test.db.select().from(audioFiles).where(eq(audioFiles.meetingId, id));
    expect(files[0]?.path).toContain(id.toLowerCase());
  });

  it('discards an unfinished meeting and its partial files, but protects finalized meetings', async () => {
    const id = randomUUID();
    await start(id);
    await put(id, 0);
    expect((await request(`/${id}`, { method: 'DELETE', headers: json })).status).toBe(200);
    expect(await test.db.select().from(meetings).where(eq(meetings.id, id))).toHaveLength(0);
    expect(await storage.exists(`meetings/${id}`)).toBe(false);
    const finished = randomUUID();
    await start(finished);
    await put(finished, 0);
    await finish(finished);
    expect((await request(`/${finished}`, { method: 'DELETE', headers: json })).status).toBe(409);
  });

  it('lists the total duration of all uploaded files', async () => {
    const id = randomUUID();
    await start(id, [
      { name: 'a.mp3', size: mp3.length },
      { name: 'b.mp3', size: mp3.length },
    ]);
    const files = await test.db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.meetingId, id))
      .orderBy(audioFiles.path);
    for (const [index, file] of files.entries())
      await test.db
        .update(audioFiles)
        .set({ durationMs: (index + 1) * 1000 })
        .where(eq(audioFiles.id, file.id));
    const response = await app.request('/api/meetings', { headers: { cookie } });
    const rows = (await response.json()) as { id: string; durationMs: number }[];
    expect(rows.find((row) => row.id === id)?.durationMs).toBe(3000);
  });

  it('accepts the RF64 WAV signature', async () => {
    const id = randomUUID();
    const body = Buffer.from('RF64____WAVEdata');
    await start(id, [{ name: 'recording.wav', size: body.length }]);
    expect((await put(id, 0, body)).status).toBe(200);
  });

  it('keeps the API responsive while more than a pool of uploads waits for network data', async () => {
    const id = randomUUID();
    await start(id);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const uploads = Array.from({ length: 12 }, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
        },
      });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        body,
        duplex: 'half',
      };
      return Promise.resolve(
        app.request(new Request(`http://localhost/api/audio-uploads/${id}/files/0`, init)),
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await Promise.race([
        app.request('/api/meetings', { headers: { cookie } }),
        new Promise<Response>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Upload streams blocked the API'));
          }, 2000);
        }),
      ]);
      expect(response.status).toBe(200);
    } finally {
      clearTimeout(timer);
      for (const controller of controllers) {
        controller.enqueue(mp3);
        controller.close();
      }
      await Promise.all(uploads);
    }
  });
});
