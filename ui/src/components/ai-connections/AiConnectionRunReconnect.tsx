import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiProvider } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

/** Renews the AI connection a failed run used; the old `claude login` flow cannot do this. */
export function AiConnectionRunReconnect({
  companyId, agentId, provider, connectionId,
}: {
  companyId: string;
  agentId: string;
  provider: AiProvider;
  connectionId?: string;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
  });
  const connections = accounts.data?.connections ?? [];
  const target = connections.find((account) => account.id === connectionId)
    ?? connections.find((account) => account.provider === provider && account.isDefault && account.ownership === "personal" && account.ownerUserId === accounts.data?.currentUserId);
  if (done) return <p role="status" className="text-xs text-muted-foreground">Connection renewed. Tasks waiting on it restart by themselves.</p>;
  if (accounts.isPending) return null;
  if (!target) return <p className="text-xs text-muted-foreground">Open the agent's AI connection settings and choose Reconnect.</p>;
  if (target.status === "connected") return <p className="text-xs text-muted-foreground">{target.name} is connected.</p>;
  return (
    <>
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>Reconnect {target.name}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reconnect account</DialogTitle>
            <DialogDescription>Sign in again to restore this connection. Its agent access stays the same.</DialogDescription>
          </DialogHeader>
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={target.provider}
            initialMethod={target.method}
            fixedMethod
            connectionId={target.id}
            name={target.name}
            ownership={target.ownership}
            agentIds={[agentId]}
            allAgents={false}
            onCancel={() => setOpen(false)}
            onComplete={() => {
              void client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
              setOpen(false);
              setDone(true);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
