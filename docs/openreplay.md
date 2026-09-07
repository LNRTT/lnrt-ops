# OpenReplay integration

An authenticated OPS error detail shows **Přehrát průběh** on each stored event
that has a valid OpenReplay reference. The link opens that event's recording at
its error-time position. Events without a recording keep their existing UI.

OpenReplay runs as a separate service. This package provides the connection,
privacy starting options and the OPS link; it does not deploy OpenReplay, install
its tracker, start recording or grant access to its dashboard. Each application
uses its own OpenReplay project. Operators also need access to that project in
OpenReplay. A link may become unavailable when the recording expires.

## 1. Configure the trusted project in OPS

Add this option to the application's existing `defineOps` call:

```ts
openReplay: process.env.OPS_OPENREPLAY_PROJECT_URL
  ? { projectUrl: process.env.OPS_OPENREPLAY_PROJECT_URL }
  : undefined,
```

Set `OPS_OPENREPLAY_PROJECT_URL` to the HTTPS **dashboard project URL**, for
example `https://replay.example.com/42` or `https://app.openreplay.com/42`.
This is not the ingest endpoint or the project key. OPS accepts links only to
that exact origin and project, in the form `/42/session/<numeric-id>`. Only the
numeric `jumpto` position is retained from the query string. Authentication,
share tokens and fragments are discarded before storage. Invalid replay
metadata never prevents the original error from being stored.

Omitting the option disables replay links and discards the reserved
`context.openReplayUrl` field on browser ingest. No database migration is needed:
references use the existing error-event context. Links are revalidated at render
time, so changing the trusted project also hides old links to other projects.
Replay metadata is a browser-reported diagnostic hint, not verified identity.

## 2. Connect the application's tracker

Install the SDK **in the application** if it does not already use OpenReplay:

```sh
npm install @openreplay/tracker@18.1.5
```

The bridge uses only the public `isActive()` and `getSessionURL()` methods. Its
privacy options and TypeScript compatibility were verified with SDK 18.1.5.
Use a tracker version compatible with your OpenReplay server.

For Next.js, mount this optional client component in the application area where
recording is enabled. Keep it out of login, invitation, OPS and other sensitive
pages. `enabled` is the application's explicit recording decision. Set the three
public configuration values at build time; the project key is the SDK's public
ingestion identifier, never an OPS secret or dashboard API token.

```tsx
"use client";

import { useEffect } from "react";
import { connectOpenReplay, openReplayPrivacyOptions } from "@lnrt/ops/client";

export function OpsReplay({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY;
    const projectUrl = process.env.NEXT_PUBLIC_OPENREPLAY_PROJECT_URL;
    const ingestPoint = process.env.NEXT_PUBLIC_OPENREPLAY_INGEST_POINT;
    if (!enabled || !projectKey || !projectUrl || !ingestPoint) return;

    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const { default: Tracker } = await import("@openreplay/tracker");
      if (disposed) return;
      const tracker = new Tracker({
        projectKey,
        ingestPoint, // e.g. https://replay.example.com/ingest
        ...openReplayPrivacyOptions(),
      });
      const disconnect = connectOpenReplay(tracker, { projectUrl });
      cleanup = () => { disconnect(); tracker.stop(); };
      await tracker.start();
      if (disposed) cleanup();
    })().catch(() => { cleanup(); });

    return () => { disposed = true; cleanup(); };
  }, [enabled]);
  return null;
}
```

`NEXT_PUBLIC_OPENREPLAY_PROJECT_URL` must match the server's
`OPS_OPENREPLAY_PROJECT_URL`. The bridge does not call `setUserID`, read a tracker
session token, propagate headers or send data on its own. It reads the current
URL only when an error is being reported. Stopped/not-yet-started trackers and
tracker exceptions produce no replay reference. Disconnect on logout or when
disabling recording; stop the tracker as well, as shown above.

## 3. Attach the reference to error reports

Applications using `browserErrorScript()` need no reporter changes: its inline
script detects the bridge at error time, even if the bridge was connected later.
Keep the existing reporter mounted once; do not add a second reporter.

Applications with their own browser reporter can add:

```ts
import { getOpenReplayContext } from "@lnrt/ops/client";

// Inside the existing error handler, when constructing the report:
const context = { ...existingContext, ...getOpenReplayContext() };
// Send this context with the existing POST /ops/api/ingest payload.
```

This entry point contains no server or tracker dependency and can be bundled for
the browser. Do not cache the context at page startup: it belongs to a specific
error occurrence. Server-only exceptions receive no automatic replay reference;
explicit server correlation can supply a validated `openReplayUrl` in the
existing `captureError(ops, error, context)` call.

## Privacy starting options

`openReplayPrivacyOptions()` returns fresh constructor options with:

- Private mode enabled: text and navigation metadata, including referrers, are
  masked. This also masks ordinary UI labels, a deliberate diagnostic tradeoff.
- Form values ignored; email/number/date masking enabled.
- Network tracking disabled, payload/header capture disabled, and no session
  token header injected. Console and duplicate SDK exception capture are off.
- Iframe and canvas capture off; resource timing capture off. Page/resource URLs
  and titles receive conservative redaction functions as an additional layer.

This is a starting configuration, not a guarantee that arbitrary DOM attributes,
images or host-provided plugins contain no personal data. Inspect a test recording
before enabling a host application. Keep sensitive pages out of recording and
avoid adding other capture plugins without equivalent controls. SDK private mode
is **masking**, not complete removal of a DOM subtree. In SDK 18.1.5 it can take
precedence over hidden-element sanitizers; this package therefore does not promise
that a custom HTML marker alone excludes every byte of a sensitive block.

## Rollout and verification

1. Update the host to this OPS version; leave `openReplay` unset initially.
2. Configure a test OpenReplay project and enable the bridge only on preview.
3. Trigger a browser error while a recording is active. In authenticated OPS,
   verify that its event links to the correct recording and time position.
4. Stop the tracker and trigger another error: the error must remain visible
   without a replay link. Verify masked content in the OpenReplay recording.
5. Enable each application separately after its recording configuration is checked.

The integration tests cover the actual inline reporter → HTTP handler → Postgres
→ authenticated OPS view path, invalid origins/projects, disabled integration,
redaction, tracker failure and lifecycle cleanup. They do not require or modify a
live OpenReplay service. To disable the integration, unset the server option and
stop/unmount the host tracker; existing error data remains readable.

SDK references: [session URLs](https://docs.openreplay.com/en/sdk/methods/get-session-url/),
[privacy options](https://docs.openreplay.com/en/sdk/constructor/),
[data sanitization](https://docs.openreplay.com/en/sdk/sanitize-data/).

## Reproduce the SDK privacy check

Alongside `npm test`, this check executes the actual pinned SDK viewport emitter
with the current preset. It checks initial and SPA referrers, URL, title and
fragment, with a negative control proving that turning off private mode exposes
raw referrers. The tracker stays outside the package dependencies:

```sh
sdk_dir=$(mktemp -d)
npm pack @openreplay/tracker@18.1.5 --pack-destination "$sdk_dir"
tar -xzf "$sdk_dir/openreplay-tracker-18.1.5.tgz" -C "$sdk_dir"
npx tsx scripts/verify-openreplay-sdk.ts "$sdk_dir/package"
```
