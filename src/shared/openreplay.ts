/** Canonical dashboard links only; never share/auth tokens or arbitrary navigation. */
export function openReplayUrl(input: unknown, projectUrl?: string): string | undefined {
  if (typeof input !== "string" || input.length > 2000 || /[\s\\]/.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const path = url.pathname.match(/^(\/(?:[A-Za-z0-9_-]+\/)*[0-9]+)\/session\/([0-9]{1,40})$/);
    if (!path) return undefined;
    if (projectUrl !== undefined) {
      const project = new URL(projectUrl);
      if (project.protocol !== "https:" || project.username || project.password || project.search || project.hash || /[\s\\]/.test(projectUrl)) return undefined;
      if (url.origin !== project.origin || path[1] !== project.pathname.replace(/\/$/, "")) return undefined;
    }
    const jump = url.searchParams.get("jumpto");
    return `${url.origin}${url.pathname}${jump && /^[0-9]{1,13}$/.test(jump) ? `?jumpto=${jump}` : ""}`;
  } catch { return undefined; }
}
