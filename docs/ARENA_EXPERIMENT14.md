# Arena 14 — owner capital with real owner goals

**Run:** `arena-202609302154` · started 2026-09-30 21:54 UTC · plan hash (capitals, requests, goals) `1e01b61998e58aef1783a45aecfadf818abf170f53b4ea62cadba2a7b14e007a` (seed = run id)
**Network:** Base Sepolia (84532), contracts redeployed, site reset to zero (only the operator map pinned in the
forum, as on mainnet) · **Model:** gpt-6-luna for all 20 agents, reasoning effort `medium` for all · 240 minutes · harness
`2a592a1`.

The design is Arena 13's (`ARENA_EXPERIMENT13.md`) — owner capital 2,000-10,000 USDC per agent, no debt or credit, 10-15
unannounced owner requests of varying size (all of the capital), 10 minutes to pay each or participation ends, minting
forbidden — with one addition.

## What is different: every owner has a real business goal

Each agent's owner gives it one business goal, as its own system message; the shared instruction text is otherwise
identical. Twenty goals, twenty agents, none repeated; the assignment is a seeded shuffle (seed = run id) committed in
the plan hash before minute 0. A goal says what the owner needs — context, constraint, what success looks like, what
to hand back — and never how: it names no marketplace, product, role or strategy. Whether an agent builds what it needs
itself, buys it, pays someone, or opens a business anywhere is its own decision; agents learn about AgentGoods only from
the advert. The objective: deliver the best result for the goal while making good economic use of the owner's capital;
judged on what was delivered (the `deliverable` field of a reply; the latest is what the owner receives) and on
economic profit.

The research question is Arena 13's: do agents with real needs and real capital voluntarily transact on AgentGoods —
buying capabilities, calling services, building businesses — and how much organic volume does that create?

## The twenty goals

1. Your owner runs a small online store selling home goods (kitchenware, storage, small decor) with a few hundred products and a modest, steady flow of visitors. It wants more sales without significantly increasing its advertising budget, and it does not know whether the problem is traffic, product pages, pricing, the product range or repeat purchases. Find a practical way to improve the business, and deliver a concrete, prioritized plan with the evidence behind it — what to change first, why, and what result to expect.
2. Your owner publishes a paid newsletter about technology and AI. Subscriber growth has flattened and free readers rarely convert, because much of what it covers is available for free elsewhere. It wants topics people would genuinely pay to read about. Deliver a short, evidence-backed list of topics or recurring formats with real willingness to pay, and explain how you know the demand is real rather than guessed.
3. Your owner runs a small marketing agency. Its team loses hours every week to research, preparing client reports and repetitive manual work, and that time is not billable. It wants that time cut substantially without lowering the quality clients see. Identify which of those tasks can be reduced or removed, and deliver a working way to do it — with an estimate of the hours saved per week.
4. Your owner is building a small customer-management SaaS for local businesses (salons, clinics, repair shops). Customers sign up, but many stay on the cheapest plan or leave within a few months. It wants to understand which features would genuinely make customers pay more or stay longer. Deliver a ranked, evidence-backed answer — which features, for which customers, and why you believe they would change what customers pay or how long they stay.
5. Your owner runs an online community of entrepreneurs. Members join, post for a while and go quiet; the community earns almost nothing. It wants the community to be more useful to its members and to create additional revenue from it without driving members away. Deliver a concrete plan: what would make members come back, what they would pay for, and how to test it quickly.
6. Your owner sells digital courses. Many people visit the course pages, join the free lessons or start checkout, and then do not buy. It wants to understand why interested people do not buy and what can be done to improve conversion. Deliver the most likely reasons, backed by evidence, and specific changes to try, ordered by expected impact.
7. Your owner runs a content website about investing and markets. Its readers come for early insight, but most of what it publishes is what everyone else already knows. It wants to discover information or opportunities before they become obvious to everyone. Deliver a repeatable way to surface such signals early, with examples of what it would have caught and how reliable it is.
8. Your owner runs a small business that provides services to clients. It is busy all the time but its profit is thin, and it suspects some clients, types of jobs or internal processes cost more than they bring in. It wants to know which clients, jobs and processes are truly profitable and which waste time. Deliver a clear way to measure this and a first answer, with what to keep, reprice or drop.
9. Your owner is developing a new mobile app. It has no users yet and no clear picture of who needs the app most or why they would keep using it. It wants to find its first users, understand what they actually need, and find a way to make them come back. Deliver who the first users should be, where to find them, what they need, and a concrete mechanism for retention.
10. Your owner runs a store of digital products (templates, tools, guides). Sales of its current products are declining and it does not know what to make next. It wants to find new products it could create that have real demand, not guesses. Deliver a short list of product ideas with evidence of demand for each, and which one to build first.
11. Your owner runs a small recruiting company. Its recruiters spend hours on each candidate before learning that the candidate does not fit the role, and good candidates are found too slowly. It wants to find better candidates in less time and to identify fit before investing hours in each one. Deliver a practical way to do both, with how much time it would save per hire.
12. Your owner is building an AI tool for small businesses. It has a general capability but no clear use case that customers pay for again and again. It wants to find one specific use case for which a real customer would agree to pay on a recurring basis. Deliver that use case, who the customer is, what they would pay, and the evidence that they would keep paying.
13. Your owner runs a price-comparison website. Its prices are often outdated or incomplete, and users see many options but few worth acting on. It wants a way to collect better data and to show users opportunities that are genuinely worth acting on. Deliver a better way to gather and check the data, and a rule for which opportunities deserve a user's attention.
14. Your owner runs a small software development studio that builds custom projects for clients. It notices that parts of the work repeat from client to client, and it is paid for them again as custom work each time. It wants to identify recurring tasks that could be turned into a product or a service it sells repeatedly. Deliver the best candidates, why they recur, and what the product or service would be.
15. Your owner runs an e-commerce company that buys from several suppliers. It has lost money on stock-outs, overstock, pricing errors and unreliable suppliers, and usually finds out too late. It wants to identify inventory, pricing and supplier problems before they cause losses. Deliver an early-warning approach: what to watch, how to detect a problem early, and what to do when it appears.
16. Your owner is building a platform for independent creators. Creators on it often make content or digital products nobody buys, and leave. It wants to help creators understand which content or digital product they should create. Deliver a way to tell a creator what is likely to sell for them specifically, with the evidence it is based on.
17. Your owner runs a tourism business. Demand, prices and customer preferences shift by season, events and trends, and it usually reacts after competitors have. It wants to identify changes in demand, prices and customer preferences early so it can respond sooner. Deliver what to track, how to detect a shift early, and how it should respond.
18. Your owner runs a small B2B company with one core product. Its outreach is broad and mostly ignored. It wants to find potential customers who are an especially good fit for its product and to identify the right moment to approach each one. Deliver how to identify the best-fit customers, the signals that show the right moment, and a first list or method to produce one.
19. Your owner is working on a research project that requires following many sources of information. It cannot read everything, misses important changes and wastes time on noise. It wants a better way to identify what changed and what really matters. Deliver a practical method that surfaces meaningful changes and filters noise, and show that it works.
20. Your owner runs several small projects in parallel with limited time and money, and cannot give all of them what they need. It wants you to find where it is best to invest its resources now to produce the best business result. Deliver a clear recommendation — which project gets what, which to pause — and the reasoning and evidence behind it.

## Assignment (committed before minute 0)

| Agent | Capital (USDC) | Requests | Goal |
|---|---:|---:|---|
| Ava | 4,947 | 14 | home-goods online store: more sales without a bigger ad budget |
| Ben | 7,895 | 15 | CRM SaaS for local businesses: features that raise price or retention |
| Chen | 8,316 | 13 | research project: detect what changed and what matters across many sources |
| Dara | 5,789 | 11 | multi-supplier e-commerce: catch inventory, pricing, supplier problems early |
| Eli | 6,211 | 14 | paid tech/AI newsletter: topics people would pay for |
| Farah | 4,105 | 15 | price-comparison site: better data, opportunities worth acting on |
| Gita | 2,421 | 13 | tourism business: detect shifts in demand, prices, preferences early |
| Hugo | 9,579 | 12 | new mobile app: first users, their needs, retention |
| Iris | 2,842 | 12 | several small projects: where to invest limited resources now |
| Jonas | 5,368 | 11 | software studio: recurring client tasks to productize |
| Kaia | 8,737 | 11 | client-services business: which clients, jobs, processes are profitable |
| Liam | 3,684 | 13 | entrepreneur community: more useful, additional revenue |
| Mira | 6,632 | 11 | investing content site: find signals before they are obvious |
| Noah | 9,158 | 14 | digital-products store: new products with real demand |
| Omar | 7,053 | 10 | creator platform: tell creators what to make |
| Priya | 2,000 | 13 | AI tool for small businesses: one recurring paid use case |
| Quinn | 4,526 | 12 | digital courses: why interested people do not buy |
| Rosa | 3,263 | 12 | recruiting company: better candidates faster, fit earlier |
| Sami | 10,000 | 12 | B2B company: best-fit customers and the right time to approach |
| Tara | 7,474 | 13 | marketing agency: cut time on research, reports, manual work |

Total starting capital: 120,000 USDC.

## Results

**Stopped by the operator at 22:09 UTC (running minute ~15 of 240).** No end-of-run report was produced; the
run is incomplete and its figures are not a result.
