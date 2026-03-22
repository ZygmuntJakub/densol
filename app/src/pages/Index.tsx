import { Helmet } from "react-helmet-async";
import { DocsHeader } from "@/components/DocsHeader";
import { HeroSection } from "@/components/HeroSection";
import { QuickStartSection } from "@/components/QuickStartSection";
import { UsageSection } from "@/components/UsageSection";
import { FeaturesSection } from "@/components/FeaturesSection";
import { BenchmarksSection } from "@/components/BenchmarksSection";
import { CalculatorSection } from "@/components/CalculatorSection";
import { HowItWorksSection } from "@/components/HowItWorksSection";
import { FooterSection } from "@/components/FooterSection";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://densol.dev/#software",
      name: "densol",
      description:
        "Transparent LZ4 compression library for Solana Anchor programs. Reduce on-chain account rent by up to 9x with a single derive macro.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Solana Virtual Machine (SBF)",
      programmingLanguage: "Rust",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      url: "https://densol.dev",
      downloadUrl: "https://crates.io/crates/densol",
      codeRepository: "https://github.com/ZygmuntJakub/densol",
      author: { "@type": "Person", name: "Jakub Zygmunt", url: "https://github.com/ZygmuntJakub" },
    },
    {
      "@type": "WebSite",
      "@id": "https://densol.dev/#website",
      url: "https://densol.dev",
      name: "densol",
      description: "On-chain compression for Solana programs",
      author: { "@type": "Person", name: "Jakub Zygmunt" },
    },
  ],
};

const Index = () => {
  return (
    <>
      <Helmet>
        <title>densol — On-chain compression for Solana Anchor programs</title>
        <meta
          name="description"
          content="densol is a Rust library that adds transparent LZ4 compression to Solana Anchor account fields. Reduce on-chain rent by up to 9x with a single derive macro — zero architecture changes."
        />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>
    <div className="min-h-screen">
      <DocsHeader />
      <main>
        <HeroSection />
        <QuickStartSection />
        <UsageSection />
        <FeaturesSection />
        <BenchmarksSection />
        <CalculatorSection />
        <HowItWorksSection />
      </main>
      <FooterSection />
    </div>
    </>
  );
};

export default Index;
