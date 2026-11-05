import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { TOOLS, type ToolContext } from "../lib/tools.server";
import { shift } from "../lib/dates";
import { dailyCap, isMockMode, spentToday } from "../lib/agent.server";
import { Chart, seriesFrom } from "../components/Chart";

type Sales = { totalSales: number; orderCount: number; averageOrderValue: number; currency: string; period: string; byDay: unknown[] };

/** Home calls the same read tools directly from code (no AI): fast and always exact. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;
  const ctx: ToolContext = { admin, shopId, runId: "home", seenIds: new Set() };
  const today = new Date().toISOString().slice(0, 10);
  const safe = <T,>(p: Promise<unknown>) =>
    p.then((v) => ({ ok: true as const, v: v as T })).catch((e: Error) => ({ ok: false as const, error: e.message }));
  const [sales, low, slow, pending] = await Promise.all([
    safe<Sales>(TOOLS.sales_summary.run(ctx, { from: shift(today, -6), to: today })),
    safe<{ count: number; threshold: number }>(TOOLS.low_stock.run(ctx, {})),
    safe<{ count: number; period: string }>(TOOLS.slow_movers.run(ctx, {})),
    db.proposal.count({ where: { shopId, status: "pending" } }),
  ]);
  return { sales, low, slow, pending, ai: { mock: isMockMode(), spent: await spentToday(shopId), cap: dailyCap() } };
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const todo: { text: string; href: string }[] = [];
  if (d.pending) todo.push({ text: `${d.pending} suggested action(s) waiting for your approval`, href: "/app/proposals" });
  if (d.low.ok && d.low.v.count)
    todo.push({ text: `${d.low.v.count} variant(s) at or below ${d.low.v.threshold} units`, href: `/app/ask?q=${encodeURIComponent("Which products are low on stock?")}` });
  if (d.slow.ok && d.slow.v.count)
    todo.push({ text: `${d.slow.v.count} product(s) selling slowly`, href: `/app/ask?q=${encodeURIComponent("Which products are slow movers?")}` });
  const errors = [d.sales, d.low, d.slow].flatMap((x) => (x.ok ? [] : [x.error]));

  return (
    <s-page heading="Store operations">
      <s-button slot="primary-action" variant="primary" href="/app/ask">
        Ask a question
      </s-button>
      {errors.length > 0 ? (
        <s-banner tone="critical" heading="Some data could not be loaded">
          <s-paragraph>{errors.join(" ")}</s-paragraph>
        </s-banner>
      ) : (
        <s-banner tone="success" heading="App is working">
          <s-paragraph>Figures below are read live from your store. Nothing changes without your approval.</s-paragraph>
        </s-banner>
      )}

      {d.sales.ok && (
        <s-section heading={`Last 7 days (${d.sales.v.period})`}>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
            <Metric label="Sales" value={`${d.sales.v.totalSales.toLocaleString()} ${d.sales.v.currency}`} />
            <Metric label="Orders" value={String(d.sales.v.orderCount)} />
            <Metric label="Average order" value={`${d.sales.v.averageOrderValue.toLocaleString()} ${d.sales.v.currency}`} />
          </s-grid>
          <Chart points={seriesFrom(d.sales.v)} title="Sales per day" />
        </s-section>
      )}

      <s-section heading="Needs your attention">
        {todo.length === 0 ? (
          <s-paragraph>Nothing right now.</s-paragraph>
        ) : (
          <s-unordered-list>
            {todo.map((t) => (
              <s-list-item key={t.text}>
                <s-link href={t.href}>{t.text}</s-link>
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-section heading="AI usage today" slot="aside">
        {d.ai.mock ? (
          <s-badge tone="caution">Demo mode — no AI key configured</s-badge>
        ) : (
          <s-text>{`$${d.ai.spent.toFixed(2)} of $${d.ai.cap.toFixed(2)} daily limit`}</s-text>
        )}
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
