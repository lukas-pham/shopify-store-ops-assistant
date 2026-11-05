import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ask, MAX_STEPS } from "../lib/agent.server";
import type { Answer, Step } from "../lib/agent.server";
import { Chart, seriesFrom } from "../components/Chart";

const EXAMPLES = ["How were sales in the last 7 days?", "What are my top 5 products this month?", "Which products are low on stock?", "Which products are slow movers? Suggest tagging them."];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const runs = await db.agentRun.findMany({ where: { shopId: session.shop }, orderBy: { createdAt: "desc" }, take: 10 });
  const proposals = await db.proposal.findMany({ where: { shopId: session.shop, runId: { in: runs.map((r) => r.id) } }, select: { id: true, runId: true, title: true, status: true } });
  return {
    maxSteps: MAX_STEPS,
    runs: runs.map((r) => ({
      id: r.id,
      question: r.question,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
      steps: r.steps as unknown as Step[],
      answer: r.answer as unknown as Answer | null,
      proposals: proposals.filter((p) => p.runId === r.id),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const question = String((await request.formData()).get("question") ?? "").trim();
  if (question.length < 3) return { error: "Type a question first." };
  const who = session.onlineAccessInfo?.associated_user?.email ?? "staff";
  const runId = await ask(admin, session.shop, who, question);
  return { runId };
};

export default function Ask() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [params] = useSearchParams();
  const [question, setQuestion] = useState(params.get("q") ?? "");
  const busy = fetcher.state !== "idle";
  const submit = (q: string) => fetcher.submit({ question: q }, { method: "POST" });

  return (
    <s-page heading="Ask about your store" inlineSize="large">
      <s-section>
        <s-stack gap="base">
          <s-text-area
            label="Your question"
            rows={2}
            value={question}
            error={fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined}
            details={`The assistant reads orders, products and inventory with ${d.maxSteps} steps at most. It can suggest changes but never makes them.`}
            onInput={(e) => setQuestion((e.currentTarget as unknown as { value: string }).value)}
          />
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" {...(busy ? { loading: true } : {})} onClick={() => submit(question)}>
              Ask
            </s-button>
            {EXAMPLES.map((q) => (
              <s-button key={q} variant="tertiary" disabled={busy} onClick={() => { setQuestion(q); submit(q); }}>
                {q}
              </s-button>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {busy && <s-banner tone="info">Reading your store data…</s-banner>}
      {d.runs.map((r) => (
        <RunCard key={r.id} run={r} />
      ))}
    </s-page>
  );
}

type Run = ReturnType<typeof useLoaderData<typeof loader>>["runs"][number];

function RunCard({ run }: { run: Run }) {
  const chartStep = run.answer?.chart ? run.steps.find((s) => s.n === run.answer!.chart!.sourceStep) : undefined;
  return (
    <s-section heading={run.question}>
      <s-stack gap="base">
        {run.status === "failed" && (
          <s-banner tone="critical" heading="No answer">
            <s-paragraph>{run.error}</s-paragraph>
            <s-paragraph>No numbers were guessed. Try again or ask a simpler question.</s-paragraph>
          </s-banner>
        )}
        {run.answer && (
          <>
            {run.status === "unverified" && (
              <s-banner tone="warning" heading="Some numbers could not be checked against your data">
                <s-unordered-list>
                  {run.answer.warnings.map((w) => (
                    <s-list-item key={w}>{w}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}
            <s-paragraph>{run.answer.text}</s-paragraph>
            {run.answer.figures.length > 0 && (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Figure</s-table-header>
                  <s-table-header format="numeric">Value</s-table-header>
                  <s-table-header>Period</s-table-header>
                  <s-table-header>Source</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {run.answer.figures.map((f, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>{f.label}</s-table-cell>
                      <s-table-cell>{`${f.value.toLocaleString()} ${f.unit}`}</s-table-cell>
                      <s-table-cell>{f.period}</s-table-cell>
                      <s-table-cell>{`Step ${f.sourceStep}`}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            {chartStep && <Chart points={seriesFrom(chartStep.data)} title={run.answer.chart!.title} kind={run.answer.chart!.kind} />}
          </>
        )}
        {run.proposals.length > 0 && (
          <s-banner tone="info" heading="Suggested actions — waiting for you">
            <s-unordered-list>
              {run.proposals.map((p) => (
                <s-list-item key={p.id}>{`${p.title} (${p.status})`}</s-list-item>
              ))}
            </s-unordered-list>
            <s-link href="/app/proposals">Review and approve</s-link>
          </s-banner>
        )}
        <details>
          <summary>{`How this was answered — ${run.steps.length} step(s)`}</summary>
          <s-ordered-list>
            {run.steps.map((s) => (
              <s-list-item key={s.n}>
                <s-text type="strong">{s.tool}</s-text> <s-text color="subdued">{JSON.stringify(s.input)}</s-text> → {s.summary}
              </s-list-item>
            ))}
          </s-ordered-list>
        </details>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
