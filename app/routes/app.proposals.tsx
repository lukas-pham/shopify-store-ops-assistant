import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { audit, executeProposal } from "../lib/tools.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const proposals = await db.proposal.findMany({ where: { shopId: session.shop }, orderBy: { createdAt: "desc" }, take: 50 });
  return {
    proposals: proposals.map((p) => ({ ...p, preview: p.preview as { label: string; before: string; after: string }[] })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id"));
  const who = session.onlineAccessInfo?.associated_user?.email ?? "staff";
  if (form.get("intent") === "reject") {
    const r = await db.proposal.updateMany({ where: { id, shopId: session.shop, status: "pending" }, data: { status: "rejected", decidedBy: who, decidedAt: new Date() } });
    if (r.count) await audit(session.shop, who, "proposal.rejected", id, {});
    return { ok: true };
  }
  try {
    await executeProposal(admin, session.shop, id, who);
    return { ok: true, applied: id };
  } catch (err) {
    return { error: (err as Error).message, id };
  }
};

const TONE: Record<string, "info" | "success" | "critical" | "neutral" | "caution"> = {
  pending: "caution",
  applied: "success",
  failed: "critical",
  rejected: "neutral",
  approved: "info",
};

export default function Proposals() {
  const d = useLoaderData<typeof loader>();
  const pending = d.proposals.filter((p) => p.status === "pending");
  const done = d.proposals.filter((p) => p.status !== "pending");
  return (
    <s-page heading="Suggested actions">
      <s-paragraph>The assistant can only suggest. Open a suggestion to see exactly what will change, then approve or dismiss it.</s-paragraph>
      <s-section heading={`Waiting for you (${pending.length})`}>
        {pending.length === 0 ? <s-paragraph>No suggestions waiting.</s-paragraph> : pending.map((p) => <ProposalRow key={p.id} p={p} />)}
      </s-section>
      <s-section heading="Decided">
        {done.length === 0 ? (
          <s-paragraph>Nothing yet.</s-paragraph>
        ) : (
          <s-stack gap="small">
            {done.map((p) => (
              <s-stack key={p.id} direction="inline" gap="small" alignItems="center">
                <s-badge tone={TONE[p.status]}>{p.status}</s-badge>
                <s-text>{p.title}</s-text>
                {p.error && <s-text tone="critical">{p.error}</s-text>}
                <s-text color="subdued">{p.decidedBy ? `by ${p.decidedBy}` : ""}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

type P = ReturnType<typeof useLoaderData<typeof loader>>["proposals"][number];

function ProposalRow({ p }: { p: P }) {
  const fetcher = useFetcher<typeof action>();
  const modalId = `proposal-${p.id}`;
  const busy = fetcher.state !== "idle";
  const send = (intent: string) => fetcher.submit({ id: p.id, intent }, { method: "POST" });
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{p.title}</s-text>
          <s-badge tone="caution">Needs approval</s-badge>
        </s-stack>
        {p.reason && <s-text color="subdued">{`Why: ${p.reason}`}</s-text>}
        {fetcher.data && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" commandFor={modalId} command="--show">
            Review change
          </s-button>
          <s-button disabled={busy} onClick={() => send("reject")}>
            Dismiss
          </s-button>
        </s-stack>
      </s-stack>

      {/* Req 4.7: the exact change is shown in s-modal before approval */}
      <s-modal id={modalId} heading={p.title}>
        <s-stack gap="base">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Field</s-table-header>
              <s-table-header>Now</s-table-header>
              <s-table-header>After approval</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {p.preview.map((row) => (
                <s-table-row key={row.label}>
                  <s-table-cell>{row.label}</s-table-cell>
                  <s-table-cell>{row.before}</s-table-cell>
                  <s-table-cell>{row.after}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-paragraph>This will be recorded in the activity log with your name.</s-paragraph>
        </s-stack>
        <s-button slot="primary-action" variant="primary" commandFor={modalId} command="--hide" {...(busy ? { loading: true } : {})} onClick={() => send("approve")}>
          Approve and apply
        </s-button>
        <s-button slot="secondary-actions" commandFor={modalId} command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
