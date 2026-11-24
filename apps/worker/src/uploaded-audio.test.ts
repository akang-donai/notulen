import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioStorage, LocalStorage } from '@openminutes/core';
import { audioFiles, eq, meetings } from '@openminutes/db';
import { createTestDatabase } from '@openminutes/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { processMeeting } from './process.js';
import { mergeAudio } from './merge-audio.js';
import { trimAudio } from './trim-audio.js';
import { probeDuration } from './probe-duration.js';

let test: Awaited<ReturnType<typeof createTestDatabase>>;
let storage: LocalStorage;
beforeAll(async () => {
  test = await createTestDatabase();
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'uploaded-audio-')));
});
afterAll(async () => {
  await test.close();
  await rm(storage.root, { recursive: true, force: true });
});

it('processes uploaded files in order and records their actual durations', async () => {
  const id = randomUUID();
  await test.db.insert(meetings).values({
    id,
    title: 'Upload',
    joinUrl: `upload://${id}`,
    platform: 'imported',
    status: 'ended',
  });
  await storage.ensureDirectory(`meetings/${id}/uploads`);
  for (const [index, ext] of ['wav', 'webm'].entries()) {
    const path = `meetings/${id}/uploads/000${index}.${ext}`;
    const args = [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${index + 1}`,
      '-ar',
      index ? '48000' : '16000',
    ];
    if (ext === 'webm')
      await writeFile(
        storage.absolutePath(path),
        execFileSync('ffmpeg', [...args, '-f', 'webm', 'pipe:1']),
      );
    else execFileSync('ffmpeg', [...args, storage.absolutePath(path)]);
    await test.db
      .insert(audioFiles)
      .values({ meetingId: id, path, codec: ext, size: await storage.size(path), durationMs: 0 });
  }
  let transcribedDuration = 0;
  await processMeeting(
    {
      db: test.db,
      loadStorage: () => Promise.resolve(new AudioStorage(storage)),
      mergeAudio,
      trimAudio,
      detectSilence: () => Promise.resolve([]),
      createRefiner: () => Promise.resolve(undefined),
      requestSummary: () => Promise.resolve(),
      createTranscriber: () =>
        Promise.resolve({
          transcribe: async ({ path }) => {
            transcribedDuration = await probeDuration(path);
            return [];
          },
          test: () => Promise.resolve({}),
        }),
    },
    id,
  );
  const [meeting] = await test.db.select().from(meetings).where(eq(meetings.id, id));
  expect(meeting?.status).toBe('transcribed');
  expect(transcribedDuration).toBeGreaterThan(2900);
  expect(transcribedDuration).toBeLessThan(3200);
  const files = await test.db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.meetingId, id))
    .orderBy(audioFiles.path);
  expect(files[0]?.durationMs).toBeGreaterThanOrEqual(1000);
  expect(files[1]?.durationMs).toBeGreaterThanOrEqual(2000);
  expect(await storage.exists(`meetings/${id}/merged.opus`)).toBe(true);
});
