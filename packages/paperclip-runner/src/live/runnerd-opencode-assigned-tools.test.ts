import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { codexSemanticToolSpecs, dynamicToolResponse } from "../drivers/codex/codex-driver-values.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const runner = defaultCapabilityRunnerdBinary();
const proxy = resolve("dist/cli/opencode-app-server-proxy.cjs");
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

it.skipIf(process.platform === "win32" || !existsSync(runner) || !existsSync(proxy))(
  "retains assigned discovery authority across Rust, the proxy, and HTTP MCP",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-opencode-assigned-"));
    const workspace = join(root, "workspace");
    const executable = join(root, "fake-opencode-server.mjs");
    await mkdir(workspace);
    await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), executable);
    await chmod(executable, 0o755);
    const operation = "paperclip_search_assigned_tools";
    const seen: string[] = [];
    const { transport } = createRunnerdCodexTransport({
      provider: "opencode", runnerBinary: runner, stateDirectory: join(root, "state"), sourceCodexHome: "",
      providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
      opencodeCommand: executable, opencodeCommandSha256: digest(executable),
      opencodeProxyPath: proxy, opencodeProxySha256: digest(proxy),
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "synthetic-fixture-key" },
    });
    transport.setServerRequestHandler(async request => {
      expect(request.method).toBe("item/tool/call");
      const tool = request.params.tool;
      expect([operation, "paperclip_finish"]).toContain(tool);
      seen.push(String(tool));
      return dynamicToolResponse(tool === operation ? { tools: [] } : "Accepted completion.");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await transport.request("thread/start", {
        cwd: workspace, model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        completionContract: { revision: "assigned-tools-v1", criterionIds: ["objective"] },
        dynamicTools: [{ name: operation, description: "Search assigned synthetic tools.", inputSchema: { type: "object" } }, ...codexSemanticToolSpecs()],
      });
      const completed = (async () => {
        for await (const notification of transport.notifications()) {
          if (notification.method === "turn/completed") return;
          if (notification.method === "turn/failed") throw new Error("Native OpenCode turn failed");
        }
        throw new Error("Native OpenCode notifications ended before completion");
      })();
      await transport.request("turn/start", { input: [{ type: "text", text: "Discover assigned synthetic tools." }] });
      await Promise.race([completed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native assigned-tool smoke timed out")), 20_000);
      })]);
      expect(seen).toEqual([operation, "paperclip_finish"]);
    } finally {
      if (timer) clearTimeout(timer);
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
