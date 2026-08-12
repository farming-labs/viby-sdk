const capabilities = [
  {
    index: "01",
    title: "Durable from the first prompt",
    description:
      "Chats, messages, generation attempts, events, tasks, and source versions remain addressable after restarts.",
  },
  {
    index: "02",
    title: "Portable at every boundary",
    description:
      "Choose the framework, model runtime, skills, storage, sandbox, browser, source provider, and deployment target.",
  },
  {
    index: "03",
    title: "Source your users can trust",
    description:
      "Every accepted change becomes an immutable version that can be restored, forked, downloaded, pushed, or deployed.",
  },
] as const;

const productLinks = [
  {
    title: "Generation",
    description: "Stream durable runs and resume from any event cursor.",
    href: "/docs/api/v1",
  },
  {
    title: "Workspaces",
    description: "Run tools against immutable source in isolated sandboxes.",
    href: "/docs/capabilities",
  },
  {
    title: "Integrations",
    description: "Connect source control and deployment without changing the core.",
    href: "/docs/integrations/github",
  },
] as const;

const quickStart = `const viby = createViby({
  framework: "farm",
  model,
  storage: {
    database: postgres(),
    artifacts: artifactStore,
  },
  skills: {
    design: [skillRead("./skills/design")],
  },
});`;

const pixelOpacities = Array.from({ length: 96 }, (_, index) => {
  const column = index % 12;
  const row = Math.floor(index / 12);
  const horizontal = column / 11;
  const centerDistance = Math.abs(row - 3.5) / 4;
  const wave = ((column * 7 + row * 3) % 10) / 100;
  return Math.max(0.035, Math.min(0.86, horizontal * 0.72 - centerDistance * 0.13 + wave));
});

function BrandMark() {
  return (
    <span className="wordmark-mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span className={[0, 2, 3, 5, 7].includes(index) ? "is-active" : ""} key={index} />
      ))}
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.19 1.78 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.58-.29-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.98 10.98 0 0 1 12 6.11c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.12 3.05.74.8 1.18 1.83 1.18 3.09 0 4.41-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 12 12">
      <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="wordmark" href="/" aria-label="Viby home">
          <BrandMark />
          <span>Viby</span>
        </a>

        <nav className="site-nav" aria-label="Primary navigation">
          <details className="nav-dropdown">
            <summary>
              Platform <ChevronIcon />
            </summary>
            <div className="nav-dropdown-panel">
              <p>Build on Viby</p>
              {productLinks.map((link) => (
                <a href={link.href} key={link.title}>
                  <span>{link.title}</span>
                  <small>{link.description}</small>
                </a>
              ))}
            </div>
          </details>
          <a href="/docs">Docs</a>
          <a href="/docs/capabilities">Capabilities</a>
          <a href="/docs/quality-matrix">Quality</a>
        </nav>

        <div className="header-actions">
          <a
            className="github-link"
            href="https://github.com/farming-labs/viby-sdk"
            aria-label="View Viby on GitHub"
          >
            <GitHubIcon />
          </a>
          <a className="button button-primary button-small" href="/docs">
            Get started
          </a>
          <details className="mobile-menu">
            <summary aria-label="Open navigation">
              <span />
              <span />
            </summary>
            <nav aria-label="Mobile navigation">
              <a href="/docs">Docs</a>
              <a href="/docs/capabilities">Capabilities</a>
              <a href="/docs/quality-matrix">Quality</a>
              <a href="https://github.com/farming-labs/viby-sdk">GitHub</a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

function PixelField() {
  return (
    <div className="pixel-field" aria-hidden="true">
      {pixelOpacities.map((opacity, index) => (
        <span key={index} style={{ opacity }} />
      ))}
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="site-shell">
      <SiteHeader />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="hero-kicker">
              <span aria-hidden="true" />
              Open-source infrastructure for AI software builders
            </p>
            <h1 id="hero-title">Build the coding product only you can imagine.</h1>
            <p className="hero-description">
              Viby is the durable, provider-neutral SDK behind generation, iteration, source
              history, tools, previews, downloads, and shipping. You own the product experience;
              Viby makes its infrastructure dependable.
            </p>

            <div className="hero-actions">
              <a className="button button-primary" href="/docs">
                Start building <ArrowIcon />
              </a>
              <a className="button button-secondary" href="https://github.com/farming-labs/viby-sdk">
                <GitHubIcon /> View on GitHub
              </a>
            </div>

            <div className="install-command" aria-label="Install Viby with npm">
              <span>npm</span>
              <code>install @viby/sdk ai</code>
            </div>
          </div>

          <div className="hero-stage" aria-label="A durable Viby generation moving from prompt to preview">
            <PixelField />
            <div className="stage-toolbar">
              <div>
                <span className="stage-status" aria-hidden="true" />
                Generation run
              </div>
              <span>durable · resumable</span>
            </div>

            <div className="stage-content">
              <div className="prompt-card">
                <span className="stage-label">Prompt</span>
                <p>Build a precise analytics workspace with complete loading and empty states.</p>
                <div className="prompt-tags" aria-label="Generation configuration">
                  <span>Farm</span>
                  <span>Design skill</span>
                  <span>Postgres</span>
                </div>
              </div>

              <ol className="run-timeline">
                <li className="is-complete">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>Plan accepted</strong>
                    <small>Requirements and permissions persisted</small>
                  </div>
                </li>
                <li className="is-complete">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>Source generated</strong>
                    <small>Immutable version v7 · 14 files</small>
                  </div>
                </li>
                <li className="is-current">
                  <span aria-hidden="true" />
                  <div>
                    <strong>Preview ready</strong>
                    <small>Sandbox healthy · visual checks passed</small>
                  </div>
                </li>
              </ol>
            </div>

            <div className="stage-footer">
              <span>event_0187</span>
              <strong>Ready to iterate</strong>
            </div>
          </div>
        </section>

        <section className="ownership-strip" aria-label="Viby product principles">
          <span>Framework agnostic</span>
          <span>Runtime portable</span>
          <span>Storage owned</span>
          <span>Provider neutral</span>
        </section>

        <section className="capability-list" aria-labelledby="capabilities-title">
          <div className="section-heading">
            <p className="eyebrow">The core contract</p>
            <h2 id="capabilities-title">Infrastructure without the lock-in.</h2>
            <p>
              Start with one model and a database URL. Replace each boundary only when your product
              needs more control.
            </p>
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

        <section className="config-section" aria-labelledby="config-title">
          <div className="config-copy">
            <p className="eyebrow">A small API, intentionally</p>
            <h2 id="config-title">Simple to start. Open where it matters.</h2>
            <p>
              Keep the convenient path for a new product, then bring custom engines, adapters, and
              policies without rewriting the application around Viby.
            </p>
            <a className="text-link" href="/docs/api/v1">
              Read the API contract <ArrowIcon />
            </a>
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
              <span>Application-owned configuration</span>
            </div>
          </div>
        </section>

        <section className="closing-cta" aria-labelledby="closing-title">
          <div>
            <p className="eyebrow">Start with the contract</p>
            <h2 id="closing-title">Give your product a durable foundation.</h2>
          </div>
          <a className="button button-inverse" href="/docs">
            Explore the documentation <ArrowIcon />
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="/" aria-label="Viby home">
          <BrandMark />
          <span>Viby</span>
        </a>
        <span>Open source by Farming Labs</span>
        <div>
          <a href="/docs">Docs</a>
          <a href="https://github.com/farming-labs/viby-sdk">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
