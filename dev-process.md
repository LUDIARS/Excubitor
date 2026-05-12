# Excubitor dev process

## Server (Hono, backend)

```bash
npm run dev
```

Listens on `EXCUBITOR_PORT` (default `17331`).

## Frontend (Vite + React)

```bash
cd frontend
npm install
npm run dev
```

Listens on port `17332`. Vite proxies `/api/*` → `http://localhost:17331`.

When running from an AI session, both are long-running — use Bash `run_in_background: true`.
