"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

const INSTALL_COMMAND = "pnpm add @viby/sdk";
const AGENT_PROMPT =
  "Install @viby/sdk with pnpm and integrate Viby into this project. Preserve the existing framework and runtime, configure a server-side AI model and DATABASE_URL, and follow the Viby SDK documentation at https://viby.farming-labs.dev/docs.";

type CopyTarget = "command" | "prompt";

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <rect height="8.5" rx="1.5" stroke="currentColor" width="8.5" x="5" y="5" />
      <path
        d="M3 10.5H2.75A1.75 1.75 0 0 1 1 8.75v-6A1.75 1.75 0 0 1 2.75 1h6A1.75 1.75 0 0 1 10.5 2.75V3"
        stroke="currentColor"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="m3 4 3 3-3 3M7.5 10h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="M8 1.5v2M4.5 2.5l1 1.7M11.5 2.5l-1 1.7M2.5 5l1.7 1M13.5 5l-1.7 1"
        stroke="currentColor"
        strokeLinecap="round"
      />
      <rect height="7" rx="2" stroke="currentColor" width="10" x="3" y="7" />
      <path
        d="M6 10.5h.01M10 10.5h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="m3 8.5 3 3 7-7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HeroInstallCopy() {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!open) return;

    const focusFrame = window.requestAnimationFrame(() => firstActionRef.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    },
    [],
  );

  const copy = async (target: CopyTarget) => {
    const value = target === "command" ? INSTALL_COMMAND : AGENT_PROMPT;
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(false);
      setCopied(target);
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
      setCopyError(true);
    }
  };

  const handleMenuKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const actions = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    if (actions.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, actions.indexOf(document.activeElement as HTMLButtonElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? actions.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % actions.length
            : (current - 1 + actions.length) % actions.length;
    actions[next]?.focus();
  };

  return (
    <div className="hero-install" aria-label="Install @viby/sdk with pnpm">
      <span aria-hidden="true">$</span>
      <code aria-label={INSTALL_COMMAND}>
        <span className="hero-install-command" aria-hidden="true">
          {INSTALL_COMMAND}
        </span>
      </code>
      <div className="hero-install-copy" ref={rootRef}>
        <button
          aria-controls="hero-copy-menu"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Copy the install command or agent prompt"
          className="hero-copy-trigger"
          onClick={() => setOpen((current) => !current)}
          ref={triggerRef}
          type="button"
        >
          <CopyIcon />
        </button>
        {open ? (
          <div
            aria-label="Copy options"
            className="hero-copy-menu"
            id="hero-copy-menu"
            onKeyDown={handleMenuKeys}
            role="menu"
          >
            <button
              onClick={() => void copy("command")}
              ref={firstActionRef}
              role="menuitem"
              type="button"
            >
              <TerminalIcon />
              <span>
                <strong>Copy command</strong>
                <small>{INSTALL_COMMAND}</small>
              </span>
              <i aria-hidden="true">{copied === "command" ? <CheckIcon /> : null}</i>
            </button>
            <button
              onClick={() => void copy("prompt")}
              role="menuitem"
              type="button"
            >
              <AgentIcon />
              <span>
                <strong>Copy agent prompt</strong>
                <small>Configure Viby in this project</small>
              </span>
              <i aria-hidden="true">{copied === "prompt" ? <CheckIcon /> : null}</i>
            </button>
            <span aria-live="polite" className="hero-copy-feedback">
              {copyError
                ? "Could not copy"
                : copied === "command"
                  ? "Command copied"
                  : copied === "prompt"
                    ? "Agent prompt copied"
                    : ""}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
