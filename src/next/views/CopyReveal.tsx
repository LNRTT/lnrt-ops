"use client";

import { useEffect, useRef, useState } from "react";

/** Only the short-lived reveal reaches this client island. Never persist it. */
export function CopyReveal({ kind, value }: { kind: "password" | "link"; value: string }) {
  const text = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const label = kind === "link" ? "Sign-in link" : "New password";

  useEffect(() => {
    function fitValue() {
      const field = text.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + 2}px`;
    }
    fitValue();
    window.addEventListener("resize", fitValue);
    return () => window.removeEventListener("resize", fitValue);
  }, [value]);


  async function copy() {
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      // Manual selection remains useful on browsers that deny clipboard access.
      text.current?.focus();
      text.current?.select();
      setStatus("failed");
    }
  }

  return (
    <div className="ops-copy" data-openreplay-masked>
      <label className="ops-field" htmlFor="ops-reveal-value">
        <span>{label}</span>
        <textarea id="ops-reveal-value" ref={text} className="ops-reveal" value={value} readOnly
          rows={kind === "link" ? 3 : 2} spellCheck={false} autoComplete="off" autoCapitalize="none" />
      </label>
      <button type="button" onClick={copy} disabled={status === "copying"}>
        {status === "copying" ? "Copying…" : kind === "link" ? "Copy link" : "Copy password"}
      </button>
      <p className={status === "failed" ? "ops-error" : "ops-note"} role="status" aria-live="polite">
        {status === "copied" ? `${label} copied.` : status === "failed"
          ? "Could not copy automatically. Select the value above and use your device’s Copy command."
          : "You can also select and copy the value above."}
      </p>
    </div>
  );
}
