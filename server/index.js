import { startServer } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const { port, setupCode } = await startServer({ host, port: Number(process.env.PORT || 4317) });

console.log(`[acc] Meridian running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
if (setupCode) console.log(`[acc] First run: create your account in the browser with setup code ${setupCode}`);
