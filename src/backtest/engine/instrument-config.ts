export interface InstrumentConfig {
  lotSizeUnits: number;
  commissionPerLot: number;
  minAtr: number;
  pricePrecision: number;     // decimal places for price rounding (2 for gold, 5 for forex, 3 for JPY)
  spreads: {
    londonNyOverlap: number;
    london: number;
    nyExtended: number;
    asian: number;
    offHours: number;
  };
}

export const INSTRUMENT_CONFIGS: Record<string, InstrumentConfig> = {
  XAUUSD: {
    lotSizeUnits: 100,        // 100 oz per lot
    commissionPerLot: 7.0,    // $7 round-trip (Pepperstone Raw)
    minAtr: 3.5,
    pricePrecision: 2,
    spreads: {
      londonNyOverlap: 0.20,
      london: 0.25,
      nyExtended: 0.30,
      asian: 0.50,
      offHours: 0.40,
    },
  },
  GBPUSD: {
    lotSizeUnits: 100_000,    // 100k units per lot
    commissionPerLot: 7.0,
    minAtr: 0.0020,
    pricePrecision: 5,
    spreads: {
      londonNyOverlap: 0.00020,
      london: 0.00025,
      nyExtended: 0.00030,
      asian: 0.00050,
      offHours: 0.00040,
    },
  },
  EURUSD: {
    lotSizeUnits: 100_000,
    commissionPerLot: 7.0,
    minAtr: 0.0018,
    pricePrecision: 5,
    spreads: {
      londonNyOverlap: 0.00015,
      london: 0.00020,
      nyExtended: 0.00025,
      asian: 0.00045,
      offHours: 0.00035,
    },
  },
  USDJPY: {
    lotSizeUnits: 100_000,
    commissionPerLot: 7.0,
    minAtr: 0.15,
    pricePrecision: 3,
    spreads: {
      londonNyOverlap: 0.015,
      london: 0.020,
      nyExtended: 0.025,
      asian: 0.040,
      offHours: 0.030,
    },
  },
  US30: {
    lotSizeUnits: 1,             // $1 per point per lot (Pepperstone index CFD)
    commissionPerLot: 0,         // No commission — spread only
    minAtr: 30,                  // ~30 points minimum M15 ATR
    pricePrecision: 1,
    spreads: {
      londonNyOverlap: 2.4,     // US regular session — tightest
      london: 3.6,              // Pre-US European morning
      nyExtended: 2.4,          // US afternoon
      asian: 8.0,               // After-hours — very wide
      offHours: 4.8,            // Post-close
    },
  },
  NAS100: {
    lotSizeUnits: 1,             // $1 per point per lot (Pepperstone index CFD)
    commissionPerLot: 0,         // No commission — spread only
    minAtr: 20,                  // ~20 points minimum M15 ATR
    pricePrecision: 1,
    spreads: {
      londonNyOverlap: 1.0,     // US regular session — tightest
      london: 1.9,              // Pre-US European morning
      nyExtended: 1.0,          // US afternoon
      asian: 4.0,               // After-hours
      offHours: 1.9,            // Post-close
    },
  },
};

export function getInstrumentConfig(symbol: string): InstrumentConfig {
  const config = INSTRUMENT_CONFIGS[symbol];
  if (!config) {
    throw new Error(`Unknown instrument: ${symbol}. Supported: ${Object.keys(INSTRUMENT_CONFIGS).join(', ')}`);
  }
  return config;
}
