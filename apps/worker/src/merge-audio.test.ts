import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeAudio } from './merge-audio.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tone = (path: string, seconds: number) =>
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-ac',
    '1',
    '-c:a',
    'libopus',
    '-f',
    'opus',
    path,
  ]);

const seconds = (path: string) =>
  Number.parseFloat(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      path,
    ]).toString(),
  );

describe.skipIf(!hasFfmpeg)('mergeAudio', () => {
  it('rejects truncated WAV data instead of publishing a shortened recording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openminutes-truncated-wav-'));
    try {
      const path = join(dir, 'broken.wav');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        path,
      ]);
      const wav = await readFile(path);
      await writeFile(path, wav.subarray(0, Math.floor(wav.length / 2)));
      await expect(mergeAudio([path], join(dir, 'merged.opus'), true)).rejects.toThrow();
      await expect(readFile(join(dir, 'merged.opus'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('normalizes mixed upload formats and sample rates without changing their order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openminutes-mixed-audio-'));
    try {
      const inputs = ['first.wav', 'second.mp3', 'third.m4a', 'fourth.ogg', 'fifth.webm'].map(
        (name) => join(dir, name),
      );
      for (const [index, input] of inputs.entries()) {
        if (index === 4) {
          await writeFile(
            input,
            execFileSync('ffmpeg', [
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=1500:duration=1',
              '-f',
              'webm',
              'pipe:1',
            ]),
          );
          continue;
        }
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${300 + index * 300}:duration=1`,
          '-ar',
          index % 2 ? '44100' : '16000',
          '-ac',
          index % 2 ? '2' : '1',
          input,
        ]);
      }
      const output = join(dir, 'merged.opus');
      await mergeAudio(inputs, output, true);
      expect(seconds(output)).toBeCloseTo(5, 0);
      // Rising tones independently prove the displayed file order survived normalization.
      const pcm = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        output,
        '-ar',
        '8000',
        '-ac',
        '1',
        '-f',
        's16le',
        '-',
      ]);
      const frequencies = inputs.map((_input, index) => {
        let crossings = 0;
        for (let sample = (index + 0.2) * 8000; sample < (index + 0.8) * 8000; sample++) {
          if (pcm.readInt16LE(sample * 2) < 0 && pcm.readInt16LE((sample + 1) * 2) >= 0)
            crossings++;
        }
        return crossings / 0.6;
      });
      frequencies.forEach((frequency, index) => {
        expect(Math.abs(frequency - (300 + index * 300))).toBeLessThan(15);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects corrupt audio rather than publishing a partial recording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openminutes-bad-audio-'));
    try {
      const input = join(dir, 'broken.wav');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(input, 'RIFFnot actually a recording'),
      );
      await expect(mergeAudio([input], join(dir, 'merged.opus'), true)).rejects.toThrow();
      await expect(readFile(join(dir, 'merged.opus'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('concatenates opus segments into one playable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openminutes-merge-test-'));
    const inputs = ['a.opus', 'b.opus', 'c.opus'].map((name) => join(dir, name));
    inputs.forEach((path, index) => tone(path, index + 1));

    const output = join(dir, 'merged.opus');
    await mergeAudio(inputs, output);

    expect(seconds(output)).toBeCloseTo(6, 0);
    expect((await readFile(output)).subarray(0, 4).toString()).toBe('OggS');
  });

  it('converts fragmented AAC in mp4 (iOS Safari) to opus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openminutes-merge-test-'));
    const input = join(dir, 'recording.m4a');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:a',
      'aac',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      input,
    ]);

    const output = join(dir, 'merged.opus');
    await mergeAudio([input], output);

    expect(seconds(output)).toBeCloseTo(3, 0);
    expect((await readFile(output)).subarray(0, 4).toString()).toBe('OggS');
  });
});
