import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rows = await db.auditLog.findMany({ where: { shopId: session.shop }, orderBy: { createdAt: "desc" }, take: 200 });
  return { rows };
};

const LABEL: Record<string, string> = {
  "proposal.approved": "Approved",
  "proposal.applied": "Applied to store",
  "proposal.failed": "Failed",
  "proposal.rejected": "Dismissed",
  "settings.updated": "Thresholds changed",
};

export default function Log() {
  const { rows } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Activity log">
      <s-paragraph>Who approved what, and when. Entries cannot be edited.</s-paragraph>
      <s-section padding="none">
        {rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No activity yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header listSlot="primary">What</s-table-header>
              <s-table-header>Who</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{new Date(r.createdAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{LABEL[r.action] ?? r.action}</s-table-cell>
                  <s-table-cell>{r.actor}</s-table-cell>
                  <s-table-cell>{describe(r.details)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

function describe(details: unknown): string {
  const d = details as { title?: string; preview?: { label: string; before: string; after: string }[]; error?: string };
  if (d?.error) return d.error;
  const change = d?.preview?.map((p) => `${p.label}: ${p.before} → ${p.after}`).join("; ");
  return [d?.title, change].filter(Boolean).join(" — ") || "—";
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
