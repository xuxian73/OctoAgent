import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderWorkspaces } from "../apps/web/src/workspaces.js";

// Uses an installed browser only; checks never download binaries or use the network.
// Opt in with CHROME_BIN=/path/to/chrome ./scripts/check.sh on a host allowing browser processes.
const browser = process.env.CHROME_BIN;
test(
  "real CSS hides ZIP controls from layout and focus; completion synchronizes workspace",
  {
    skip: browser
      ? false
      : "Install Chrome/Chromium or set CHROME_BIN for browser regression",
    timeout: 30000
  },
  async () => {
    const script = `
    let state = 'active', party = 'buyer', accepted = false, posts = 0;
    let finishCompletion;
    const milestone = (id) => ({ id, title: 'ZIP', version: 1, status: accepted ? 'accepted' : 'planned' });
    const contract = () => ({ id: 'c', status: state, version: 1, revision: 2, milestones: [milestone("m"), milestone("m2")], zipDeliveries: [], events: [], versions: [{ terms: { scope: '测试合同' } }] });
    window.fetch = async (url, init) => {
      let data;
      if (url === '/api/auth/me') data = { csrf: 'synthetic' };
      else if (init?.method === 'POST') { posts++; await new Promise(resolve => { finishCompletion = resolve; }); state = 'completed'; data = contract(); }
      else if (url === '/api/contracts') data = [contract()];
      else if (url.startsWith('/api/files')) data = [];
      else if (url.startsWith('/api/workspaces')) data = { ...contract(), party, actors: [], branches: {}, commits: [], permissions: [] };
      else data = contract();
      return { ok: true, json: async () => ({ ok: true, data }) };
    };
    const el = id => document.getElementById(id);
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const tick = () => new Promise(r => setTimeout(r, 20));
    const hidden = id => {
      const node = el(id);
      check(getComputedStyle(node).display === 'none', id + ' computed display');
      check(node.getClientRects().length === 0, id + ' layout');
      node.focus();
      check(document.activeElement !== node, id + ' keyboard focus');
    };
    const reload = async () => { el('load').click(); hidden('zip-complete'); await tick(); };
    try {
      await import('/workspaces.js');
      await tick();
      hidden('zip-complete');
      accepted = true; party = 'seller'; await reload(); hidden('zip-complete');
      party = 'buyer';
      for (state of ['paused', 'disputed', 'completed', 'pending_confirmation']) { await reload(); hidden('zip-complete'); }
      state = 'active'; await reload();
      check(getComputedStyle(el('zip-complete')).display === 'inline-flex', 'eligible completion visible');
      el('zip-complete').click(); el('zip-complete').click(); await tick();
      check(posts === 1, 'single completion request');
      el('file-milestone').value = 'm2';
      el('file-milestone').dispatchEvent(new Event('input', { bubbles: true }));
      hidden('zip-complete');
      await tick();
      check(el('zip-complete').disabled, 'completion stays disabled during milestone refresh');
      el('zip-complete').click();
      check(posts === 1, 'no duplicate while pending');
      finishCompletion(); await tick();
      check(el('file-milestone').value === 'm2', 'selected milestone preserved');
      check(el('status').textContent.includes('已完成'), 'parent status');
      check(el('contract').selectedOptions[0].textContent.includes('completed'), 'contract option');
      check(el('zip-review-status').textContent.includes('合同已完成'), 'success feedback');
      for (const id of ['zip-complete', 'zip-form', 'file-upload', 'authorization']) hidden(id);
      el('zip-complete').click(); await tick(); check(posts === 1, 'no repeat completion');
      await reload(); check(el('zip-review-status').textContent === '', 'no old feedback');
      state = 'active'; await reload();
      el('contract').dispatchEvent(new Event('input')); hidden('zip-complete'); hidden('file-upload');
      check(el('zip-review-status').textContent === '', 'switch clears feedback');
      document.body.dataset.result = 'passed';
    } catch (e) { document.body.dataset.result = String(e); }
  `;
    async function moduleUrl(path: string): Promise<string> {
      let source = await readFile(path, "utf8");
      for (const match of [...source.matchAll(/from "([^"]+)"/g)]) {
        const dependency = await moduleUrl(resolve(dirname(path), match[1]!));
        source = source.replace(match[0], `from "${dependency}"`);
      }
      return (
        "data:text/javascript;base64," + Buffer.from(source).toString("base64")
      );
    }
    const profile = await mkdtemp(join(tmpdir(), "zip-browser-"));
    try {
      const entry = await moduleUrl(resolve("dist/apps/web/src/workspaces.js"));
      const css = await readFile("apps/web/app.css", "utf8");
      const html = renderWorkspaces()
        .replace(/<link[^>]+>/g, "")
        .replace("</head>", `<style>${css}</style></head>`)
        .replace(
          '<script type="module" src="/workspaces.js"></script>',
          () =>
            `<script type="module">${script.replace(
              "/workspaces.js",
              entry
            )}</script>`
        );
      const page = join(profile, "test.html");
      await writeFile(page, html);
      const { stdout } = await promisify(execFile)(
        browser!,
        [
          "--headless",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-background-networking",
          `--user-data-dir=${profile}`,
          "--dump-dom",
          "--virtual-time-budget=5000",
          pathToFileURL(page).href
        ],
        { timeout: 20000, maxBuffer: 1024 * 1024 }
      );
      assert.match(stdout, /data-result="passed"/, stdout);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
);
