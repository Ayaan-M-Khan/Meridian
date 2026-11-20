import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, requireAuth, issueSetupCode } from './auth.js';
import { apiRoutes } from './routes.js';
import { ingestHandler } from './ingest.js';
import { startScheduler } from './sync.js';
import { recoverRuns } from './runner.js';
import { bridgeHandler, setBridgeBase } from './engines.js';
import { HttpError } from './util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.ACC_TRUST_PROXY === '1') app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  app.use('/api/restore', express.json({ limit: '64mb' })); // backups can be large; everything else stays small
  app.use('/api', express.json({ limit: '256kb' }));

  // Browsers can't send a custom header cross-site without CORS preflight, which this server never grants.
  // Ingest and the MCP bridge authenticate with their own bearer tokens instead of the session cookie.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.path.startsWith('/ingest/') || req.path.startsWith('/bridge/')) return next();
    if (req.get('x-acc-request') !== '1') return next(new HttpError(403, 'Request blocked: missing app header.'));
    next();
  });

  authRoutes(app);
  app.post('/api/ingest/:id', ingestHandler);
  app.post('/api/bridge/:run', bridgeHandler);
  app.use('/api', requireAuth);
  apiRoutes(app);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use('/vendor/chart.js', express.static(path.join(root, 'node_modules/chart.js/dist'), { maxAge: '7d' }));
  // Fonts ship with the app, so opening it never contacts a font service (or tells one your IP address).
  app.use('/vendor/fonts/inter', express.static(path.join(root, 'node_modules/@fontsource-variable/inter/files'), { maxAge: '30d' }));
  app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));

  app.use((err, req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error('[acc]', err);
    const message =
      err.type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : status >= 500
          ? 'Something went wrong on the server. Check its console for details.'
          : err.message;
    res.status(status).json({ error: message });
  });
  return app;
}

let schedulerStarted = false;

/** Starts the HTTP server. Resolves with the bound port and, on first run, the one-time setup code. */
export function startServer({ host = '127.0.0.1', port = 4317 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      setBridgeBase(`http://127.0.0.1:${server.address().port}`);
      if (!schedulerStarted) {
        schedulerStarted = true;
        recoverRuns();
        startScheduler();
      }
      resolve({ port: server.address().port, setupCode: issueSetupCode(), close: () => server.close() });
    });
  });
}
