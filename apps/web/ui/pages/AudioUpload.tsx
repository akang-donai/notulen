import { useState, type SubmitEvent } from 'react';
import { AUDIO_ACCEPT, audioUploadProblem } from '../../src/dto/audio-uploads.js';
import { api, errorMessage } from '../api.js';
import { uploadChunks } from '../import/upload.js';
import { uuid } from '../uuid.js';
import '../import/import.css';
import './audio-upload.css';

export function AudioUpload() {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  // ponytail: retries retain this submission only while the page stays open; persist a draft if reload-resume is needed.
  const [id, setId] = useState(uuid);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string>();
  const problem = files.length ? audioUploadProblem(files) : undefined;
  const total = files.reduce((size, file) => size + file.size, 0);
  const locked = busy || started;

  function move(index: number, direction: number) {
    setFiles((current) => {
      const next = [...current];
      const file = next[index];
      const other = next[index + direction];
      if (file && other) {
        next[index] = other;
        next[index + direction] = file;
      }
      return next;
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !title.trim() || audioUploadProblem(files)) return;
    setBusy(true);
    setStarted(true);
    setError(undefined);
    setSent(0);
    try {
      const state = await api.audioUploadStart({
        id,
        title: title.trim(),
        files: files.map((file) => ({ name: file.name, size: file.size })),
      });
      if (state.status === 'uploading') {
        let complete = 0;
        for (const [index, file] of files.entries()) {
          await uploadChunks(file, file.size, {
            send: (_chunk, body) => api.audioUploadFile(id, index, body).then(() => undefined),
            onProgress: (bytes) => {
              setSent(complete + bytes);
            },
          });
          complete += file.size;
        }
      }
      setSent(total);
      await api.audioUploadFinish(id);
      window.location.hash = `#/meetings/${id}`;
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    try {
      await api.audioUploadDiscard(id);
      setId(uuid());
      setFiles([]);
      setTitle('');
      setStarted(false);
      setSent(0);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Upload audio</h1>
          <p className="lede">Create one meeting from recordings in the order below.</p>
        </div>
      </header>
      <form
        className="panel audio-upload import-stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Meeting title
          <input
            required
            maxLength={300}
            value={title}
            disabled={locked}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </label>
        <label>
          Audio files
          <input
            type="file"
            multiple
            accept={AUDIO_ACCEPT}
            disabled={locked}
            onChange={(event) => {
              const added = Array.from(event.target.files ?? []);
              setFiles((current) => [...current, ...added]);
              if (!title && added[0]) setTitle(added[0].name.replace(/\.[^.]+$/, '').slice(0, 300));
              setError(undefined);
              event.target.value = '';
            }}
          />
        </label>
        <p className="muted">
          MP3, WAV, M4A, OGG or WebM. Up to 10 MB per file, 100 MB per meeting.
        </p>
        {files.length > 0 && (
          <>
            <ol className="audio-upload-files">
              {files.map((file, index) => (
                <li key={`${index}-${file.name}`}>
                  <span className="audio-upload-name">
                    {file.name}{' '}
                    <small className="muted">({(file.size / 1_000_000).toFixed(2)} MB)</small>
                  </span>
                  <div className="head-actions">
                    <button
                      type="button"
                      aria-label={`Move ${file.name} up`}
                      disabled={locked || index === 0}
                      onClick={() => {
                        move(index, -1);
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${file.name} down`}
                      disabled={locked || index === files.length - 1}
                      onClick={() => {
                        move(index, 1);
                      }}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      disabled={locked}
                      onClick={() => {
                        setFiles((current) => current.filter((_file, i) => i !== index));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <p>{(total / 1_000_000).toFixed(2)} / 100 MB</p>
          </>
        )}
        {(problem || error) && (
          <p className="banner banner-error" role="alert">
            {problem ?? error}
          </p>
        )}
        {busy && (
          <div className="import-status" role="status">
            <progress aria-label="Audio upload progress" max={total || 1} value={sent} />
            <span>
              {sent === total
                ? 'Preparing your meeting…'
                : `Uploading ${Math.round((sent / total) * 100)}%…`}
            </span>
          </div>
        )}
        <div className="head-actions">
          <button
            className="primary"
            type="submit"
            disabled={busy || !!problem || files.length === 0 || !title.trim()}
          >
            {busy ? 'Uploading…' : started ? 'Retry upload' : 'Upload and transcribe'}
          </button>
          <a className="button" href="#/">
            Back to meetings
          </a>
          {started && !busy && sent < total && (
            <button
              type="button"
              onClick={() => {
                void discard();
              }}
            >
              Discard upload
            </button>
          )}
        </div>
      </form>
    </>
  );
}
