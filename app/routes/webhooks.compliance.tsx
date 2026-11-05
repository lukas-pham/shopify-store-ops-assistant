import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory privacy webhooks (HMAC verified by authenticate.webhook).
 * The app never stores customer records: order notes are redacted before storage and no customer fields are queried,
 * so customers/data_request and customers/redact have nothing to return or delete.
 * shop/redact removes everything stored for the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    await db.$transaction([
      db.agentRun.deleteMany({ where: { shopId: shop } }),
      db.proposal.deleteMany({ where: { shopId: shop } }),
      db.auditLog.deleteMany({ where: { shopId: shop } }),
      db.aiCall.deleteMany({ where: { shopId: shop } }),
      db.shopSettings.deleteMany({ where: { shopId: shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }
  return new Response();
};
