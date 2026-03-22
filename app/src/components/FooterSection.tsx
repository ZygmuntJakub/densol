import { Link } from "react-router-dom";
import { Github, ExternalLink } from "lucide-react";

const NAV = [
  { label: "Quick Start", href: "#quickstart", scroll: true },
  { label: "Benchmarks", href: "#benchmarks", scroll: true },
  { label: "Calculator", href: "#calculator", scroll: true },
  { label: "How It Works", href: "#how-it-works", scroll: true },
];

const EXTERNAL = [
  { label: "Docs", href: "/docs", internal: true },
  { label: "crates.io", href: "https://crates.io/crates/densol", internal: false },
  { label: "GitHub", href: "https://github.com/ZygmuntJakub/densol", internal: false },
];

export const FooterSection = () => (
  <footer className="border-t border-border bg-background">
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">
        {/* Brand */}
        <div className="flex flex-col gap-3">
          <img src="/densol.svg" alt="densol" className="h-7 w-auto" />
          <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
            On-chain LZ4 compression for Solana Anchor programs.
          </p>
        </div>

        {/* Links */}
        <div className="flex flex-wrap gap-12">
          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Sections
            </span>
            {NAV.map(({ label, href }) => (
              <button
                key={href}
                onClick={() =>
                  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" })
                }
                className="text-sm text-foreground/70 hover:text-primary transition-colors text-left"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Resources
            </span>
            {EXTERNAL.map(({ label, href, internal }) =>
              internal ? (
                <Link
                  key={href}
                  to={href}
                  className="text-sm text-foreground/70 hover:text-primary transition-colors flex items-center gap-1"
                >
                  {label}
                </Link>
              ) : (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-foreground/70 hover:text-primary transition-colors flex items-center gap-1"
                >
                  {label} <ExternalLink className="w-3 h-3" />
                </a>
              )
            )}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="mt-10 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} densol — Apache 2.0 License
        </p>
        <a
          href="https://github.com/ZygmuntJakub/densol"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-primary transition-colors"
          aria-label="GitHub"
        >
          <Github className="w-4 h-4" />
        </a>
      </div>
    </div>
  </footer>
);
