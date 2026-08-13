const pixelOpacities = Array.from({ length: 352 }, (_, index) => {
  const column = index % 32;
  const row = Math.floor(index / 32);
  const distanceFromCenter = Math.abs(column - 15.5);
  const visibleWidth = 2.1 + row * 1.72;

  if (distanceFromCenter > visibleWidth) return 0;

  const edgeFade = 1 - distanceFromCenter / visibleWidth;
  const depth = (row + 1) / 11;
  const texture = ((column * 11 + row * 7) % 9) / 90;
  return Math.min(0.92, 0.06 + edgeFade * depth * 0.76 + texture);
});

function VibyMark() {
  return (
    <span className="viby-mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span className={[0, 2, 3, 5, 6, 8].includes(index) ? "is-visible" : ""} key={index} />
      ))}
    </span>
  );
}

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

function SiteHeader() {
  return (
    <header className="landing-header">
      <a className="landing-wordmark" href="/" aria-label="Viby home">
        <VibyMark />
        <span>Viby</span>
      </a>

      <nav className="landing-nav" aria-label="Primary navigation">
        <a href="/docs">Documentation</a>
        <a href="/docs/capabilities">Capabilities</a>
        <a href="https://github.com/farming-labs/viby-sdk">GitHub</a>
      </nav>

      <a className="header-cta" href="/docs">
        Get started
      </a>
    </header>
  );
}

export default function HomePage() {
  return (
    <main className="landing-shell">
      <SiteHeader />

      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="hero-status">
          <span aria-hidden="true" />
          Open source · provider neutral
        </div>

        <div className="hero-copy">
          <h1 id="hero-title">
            <span>Generate.</span>
            <span>Iterate.</span>
            <span>Ship.</span>
          </h1>
          <p>
            The durable TypeScript SDK for building your own vibe coding product—without giving up
            your framework, models, storage, or deployment stack.
          </p>

          <div className="hero-actions">
            <a className="hero-button hero-button-primary" href="/docs">
              Start building <ArrowIcon />
            </a>
            <a
              className="hero-button hero-button-secondary"
              href="https://github.com/farming-labs/viby-sdk"
            >
              <GitHubIcon /> View on GitHub
            </a>
          </div>

          <div className="install-command" aria-label="Install Viby with npm">
            <span>$</span>
            <code>npm install @viby/sdk ai</code>
          </div>
        </div>

        <div className="pixel-horizon" aria-hidden="true">
          {pixelOpacities.map((opacity, index) => (
            <span key={index} style={{ opacity }} />
          ))}
        </div>

        <div className="hero-footnote" aria-hidden="true">
          <span>Durable generations</span>
          <span>Immutable source</span>
          <span>Portable adapters</span>
        </div>
      </section>
    </main>
  );
}
