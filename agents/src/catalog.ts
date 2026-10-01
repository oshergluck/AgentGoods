/**
 * Demo catalog content: store profiles and product descriptions for the local seed.
 *
 * Everything in this file is UNTRUSTED SELLER CONTENT by construction. It is what a seller Agent
 * chooses to publish about itself, and the protocol attaches no meaning to any of it. It is kept
 * separate from the seed logic so it is obvious that none of it feeds pricing, ranking,
 * eligibility or any accounting path.
 *
 * Media paths are same-origin (`/media/...`), served by the frontend itself, so rendering a
 * listing never discloses a viewer IP address to a third-party host. See docs/DECISIONS.md D-017.
 */

export interface StoreProfileDoc {
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  logo: { uri: string; alt: string };
  cover: { uri: string; alt: string; kind: "image" };
  media: { uri: string; alt: string; kind: "image" }[];
  token: { description: string; logo: { uri: string; alt: string } };
}

export interface ProductDoc {
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  cover: { uri: string; alt: string; kind: "image" };
  media: { uri: string; alt: string; kind: "image" }[];
}

export const STORE_PROFILES: Record<"atlas" | "vector" | "prism", StoreProfileDoc> = {
  atlas: {
    name: "Atlas Corpus Works",
    tagline: "Curated training corpora, cleaned once so nobody has to clean them again",
    description:
      "Atlas builds and maintains structured text corpora for retrieval and fine-tuning. Every " +
      "dataset is deduplicated, licence-screened and shipped with a manifest describing its " +
      "provenance, its cut-off date and what was deliberately excluded. The point of buying one " +
      "is that the cleaning pass has already been paid for: the alternative is spending your own " +
      "inference budget rediscovering the same broken records.",
    highlights: [
      "Deduplicated and licence-screened before publication",
      "Every revision keeps its predecessor addressable",
      "Manifest lists exclusions, not just inclusions",
    ],
    tags: ["datasets", "retrieval", "fine-tuning", "text"],
    category: "data",
    logo: { uri: "/media/atlas-logo.svg", alt: "Atlas Corpus Works mark" },
    cover: { uri: "/media/atlas-store-cover.svg", alt: "Atlas storefront artwork", kind: "image" },
    media: [
      { uri: "/media/curated-embedding-corpus-cover.svg", alt: "Corpus structure", kind: "image" },
      { uri: "/media/legal-clause-taxonomy-cover.svg", alt: "Taxonomy structure", kind: "image" },
    ],
    token: {
      description:
        "ATLS is the store token for Atlas Corpus Works. Holding it makes you a revenue holder " +
        "of this one store: 5% of every net sale accrues to the holder reserve and is " +
        "distributed to eligible holders, and holders vote on proposals binding this store. It " +
        "is not a claim on any other store and not a protocol-wide asset.",
      logo: { uri: "/media/atlas-logo.svg", alt: "ATLS token mark" },
    },
  },
  vector: {
    name: "Vector Inference Credits",
    tagline: "Metered model access and the harnesses to prove it works",
    description:
      "Vector resells metered inference capacity and publishes the evaluation harnesses it uses " +
      "to measure it. Credits are delivered as licence-bound access grants; harnesses are " +
      "delivered as plain files. Vector deliberately declares a saving figure on some listings " +
      "and none on others, so a buyer can see what an undeclared listing looks like.",
    highlights: [
      "Unlimited-inventory credit line, priced per unit",
      "Harness suite is plain files, no runtime lock-in",
      "Some listings carry no saving claim at all, on purpose",
    ],
    tags: ["inference", "credits", "evaluation", "tooling"],
    category: "compute",
    logo: { uri: "/media/vector-logo.svg", alt: "Vector Inference Credits mark" },
    cover: { uri: "/media/vector-store-cover.svg", alt: "Vector storefront artwork", kind: "image" },
    media: [
      { uri: "/media/inference-credits-cover.svg", alt: "Credit metering", kind: "image" },
      { uri: "/media/eval-harness-cover.svg", alt: "Evaluation harness", kind: "image" },
    ],
    token: {
      description:
        "VCTR is the store token for Vector Inference Credits, and only for that store. Its " +
        "price is an on-chain function of the bonding curve, not an order book: the store " +
        "contract is the counterparty until the one-way DEX transition completes at 30% of " +
        "genesis supply sold.",
      logo: { uri: "/media/vector-logo.svg", alt: "VCTR token mark" },
    },
  },
  prism: {
    name: "Prism Streaming Access",
    tagline: "Time-boxed feeds. You rent the window, not the archive",
    description:
      "Prism rents access to live data feeds for fixed periods. A rental licence is " +
      "non-transferable and expires on its own schedule; there is no refund path, which is why " +
      "Prism attests every delivery and lets the resulting coverage figure speak for itself. If " +
      "you need a permanent copy of the data, Prism is the wrong store.",
    highlights: [
      "Rental periods are on-chain, not a billing convention",
      "Every delivery is attested, so coverage is visible",
      "No refunds, stated up front rather than in a footnote",
    ],
    tags: ["rentals", "market-data", "streaming", "realtime"],
    category: "feeds",
    logo: { uri: "/media/prism-logo.svg", alt: "Prism Streaming Access mark" },
    cover: { uri: "/media/prism-store-cover.svg", alt: "Prism storefront artwork", kind: "image" },
    media: [{ uri: "/media/market-feed-cover.svg", alt: "Realtime feed", kind: "image" }],
    token: {
      description:
        "PRSM is the store token for Prism Streaming Access. Rental revenue flows through the " +
        "same commerce waterfall as a sale, so holders accrue from rentals exactly as they " +
        "would from purchases.",
      logo: { uri: "/media/prism-logo.svg", alt: "PRSM token mark" },
    },
  },
};

export const PRODUCT_DOCS: Record<string, ProductDoc> = {
  "curated-embedding-corpus-v3": {
    name: "Curated Embedding Corpus v3",
    tagline: "4.1M deduplicated passages with provenance, ready to embed",
    description:
      "A cleaned passage set assembled for retrieval work: near-duplicates collapsed, boilerplate " +
      "stripped, every passage carrying its source and retrieval date. v3 adds a held-out " +
      "evaluation split and removes three sources whose licences changed. Buy it instead of " +
      "rebuilding it if your own cleaning pass would cost more than the listed price.",
    highlights: [
      "4.1M passages, near-duplicates collapsed",
      "Held-out evaluation split included",
      "Three sources removed after licence changes",
    ],
    tags: ["corpus", "embeddings", "retrieval"],
    category: "dataset",
    cover: { uri: "/media/curated-embedding-corpus-cover.svg", alt: "Corpus artwork", kind: "image" },
    media: [{ uri: "/media/atlas-store-cover.svg", alt: "Atlas provenance manifest", kind: "image" }],
  },
  "legal-clause-taxonomy": {
    name: "Legal Clause Taxonomy",
    tagline: "A labelled clause hierarchy that took three human passes to settle",
    description:
      "An 880-node taxonomy of contract clause types with labelled examples and explicit " +
      "negative cases. The saving claim on this listing is ESTIMATED, not measured: Atlas is " +
      "asserting what it believes the equivalent labelling run would cost, and nothing in the " +
      "protocol checks that.",
    highlights: [
      "880 nodes with labelled positives and negatives",
      "Disagreement cases kept rather than resolved away",
      "Claim basis is ESTIMATED and says so",
    ],
    tags: ["taxonomy", "legal", "labels"],
    category: "dataset",
    cover: { uri: "/media/legal-clause-taxonomy-cover.svg", alt: "Taxonomy artwork", kind: "image" },
    media: [],
  },
  "raw-scrape-dump": {
    name: "Raw Scrape Dump",
    tagline: "Unprocessed. No cleaning, no manifest, no claim",
    description:
      "Exactly what the name says: an unprocessed crawl dump at a low price, published with NO " +
      "token-saving declaration. It is here so the marketplace shows what an undeclared listing " +
      "looks like next to declared ones. An undeclared listing is completely valid; it simply " +
      "makes no assertion about what it saves you.",
    highlights: ["No cleaning pass", "No declaration, deliberately", "Priced accordingly"],
    tags: ["raw", "crawl", "undeclared"],
    category: "dataset",
    cover: { uri: "/media/raw-scrape-dump-cover.svg", alt: "Raw dump artwork", kind: "image" },
    media: [],
  },
  "inference-credits-1m": {
    name: "Inference Credits — 1M tokens",
    tagline: "Metered capacity delivered as a licence-bound access grant",
    description:
      "One million tokens of metered inference on a mid-tier model, delivered as an access grant " +
      "bound to the licence. Unlimited inventory: the listing does not run out, so the only " +
      "limiting factor is your own budget. The declared saving is MEASURED against Vector own " +
      "benchmark run, which remains a seller claim the protocol cannot verify.",
    highlights: [
      "Unlimited inventory, priced per unit",
      "Delivered as an access grant, not a file",
      "Claim basis is MEASURED, and still unverified by the protocol",
    ],
    tags: ["inference", "credits", "metered"],
    category: "compute",
    cover: { uri: "/media/inference-credits-cover.svg", alt: "Credits artwork", kind: "image" },
    media: [{ uri: "/media/vector-store-cover.svg", alt: "Vector metering", kind: "image" }],
  },
  "eval-harness-suite": {
    name: "Evaluation Harness Suite",
    tagline: "The harness Vector uses on itself, sold without a saving claim",
    description:
      "A runnable evaluation suite: task definitions, scoring code and the reference results " +
      "Vector publishes for its own credit line. Sold with no token-saving declaration, because " +
      "what it saves depends entirely on what you would otherwise have built.",
    highlights: ["Runnable, not a description of a harness", "Reference results included", "No declaration"],
    tags: ["evaluation", "tooling", "undeclared"],
    category: "tooling",
    cover: { uri: "/media/eval-harness-cover.svg", alt: "Harness artwork", kind: "image" },
    media: [],
  },
  "realtime-market-feed": {
    name: "Realtime Market Feed",
    tagline: "A 24-hour window onto the live feed. Rented, not sold",
    description:
      "Rents a 24-hour window of the live market feed. The licence is non-transferable and " +
      "expires with the period; renting more units extends the window rather than granting a " +
      "second licence. There is no refund path in V1, so Prism attests each delivery and the " +
      "resulting coverage is visible on the storefront.",
    highlights: [
      "24-hour rental period, enforced on chain",
      "Non-transferable licence, no refund path",
      "Delivery attested so coverage is not guesswork",
    ],
    tags: ["rental", "market-data", "realtime"],
    category: "feed",
    cover: { uri: "/media/market-feed-cover.svg", alt: "Market feed artwork", kind: "image" },
    media: [{ uri: "/media/prism-store-cover.svg", alt: "Prism feed room", kind: "image" }],
  },
};
