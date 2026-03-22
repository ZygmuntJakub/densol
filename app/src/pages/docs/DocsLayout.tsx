import { Outlet } from "react-router-dom";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { useState } from "react";
import { Menu } from "lucide-react";

const DocsLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <DocsSidebar mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <main className="flex-1 min-w-0">
        <div className="md:hidden flex items-center h-12 px-4 border-b border-border bg-background sticky top-0 z-40">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-12">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default DocsLayout;
