import { cookies } from "next/headers";
import { OpsView } from "./OpsView";
import type { OpsInstance } from "../server/config";

type SearchParams = Record<string, string | string[] | undefined>;

export type OpsPageProps = {
  ops: OpsInstance;
  params: Promise<{ path?: string[] }>;
  searchParams?: Promise<SearchParams>;
};

export async function OpsPage({ ops, params, searchParams }: OpsPageProps) {
  const [{ path = [] }, search] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as SearchParams),
  ]);
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
  return <OpsView ops={ops} path={path} search={search} cookieHeader={cookieHeader} />;
}
