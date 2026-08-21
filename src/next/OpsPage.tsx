import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OpsView } from "./OpsView";
import type { OpsInstance } from "../server/config";

type SearchParams = Record<string, string | string[] | undefined>;

export type OpsPageProps = {
  ops: OpsInstance;
  params: Promise<{ path?: string[] }>;
  searchParams?: Promise<SearchParams>;
};

export async function OpsPage({ ops, params, searchParams }: OpsPageProps) {
  // Checked first, before reading anything else: an unconfigured gate must be
  // indistinguishable from a route that does not exist — a real 404, not a
  // 200 page whose body happens to say "Not found." An uptime check would
  // stay green and a crawler could index that page otherwise. OpsView keeps
  // its own copy of this guard as the belt-and-braces path for direct callers
  // and tests, but this is what makes the host's actual HTTP response honest.
  if (!ops.enabled()) notFound();

  const [{ path = [] }, search] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as SearchParams),
  ]);
  // Read the raw header directly rather than rebuilding it from Next's
  // `RequestCookies` (a Map, so a duplicate name keeps the *last* entry).
  // `handlers.ts` parses the raw `Cookie:` header and keeps the *first* —
  // browsers send the more specific path first, so re-serialising here could
  // make the page and the API disagree about which of two same-named cookies
  // is the live session.
  const cookieHeader = (await headers()).get("cookie") ?? "";
  return <OpsView ops={ops} path={path} search={search} cookieHeader={cookieHeader} />;
}
