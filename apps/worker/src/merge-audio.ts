import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { runFfmpeg } from './ffmpeg.js';
import { probeDuration } from './probe-duration.js';

export type MergeAudio = (
  inputs: string[],
  output: string,
  normalize?: boolean,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Existing mergers return void; normalization adds measured durations.
) => Promise<void | { durationMs: number; fileDurationsMs: number[] }>;

const OPUS_EXTENSIONS = new Set(['.opus', '.webm', '.ogg']);

// Opus in webm or ogg is copied as is. Anything else (AAC in mp4 from iOS Safari, mp3) cannot be
// written into an opus file without converting it, so it is encoded to Opus.
const codecArgs = (inputs: string[]) =>
  inputs.every((path) => OPUS_EXTENSIONS.has(extname(path).toLowerCase()))
    ? ['-c', 'copy']
    : ['-c:a', 'libopus', '-b:a', '48k', '-ac', '1'];

const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

export const mergeAudio: MergeAudio = async (inputs, output, normalize = false) => {
  const dir = await mkdtemp(join(tmpdir(), 'openminutes-merge-'));
  const partial = join(dirname(output), '.merged.opus.part');
  const fileDurationsMs: number[] = [];
  try {
    if (normalize) {
      const normalized: string[] = [];
      for (const [index, input] of inputs.entries()) {
        const path = join(dir, `${index}.opus`);
        await runFfmpeg([
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-xerror',
          '-i',
          input,
          '-map',
          '0:a:0',
          '-vn',
          '-sn',
          '-dn',
          '-c:a',
          'libopus',
          '-b:a',
          '48k',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-threads',
          '2',
          '-f',
          'opus',
          path,
        ]);
        normalized.push(path);
        fileDurationsMs.push(await probeDuration(path));
      }
      inputs = normalized;
    }
    const list = join(dir, 'list.txt');
    await writeFile(list, inputs.map((path) => `file ${quote(path)}\n`).join(''));
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      ...codecArgs(inputs),
      '-f',
      'opus',
      partial,
    ]);
    await rename(partial, output);
    if (normalize) return { durationMs: await probeDuration(output), fileDurationsMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
};
