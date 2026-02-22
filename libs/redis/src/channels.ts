export const REDIS_CHANNELS = {
  CANDLE_STORED: 'candle:stored',
  TRADE_OPENED: 'trade:opened',
  TRADE_CLOSED: 'trade:closed',
  TRADE_REJECTED: 'trade:rejected',
  CANDIDATE_CREATED: 'candidate:created',
  LLM_DECISION: 'llm:decision',
  RISK_STATE_UPDATED: 'risk:state:updated',
} as const;
