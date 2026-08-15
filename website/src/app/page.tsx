function ArrowIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function SparkIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="M8 1.5c.3 3.8 2.2 5.7 6 6-3.8.3-5.7 2.2-6 6-.3-3.8-2.2-5.7-6-6 3.8-.3 5.7-2.2 6-6Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
    </span>
  );
}

function ProductStage() {
  return (
    <div className="product-stage" aria-label="Viby generation workspace preview">
      <div className="product-window">
        <div className="product-bar">
          <div className="product-brand">
            <BrandMark />
            <span>viby</span>
          </div>
          <div className="project-path">
            <span>farming-labs</span>
            <span aria-hidden="true">/</span>
            <strong>analytics-studio</strong>
          </div>
          <div className="run-status">
            <i aria-hidden="true" />
            Running
          </div>
        </div>

        <div className="product-body">
          <aside className="version-rail" aria-label="Project versions">
            <div className="version-heading">
              <span>Versions</span>
              <span className="mock-icon" aria-hidden="true">+</span>
            </div>

            <div className="version-list">
              <div className="version-item version-item-active">
                <span className="version-number">v3</span>
                <span>
                  <strong>Refine revenue chart</strong>
                  <small>Generating now</small>
                </span>
              </div>
              <div className="version-item">
                <span className="version-number">v2</span>
                <span>
                  <strong>Add date filters</strong>
                  <small>2 min ago</small>
                </span>
              </div>
              <div className="version-item">
                <span className="version-number">v1</span>
                <span>
                  <strong>Initial dashboard</strong>
                  <small>8 min ago</small>
                </span>
              </div>
            </div>

            <div className="version-footer">
              <span className="avatar">FL</span>
              <span>
                <strong>Farming Labs</strong>
                <small>Postgres connected</small>
              </span>
            </div>
          </aside>

          <section className="generation-pane" aria-label="Generation conversation">
            <div className="pane-heading">
              <div>
                <span className="eyebrow">Generation</span>
                <strong>Refine revenue chart</strong>
              </div>
              <span className="attempt-pill">Attempt 2</span>
            </div>

            <div className="conversation">
              <div className="user-message">
                Make the revenue trend easier to compare, add a range filter, and keep the current
                visual language.
              </div>

              <div className="assistant-message">
                <span className="assistant-mark"><SparkIcon /></span>
                <div>
                  <div className="assistant-status">
                    <strong>Implementing your changes</strong>
                    <span><i aria-hidden="true" /> Live</span>
                  </div>
                  <p>
                    I’m updating the chart interaction and preserving the existing tokens and
                    component structure.
                  </p>
                  <div className="work-log">
                    <span><i className="work-done" aria-hidden="true">✓</i> Read design system</span>
                    <span><i className="work-done" aria-hidden="true">✓</i> Updated chart data</span>
                    <span><i className="work-active" aria-hidden="true" /> Editing dashboard.tsx</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="changed-files">
              <span>Changed files</span>
              <div>
                <code>src/dashboard.tsx</code>
                <code>src/chart.tsx</code>
                <code>src/styles.css</code>
              </div>
            </div>

            <div className="prompt-box">
              <span>Ask Viby to change anything…</span>
              <span className="mock-submit" aria-hidden="true"><ArrowIcon /></span>
            </div>
          </section>

          <section className="preview-pane" aria-label="Generated application preview">
            <div className="preview-bar">
              <span>Preview</span>
              <div>
                <i aria-hidden="true" />
                <i aria-hidden="true" />
                <i aria-hidden="true" />
              </div>
            </div>

            <div className="dashboard-preview">
              <div className="dashboard-nav">
                <span className="dashboard-logo">Northstar</span>
                <span>Overview</span>
                <span>Reports</span>
                <span>Customers</span>
                <i aria-hidden="true" />
              </div>

              <div className="dashboard-content">
                <div className="dashboard-header">
                  <div>
                    <span>Overview</span>
                    <strong>Revenue performance</strong>
                  </div>
                  <span className="mock-filter">Last 30 days <span>⌄</span></span>
                </div>

                <div className="metric-row">
                  <div className="metric-card metric-card-primary">
                    <span>Revenue</span>
                    <strong>$184,240</strong>
                    <small>↗ 12.8%</small>
                  </div>
                  <div className="metric-card">
                    <span>Customers</span>
                    <strong>2,408</strong>
                    <small>↗ 8.4%</small>
                  </div>
                  <div className="metric-card">
                    <span>Conversion</span>
                    <strong>4.82%</strong>
                    <small>↗ 0.6%</small>
                  </div>
                </div>

                <div className="chart-card">
                  <div className="chart-heading">
                    <div>
                      <span>Total revenue</span>
                      <strong>$184.2k</strong>
                    </div>
                    <div className="chart-legend"><i /> This period</div>
                  </div>
                  <svg className="revenue-chart" viewBox="0 0 520 190" role="img" aria-label="Revenue increasing over the last 30 days">
                    <defs>
                      <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#191919" stopOpacity="0.15" />
                        <stop offset="1" stopColor="#191919" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <g className="chart-grid">
                      <path d="M0 22H520M0 70H520M0 118H520M0 166H520" />
                    </g>
                    <path className="chart-area" d="M0 148C43 139 55 114 91 123s55 15 82-7 48-48 83-35 55 38 88 15 45-69 81-55 59 19 95-16v165H0Z" />
                    <path className="chart-line" d="M0 148C43 139 55 114 91 123s55 15 82-7 48-48 83-35 55 38 88 15 45-69 81-55 59 19 95-16" />
                    <circle cx="425" cy="41" r="5" />
                  </svg>
                  <div className="chart-labels">
                    <span>Aug 01</span><span>Aug 08</span><span>Aug 15</span><span>Aug 22</span><span>Aug 30</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div className="capability-rail" aria-label="Core Viby capabilities">
        <span>Durable runs</span>
        <span>Immutable versions</span>
        <span>Any framework</span>
        <span>Your infrastructure</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="landing-shell">
      <div className="landing-frame">
        <nav className="site-nav" aria-label="Main navigation">
          <a className="site-brand" href="/" aria-label="Viby home">
            <BrandMark />
            <span>viby</span>
          </a>

          <div className="site-links">
            <a href="/docs">Docs</a>
            <a href="/docs/api/v1">API</a>
            <a href="https://github.com/farming-labs/viby-sdk">GitHub</a>
          </div>

          <a className="nav-cta" href="/docs">
            Get started <ArrowIcon />
          </a>
        </nav>

        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="hero-kicker"><span aria-hidden="true" /> Open-source infrastructure for coding products</p>
            <h1 id="hero-title">Build the coding product.<br /><span>Keep the stack.</span></h1>
            <p className="hero-description">
              Durable generation, source history, sandboxes, and previews—without giving up your
              framework, model, storage, or runtime.
            </p>

            <div className="hero-actions">
              <a className="hero-button hero-button-primary" href="/docs">
                Read the docs <ArrowIcon />
              </a>
              <a className="hero-button hero-button-secondary" href="https://github.com/farming-labs/viby-sdk">
                <GitHubIcon /> View on GitHub
              </a>
            </div>

            <div className="install-command" aria-label="Install Viby with npm">
              <span aria-hidden="true">$</span>
              <code>npm i @viby/sdk ai</code>
            </div>
          </div>

          <ProductStage />
        </section>
      </div>
    </main>
  );
}
