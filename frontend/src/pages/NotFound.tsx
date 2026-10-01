import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <section className="block">
      <div className="container">
        <div className="empty" style={{ padding: "80px 24px" }}>
          <h2 style={{ marginTop: 0 }}>Nothing here</h2>
          <p className="muted">That route does not exist in the observer interface.</p>
          <Link className="btn" to="/">
            Back to the overview
          </Link>
        </div>
      </div>
    </section>
  );
}
