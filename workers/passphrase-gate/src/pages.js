/** @implements SPEC-PASSPHRASE-GATE (spec/feature/passphrase-gate.md) */
// 入場画面 (なまえ / あいことば) の HTML。外部依存なし。

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f4f5; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #18181b; color: #f4f4f5; } .card { background: #27272a; } input { background: #18181b; color: #f4f4f5; border-color: #52525b; } }
  .card { background: #fff; border-radius: 16px; padding: 32px 28px; width: min(92vw, 380px); box-shadow: 0 8px 30px rgba(0,0,0,.12); }
  h1 { font-size: 1.25rem; margin: 0 0 6px; }
  p.lead { margin: 0 0 20px; font-size: .9rem; opacity: .75; }
  label { display: block; font-size: .85rem; margin: 14px 0 6px; }
  input { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 10px 12px; border: 1px solid #d4d4d8; border-radius: 10px; }
  button { margin-top: 22px; width: 100%; font-size: 1rem; padding: 12px; border: 0; border-radius: 10px; background: #2563eb; color: #fff; cursor: pointer; }
  .error { margin: 0 0 8px; padding: 10px 12px; border-radius: 10px; background: #fee2e2; color: #991b1b; font-size: .9rem; }
`;

export function loginPage({ title, next, error, name = "" }) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><form class="card" method="post" action="/__gate/login" autocomplete="off">
<h1>${escapeHtml(title)}</h1>
<p class="lead">なまえと、案内されたあいことばを入力してください。</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="name">なまえ</label>
<input id="name" name="name" required maxlength="40" value="${escapeHtml(name)}" placeholder="表示名 (ニックネーム可)">
<label for="passphrase">あいことば</label>
<input id="passphrase" name="passphrase" type="password" required maxlength="128" autocomplete="off">
<button type="submit">はいる</button>
</form></body></html>`;
}

export function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      ...extraHeaders,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
