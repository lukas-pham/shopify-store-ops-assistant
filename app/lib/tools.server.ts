import db from "../db.server";
import { ordersQuery, parsePeriod, periodLabel, shift } from "./dates";
import { redactPII } from "./pii";

/**
 * The ONLY ways the agent can touch Shopify (req 4.1, 4.2).
 * Each tool runs a fixed, pre-validated GraphQL operation (Admin API 2026-10). The model can only pick a tool
 * and fill typed arguments; it can never send its own GraphQL. Write tools only create Proposals.
 */

export interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface ToolContext {
  admin: AdminClient;
  shopId: string;
  runId: string;
  /** IDs seen in earlier tool results of this run; proposals may only reference these. */
  seenIds: Set<string>;
}

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}

// ---------- read helpers ----------
const MAX_ORDER_PAGES = 10; // 1,000 orders per question keeps cost and latency bounded

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
  note: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: { title: string; quantity: number; product: { id: string } | null }[] };
}

async function fetchOrders(admin: AdminClient, q: string) {
  const orders: OrderNode[] = [];
  let after: string | null = null;
  let currency = "";
  let truncated = false;
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    // No customer fields are requested (req 4.10).
    const d: {
      shop: { currencyCode: string };
      orders: { nodes: OrderNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await gql(
      admin,
      `#graphql
      query Orders($q: String!, $after: String) {
        shop { currencyCode ianaTimezone }
        orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
          nodes {
            id name createdAt displayFinancialStatus cancelledAt note
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) { nodes { title quantity product { id } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q, after },
    );
    currency = d.shop.currencyCode;
    orders.push(...d.orders.nodes);
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
    if (page === MAX_ORDER_PAGES - 1) truncated = true;
  }
  return { orders: orders.filter((o) => !o.cancelledAt), currency, truncated };
}

interface VariantRow {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  inventoryItemId: string;
  available: number;
  tags: string[];
}

async function fetchInventory(admin: AdminClient) {
  const rows: VariantRow[] = [];
  let after: string | null = null;
  let locations: { id: string; name: string; isActive: boolean }[] = [];
  for (let page = 0; page < 10; page++) {
    const d: {
      products: {
        nodes: {
          id: string;
          title: string;
          tags: string[];
          tracksInventory: boolean;
          variants: { nodes: { id: string; sku: string | null; title: string; inventoryQuantity: number | null; inventoryItem: { id: string } }[] };
        }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
      locations: { nodes: { id: string; name: string; isActive: boolean }[] };
    } = await gql(
      admin,
      `#graphql
      query Inventory($after: String) {
        products(first: 100, after: $after, query: "status:active") {
          nodes { id title tags totalInventory tracksInventory
            variants(first: 20) { nodes { id sku title inventoryQuantity inventoryItem { id } } } }
          pageInfo { hasNextPage endCursor }
        }
        locations(first: 10) { nodes { id name isActive } }
      }`,
      { after },
    );
    locations = d.locations.nodes;
    for (const p of d.products.nodes) {
      if (!p.tracksInventory) continue;
      for (const v of p.variants.nodes) {
        rows.push({
          productId: p.id,
          productTitle: p.title,
          variantId: v.id,
          variantTitle: v.title,
          sku: v.sku,
          inventoryItemId: v.inventoryItem.id,
          available: v.inventoryQuantity ?? 0,
          tags: p.tags,
        });
      }
    }
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return { rows, locations: locations.filter((l) => l.isActive) };
}

const settingsOf = (shopId: string) => db.shopSettings.upsert({ where: { shopId }, create: { shopId }, update: {} });

// ---------- tool implementations ----------
type Args = Record<string, unknown>;

export const TOOLS: Record<string, { description: string; schema: Record<string, unknown>; write?: boolean; run: (ctx: ToolContext, a: Args) => Promise<unknown> }> = {
  sales_summary: {
    description: "Total sales, order count and average order value for a date range, with a per-day breakdown. Cancelled orders excluded.",
    schema: { from: { type: "string", description: "YYYY-MM-DD inclusive" }, to: { type: "string", description: "YYYY-MM-DD inclusive" } },
    async run(ctx, a) {
      const p = parsePeriod(a.from, a.to);
      const { orders, currency, truncated } = await fetchOrders(ctx.admin, ordersQuery(p));
      const byDay = new Map<string, { sales: number; orders: number }>();
      for (let d = p.from; d <= p.to; d = shift(d, 1)) byDay.set(d, { sales: 0, orders: 0 });
      let total = 0;
      for (const o of orders) {
        const amt = Number(o.currentTotalPriceSet.shopMoney.amount);
        total += amt;
        const day = byDay.get(o.createdAt.slice(0, 10));
        if (day) {
          day.sales += amt;
          day.orders += 1;
        }
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        period: periodLabel(p),
        currency,
        orderCount: orders.length,
        totalSales: r2(total),
        averageOrderValue: orders.length ? r2(total / orders.length) : 0,
        byDay: [...byDay].map(([date, v]) => ({ date, sales: r2(v.sales), orders: v.orders })),
        note: truncated ? "Only the first 1,000 orders were counted." : "Orders older than 60 days need the read_all_orders scope.",
      };
    },
  },

  top_products: {
    description: "Products ranked by units sold in a date range.",
    schema: { from: { type: "string" }, to: { type: "string" }, limit: { type: "integer", description: "1-20" } },
    async run(ctx, a) {
      const p = parsePeriod(a.from, a.to);
      const limit = Math.min(20, Math.max(1, Number(a.limit) || 5));
      const { orders } = await fetchOrders(ctx.admin, ordersQuery(p));
      const units = new Map<string, { productId: string; title: string; units: number }>();
      for (const o of orders)
        for (const li of o.lineItems.nodes) {
          const key = li.product?.id ?? li.title;
          const cur = units.get(key) ?? { productId: li.product?.id ?? "", title: li.title, units: 0 };
          cur.units += li.quantity;
          units.set(key, cur);
        }
      const products = [...units.values()].sort((x, y) => y.units - x.units).slice(0, limit);
      products.forEach((x) => x.productId && ctx.seenIds.add(x.productId));
      return { period: periodLabel(p), products };
    },
  },

  list_orders: {
    description: "Recent orders in a date range (number, date, total, payment status, note). No customer details are available.",
    schema: { from: { type: "string" }, to: { type: "string" }, limit: { type: "integer", description: "1-50" } },
    async run(ctx, a) {
      const p = parsePeriod(a.from, a.to);
      const limit = Math.min(50, Math.max(1, Number(a.limit) || 10));
      const { orders } = await fetchOrders(ctx.admin, ordersQuery(p));
      return {
        period: periodLabel(p),
        orders: orders.slice(-limit).reverse().map((o) => ({
          order: o.name,
          createdAt: o.createdAt,
          total: Number(o.currentTotalPriceSet.shopMoney.amount),
          paymentStatus: o.displayFinancialStatus,
          // Notes are customer-written: PII removed and marked as untrusted text.
          note_untrusted: redactPII(o.note).slice(0, 300),
        })),
      };
    },
  },

  low_stock: {
    description: "Variants at or below the merchant's low-stock threshold.",
    schema: {},
    async run(ctx) {
      const s = await settingsOf(ctx.shopId);
      const { rows, locations } = await fetchInventory(ctx.admin);
      const items = rows.filter((r) => r.available <= s.lowStockThreshold).sort((a, b) => a.available - b.available).slice(0, 50);
      items.forEach((i) => {
        ctx.seenIds.add(i.variantId);
        ctx.seenIds.add(i.productId);
      });
      return {
        period: `as of ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
        threshold: s.lowStockThreshold,
        count: items.length,
        items: items.map((i) => ({ product: i.productTitle, variant: i.variantTitle, sku: i.sku, available: i.available, variantId: i.variantId, productId: i.productId })),
        locations: locations.map((l) => ({ id: l.id, name: l.name })),
      };
    },
  },

  slow_movers: {
    description: "Products with stock that sold at most N units in the merchant's slow-mover window.",
    schema: {},
    async run(ctx) {
      const s = await settingsOf(ctx.shopId);
      const today = new Date().toISOString().slice(0, 10);
      const p = { from: shift(today, -(s.slowMoverDays - 1)), to: today };
      const [{ orders }, { rows }] = await Promise.all([fetchOrders(ctx.admin, ordersQuery(p)), fetchInventory(ctx.admin)]);
      const sold = new Map<string, number>();
      for (const o of orders) for (const li of o.lineItems.nodes) if (li.product) sold.set(li.product.id, (sold.get(li.product.id) ?? 0) + li.quantity);
      const stock = new Map<string, { title: string; available: number; tags: string[] }>();
      for (const r of rows) {
        const cur = stock.get(r.productId) ?? { title: r.productTitle, available: 0, tags: r.tags };
        cur.available += r.available;
        stock.set(r.productId, cur);
      }
      const items = [...stock]
        .filter(([id, v]) => v.available > 0 && (sold.get(id) ?? 0) <= s.slowMoverMaxUnits)
        .map(([id, v]) => ({ productId: id, product: v.title, unitsSold: sold.get(id) ?? 0, available: v.available, tags: v.tags }))
        .sort((a, b) => b.available - a.available)
        .slice(0, 50);
      items.forEach((i) => ctx.seenIds.add(i.productId));
      return { period: periodLabel(p), maxUnits: s.slowMoverMaxUnits, count: items.length, items };
    },
  },

  // ---------- write proposals (never executed by the agent) ----------
  propose_inventory_adjustment: {
    description: "PROPOSE an inventory change for a variant returned by low_stock. Creates a pending proposal the merchant must approve. Does not change anything.",
    schema: { variantId: { type: "string" }, locationId: { type: "string" }, delta: { type: "integer" }, reason: { type: "string" } },
    write: true,
    async run(ctx, a) {
      const variantId = String(a.variantId);
      const delta = Math.trunc(Number(a.delta));
      if (!ctx.seenIds.has(variantId)) return { error: "Unknown variant. Only variants returned by low_stock in this conversation can be adjusted." };
      if (!delta || Math.abs(delta) > 1000) return { error: "delta must be a non-zero whole number between -1000 and 1000." };
      const d = await gql<{ productVariant: { title: string; product: { title: string }; inventoryItem: { id: string } } | null }>(
        ctx.admin,
        `#graphql
        query VariantForProposal($id: ID!) { productVariant(id: $id) { id title product { title } inventoryItem { id } } }`,
        { id: variantId },
      );
      if (!d.productVariant) return { error: "Variant not found." };
      const level = await gql<{ inventoryItem: { inventoryLevel: { quantities: { quantity: number }[] } | null } | null }>(
        ctx.admin,
        `#graphql
        query Level($item: ID!, $loc: ID!) {
          inventoryItem(id: $item) { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } }
        }`,
        { item: d.productVariant.inventoryItem.id, loc: String(a.locationId) },
      );
      const current = level.inventoryItem?.inventoryLevel?.quantities[0]?.quantity;
      if (current === undefined) return { error: "This variant is not stocked at that location." };
      const proposal = await db.proposal.create({
        data: {
          shopId: ctx.shopId,
          runId: ctx.runId,
          kind: "inventory_adjust",
          title: `Adjust stock: ${d.productVariant.product.title} – ${d.productVariant.title}`,
          reason: String(a.reason ?? "").slice(0, 500),
          payload: { inventoryItemId: d.productVariant.inventoryItem.id, locationId: String(a.locationId), delta, changeFromQuantity: current },
          preview: [{ label: "Available", before: String(current), after: String(current + delta) }],
        },
      });
      return { proposalId: proposal.id, status: "pending_merchant_approval" };
    },
  },

  propose_add_tags: {
    description: "PROPOSE adding tags to a product returned by an earlier tool (e.g. 'slow-mover'). Creates a pending proposal; does not change anything.",
    schema: { productId: { type: "string" }, tags: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
    write: true,
    async run(ctx, a) {
      const productId = String(a.productId);
      if (!ctx.seenIds.has(productId)) return { error: "Unknown product. Only products returned earlier in this conversation can be tagged." };
      const tags = (Array.isArray(a.tags) ? a.tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 5);
      if (!tags.length) return { error: "Give at least one tag." };
      const d = await gql<{ product: { title: string; tags: string[] } | null }>(
        ctx.admin,
        `#graphql
        query ProductTags($id: ID!) { product(id: $id) { id title tags } }`,
        { id: productId },
      );
      if (!d.product) return { error: "Product not found." };
      const proposal = await db.proposal.create({
        data: {
          shopId: ctx.shopId,
          runId: ctx.runId,
          kind: "add_tags",
          title: `Add tags to ${d.product.title}`,
          reason: String(a.reason ?? "").slice(0, 500),
          payload: { id: productId, tags },
          preview: [{ label: "Tags", before: d.product.tags.join(", ") || "(none)", after: [...new Set([...d.product.tags, ...tags])].join(", ") }],
        },
      });
      return { proposalId: proposal.id, status: "pending_merchant_approval" };
    },
  },
};

// ---------- executing an approved proposal ----------
export async function executeProposal(admin: AdminClient, shopId: string, proposalId: string, approver: string) {
  // Claim atomically so a double click cannot apply twice.
  const claimed = await db.proposal.updateMany({ where: { id: proposalId, shopId, status: "pending" }, data: { status: "approved", decidedBy: approver, decidedAt: new Date() } });
  if (!claimed.count) throw new Error("This proposal was already handled.");
  const p = (await db.proposal.findUnique({ where: { id: proposalId } }))!;
  await audit(shopId, approver, "proposal.approved", p.id, { title: p.title, payload: p.payload });
  try {
    if (p.kind === "inventory_adjust") {
      const x = p.payload as { inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: number };
      const d = await gql<{ inventoryAdjustQuantities: { userErrors: { message: string }[] } }>(
        admin,
        `#graphql
        mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
          inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
            inventoryAdjustmentGroup { id changes { name delta } }
            userErrors { field message }
          }
        }`,
        {
          key: p.id,
          input: {
            name: "available",
            reason: "correction",
            changes: [{ inventoryItemId: x.inventoryItemId, locationId: x.locationId, delta: x.delta, changeFromQuantity: x.changeFromQuantity }],
          },
        },
      );
      if (d.inventoryAdjustQuantities.userErrors.length) throw new Error(d.inventoryAdjustQuantities.userErrors.map((e) => e.message).join("; "));
    } else if (p.kind === "add_tags") {
      const x = p.payload as { id: string; tags: string[] };
      const d = await gql<{ tagsAdd: { userErrors: { message: string }[] } }>(
        admin,
        `#graphql
        mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }`,
        x,
      );
      if (d.tagsAdd.userErrors.length) throw new Error(d.tagsAdd.userErrors.map((e) => e.message).join("; "));
    }
    await db.proposal.update({ where: { id: p.id }, data: { status: "applied" } });
    await audit(shopId, approver, "proposal.applied", p.id, { title: p.title, preview: p.preview });
  } catch (err) {
    await db.proposal.update({ where: { id: p.id }, data: { status: "failed", error: (err as Error).message } });
    await audit(shopId, approver, "proposal.failed", p.id, { error: (err as Error).message });
    throw err;
  }
}

export function audit(shopId: string, actor: string, action: string, target: string, details: object) {
  return db.auditLog.create({ data: { shopId, actor, action, target, details } });
}
