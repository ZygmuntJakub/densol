import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import DocsLayout from "./pages/docs/DocsLayout.tsx";
import DocsIntroduction from "./pages/docs/DocsIntroduction.tsx";
import DocsInstallation from "./pages/docs/DocsInstallation.tsx";
import DocsQuickStart from "./pages/docs/DocsQuickStart.tsx";
import DocsApi from "./pages/docs/DocsApi.tsx";
import DocsConfiguration from "./pages/docs/DocsConfiguration.tsx";
import DocsExamples from "./pages/docs/DocsExamples.tsx";
import DocsBenchmarks from "./pages/docs/DocsBenchmarks.tsx";
import DocsCalculator from "./pages/docs/DocsCalculator.tsx";
import DocsComparison from "./pages/docs/DocsComparison.tsx";
import DocsTroubleshooting from "./pages/docs/DocsTroubleshooting.tsx";

const queryClient = new QueryClient();

const App = () => (
  <HelmetProvider>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/docs" element={<DocsLayout />}>
            <Route index element={<DocsIntroduction />} />
            <Route path="installation" element={<DocsInstallation />} />
            <Route path="quickstart" element={<DocsQuickStart />} />
            <Route path="api" element={<DocsApi />} />
            <Route path="configuration" element={<DocsConfiguration />} />
            <Route path="examples" element={<DocsExamples />} />
            <Route path="benchmarks" element={<DocsBenchmarks />} />
            <Route path="calculator" element={<DocsCalculator />} />
            <Route path="comparison" element={<DocsComparison />} />
            <Route path="troubleshooting" element={<DocsTroubleshooting />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </HelmetProvider>
);

export default App;
