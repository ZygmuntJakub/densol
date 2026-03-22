import { Helmet } from "react-helmet-async";
import { Link, useLocation } from "react-router-dom";
import { useDocsNav } from "@/components/docs/DocsSidebar";
import { ChevronLeft, ChevronRight, Copy, Check } from "lucide-react";
import { ReactNode, useState } from "react";

export const DocsPage = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => {
  const { prev, next } = useDocsNav();
  const { pathname } = useLocation();

  const pageTitle = `${title} | densol docs`;
  const pageDescription =
    description ??
    "densol documentation — transparent LZ4 compression for Solana Anchor programs.";

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "densol", item: "https://densol.dev" },
      { "@type": "ListItem", position: 2, name: "Docs", item: "https://densol.dev/docs" },
      { "@type": "ListItem", position: 3, name: title, item: `https://densol.dev${pathname}` },
    ],
  };

  return (
    <>
      <Helmet>
        <title>{pageTitle}</title>
        <meta name="description" content={pageDescription} />
        <link rel="canonical" href={`https://densol.dev${pathname}`} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:url" content={`https://densol.dev${pathname}`} />
        <script type="application/ld+json">{JSON.stringify(breadcrumbJsonLd)}</script>
      </Helmet>
    <article>
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight mb-3">{title}</h1>
        {description && <p className="text-muted-foreground text-lg leading-relaxed">{description}</p>}
      </header>

      <div className="prose-densol">{children}</div>

      <nav className="mt-16 pt-8 border-t border-border flex items-center justify-between">
        {prev ? (
          <Link
            to={prev.path}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Previous</p>
              <p className="font-medium text-foreground">{prev.title}</p>
            </div>
          </Link>
        ) : (
          <div />
        )}
        {next ? (
          <Link
            to={next.path}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors text-right"
          >
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Next</p>
              <p className="font-medium text-foreground">{next.title}</p>
            </div>
            <ChevronRight className="w-4 h-4" />
          </Link>
        ) : (
          <div />
        )}
      </nav>
    </article>
    </>
  );
};

export const CodeBlock = ({ children, title }: { children: string; title?: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const CopyBtn = () => (
    <button
      onClick={handleCopy}
      aria-label="Copy code"
      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );

  return (
    <div className="my-4">
      {title ? (
        <div className="flex items-center justify-between px-4 py-2 rounded-t-lg border border-b-0 bg-secondary/50 border-code-border">
          <span className="text-xs font-mono text-muted-foreground">{title}</span>
          <CopyBtn />
        </div>
      ) : null}
      <div className="relative group">
        <pre className={`code-block ${title ? "rounded-t-none" : ""}`}>
          <code>{children}</code>
        </pre>
        {!title && (
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyBtn />
          </div>
        )}
      </div>
    </div>
  );
};

export const Callout = ({
  children,
  type = "info",
}: {
  children: ReactNode;
  type?: "info" | "warning" | "tip";
}) => {
  const styles = {
    info: "border-primary/30 bg-primary/5",
    warning: "border-destructive/30 bg-destructive/5",
    tip: "border-primary/30 bg-primary/5",
  };
  const labels = { info: "Note", warning: "Warning", tip: "Tip" };

  return (
    <div className={`my-6 rounded-lg border p-4 ${styles[type]}`}>
      <p className="text-xs font-mono font-semibold text-primary uppercase tracking-wider mb-2">{labels[type]}</p>
      <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
};

export const H2 = ({ children }: { children: ReactNode }) => (
  <h2 className="text-xl font-semibold mt-12 mb-4 text-foreground">{children}</h2>
);

export const H3 = ({ children }: { children: ReactNode }) => (
  <h3 className="text-lg font-semibold mt-8 mb-3 text-foreground">{children}</h3>
);

export const P = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground leading-relaxed mb-4">{children}</p>
);
