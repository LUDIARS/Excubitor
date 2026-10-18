/** @implements SPEC-EX-PORT-PROVENANCE — declared endpoints and historical observations are distinct. */
export interface ServicePortView {
  port: number | null;
  observed_port: number | null;
  port_source: 'catalog' | 'observation' | 'none' | 'invalid_catalog';
  port_mismatch: boolean;
}

function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

/** Resolve once for both API display and ownership checks; never overwrite stored observations. */
export function servicePortView(row: { catalog_snapshot?: unknown; port?: unknown }): ServicePortView {
  const observed = validPort(row.port);
  let catalog = row.catalog_snapshot;
  if (typeof catalog === 'string') {
    try { catalog = JSON.parse(catalog) as unknown; }
    catch { return { port: null, observed_port: observed, port_source: 'invalid_catalog', port_mismatch: false }; }
  }
  if (catalog !== null && typeof catalog === 'object' && !Array.isArray(catalog) && Object.hasOwn(catalog, 'port')) {
    const value = (catalog as Record<string, unknown>).port;
    const declared = validPort(value);
    return { port: declared, observed_port: observed,
      port_source: value === null || declared !== null ? 'catalog' : 'invalid_catalog',
      port_mismatch: observed !== null && declared !== null && observed !== declared };
  }
  return { port: observed, observed_port: observed, port_source: observed === null ? 'none' : 'observation', port_mismatch: false };
}
