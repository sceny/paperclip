// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { AiConnectionRunReconnect } from "./AiConnectionRunReconnect";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mocks }));
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => {
    credentialProps = props;
    return <div>Provider sign-in</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;
const account = (overrides: Partial<AiManagedConnectionSummary> = {}): AiManagedConnectionSummary => ({
  id: "failed-connection", grantId: "failed-grant", companyId: "company",
  provider: "anthropic", method: "subscription", name: "My Claude",
  ownership: "personal", ownerUserId: "owner", isDefault: true,
  status: "needs_attention", ...overrides,
});
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
async function mount(connections: AiManagedConnectionSummary[], connectionId?: string) {
  mocks.list.mockResolvedValue({ currentUserId: "owner", connections, canManageConnections: true });
  flushSync(() => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AiConnectionRunReconnect companyId="company" agentId="agent" provider="anthropic" connectionId={connectionId} />
  </QueryClientProvider>));
  await settle();
}
function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find(item => item.textContent === label);
}
beforeEach(() => {
  vi.clearAllMocks();
  credentialProps = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

it("reconnects the connection the failed run used, not the legacy login", async () => {
  await mount([account({ id: "default", isDefault: true }), account({ id: "used-by-run", name: "Team Claude", isDefault: false })], "used-by-run");
  flushSync(() => button("Reconnect Team Claude")!.click());
  await settle();
  expect(credentialProps).toMatchObject({ connectionId: "used-by-run", fixedMethod: true, initialMethod: "subscription" });
  credentialProps!.onComplete({ connectionId: "used-by-run", grantId: "failed-grant", method: "subscription" });
  await settle();
  expect(container.textContent).toContain("Connection renewed");
});

it("falls back to the personal default when the run carries no attribution", async () => {
  await mount([account()]);
  expect(button("Reconnect My Claude")).toBeDefined();
});

it("points to the connection settings when no account can be found", async () => {
  await mount([]);
  expect(container.textContent).toContain("choose Reconnect");
});

it("offers no reconnect for a connection that is already connected", async () => {
  await mount([account({ status: "connected" })], "failed-connection");
  expect(button("Reconnect My Claude")).toBeUndefined();
  expect(container.textContent).toContain("My Claude is connected.");
});
