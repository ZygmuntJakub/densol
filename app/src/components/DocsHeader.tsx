import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Menu, X, Github, ExternalLink } from "lucide-react";

const NAV_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "quickstart", label: "Quick Start" },
  { id: "usage", label: "Usage" },
  { id: "features", label: "Features" },
  { id: "benchmarks", label: "Benchmarks" },
  { id: "calculator", label: "Calculator" },
  { id: "how-it-works", label: "How It Works" },
];

export const DocsHeader = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    setMobileOpen(false);
  };

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? "bg-background/80 backdrop-blur-xl border-b border-border" : ""
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 h-16">
        <button onClick={() => scrollTo("overview")} aria-label="Go to overview" className="flex items-center gap-2">
          <img src="/densol.svg" alt="densol" className="h-7 w-auto" />
        </button>

        <nav className="hidden md:flex items-center gap-6">
          {NAV_SECTIONS.slice(1).map((s) => (
            <button key={s.id} onClick={() => scrollTo(s.id)} className="nav-link">
              {s.label}
            </button>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <Link
            to="/docs"
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://crates.io/crates/densol"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link flex items-center gap-1.5"
          >
            crates.io <ExternalLink className="w-3 h-3" />
          </a>
          <a
            href="https://github.com/ZygmuntJakub/densol"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link flex items-center gap-1.5"
          >
            <Github className="w-4 h-4" />
          </a>
        </div>

        <button onClick={() => setMobileOpen(!mobileOpen)} className="md:hidden text-foreground">
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <nav className="md:hidden border-t border-border bg-background/95 backdrop-blur-xl px-6 py-4 flex flex-col gap-3">
          {NAV_SECTIONS.map((s) => (
            <button key={s.id} onClick={() => scrollTo(s.id)} className="nav-link text-left py-1">
              {s.label}
            </button>
          ))}
          <div className="flex items-center gap-4 pt-2 border-t border-border mt-2">
            <Link
              to="/docs"
              onClick={() => setMobileOpen(false)}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
            >
              Docs
            </Link>
            <a href="https://crates.io/crates/densol" target="_blank" rel="noopener noreferrer" className="nav-link flex items-center gap-1.5">
              crates.io <ExternalLink className="w-3 h-3" />
            </a>
            <a href="https://github.com/ZygmuntJakub/densol" target="_blank" rel="noopener noreferrer" className="nav-link">
              <Github className="w-4 h-4" />
            </a>
          </div>
        </nav>
      )}
    </header>
  );
};
