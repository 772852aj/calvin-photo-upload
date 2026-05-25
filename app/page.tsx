"use client";

import { useCallback, useRef, useState } from "react";

const MAX_FILES = 500;
const CONCURRENCY = 3;

type FileStatus = "pending" | "uploading" | "done" | "error";

interface QueuedFile {
  id: string;
  file: File;
  progress: number;
  status: FileStatus;
  error?: string;
  thumb?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function uploadOne(
  qf: QueuedFile,
  guestName: string,
  onProgress: (p: number) => void,
): Promise<void> {
  const initRes = await fetch("/api/create-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: qf.file.name,
      mimeType: qf.file.type || "application/octet-stream",
      size: qf.file.size,
      guestName,
    }),
  });

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`Could not start upload: ${text.slice(0, 100)}`);
  }

  const { uploadUrl } = (await initRes.json()) as { uploadUrl: string };
  if (!uploadUrl) throw new Error("No upload URL");

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader(
      "Content-Type",
      qf.file.type || "application/octet-stream",
    );

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Upload failed (status ${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));

    xhr.send(qf.file);
  });
}

export default function HomePage() {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [guestName, setGuestName] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    setPageError(null);
    setAllDone(false);
    const list = Array.from(incoming);
    setFiles((prev) => {
      const remainingSlots = MAX_FILES - prev.length;
      if (remainingSlots <= 0) {
        setPageError(`You've reached the ${MAX_FILES} file limit per session.`);
        return prev;
      }
      const accepted = list.slice(0, remainingSlots);
      if (list.length > accepted.length) {
        setPageError(
          `Only added ${accepted.length} — limit is ${MAX_FILES} per session.`,
        );
      }
      const queued: QueuedFile[] = accepted.map((file) => {
        const id = `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`;
        let thumb: string | undefined;
        if (file.type.startsWith("image/")) {
          thumb = URL.createObjectURL(file);
        }
        return { id, file, progress: 0, status: "pending", thumb };
      });
      return [...prev, ...queued];
    });
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };

  const updateFile = (id: string, patch: Partial<QueuedFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const startUpload = async () => {
    if (isUploading) return;
    const pending = files.filter((f) => f.status === "pending" || f.status === "error");
    if (pending.length === 0) return;

    setIsUploading(true);
    setPageError(null);

    const queue = [...pending];
    let cursor = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const qf = queue[cursor++];
        if (!qf) break;
        updateFile(qf.id, { status: "uploading", progress: 0, error: undefined });
        try {
          await uploadOne(qf, guestName.trim(), (p) => {
            updateFile(qf.id, { progress: p });
          });
          updateFile(qf.id, { status: "done", progress: 1 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          updateFile(qf.id, { status: "error", error: msg });
        }
      }
    });

    await Promise.all(workers);
    setIsUploading(false);

    setFiles((curr) => {
      if (curr.length > 0 && curr.every((f) => f.status === "done")) {
        setAllDone(true);
      }
      return curr;
    });
  };

  const reset = () => {
    files.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb));
    setFiles([]);
    setAllDone(false);
    setPageError(null);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.thumb) URL.revokeObjectURL(target.thumb);
      return prev.filter((f) => f.id !== id);
    });
    setPageError(null);
  };

  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
  const uploadedBytes = files.reduce(
    (s, f) => s + f.file.size * (f.status === "done" ? 1 : f.progress),
    0,
  );
  const overallProgress = totalBytes > 0 ? uploadedBytes / totalBytes : 0;
  const showOverallBar = isUploading || (doneCount > 0 && doneCount < files.length);

  if (allDone) {
    return (
      <main className="page">
        <div className="arch-card thank-you">
          <WaveDeco />
          <span className="emoji">🌊🤙</span>
          <div className="title">Thanks for sharing!</div>
          <p className="body">
            {doneCount} {doneCount === 1 ? "memory" : "memories"} uploaded.
            <br />
            High five from Calvin!🖐️ 
          </p>
          <button className="again" onClick={reset}>
            Upload more
          </button>
        </div>
        <div className="footer">made with 💙 for Calvin&apos;s 1st birthday</div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="arch-card">
        <WaveDeco />
        <BannerOrFallback />

        <div className="action-block">
          <p className="action-head">Share your photos &amp; videos!</p>
          <p className="action-sub">
            Help us remember Calvin&apos;s big day — drop your pics &amp; clips below.
          </p>
        </div>

        <div className="tray">
          <input
            className="name-input"
            type="text"
            placeholder="Your name (optional)"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            maxLength={40}
            disabled={isUploading}
          />

          <div
            className={`drop-zone ${dropActive ? "active" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDropActive(true);
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
            }}
          >
            <span className="icon">📸</span>
            <div className="primary">Tap to choose photos &amp; videos</div>
            <div className="secondary">or drag &amp; drop them here</div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: "none" }}
              onChange={onPick}
            />
          </div>

          {files.length > 0 && (
            <>
              {showOverallBar && (
                <div className="overall-progress">
                  <div className="overall-progress-header">
                    <span>
                      {isUploading ? "Uploading" : "Uploaded"} {doneCount} of {files.length}
                    </span>
                    <span>{Math.round(overallProgress * 100)}%</span>
                  </div>
                  <div className="progress-bar overall-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.round(overallProgress * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              <ul className="file-list">
                {files.map((f) => {
                  const canRemove =
                    !isUploading && (f.status === "pending" || f.status === "error");
                  return (
                  <li key={f.id} className="file-item">
                    <div className="file-item-row">
                      {f.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="file-thumb" src={f.thumb} alt="" />
                      ) : (
                        <div className="file-thumb">
                          {f.file.type.startsWith("video/") ? "🎬" : "📄"}
                        </div>
                      )}
                      <div className="file-meta">
                        <div className="file-name">{f.file.name}</div>
                        <div className="file-size">{formatSize(f.file.size)}</div>
                      </div>
                      <div className={`file-status ${f.status}`}>
                        {f.status === "pending" && "ready to upload"}
                        {f.status === "uploading" && `${Math.round(f.progress * 100)}%`}
                        {f.status === "done" && "✓ done"}
                        {f.status === "error" && "✗ failed"}
                      </div>
                      {canRemove && (
                        <button
                          type="button"
                          className="remove-btn"
                          aria-label={`Remove ${f.file.name}`}
                          onClick={() => removeFile(f.id)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {(f.status === "uploading" || f.status === "done" || f.status === "error") && (
                      <div className="progress-bar">
                        <div
                          className={`progress-fill ${f.status === "done" ? "done" : ""} ${f.status === "error" ? "error" : ""}`}
                          style={{ width: `${Math.round(f.progress * 100)}%` }}
                        />
                      </div>
                    )}
                    {f.status === "error" && f.error && (
                      <div style={{ fontSize: 12, color: "#dc2626" }}>{f.error}</div>
                    )}
                  </li>
                  );
                })}
              </ul>

              <div className="summary">
                {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalBytes)}
                {doneCount > 0 && ` · ${doneCount} uploaded`}
                {errorCount > 0 && ` · ${errorCount} failed`}
              </div>
            </>
          )}

          {pageError && <div className="error-msg">{pageError}</div>}

          <button
            className="cta-button"
            onClick={startUpload}
            disabled={isUploading || files.length === 0 || files.every((f) => f.status === "done")}
          >
            {isUploading
              ? "Uploading…"
              : errorCount > 0
                ? `Retry ${errorCount} failed`
                : files.length === 0
                  ? "UPLOAD"
                  : `Upload ${files.filter((f) => f.status !== "done").length} file${files.filter((f) => f.status !== "done").length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      <div className="footer">made with 💙 for Calvin&apos;s 1st birthday</div>
    </main>
  );
}

function WaveDeco() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="wave-deco"
      src="/wave.png"
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}

function BannerOrFallback() {
  const [imgFailed, setImgFailed] = useState(false);

  if (imgFailed) {
    return (
      <div className="banner-fallback">
        <div className="welcome">welcome to</div>
        <div className="name">CALVIN&apos;S</div>
        <div className="occasion">FIRST BIRTHDAY</div>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="banner"
      src="/banner.png"
      alt="Welcome to Calvin's First Birthday"
      onError={() => setImgFailed(true)}
    />
  );
}
