import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { audit } from "../lib/tools.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return db.shopSettings.upsert({ where: { shopId: session.shop }, create: { shopId: session.shop }, update: {} });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const num = (k: string) => Number(f.get(k));
  const values = { lowStockThreshold: num("lowStockThreshold"), slowMoverDays: num("slowMoverDays"), slowMoverMaxUnits: num("slowMoverMaxUnits") };
  const errors: Record<string, string> = {};
  if (!Number.isInteger(values.lowStockThreshold) || values.lowStockThreshold < 0 || values.lowStockThreshold > 10000) errors.lowStockThreshold = "Enter a whole number from 0 to 10,000.";
  if (!Number.isInteger(values.slowMoverDays) || values.slowMoverDays < 7 || values.slowMoverDays > 365) errors.slowMoverDays = "Enter a number of days from 7 to 365.";
  if (!Number.isInteger(values.slowMoverMaxUnits) || values.slowMoverMaxUnits < 0) errors.slowMoverMaxUnits = "Enter a whole number, 0 or more.";
  if (Object.keys(errors).length) return { errors };
  await db.shopSettings.upsert({ where: { shopId: session.shop }, create: { shopId: session.shop, ...values }, update: values });
  await audit(session.shop, session.onlineAccessInfo?.associated_user?.email ?? "staff", "settings.updated", "thresholds", values);
  return { saved: true };
};

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const r = useActionData<typeof action>();
  const errors: Record<string, string | undefined> = r && "errors" in r ? (r.errors ?? {}) : {};
  const saving = useNavigation().state === "submitting";
  return (
    <s-page heading="Thresholds">
      <Form method="post" data-save-bar data-discard-confirmation>
        <s-section heading="Low stock">
          {r && "saved" in r && !saving && <s-banner tone="success">Saved.</s-banner>}
          <s-number-field name="lowStockThreshold" label="Flag a variant when available stock is at or below" defaultValue={String(d.lowStockThreshold)} suffix="units" error={errors.lowStockThreshold} />
        </s-section>
        <s-section heading="Slow movers">
          <s-stack gap="base">
            <s-number-field name="slowMoverDays" label="Look back over" defaultValue={String(d.slowMoverDays)} suffix="days" error={errors.slowMoverDays} />
            <s-number-field name="slowMoverMaxUnits" label="Slow if it sold at most" defaultValue={String(d.slowMoverMaxUnits)} suffix="units" error={errors.slowMoverMaxUnits} />
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
