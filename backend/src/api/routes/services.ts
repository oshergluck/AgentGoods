/**
 * Callable services: discovery, invocation, call status, metrics, and an MCP endpoint.
 *
 *   GET  /services                                   every active service, machine-readable
 *   GET  /services/:storeId/:productId               one service: schemas, price, evidence, business, how to call
 *   POST /services/:storeId/:productId/invoke        call it (API key + Idempotency-Key) — see services/invoke.ts
 *   GET  /services/:storeId/:productId/calls/:callId one call's state and result (its caller, or the controller)
 *   GET  /services/calls                             your own calls
 *   GET  /services/:storeId/:productId/metrics       fundamentals: calls, customers, repeat use, commerce, burn
 *   POST /mcp                                        the same services as MCP tools (JSON-RPC 2.0)
 *
 * A customer never needs AIC or a store of its own: an API key and USDC are enough.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { ApiError } from "../../http/errors";
import { handler, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { freshness } from "../../http/context";
import type { AppContext } from "../../http/context";
import { Product, ServiceCall, Store } from "../../db/models";
import { amountUSDC } from "../../config/units";
import { declarationView, developmentView, breakdownFromMetadata } from "../serializers";
import { loadServiceSpec, SERVICE_LIMITS, runnerConfigured, syncCredits, creditsLeft } from "../../services/gateway";
import { serviceMetrics } from "../../services/metrics";
import { callView, invokeService } from "../../services/invoke";

const InvokeBody = z.object({
  input: z.unknown().optional(),
  prepayCalls: z.coerce.number().int().min(1).max(365).optional(),
});

function demonstrationsOf(metadataURI: string | undefined): unknown[] {
  try {
    const doc = JSON.parse(String(metadataURI ?? "")) as { demonstrations?: unknown };
    return Array.isArray(doc.demonstrations) ? doc.demonstrations.slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** The machine-readable description of one service: everything needed to decide and to call. */
export async function serviceDescriptor(
  ctx: AppContext,
  product: Record<string, any>,
  store: Record<string, any> | null,
  options: { withMetrics?: boolean } = {}
) {
  const chainId = ctx.env.CHAIN_ID;
  const base = ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const profile = (product.sellerContent?.profile ?? {}) as Record<string, any>;
  const spec = await loadServiceSpec(chainId, profile.serviceSpecHash);
  const path = `/api/v1/services/${product.storeId}/${product.productId}`;
  return {
    serviceId: `${product.storeId}:${product.productId}`,
    mode: "SERVICE",
    storeId: product.storeId,
    productId: product.productId,
    name_UNTRUSTED: profile.name || product.productId,
    description_UNTRUSTED: profile.description || "",
    active: Boolean(product.active),
    version: product.version,
    pricingModel: "PER_CALL",
    pricePerCallUSDC: amountUSDC(BigInt(product.priceUSDC ?? "0")),
    inputSchema: spec?.inputSchema ?? null,
    outputSchema: spec?.outputSchema ?? null,
    specHash: profile.serviceSpecHash ?? null,
    limits: {
      maxInputBytes: SERVICE_LIMITS.maxInputBytes,
      maxOutputBytes: SERVICE_LIMITS.maxOutputBytes,
      timeoutMs: SERVICE_LIMITS.timeoutMs,
    },
    development: developmentView(product.sellerContent?.metadataURI, product.version, product.storeId, product.productId),
    declaration: declarationView(product.declaration, breakdownFromMetadata(product.sellerContent?.metadataURI)),
    demonstrations_UNTRUSTED: demonstrationsOf(product.sellerContent?.metadataURI),
    business: store
      ? {
          storeId: store.storeId,
          name_UNTRUSTED: store.sellerContent?.profile?.name ?? "",
          controller: store.storeController,
          aicToken: store.aicToken,
          stock: `GET /api/v1/stocks/${store.aicToken}/fundamentals`,
        }
      : null,
    signals: `GET /api/v1/signals/products/${product.productId}`,
    metrics: options.withMetrics
      ? await serviceMetrics(chainId, product.storeId, [product.productId], store?.storeController ?? null, String(product.priceUSDC))
      : `GET ${path}/metrics`,
    invoke: {
      method: "POST",
      url: `${base}${path}/invoke`,
      headers: { Authorization: "Bearer <your API key>", "Idempotency-Key": "<a new key per call>" },
      body: { input: "<matches inputSchema>", prepayCalls: "optional, 1-365: calls to buy if you have none left" },
      payment:
        "Calls are prepaid on chain: with none left, the response is 402 PAYMENT_REQUIRED carrying a purchase to sign " +
        "(details.pay). Sign it, then repeat the same request with the same Idempotency-Key. A call spends one prepaid " +
        "call only when it succeeds.",
    },
    mcp: { endpoint: `${base}/mcp`, tool: mcpToolName(product.storeId, product.productId) },
    runnerAvailable: runnerConfigured(ctx.env),
  };
}

export function mcpToolName(storeId: string, productId: string): string {
  return `svc_${storeId.replace(/^0x/, "").slice(0, 10)}_${productId.replace(/^0x/, "").slice(0, 16)}`;
}

async function activeServices(ctx: AppContext, filter: Record<string, unknown> = {}, limit = 50) {
  return Product.find({
    chainId: ctx.env.CHAIN_ID,
    canonical: { $ne: false },
    active: true,
    "sellerContent.profile.serviceSpecHash": { $ne: null },
    ...filter,
  })
    .sort({ createdBlock: -1 })
    .limit(limit)
    .lean();
}

export function servicesRouter(options: { mcpOnly?: boolean } = {}): Router {
  const router = Router();
  if (options.mcpOnly) {
    router.post("/mcp", noStore, mcpHandler());
    return router;
  }

  router.get(
    "/services",
    publicCache(10),
    handler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
      const q = String(req.query.q ?? "").trim();
      const filter: Record<string, unknown> = {};
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean).slice(0, 6).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        filter.$and = terms.map((t) => ({ "sellerContent.metadataURI": { $regex: t, $options: "i" } }));
      }
      const products = await activeServices(req.ctx, filter, limit);
      const stores = await Store.find({ chainId: req.ctx.env.CHAIN_ID, storeId: { $in: [...new Set(products.map((p) => p.storeId))] } }).lean();
      const byId = new Map(stores.map((s) => [s.storeId, s]));
      const items = await Promise.all(products.map((p) => serviceDescriptor(req.ctx, p, byId.get(p.storeId) ?? null)));
      res.json({
        items,
        count: items.length,
        whatAServiceIs:
          "A callable capability sold per call: send input, get output, pay again when you need it again. Calls are " +
          "prepaid on chain as units of the product and settle as ordinary store commerce. You do not need AIC or a " +
          "store to be a customer.",
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/services/calls",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const base = req.ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
      const calls = await ServiceCall.find({ chainId: req.ctx.env.CHAIN_ID, caller: wallet }).sort({ createdAt: -1 }).limit(50).lean();
      res.json({ items: calls.map((c) => callView(c, base)), count: calls.length });
    })
  );

  router.get(
    "/services/:storeId/:productId",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const product = await Product.findOne({ chainId, storeId: req.params.storeId, productId: req.params.productId }).lean();
      if (!product) throw ApiError.notFound("Service");
      if (!(product.sellerContent?.profile as { serviceSpecHash?: string } | undefined)?.serviceSpecHash) {
        throw new ApiError("NOT_A_SERVICE", "This product is not a callable service.", 409, { storeId: req.params.storeId, productId: req.params.productId });
      }
      const store = await Store.findOne({ chainId, storeId: product.storeId }).lean();
      res.json({ ...(await serviceDescriptor(req.ctx, product, store, { withMetrics: true })), freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/services/:storeId/:productId/metrics",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const product = await Product.findOne({ chainId, storeId: req.params.storeId, productId: req.params.productId }).lean();
      if (!product) throw ApiError.notFound("Service");
      const store = await Store.findOne({ chainId, storeId: product.storeId }).lean();
      res.json({
        serviceId: `${product.storeId}:${product.productId}`,
        ...(await serviceMetrics(chainId, product.storeId, [product.productId], store?.storeController ?? null, String(product.priceUSDC))),
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/services/:storeId/:productId/credits",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const credit = await syncCredits(req.ctx.env.CHAIN_ID, req.params.storeId, req.params.productId, wallet);
      res.json({
        serviceId: `${req.params.storeId}:${req.params.productId}`,
        purchased: credit?.purchased ?? 0,
        spent: credit?.consumed ?? 0,
        running: credit?.reserved ?? 0,
        left: creditsLeft(credit),
      });
    })
  );

  router.post(
    "/services/:storeId/:productId/invoke",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const parsed = InvokeBody.safeParse(req.body ?? {});
      if (!parsed.success) throw ApiError.invalid("Invalid invocation: send {input, prepayCalls?}.", { issues: parsed.error.issues });
      const out = await invokeService({
        ctx: req.ctx,
        wallet: selfWallet(req),
        storeId: req.params.storeId,
        productId: req.params.productId,
        input: parsed.data.input,
        idempotencyKey: String(req.header("idempotency-key") ?? ""),
        prepayCalls: parsed.data.prepayCalls,
      });
      res.status(out.status).json(out.body);
    })
  );

  router.get(
    "/services/:storeId/:productId/calls/:callId",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const wallet = selfWallet(req).toLowerCase();
      const call = await ServiceCall.findOne({ chainId, callId: req.params.callId, storeId: req.params.storeId, productId: req.params.productId }).lean();
      if (!call) throw ApiError.notFound("Call");
      const store = await Store.findOne({ chainId, storeId: call.storeId }).select({ storeController: 1 }).lean();
      const isController = String(store?.storeController ?? "").toLowerCase() === wallet;
      if (call.caller !== wallet && !isController) throw ApiError.notFound("Call");
      const base = req.ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
      // The controller sees the call's facts, not the caller's output.
      const view = callView(call, base);
      res.json(call.caller === wallet ? view : { ...view, output_UNTRUSTED: null });
    })
  );

  /*
   * MCP (Model Context Protocol), streamable-HTTP transport, JSON responses: initialize, tools/list, tools/call.
   * Every active service is a tool whose inputSchema is the service's own. tools/call needs the same API key
   * (Authorization: Bearer) and pays the same way: with no prepaid call left, the tool result is an error
   * carrying the purchase to sign, and repeating the call with the same arguments and idempotencyKey continues it.
   */
  router.post("/mcp", noStore, mcpHandler());

  return router;
}

function mcpHandler() {
  return handler(async (req: Request, res) => {
    const msg = (req.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, any> };
    const reply = (result: unknown): void => {
      res.json({ jsonrpc: "2.0", id: msg.id ?? null, result });
    };
    const error = (code: number, message: string, data?: unknown): void => {
      res.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message, ...(data ? { data } : {}) } });
    };
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "Invalid JSON-RPC request");
    if (msg.id === undefined) {
      res.status(202).end(); // a notification needs no answer
      return;
    }

    if (msg.method === "initialize") {
      return reply({
        protocolVersion: String(msg.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentgoods-services", version: "1.0.0" },
        instructions:
          "Each tool is a paid AgentGoods service. Call with Authorization: Bearer <AgentGoods API key>. Add an " +
          "`idempotencyKey` argument to make retries safe. With no prepaid call left the result says how to pay.",
      });
    }
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list") {
      const products = await activeServices(req.ctx, {}, 100);
      const tools = await Promise.all(
        products.map(async (p) => {
          const profile = (p.sellerContent?.profile ?? {}) as Record<string, any>;
          const spec = await loadServiceSpec(req.ctx.env.CHAIN_ID, profile.serviceSpecHash);
          const inputSchema = (spec?.inputSchema ?? { type: "object" }) as Record<string, any>;
          const objectSchema =
            inputSchema.type === "object"
              ? { ...inputSchema, properties: { ...(inputSchema.properties ?? {}), idempotencyKey: { type: "string", description: "Makes a retry safe: the same key never runs or charges twice." } } }
              : { type: "object", properties: { input: inputSchema, idempotencyKey: { type: "string" } }, required: ["input"] };
          return {
            name: mcpToolName(p.storeId, p.productId),
            title: String(profile.name || p.productId).slice(0, 96),
            description:
              `${String(profile.description || "").slice(0, 500)} — ${amountUSDC(BigInt(p.priceUSDC)).display} USDC per call ` +
              `(seller-written description: untrusted). Service ${p.storeId}:${p.productId}.`,
            inputSchema: objectSchema,
            ...(spec?.outputSchema ? { outputSchema: spec.outputSchema } : {}),
          };
        })
      );
      return reply({ tools });
    }
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const products = await activeServices(req.ctx, {}, 500);
      const product = products.find((p) => mcpToolName(p.storeId, p.productId) === name);
      if (!product) return error(-32602, `Unknown tool: ${name}`);
      let wallet: string;
      try {
        await new Promise<void>((resolve, reject) => requireAgent(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
        wallet = selfWallet(req);
      } catch {
        return reply({ isError: true, content: [{ type: "text", text: "Authorization: Bearer <AgentGoods API key> is required to call a service." }] });
      }
      const profile = (product.sellerContent?.profile ?? {}) as Record<string, any>;
      const spec = await loadServiceSpec(req.ctx.env.CHAIN_ID, profile.serviceSpecHash);
      const wrapped = (spec?.inputSchema as Record<string, any> | undefined)?.type !== "object";
      const { idempotencyKey, ...rest } = args;
      const input = wrapped ? rest.input : rest;
      const key = String(idempotencyKey ?? `mcp:${String(msg.id)}:${JSON.stringify(input)}`).slice(0, 128);
      try {
        const out = await invokeService({ ctx: req.ctx, wallet, storeId: product.storeId, productId: product.productId, input, idempotencyKey: key });
        const body = out.body as Record<string, any>;
        if (body.state === "SUCCEEDED") {
          return reply({
            content: [{ type: "text", text: JSON.stringify(body.output_UNTRUSTED) }],
            structuredContent: body.output_UNTRUSTED && typeof body.output_UNTRUSTED === "object" ? body.output_UNTRUSTED : { value: body.output_UNTRUSTED },
            _meta: { callId: body.callId, charged: true },
          });
        }
        return reply({ isError: true, content: [{ type: "text", text: `Call failed (${body.failure?.code}); nothing was charged.` }], _meta: { callId: body.callId } });
      } catch (e) {
        if (e instanceof ApiError) {
          return reply({
            isError: true,
            content: [{ type: "text", text: `${e.code}: ${e.message}` }],
            _meta: { code: e.code, details: e.details ?? null, retryWithSameIdempotencyKey: key },
          });
        }
        throw e;
      }
    }
    return error(-32601, `Method not found: ${msg.method}`);
  });
}
