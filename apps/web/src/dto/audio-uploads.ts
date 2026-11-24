export const MAX_AUDIO_FILE_BYTES = 10_000_000;
export const MAX_AUDIO_MEETING_BYTES = 100_000_000;
export const MAX_AUDIO_FILES = 1000;
export const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.ogg,.webm';
export const AUDIO_UPLOAD_PENDING_MESSAGE =
  'Audio upload is waiting to be queued. Retry the upload to continue.';

export interface AudioUploadFile {
  name: string;
  size: number;
}
export interface AudioUploadInput {
  id: string;
  title: string;
  files: AudioUploadFile[];
}
export interface AudioUploadDto {
  id: string;
  status: string;
}

export const audioExtension = (name: string) =>
  /\.(mp3|wav|m4a|ogg|webm)$/i.exec(name)?.[1]?.toLowerCase();

export function audioUploadProblem(files: readonly AudioUploadFile[]): string | undefined {
  if (files.length === 0) return 'Choose at least one audio file.';
  if (files.length > MAX_AUDIO_FILES) return 'Choose no more than 1000 files.';
  for (const file of files) {
    if (!audioExtension(file.name)) return 'Choose MP3, WAV, M4A, OGG or WebM audio files.';
    if (file.size === 0) return `${file.name} is empty.`;
    if (file.size > MAX_AUDIO_FILE_BYTES) return `${file.name} exceeds 10 MB.`;
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_AUDIO_MEETING_BYTES)
    return 'The files exceed 100 MB in total.';
  return undefined;
}
