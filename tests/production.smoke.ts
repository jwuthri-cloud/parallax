import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test(
  "built Next server: effective preview headers, workspace isolation and file links",
  { timeout: 30000 },
  async () => {
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const temp = mkdtempSync(
      path.join(os.tmpdir(), "parallax-production-test-"),
    );
    mkdirSync(path.join(temp, "research"));
    const child = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PARALLAX_DATA_DIR: path.join(temp, "data"),
          PARALLAX_RESEARCH_ROOT: path.join(temp, "research"),
          PARALLAX_WORKSPACE_ID: "default",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    const base = `http://127.0.0.1:${port}`;
    async function json(url: string, body?: unknown, method = "POST") {
      const response = await fetch(
        base + url,
        body === undefined
          ? undefined
          : {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    }
    try {
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          if ((await fetch(base)).ok) {
            ready = true;
            break;
          }
        } catch {}
        if (child.exitCode !== null) break;
        await delay(100);
      }
      assert.ok(ready, output);
      const home = await fetch(base);
      assert.equal(home.headers.get("x-frame-options"), "DENY");
      assert.equal(
        home.headers.get("content-security-policy"),
        "frame-src 'self'",
      );
      await json("/api/workspace?workspaceId=default");
      const a = await json("/api/records?workspaceId=default", {
        kind: "note",
        title: "Fixture production A",
      });
      const b = await json("/api/records?workspaceId=default", {
        kind: "finding",
        title: "Fixture production B",
      });
      const html =
        "<h1>Fixture only</h1><script>document.body.dataset.ready='yes'</script>";
      const form = new FormData();
      form.append(
        "file",
        new Blob([html], { type: "text/html" }),
        "fixture.html",
      );
      form.append("recordId", a.id);
      const upload = await fetch(base + "/api/artifacts?workspaceId=default", {
        method: "POST",
        body: form,
      });
      assert.equal(upload.status, 201);
      const file = await upload.json();
      const preview = await fetch(
        base + `/api/artifacts/${file.id}?preview&workspaceId=default`,
      );
      assert.equal(preview.headers.get("x-frame-options"), "SAMEORIGIN");
      const policy = preview.headers.get("content-security-policy") || "";
      assert.match(policy, /sandbox allow-scripts/);
      assert.match(policy, /default-src 'none'/);
      assert.match(policy, /connect-src 'none'/);
      assert.match(policy, /frame-ancestors 'self'/);
      assert.doesNotMatch(policy, /allow-same-origin/);
      assert.equal(await preview.text(), html);
      const links = await json(
        `/api/artifacts/${file.id}?workspaceId=default`,
        { recordIds: [a.id, b.id], revision: file.revision },
        "PATCH",
      );
      assert.deepEqual(links.recordIds, [a.id, b.id]);
      const page = await json("/api/records?workspaceId=default", {
        kind: "note",
        title: "Fixture document with a local file",
        content: `[Open source artifact](/api/artifacts/${file.id}?workspaceId=default)`,
      });
      const files = await json("/api/artifacts?workspaceId=default");
      assert.deepEqual(
        files.find((entry: { id: string }) => entry.id === file.id).recordIds,
        [a.id, b.id, page.id],
      );
      const other = await json("/api/workspaces", {
        name: "Fixture production workspace",
      });
      assert.equal(
        (await json(`/api/workspace?workspaceId=${other.id}`)).records.length,
        0,
      );
      assert.equal(
        (
          await fetch(
            base + `/api/artifacts/${file.id}?preview&workspaceId=${other.id}`,
          )
        ).status,
        404,
      );
      assert.equal(
        (await fetch(base + `/api/records/${a.id}?workspaceId=${other.id}`))
          .status,
        404,
      );
      const privateRecord = await json(`/api/records?workspaceId=${other.id}`, {
        kind: "note",
        title: "Fixture isolated",
      });
      assert.equal(
        (
          await fetch(
            base + `/api/records/${privateRecord.id}?workspaceId=default`,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(base + "/api/workspace?workspaceId=default", {
            headers: { Origin: "null" },
          })
        ).status,
        403,
      );
    } finally {
      if (child.exitCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        await stopped;
      }
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
