import { NavLink, useLocation } from "react-router-dom";
import { Book, Rocket, Code, Settings, BarChart3, Calculator, Layers, HelpCircle, GitCompare, ChevronLeft, ChevronRight, ArrowLeft, X } from "lucide-react";
import { useState } from "react";

const sections = [
  {
    label: "Getting Started",
    items: [
      { title: "Introduction", path: "/docs", icon: Book },
      { title: "Installation", path: "/docs/installation", icon: Rocket },
      { title: "Quick Start", path: "/docs/quickstart", icon: Code },
    ],
  },
  {
    label: "Guide",
    items: [
      { title: "API Reference", path: "/docs/api", icon: Code },
      { title: "Configuration", path: "/docs/configuration", icon: Settings },
      { title: "Examples", path: "/docs/examples", icon: Layers },
    ],
  },
  {
    label: "Reference",
    items: [
      { title: "Benchmarks", path: "/docs/benchmarks", icon: BarChart3 },
      { title: "Calculator", path: "/docs/calculator", icon: Calculator },
      { title: "Comparison", path: "/docs/comparison", icon: GitCompare },
      { title: "Troubleshooting", path: "/docs/troubleshooting", icon: HelpCircle },
    ],
  },
];

export const DocsSidebar = ({
  mobileOpen = false,
  setMobileOpen,
}: {
  mobileOpen?: boolean;
  setMobileOpen?: (open: boolean) => void;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  const sidebarContent = (isMobile: boolean) => (
    <>
      <div className="h-14 flex items-center justify-between px-3 border-b border-border flex-shrink-0">
        {(!collapsed || isMobile) && (
          <NavLink to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm">
            <ArrowLeft className="w-4 h-4" />
            <img src="/densol.svg" alt="densol" className="h-5 w-auto" />
            <span className="text-muted-foreground text-xs">/docs</span>
          </NavLink>
        )}
        {isMobile ? (
          <button
            onClick={() => setMobileOpen?.(false)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto py-4 px-2">
        {sections.map((section) => (
          <div key={section.label} className="mb-5">
            {(!collapsed || isMobile) && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground px-2 mb-2">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === "/docs"}
                  onClick={() => setMobileOpen?.(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    }`
                  }
                  title={collapsed && !isMobile ? item.title : undefined}
                >
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {(!collapsed || isMobile) && <span>{item.title}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex sticky top-0 h-screen border-r border-border bg-card flex-col transition-all duration-200 ${
          collapsed ? "w-14" : "w-64"
        }`}
      >
        {sidebarContent(false)}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen?.(false)}
            aria-hidden="true"
          />
          <aside className="relative w-64 h-full bg-card border-r border-border flex flex-col">
            {sidebarContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};

// Helper to get prev/next navigation
export const useDocsNav = () => {
  const location = useLocation();
  const allItems = sections.flatMap((s) => s.items);
  const currentIndex = allItems.findIndex(
    (item) => item.path === location.pathname || (item.path === "/docs" && location.pathname === "/docs")
  );
  return {
    prev: currentIndex > 0 ? allItems[currentIndex - 1] : null,
    next: currentIndex < allItems.length - 1 ? allItems[currentIndex + 1] : null,
  };
};
