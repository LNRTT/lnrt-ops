import { openReplayUrl } from "../shared/openreplay";

/** Structural interface: hosts install and own the optional OpenReplay tracker. */
export type OpenReplayTracker = {
  isActive(): boolean;
  getSessionURL(options?: { withCurrentTime?: boolean }): string | undefined;
};
type ReplayWindow = Window & { __lnrtOpsReplay?: () => string | undefined };

/** Connect an existing tracker. Does not start recording, identify a user or send data. */
export function connectOpenReplay(tracker: OpenReplayTracker, options: { projectUrl: string }): () => void {
  if (typeof window === "undefined") return () => {};
  const target = window as ReplayWindow;
  const getUrl = () => {
    try {
      return tracker.isActive() ? openReplayUrl(tracker.getSessionURL({ withCurrentTime: true }), options.projectUrl) : undefined;
    } catch { return undefined; }
  };
  target.__lnrtOpsReplay = getUrl;
  return () => { if (target.__lnrtOpsReplay === getUrl) delete target.__lnrtOpsReplay; };
}

/** For hosts with their own error reporter: spread into the error's context. */
export function getOpenReplayContext(): { openReplayUrl?: string } {
  try {
    const url = typeof window === "undefined" ? undefined : openReplayUrl((window as ReplayWindow).__lnrtOpsReplay?.());
    return url ? { openReplayUrl: url } : {};
  } catch { return {}; }
}

/** Conservative starting options: mask text and navigation metadata; omit other sensitive channels. */
export function openReplayPrivacyOptions() {
  const hideUrl = (raw: string): string => {
    try { return `${new URL(raw).origin}/[redacted]`; } catch { return "[redacted]"; }
  };
  return {
    privateMode: true,
    respectDoNotTrack: true,
    defaultInputMode: 2 as const,
    obscureTextEmails: true,
    obscureTextNumbers: true,
    obscureInputEmails: true,
    obscureInputNumbers: true,
    obscureInputDates: true,
    consoleMethods: [] as [],
    captureExceptions: false,
    captureIFrames: false,
    captureResourceTimings: false,
    capturePageRenderTimings: false,
    resourceNameSanitizer: hideUrl,
    urls: { urlSanitizer: hideUrl, titleSanitizer: () => "[redacted]" },
    network: {
      disabled: true, sessionTokenHeader: false, failuresOnly: true, captureInIframes: false,
      capturePayload: false, ignoreHeaders: true as const, sanitizer: (_data: unknown) => null,
    },
    canvas: { disableCanvas: true },
  };
}
