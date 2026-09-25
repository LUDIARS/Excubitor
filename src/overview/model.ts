/** Transport contract for the cached service overview. @implements SPEC-EX-SERVICE-OVERVIEW */
export type OverviewState = 'up' | 'partial' | 'down';
export interface OverviewComponent {
  code: string; name: string; state: OverviewState; observed: boolean;
  checked_at: number | null; version: string | null; startup: boolean | null;
  subdomain: string | null; frontend_url: string | null; disabled: boolean;
}
export interface OverviewService {
  code: string; name: string; state: OverviewState; observed: boolean;
  startup: boolean; versions: string[]; components: OverviewComponent[];
}
export interface OverviewSite {
  id: string; name: string; local: boolean; connected: boolean; stale: boolean;
  checked_at: number | null; services: OverviewService[];
}
export interface ServiceOverview {
  generated_at: number; stale_after_ms: number; sites: OverviewSite[];
}
/** Unknown observations never become a false all-green result. */
export function groupOverviewServices(rows: Array<OverviewComponent & { project: string }>): OverviewService[] {
  const groups = new Map<string, OverviewService>();
  for (const row of rows) {
    let group = groups.get(row.project);
    if (!group) {
      group = { code: row.project, name: row.project, state: 'down', observed: false, startup: false, versions: [], components: [] };
      groups.set(row.project, group);
    }
    group.components.push(row);
  }
  for (const group of groups.values()) {
    const active = group.components.filter(c => !c.disabled);
    const up = active.filter(c => c.observed && c.state === 'up').length;
    group.observed = active.length > 0 && active.every(c => c.observed);
    group.state = up === active.length && group.observed ? 'up' : up > 0 ? 'partial' : 'down';
    group.startup = active.some(c => c.startup === true);
    group.versions = [...new Set(group.components.flatMap(c => c.version ? [c.version] : []))];
    if (group.components.length === 1) group.name = group.components[0]!.name;
    else group.name = group.components.find(c => c.code === group.code)?.name ?? group.code;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
