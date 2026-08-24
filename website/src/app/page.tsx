import { HeroInstallCopy } from "../components/hero-install-copy";

function DocsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="hero-button-leading-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.5 2.5h3.25A2.25 2.25 0 0 1 8 4.75v8.75a2.25 2.25 0 0 0-2.25-2.25H2.5V2.5ZM13.5 2.5h-3.25A2.25 2.25 0 0 0 8 4.75v8.75a2.25 2.25 0 0 1 2.25-2.25h3.25V2.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DemoIcon() {
  return (
    <svg
      aria-hidden="true"
      className="hero-button-leading-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <rect x="1.75" y="2.25" width="12.5" height="9.5" rx="1.5" stroke="currentColor" />
      <path
        d="m6.5 5.25 3.25 1.75L6.5 8.75v-3.5ZM5.25 13.75h5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      className="hero-button-leading-icon"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02 0 2.05.14 3.01.4 2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.3c0 .32.19.69.8.58A12 12 0 0 0 12 0Z" />
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      aria-hidden="true"
      className="hero-button-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M4 12 12 4M6 4h6v6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VibyLogo() {
  return (
    <span className="viby-logo" aria-label="viby">
      <span className="terminal-glyph" aria-hidden="true">›_</span>
      <span className="viby-wordmark">viby</span>
    </span>
  );
}

const fileNames = ["src/dashboard.tsx", "src/components/chart.tsx", "src/styles.css"];

function FileBadges() {
  return (
    <div className="file-badges">
      {fileNames.map((name) => (
        <span key={name}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 1.5A1.5 1.5 0 0 1 3.5 0h6.88c.4 0 .78.16 1.06.44l2.12 2.12c.28.28.44.66.44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 14.5v-13Z" />
          </svg>
          {name}
        </span>
      ))}
    </div>
  );
}

function AppMockup() {
  return (
    <div className="app-mockup" aria-label="viby generation workspace preview">
      <div className="mock-titlebar">
        <div className="mock-project">
          <span className="window-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>viby / analytics-dashboard</span>
        </div>
        <div className="mock-running"><i aria-hidden="true" /> running</div>
      </div>

      <div className="mock-body">
        <aside className="mock-sidebar" aria-label="Recent generations">
          <div className="mock-sidebar-heading">
            <span>Generations</span>
            <i aria-hidden="true">+</i>
          </div>
          <div className="mock-session mock-session-active">
            <strong>Revenue dashboard</strong>
            <small>3 min ago</small>
          </div>
          <div className="mock-session">
            <strong>Checkout flow</strong>
            <small>2h ago</small>
          </div>
          <div className="mock-session">
            <strong>Docs redesign</strong>
            <small>1d ago</small>
          </div>
        </aside>

        <section className="mock-chat" aria-label="Generation conversation">
          <div className="mock-messages">
            <div className="mock-user-row">
              <p>Build a polished analytics dashboard with filters</p>
            </div>

            <div className="mock-response">
              <div className="tool-summary">
                <span>
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z" />
                    <path d="M8 4v4l3 1.5" />
                  </svg>
                  12 tool calls
                </span>
                <i aria-hidden="true" />
                <span>3/4 tasks <b aria-hidden="true"><i /><i /><i /><i /></b></span>
                <i aria-hidden="true" />
                <span>42s</span>
              </div>

              <p className="mock-agent-text">
                I&apos;ve built the analytics dashboard with a responsive sidebar, KPI trends,
                date filters, and complete loading states. Running the typecheck now…
              </p>
              <FileBadges />
            </div>
          </div>

          <div className="mock-composer">
            <div>
              <span>Request changes or ask a question…</span>
              <i aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 12V4M8 4 5 7M8 4l3 3" />
                </svg>
              </i>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="landing-shell">
      <div className="landing-rails" aria-hidden="true"><span /></div>

      <header className="landing-header">
        <div>
          <VibyLogo />
          <a
            aria-label="Open the Viby demo"
            className="hero-button hero-button-secondary"
            href="https://viby-app.farming-labs.dev"
          >
            <DemoIcon />
            <span aria-hidden="true" className="hero-button-divider">
              /
            </span>
            <span>Demo</span>
          </a>
        </div>
      </header>

      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">viby.</h1>
          <p>
            The infrastructure SDK for persistent, skill-guided vibe coding products. Bring your
            framework, model, storage, and runtime.
          </p>
          <HeroInstallCopy />
          <div className="hero-actions">
            <a className="hero-button hero-button-primary" href="/docs">
              <DocsIcon />
              <span aria-hidden="true" className="hero-button-divider">
                /
              </span>
              <span>Read the docs</span>
            </a>
            <a
              className="hero-button hero-button-secondary"
              href="https://github.com/farming-labs/viby-sdk"
            >
              <GitHubIcon />
              <span aria-hidden="true" className="hero-button-divider">
                /
              </span>
              <span>Open Source</span>
              <ArrowUpRightIcon />
            </a>
          </div>
        </div>

        <div className="stage-wrap">
          <div className="product-stage">
            <div className="grain" aria-hidden="true" />
            <div className="stage-overlay" aria-hidden="true" />
            <div className="stage-content"><AppMockup /></div>
          </div>
        </div>
      </section>
    </main>
  );
}
