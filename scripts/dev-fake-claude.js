/**
 * Development only: runs the server with a scripted stand-in for the Claude API, so the chat and background
 * tasks can be clicked through without an API key or any request leaving the machine. Not part of the app build.
 *   ACC_DATA_DIR=./tmp-dev PORT=4399 node scripts/dev-fake-claude.js
 */
const { setClaudeClientForTests } = await import('../server/claude.js');
const { startServer } = await import('../server/app.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function reply(params) {
  const last = params.messages.at(-1);
  const background = params.system.startsWith('You are carrying out a background task');
  const turns = params.messages.filter((m) => m.role === 'assistant').length;
  const tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `fake_${++n}`, name, input }] });
  if (background) {
    if (turns === 0) return tool('report_progress', { percent: 15, step: 'Reading your usage data' });
    if (turns === 1) return tool('get_overview', {});
    if (turns === 2) return tool('report_progress', { percent: 55, step: 'Drafting the report' });
    if (turns === 3) return tool('report_progress', { percent: 85, step: 'Checking the figures' });
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '## Usage report (fake)\n\nThis result came from the development stand-in, not Claude.\n\n- **Spend:** from your connected tools\n- **Next step:** connect a real key' }] };
  }
  if (typeof last.content === 'string') return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, ...tool('list_tasks', { status: 'running' }).content] };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is what I found (development stand-in, not Claude):\n\n- **Weekly crawl** is about halfway and should finish in **about 10 minutes**, estimated from its progress.\n- Nothing looks stuck.\n\nWant me to start a background task to draft a report?' }] };
}

setClaudeClientForTests({
  beta: {
    messages: {
      async create() {
        await sleep(300);
        return {
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 600, output_tokens: 80 },
          content: [{ type: 'text', text: 'This summary came from the development stand-in, not Claude. Your connected tools and tasks are listed below.' }],
        };
      },
    },
  },
  messages: {
    stream(params, { signal } = {}) {
      const msg = reply(params);
      const handlers = {};
      return {
        on(ev, fn) { handlers[ev] = fn; return this; },
        async finalMessage() {
          await sleep(params.system.startsWith('You are carrying out a background task') ? 6000 : 400);
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          for (const b of msg.content) {
            if (b.type !== 'text') continue;
            for (const word of b.text.split(/(?<= )/)) {
              handlers.text?.(word, '');
              await sleep(25);
            }
          }
          return { model: 'claude-opus-5-5', usage: { input_tokens: 1200, output_tokens: 150 }, ...msg };
        },
      };
    },
  },
});

const { port, setupCode } = await startServer({ port: Number(process.env.PORT || 4399) });
console.log(`[acc] dev server with FAKE Claude at http://127.0.0.1:${port}${setupCode ? `/?setup=${setupCode}` : ''}`);
