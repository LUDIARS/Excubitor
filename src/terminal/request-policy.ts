/** The terminal tools must not become a proxy from an external MCP origin. @implements SPEC-TERMINAL-CONNECTIONS */
export function isLocalTerminalRequest(urlString: string, origin?: string): boolean {
  const url = new URL(urlString);
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!origin || origin === url.origin);
}
