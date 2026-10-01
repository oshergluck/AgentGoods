/**
 * The licence, on the site.
 *
 * Published here rather than only in the repository because the restriction is about this
 * deployment: someone reading the site is exactly the person who needs to know that the source can
 * be audited but not reused, and that the free path to their own store is the Factory.
 *
 * The full legal text lives in `/LICENSE` at the repository root and is the binding version. This
 * page states the same terms in the same order; where they differ, the file wins.
 */

export default function License() {
  return (
    <section className="block page-detail">
      <div className="container" style={{ maxWidth: "76ch" }}>
        <div className="section-head">
          <h2>License</h2>
          <span className="sub">AgentGoods Restricted Use License, version 1.0</span>
        </div>

        <div className="notice info">
          <strong>Source-available, not open source.</strong> Everything is published so that anyone
          can read it, audit it, and check that the deployed bytecode matches. It is published for
          inspection, not for reuse.
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>The short version</h3>
          <ul className="highlights" style={{ paddingLeft: 18 }}>
            <li>You may read and audit everything here. That is the point of publishing it.</li>
            <li>You may not copy the contracts or any other code into anything.</li>
            <li>You may not deploy these contracts yourself.</li>
            <li>
              If you want your own store and your own store contracts, create them through the
              canonical Factory. That is free, it is the intended way, and it is the only authorized
              way.
            </li>
          </ul>
        </div>

        <h3>Creating a store is free, and it is the authorized path</h3>
        <p className="muted">
          You do not need to copy or deploy anything to have your own store. The canonical Factory
          creates a complete, independent store in a single transaction: its own store contract, its
          own AIC store token (an ERC20), its own LicenseToken and its own governance. The operator
          charges nothing for it; you pay only the network&rsquo;s gas.
          Those contracts are yours to control, and nothing in the licence restricts what you do
          with a store you created that way.
        </p>
        <p className="muted">
          This is not a limitation dressed up as a feature. Provenance is what lets an Agent verify
          that a store is canonical rather than a convincing copy, and that guarantee only holds if
          every canonical store comes from the same Factory. A deployed copy would be, by
          construction, exactly what the provenance check exists to reject.
        </p>

        <h3>What the licence cannot do</h3>
        <p className="muted">
          Contract bytecode on a public chain is readable and copyable by anyone. This licence is a
          legal instrument, not a technical control: it states what is permitted and what is
          forbidden, and it does not pretend to make copying impossible.
        </p>

        <h3>No warranty</h3>
        <p className="muted">
          The software is provided as is, without warranty of any kind. It operates on public
          blockchains and handles digital assets, and it has not been subject to an external
          security audit.
        </p>

        <div className="tiny dim" style={{ marginTop: 22 }}>
          The binding text is the <code>LICENSE</code> file in the repository, SPDX identifier{" "}
          <code>LicenseRef-AgentGoods-1.0</code>. It was drafted for this project and has not been
          reviewed by a lawyer. Permission to copy, deploy or operate the software outside this
          deployment can be requested from the operator; absent written permission, assume it is
          refused.
        </div>
      </div>
    </section>
  );
}
