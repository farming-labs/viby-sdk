const signalClusters = [
  { x: 156, y: 185 },
  { x: 270, y: 164 },
  { x: 458, y: 144 },
  { x: 505, y: 170 },
  { x: 617, y: 222 },
  { x: 784, y: 282 },
  { x: 866, y: 186 },
  { x: 873, y: 363 },
];

const clusterPixels = [
  [0, 0],
  [10, 0],
  [20, 0],
  [-10, 10],
  [0, 10],
  [10, 10],
  [20, 10],
  [30, 10],
  [0, 20],
  [10, 20],
  [20, 20],
  [10, 30],
];

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
        Get started <ArrowIcon />
      </a>
    </header>
  );
}

function PixelNetwork() {
  return (
    <div className="network-visual" aria-hidden="true">
      <div className="network-label">
        <span>Generation network</span>
        <span className="network-live"><i /> live</span>
      </div>

      <svg className="network-map" viewBox="0 0 1000 470" role="presentation">
        <defs>
          <pattern id="world-pixels" width="10" height="10" patternUnits="userSpaceOnUse">
            <rect x="3.2" y="3.2" width="3.4" height="3.4" fill="currentColor" />
          </pattern>
          <linearGradient id="route-fade" x1="0" x2="1">
            <stop offset="0" stopColor="white" stopOpacity="0" />
            <stop offset="0.48" stopColor="white" stopOpacity="0.24" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g className="world-shape">
          <path d="M47 111 77 82l48-15 53 10 21 25 39 8 20 28-17 21-32-5-12 19 20 20-19 25-36-8-18 15-29-21-25 4-10-29-25-10-19-34Z" />
          <path d="m230 233 43-12 41 20 17 40-13 36 4 31-18 34-15 46-18-14-4-39-21-28-9-36-24-31Z" />
          <path d="m420 106 31-22 43 1 20 16 37-7 25 18 52-10 43 15 58-15 62 21 53-1 43 24-15 24 30 18-15 29-48-5-17 24-32-9-32 15-31-13-28 11-29-28-33-10-28 18-27-8-12-25-29-2-24-26-41 2-32-19-29-6-9-21 28-18Z" />
          <path d="m478 205 47-12 39 20 22 39-8 34-26 26-9 44-26 28-24-29 1-37-24-24-8-38Z" />
          <path d="m825 319 34-20 46 7 31 29-4 34-31 20-43-8-22-27Z" />
          <path d="m907 205 17-11 22 7 7 17-19 10-20-8Z" />
        </g>

        <g className="network-routes">
          <path d="M166 195C282 88 384 104 468 154" />
          <path d="M280 174C388 248 493 249 627 232" />
          <path d="M515 180C646 106 760 122 876 196" />
          <path d="M627 232C720 221 750 249 794 292" />
          <path d="M794 292C830 315 851 338 883 373" />
        </g>

        <g className="network-signal">
          {signalClusters.flatMap((cluster, clusterIndex) =>
            clusterPixels.map(([offsetX, offsetY], pixelIndex) => (
              <rect
                className={`signal-pixel signal-delay-${(clusterIndex + pixelIndex) % 5}`}
                height="5"
                key={`${clusterIndex}-${pixelIndex}`}
                width="5"
                x={cluster.x + offsetX}
                y={cluster.y + offsetY}
              />
            )),
          )}
        </g>
      </svg>

      <div className="network-caption">
        <span>Frameworks</span>
        <span>Models</span>
        <span>Runtimes</span>
        <span>Providers</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="landing-shell">
      <SiteHeader />

      <section className="landing-hero" aria-labelledby="hero-title">
        <PixelNetwork />

        <div className="hero-status">
          <span aria-hidden="true" />
          Open source / provider neutral
        </div>

        <div className="hero-copy">
          <p className="hero-kicker">Generation infrastructure for products</p>
          <h1 id="hero-title" aria-label="Build the layer behind the prompt.">
            <span className="hero-title-primary">Build the layer</span>
            {" "}
            <span>behind the prompt.</span>
          </h1>
          <p className="hero-description">
            A durable TypeScript SDK for turning conversations into working software—while you own
            the framework, model, storage, and runtime.
          </p>

          <div className="hero-actions">
            <a className="hero-button hero-button-primary" href="/docs">
              Start building <ArrowIcon />
            </a>
            <a
              className="hero-button hero-button-secondary"
              href="https://github.com/farming-labs/viby-sdk"
            >
              <GitHubIcon /> View source
            </a>
          </div>
        </div>

        <div className="hero-rail">
          <div className="install-command" aria-label="Install Viby with npm">
            <span>Install</span>
            <code>npm i @viby/sdk ai</code>
          </div>
          <div className="rail-item">
            <strong>01</strong>
            <span>Durable runs</span>
          </div>
          <div className="rail-item">
            <strong>02</strong>
            <span>Immutable source</span>
          </div>
          <div className="rail-item">
            <strong>03</strong>
            <span>Portable adapters</span>
          </div>
        </div>
      </section>
    </main>
  );
}
