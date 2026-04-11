import { db, groupRoutersTable, groupSubgroupsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

export async function resolveRouterIds(
  directRouterIds: number[],
  groupIds: number[]
): Promise<number[]> {
  const seen = new Set<number>();
  const ordered: number[] = [];

  function addUnique(id: number) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  for (const id of directRouterIds) addUnique(id);

  const visited = new Set<number>();
  let pending = groupIds.filter((id) => !visited.has(id));

  while (pending.length > 0) {
    for (const id of pending) visited.add(id);

    const [routerLinks, subgroupLinks] = await Promise.all([
      db
        .select({ routerId: groupRoutersTable.routerId })
        .from(groupRoutersTable)
        .where(inArray(groupRoutersTable.groupId, pending)),
      db
        .select({ childGroupId: groupSubgroupsTable.childGroupId })
        .from(groupSubgroupsTable)
        .where(inArray(groupSubgroupsTable.parentGroupId, pending)),
    ]);

    for (const link of routerLinks) addUnique(link.routerId);

    pending = subgroupLinks
      .map((s) => s.childGroupId)
      .filter((id) => !visited.has(id));
  }

  return ordered;
}

export function buildExcelLookup(
  excelData: Record<string, string>[] | undefined
): Map<string, Record<string, string>> | null {
  if (!excelData || excelData.length === 0) return null;
  const lookup = new Map<string, Record<string, string>>();
  for (const row of excelData) {
    const ip = row["ROUTER_IP"]?.trim();
    const name = row["ROUTER_NAME"]?.trim();
    if (ip) lookup.set(`ip:${ip}`, row);
    if (name) lookup.set(`name:${name.toLowerCase()}`, row);
  }
  return lookup;
}

export function findExcelRow(
  router: { name: string; ipAddress: string },
  lookup: Map<string, Record<string, string>> | null,
  index: number,
  excelData?: Record<string, string>[]
): Record<string, string> {
  if (lookup) {
    const byIp = lookup.get(`ip:${router.ipAddress}`);
    if (byIp) return byIp;
    const byName = lookup.get(`name:${router.name.toLowerCase()}`);
    if (byName) return byName;
  }
  if (excelData && excelData.length > 0) {
    return excelData[index] ?? excelData[excelData.length - 1];
  }
  return {};
}

const SSH_CONCURRENCY = 10;

export async function runConcurrent<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = SSH_CONCURRENCY
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
