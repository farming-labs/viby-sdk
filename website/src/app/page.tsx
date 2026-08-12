const capabilities = [
  {
    index: "01",
    title: "Durable by default",
    description:
      "Chats, generations, events, tasks, attempts, and source versions survive process restarts.",
  },
  {
    index: "02",
    title: "Portable at every boundary",
    description:
      "Bring your framework, model runtime, skills, database, sandbox, browser, and deployment providers.",
  },
  {
    index: "03",
    title: "Source you can trust",
    description:
      "Every iteration produces an immutable version that can be restored, forked, downloaded, or shipped.",
  },
] as const;

const quickStart = `const viby = createViby({
  framework: "farm",
  model,
  skills: {
    design: ["farming-labs/design-engineer"],
  },
});`;

export default function HomePage() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Viby home">
          <span className="wordmark-mark" aria-hidden="true">
            V
          </span>
          <span>Viby</span>
        </a>

        <nav className="site-nav" aria-label="Primary navigation">
          <a href="/docs">Docs</a>
          <a href="/docs/capabilities">Capabilities</a>
          <a href="https://github.com/farming-labs/viby-sdk">GitHub</a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Framework-neutral SDK for vibe coding products</p>
            <h1 id="hero-title">Your product. Your stack. One durable generation layer.</h1>
            <p className="hero-description">
              Viby gives product teams the infrastructure behind generation, iteration, source
              history, sandboxes, tools, downloads, and deployment—without owning the application
              around it.
            </p>

            <div className="hero-actions">
              <a className="button button-primary" href="/docs">
                Read the docs <span aria-hidden="true">→</span>
              </a>
              <a className="button button-secondary" href="/docs/capabilities">
                Explore capabilities
              </a>
            </div>

            <div className="install-command" aria-label="Install Viby">
              <span aria-hidden="true">$</span>
              <code>npm install @viby/sdk ai</code>
            </div>
          </div>

          <div className="code-proof" aria-label="Viby configuration example">
            <div className="code-proof-header">
              <span>viby.config.ts</span>
              <span>TypeScript</span>
            </div>
            <pre>
              <code>{quickStart}</code>
            </pre>
            <div className="code-proof-footer">
              <span className="status-dot" aria-hidden="true" />
              <span>Framework and runtime stay application-owned</span>
            </div>
          </div>
        </section>

        <section className="capability-list" aria-labelledby="capabilities-title">
          <div className="section-heading">
            <p className="eyebrow">Core contract</p>
            <h2 id="capabilities-title">Infrastructure without lock-in.</h2>
          </div>

          <div className="capability-rows">
            {capabilities.map((capability) => (
              <article className="capability-row" key={capability.index}>
                <span className="capability-index">{capability.index}</span>
                <h3>{capability.title}</h3>
                <p>{capability.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="closing-cta" aria-labelledby="closing-title">
          <div>
            <p className="eyebrow">Start with the contract</p>
            <h2 id="closing-title">Build the experience only your product needs.</h2>
          </div>
          <a className="button button-primary" href="/docs/api/v1">
            Open the API contract <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <span>Viby by Farming Labs</span>
        <span>Powered by Farm and @farming-labs/docs</span>
      </footer>
    </div>
  );
}
