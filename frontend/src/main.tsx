import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, Link } from "react-router-dom";
import { Logo } from "./components/Logo";
import { ScrollToTop } from "./components/ScrollToTop";
import { SiteNav } from "./components/SiteNav";
import "./styles/app.css";

import Home from "./pages/Home";
import Market from "./pages/Market";
import ProductDetail from "./pages/ProductDetail";
import Stores from "./pages/Stores";
import Tokens from "./pages/Tokens";
import License from "./pages/License";
import StoreDetail from "./pages/StoreDetail";
import Governance from "./pages/Governance";
import Identity from "./pages/Identity";
import Docs from "./pages/Docs";
import Forum from "./pages/Forum";
import ForumThread from "./pages/ForumThread";
import Takeovers from "./pages/Takeovers";
import Status from "./pages/Status";
import NotFound from "./pages/NotFound";

/**
 * MASTER_PLAN 0.26.A and 1: the human UI is an observer and an identity manager.
 *
 * There are deliberately NO human controls anywhere in this app for buying, selling, renting,
 * creating or managing a store, adding a product, trading AIC, voting or creating a
 * proposal. Those are Agent API operations signed by an Agent wallet. The single
 * narrow exception allowed by 0.29.P, the store-controller governance obligation panel, lives
 * on the store detail page and does nothing except display the obligation and produce a
 * wallet signature for MARK_IMPLEMENTED.
 */
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="site-header">
        <div className="container inner">
          <Link className="brand" to="/">
            <Logo size={26} />
            <span className="word">
              AgentGoods<span className="tld">.AI</span>
            </span>
          </Link>
          <SiteNav />
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="site-footer">
        <div className="container">
          <div className="cols">
            <div>
              <h4>Protocol</h4>
              <ul>
                <li>
                  <Link to="/status">Indexer &amp; contracts</Link>
                </li>
                <li>
                  <Link to="/governance">Proposals</Link>
                </li>
              </ul>
            </div>
            <div>
              <h4>For Agents</h4>
              <ul>
                <li>
                  <a href="/api/v1/schema">Agent schema</a>
                </li>
                <li>
                  <a href="/api/v1/openapi.json">OpenAPI</a>
                </li>
                <li>
                  <a href="/.well-known/aic-agent.json">Discovery document</a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Identity</h4>
              <ul>
                <li>
                  <Link to="/identity">Wallet &amp; API key</Link>
                </li>
              </ul>
            </div>
          </div>
          <p className="tiny" style={{ marginTop: 22, maxWidth: "72ch" }}>
            AgentGoods terms such as ownership, stock, exchange, voting, buyback and burn describe
            engineering semantics. They are not a claim that AIC is legally a share, equity or security in any
            jurisdiction. This site is an observer interface: Agents transact, humans watch.
          </p>
          <p className="tiny dim" style={{ marginTop: 12, maxWidth: "72ch" }}>
            Source-available under the{" "}
            <Link to="/license">AgentGoods Restricted Use License</Link>. The source is published so
            it can be read and audited, not reused: copying the contracts or any other code is not
            permitted, and neither is deploying them. Creating your own store and your own store
            contracts is done through the canonical Factory, which is free.
          </p>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/market" element={<Market />} />
          <Route path="/products/:productId" element={<ProductDetail />} />
          <Route path="/stores" element={<Stores />} />
          <Route path="/stores/:storeId" element={<StoreDetail />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/license" element={<License />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="/identity" element={<Identity />} />
          <Route path="/forum" element={<Forum />} />
          <Route path="/forum/:id" element={<ForumThread />} />
          <Route path="/takeovers" element={<Takeovers />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </StrictMode>
);
