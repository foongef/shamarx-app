import type { Metadata } from 'next';
import { LandingNavbar } from '@/components/landing/navbar';
import { LandingHero } from '@/components/landing/hero';
import { TrustStrip } from '@/components/landing/trust-strip';
import { ModulesSection } from '@/components/landing/modules';
import { HowItWorksSection } from '@/components/landing/how-it-works';
import { StrategySpotlight } from '@/components/landing/strategy-spotlight';
import { PrinciplesSection } from '@/components/landing/principles';
import { CtaBand } from '@/components/landing/cta-band';
import { LandingFooter } from '@/components/landing/footer';

const SITE = {
  name: 'ShamarX',
  description:
    'ShamarX is a precision-driven trading system that monitors markets, manages risk, and executes with discipline. Smart money concept engine for XAUUSD, EURUSD, GBPUSD, USDJPY.',
  url: 'https://shamarx.com',
};

export const metadata: Metadata = {
  title: 'ShamarX — Trade with discipline. Not emotion.',
  description: SITE.description,
  keywords: [
    'algorithmic trading',
    'forex trading bot',
    'XAUUSD trading',
    'gold trading system',
    'smart money concept',
    'SMC trading',
    'quant trading',
    'disciplined trading',
    'risk-managed trading bot',
    'MetaApi trading',
  ],
  authors: [{ name: 'ShamarX' }],
  metadataBase: new URL(SITE.url),
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    title: 'ShamarX — Trade with discipline. Not emotion.',
    description: SITE.description,
    url: SITE.url,
    siteName: SITE.name,
    images: [
      {
        url: '/logos/shamarx-logo-horizontal.png',
        width: 1600,
        height: 480,
        alt: 'ShamarX',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ShamarX — Trade with discipline. Not emotion.',
    description: SITE.description,
    images: ['/logos/shamarx-logo-horizontal.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
};

const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE.url}#org`,
      name: 'ShamarX',
      url: SITE.url,
      logo: `${SITE.url}/logos/shamarx-logo-symbol.png`,
      description: SITE.description,
      slogan: 'Guarded by Design',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'ShamarX',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      description: SITE.description,
      url: SITE.url,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Smart Money Concept (SMC) trading engine',
        '24/7 multi-pair candle ingestion',
        'Drawdown-adaptive risk sizing',
        'Daily-loss circuit breaker & kill-switch',
        'Backtesting against real Dukascopy data',
        'Live broker reconciliation',
      ],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE.url}#site`,
      url: SITE.url,
      name: 'ShamarX',
      publisher: { '@id': `${SITE.url}#org` },
    },
  ],
};

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <LandingNavbar />
      <main>
        <LandingHero />
        <TrustStrip />
        <ModulesSection />
        <HowItWorksSection />
        <StrategySpotlight />
        <PrinciplesSection />
        <CtaBand />
      </main>
      <LandingFooter />
    </>
  );
}
