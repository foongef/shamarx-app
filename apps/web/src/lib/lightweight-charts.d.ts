// Augment lightweight-charts to export series definitions missing from d.ts
import { SeriesDefinition } from 'lightweight-charts';

declare module 'lightweight-charts' {
  export const AreaSeries: SeriesDefinition<'Area'>;
  export const LineSeries: SeriesDefinition<'Line'>;
  export const CandlestickSeries: SeriesDefinition<'Candlestick'>;
  export const BarSeries: SeriesDefinition<'Bar'>;
  export const BaselineSeries: SeriesDefinition<'Baseline'>;
  export const HistogramSeries: SeriesDefinition<'Histogram'>;
}
