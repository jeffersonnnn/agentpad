"use client";

// Small, styled form primitives shared by the create form. No new dependencies: they wrap plain
// inputs and read their classes from the co-located create.module.css. Each field renders a label,
// an optional hint, the control, and an optional error line.

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "@/app/create/create.module.css";

// The token logo preview. The upload returns a public Pinata gateway URL, which is heavily rate-limited
// and often fails to load (a broken-image box). So we degrade gracefully: on error, retry the same CID
// on a second public gateway (ipfs.io); if that also fails, show a neutral placeholder instead of a
// broken image. Display-only — the stored/on-chain URL is unchanged.
function ipfsFallbacks(url: string): string[] {
  const m = url.match(/\/ipfs\/([A-Za-z0-9]+.*)$/);
  if (!m) return [url];
  const cid = m[1];
  const alts = [url, `https://ipfs.io/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`];
  return Array.from(new Set(alts)); // de-dupe if the source already is one of these
}

function Thumb({ src, alt }: { src: string; alt: string }) {
  const chain = ipfsFallbacks(src);
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  // Reset when the source changes (a new upload / paste).
  useEffect(() => {
    setIdx(0);
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <div className={styles.uploadThumbFallback} aria-label="Logo preview unavailable" title={src}>
        <span aria-hidden>🖼️</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={chain[idx]}
      alt={alt}
      className={styles.uploadThumb}
      referrerPolicy="no-referrer"
      loading="eager"
      onError={() => {
        if (idx < chain.length - 1) setIdx((i) => i + 1);
        else setFailed(true);
      }}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required ? <span className={styles.req} aria-hidden="true"> *</span> : null}
      </label>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {children}
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  invalid,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  inputMode?: "text" | "url" | "numeric" | "decimal";
  invalid?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      className={styles.input}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      autoComplete="off"
    />
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  maxLength,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      id={id}
      className={styles.textarea}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      maxLength={maxLength}
      disabled={disabled}
    />
  );
}

// Image upload: pick a file, pin it to IPFS via /api/upload, then show a thumbnail. `value` is the
// pinned gateway URL (also the form's `logo`). Optional: launch works with no image. A small "paste a
// URL" affordance covers creators who already host their logo.
export function ImageUpload({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState(false);

  async function upload(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("The image must be 5 MB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Upload failed.");
      onChange(data.url);
      setPasteMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (value) {
    return (
      <div className={styles.upload}>
        <div className={styles.uploadPreview}>
          <Thumb src={value} alt="Token logo preview" />
          <div className={styles.uploadPreviewMeta}>
            <span className={styles.uploadDone}>Logo uploaded</span>
            <div className={styles.uploadActions}>
              <button
                type="button"
                className={styles.uploadTextButton}
                onClick={() => inputRef.current?.click()}
                disabled={disabled || busy}
              >
                {busy ? "Uploading…" : "Replace"}
              </button>
              <button
                type="button"
                className={styles.uploadTextButton}
                onClick={() => {
                  onChange("");
                  setError(null);
                }}
                disabled={disabled || busy}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          disabled={disabled || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.upload}>
      {pasteMode ? (
        <input
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://…/logo.png"
          inputMode="url"
          disabled={disabled}
          autoComplete="off"
        />
      ) : (
        <button
          type="button"
          className={styles.uploadButton}
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy}
        >
          {busy ? (
            <>
              <span className={styles.uploadSpinner} aria-hidden="true" /> Uploading…
            </>
          ) : (
            "Choose an image"
          )}
        </button>
      )}
      <button
        type="button"
        className={styles.uploadTextButton}
        onClick={() => {
          setPasteMode((p) => !p);
          setError(null);
        }}
        disabled={disabled || busy}
      >
        {pasteMode ? "Upload a file instead" : "or paste a URL"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        disabled={disabled || busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}

export function Select<T extends string>({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      className={styles.select}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      disabled={disabled}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
