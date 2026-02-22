export const SYMBOL = 'XAUUSD';

export const POINT_VALUE = 0.01; // XAUUSD point value
export const LOT_SIZE_UNITS = 100; // 1 lot = 100 oz for gold

export const SERVICE_URLS = {
  EXECUTION: process.env.EXECUTION_SERVICE_URL || 'http://localhost:8000',
};
