import Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'get_account_risk_state',
    description:
      'Get current account risk state including balance, equity, daily PnL, consecutive losses, open positions, and all risk limit thresholds. Use this to verify the account can take on new risk.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_market_snapshot',
    description:
      'Get current XAUUSD M15 market snapshot including price, EMA20/50/200, RSI14, ATR14, and latest candle data. Use this to verify technical alignment of the trade setup.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_structure_context',
    description:
      'Get H1 market structure context including bias direction, recent swing highs/lows, and last break of structure direction. Use this to verify higher-timeframe alignment.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_sr_levels',
    description:
      'Get active support and resistance levels with their strength scores. Use this to verify stop loss and take profit placement relative to key levels.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_economic_risk',
    description:
      'Get upcoming high-impact economic events and whether the current period is high-risk for trading. Use this to check for news-related risks.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_spread_stats',
    description:
      'Get current and historical spread statistics for XAUUSD including current spread, 1-hour average, and whether spread is elevated. Use this to verify execution conditions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
