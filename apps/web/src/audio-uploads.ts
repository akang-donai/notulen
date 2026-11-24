import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import {
  matchesFormat,
  meetingFolder,
  recordingFormat,
  writeAtomically,
  type JobSender,
  type LocalStorage,
} from '@openminutes/core';
import { and, audioFiles, eq, meetings, sql, type Database } from '@openminutes/db';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  audioExtension,
  audioUploadProblem,
  AUDIO_UPLOAD_PENDING_MESSAGE as PENDING,
  MAX_AUDIO_FILE_BYTES,
  MAX_AUDIO_FILES,
  MAX_AUDIO_MEETING_BYTES,
  type AudioUploadDto,
} from './dto/audio-uploads.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const start = z.object({
  id: uuid,
  title: z.string().trim().min(1).max(300),
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        size: z.int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(MAX_AUDIO_FILES),
});
const indexSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_AUDIO_FILES - 1);

class UploadError extends Error {
  constructor(
    message: string,
    readonly status: 413 | 422,
  ) {
    super(message);
  }
}

function validHead(extension: string, head: Buffer): boolean {
  if (extension === 'wav')
    return (
      ['RIFF', 'RF64', 'RIFX'].includes(head.toString('ascii', 0, 4)) &&
      head.toString('ascii', 8, 12) === 'WAVE'
    );
  const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', webm: 'audio/webm' }[
    extension
  ];
  const format = mime && recordingFormat(mime);
  return !!format && matchesFormat(format, head);
}

export function audioUploadRoutes(deps: {
  db: Database;
  storage: LocalStorage;
  queue: JobSender;
}): Hono {
  const routes = new Hono();
  type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
  // Use the locking connection for all queries so concurrent uploads cannot exhaust the pool.
  const locked = <T>(id: string, action: (tx: Transaction) => Promise<T>) =>
    deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      return action(tx);
    });
  const find = async (tx: Pick<Database, 'select'>, id: string) =>
    (
      await tx
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, id), eq(meetings.joinUrl, `upload://${id}`)))
    )[0];
  const filesFor = (tx: Pick<Database, 'select'>, id: string) =>
    tx.select().from(audioFiles).where(eq(audioFiles.meetingId, id)).orderBy(audioFiles.path);

  routes.post('/', async (c) => {
    const body = start.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Provide a title and nonempty audio files.' }, 400);
    const { id, title, files } = body.data;
    const problem = audioUploadProblem(files);
    if (problem)
      return c.json(
        { error: problem },
        files.some((f) => f.size > MAX_AUDIO_FILE_BYTES) ||
          files.reduce((sum, f) => sum + f.size, 0) > MAX_AUDIO_MEETING_BYTES
          ? 413
          : 400,
      );
    const expected = files.map((file, i) => ({
      meetingId: id,
      path: `${meetingFolder(id)}/uploads/${String(i).padStart(4, '0')}.${audioExtension(file.name)}`,
      durationMs: 0,
      codec: audioExtension(file.name) ?? '',
      size: file.size,
    }));
    return locked(id, async (tx) => {
      const rows = await tx
        .insert(meetings)
        .values({
          id,
          title,
          titleEdited: true,
          platform: 'imported',
          joinUrl: `upload://${id}`,
          status: 'uploading',
          startedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      const created = rows.length > 0;
      if (created) await tx.insert(audioFiles).values(expected);
      if (!created) {
        const row = await find(tx, id);
        const actual = row && (await filesFor(tx, id));
        if (
          !row ||
          row.title !== title ||
          !actual ||
          actual.length !== expected.length ||
          actual.some(
            (file, i) => file.path !== expected[i]?.path || file.size !== expected[i].size,
          )
        )
          return c.json({ error: 'This upload ID belongs to a different submission.' }, 409);
      }
      return c.json<AudioUploadDto>(
        { id, status: created ? 'uploading' : ((await find(tx, id))?.status ?? 'uploading') },
        created ? 201 : 200,
      );
    });
  });

  routes.put('/:id/files/:index', async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    const index = indexSchema.safeParse(c.req.param('index'));
    if (!id.success || !index.success) return c.json({ error: 'Invalid upload file.' }, 400);
    if (!/^application\/octet-stream(;.*)?$/i.test(c.req.header('content-type') ?? ''))
      return c.json({ error: 'Send audio as application/octet-stream.' }, 415);
    const row = await find(deps.db, id.data);
    if (!row) return c.json({ error: 'Upload not found.' }, 404);
    if (row.status !== 'uploading') return c.json({ error: 'This upload is finished.' }, 409);
    const file = (await filesFor(deps.db, id.data))[index.data];
    if (!file) return c.json({ error: 'File not found.' }, 404);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'The audio file is empty.' }, 400);
    let size = 0;
    let head = Buffer.alloc(0);
    const check = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        done(
          size > file.size || size > MAX_AUDIO_FILE_BYTES
            ? new UploadError('The audio file exceeds its declared size or 10 MB.', 413)
            : null,
          chunk,
        );
      },
      flush(done) {
        done(
          size !== file.size || !validHead(file.codec, head)
            ? new UploadError('The audio is incomplete or does not match its format.', 422)
            : null,
        );
      },
    });
    const staged = `${meetingFolder(id.data)}/uploads/.${randomUUID()}.staged`;
    try {
      await writeAtomically(deps.storage, staged, (temporary) =>
        pipeline(
          Readable.fromWeb(body as WebStream<Uint8Array>),
          check,
          createWriteStream(temporary),
        ),
      );
      // Network reads hold no DB connection. Lock only to publish a complete file.
      return await locked(id.data, async (tx) => {
        const current = await find(tx, id.data);
        if (!current) return c.json({ error: 'Upload not found.' }, 404);
        if (current.status !== 'uploading')
          return c.json({ error: 'This upload is finished.' }, 409);
        if ((await filesFor(tx, id.data))[index.data]?.id !== file.id)
          return c.json({ error: 'This upload has been replaced. Start again.' }, 409);
        await rename(deps.storage.absolutePath(staged), deps.storage.absolutePath(file.path));
        return c.json({ ok: true });
      });
    } catch (error) {
      if (error instanceof UploadError) return c.json({ error: error.message }, error.status);
      throw error;
    } finally {
      await deps.storage.remove(staged);
    }
  });

  routes.delete('/:id', async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid upload.' }, 400);
    return locked(id.data, async (tx) => {
      const row = await find(tx, id.data);
      if (!row) return c.json({ ok: true });
      if (row.status !== 'uploading') return c.json({ error: 'This upload is finished.' }, 409);
      await deps.storage.removeDirectory(meetingFolder(id.data));
      await tx.delete(meetings).where(eq(meetings.id, id.data));
      return c.json({ ok: true });
    });
  });

  routes.post('/:id/finish', async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid upload.' }, 400);
    const response = await locked(id.data, async (tx) => {
      const row = await find(tx, id.data);
      if (!row) return c.json({ error: 'Upload not found.' }, 404);
      if (row.status !== 'uploading' && !(row.status === 'ended' && row.error === PENDING))
        return c.json<AudioUploadDto>({ id: id.data, status: row.status });
      const files = await filesFor(tx, id.data);
      for (const file of files) {
        if (
          !(await deps.storage.exists(file.path)) ||
          (await deps.storage.size(file.path)) !== file.size
        )
          return c.json({ error: 'Some audio files are missing. Retry the upload.' }, 409);
      }
      if (files.length === 0) return c.json({ error: 'No audio files were uploaded.' }, 409);
      if (row.status === 'uploading') {
        await tx
          .update(meetings)
          .set({ status: 'ended', endedAt: new Date(), error: PENDING })
          .where(and(eq(meetings.id, id.data), eq(meetings.status, 'uploading')));
      }
      return null;
    });
    if (response) return response;
    // Commit files and status first. A stable pg-boss job ID makes concurrent retries harmless.
    try {
      await deps.queue.send('meeting.process', { meetingId: id.data }, { id: id.data });
    } catch {
      return c.json(
        { error: 'Processing could not be queued. Retry the upload to continue.' },
        503,
      );
    }
    await deps.db
      .update(meetings)
      .set({ error: null })
      .where(and(eq(meetings.id, id.data), eq(meetings.error, PENDING)));
    return c.json<AudioUploadDto>({ id: id.data, status: 'ended' }, 202);
  });
  return routes;
}
