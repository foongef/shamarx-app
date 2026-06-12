//+------------------------------------------------------------------+
//| ShamarxBridge.mq5 — in-terminal bridge for MT5 Direct (Spec 4)   |
//|                                                                  |
//| File transport via the MQL5\Files sandbox (SocketConnect is      |
//| gated behind a GUI-only whitelist - error 4014 headless).        |
//| Worker writes shamarx_req.txt; EA answers in shamarx_resp.txt.   |
//|                                                                  |
//| Request : <id>|<op>|<args...>\n                                  |
//| Response: <id>|ok|<fields...>\n  or  <id>|err|<message>\n        |
//+------------------------------------------------------------------+
#property strict
#include <Trade\Trade.mqh>

CTrade  trade;
string  lastId = "";

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetDeviationInPoints(20);
   EventSetMillisecondTimer(200);
   Print("bridge: init (file transport)");
   // presence marker so the worker can detect the EA before first request
   int fh = FileOpen("shamarx_alive.txt", FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(fh != INVALID_HANDLE) { FileWriteString(fh, "1"); FileClose(fh); }
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void Send(const string line)
{
   FileDelete("shamarx_resp.txt");
   int fh = FileOpen("shamarx_resp.txt", FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(fh == INVALID_HANDLE) { Print("bridge: resp write failed ", GetLastError()); return; }
   FileWriteString(fh, line);
   FileClose(fh);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   int fh = FileOpen("shamarx_req.txt", FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(fh == INVALID_HANDLE) return;
   string line = FileReadString(fh);
   FileClose(fh);
   StringTrimRight(line);
   if(StringLen(line) == 0) return;
   int sep = StringFind(line, "|");
   if(sep <= 0) return;
   string rid = StringSubstr(line, 0, sep);
   if(rid == lastId) return;
   lastId = rid;
   Handle(line);
}

//+------------------------------------------------------------------+
void Handle(const string line)
{
   string p[];
   int n = StringSplit(line, '|', p);
   if(n < 2) return;
   string id = p[0], op = p[1];

   if(op == "ping")          { Send(id + "|ok|pong"); return; }
   if(op == "account")       { OpAccount(id); return; }
   if(op == "positions")     { OpPositions(id, n > 2 ? p[2] : ""); return; }
   if(op == "order"  && n>=8){ OpOrder(id, p[2], p[3], p[4], p[5], p[6], p[7]); return; }
   if(op == "modify" && n>=5){ OpModify(id, p[2], p[3], p[4]); return; }
   if(op == "close"  && n>=3){ OpClose(id, p[2]); return; }
   if(op == "history"&& n>=3){ OpHistory(id, p[2]); return; }
   if(op == "candles"&& n>=5){ OpCandles(id, p[2], p[3], p[4]); return; }
   Send(id + "|err|unknown op " + op);
}

//+------------------------------------------------------------------+
void OpAccount(const string id)
{
   bool conn = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   Send(id + "|ok|" + (string)(conn ? 1 : 0) + "|" + (string)login + "|" +
        DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "|" +
        DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "|" +
        DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "|" +
        DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + "|" +
        (string)PositionsTotal());
}

void OpPositions(const string id, const string symbol)
{
   string rows = "";
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      if(symbol != "" && sym != symbol) continue;
      if(rows != "") rows += ";";
      rows += (string)ticket + "," + sym + "," +
              ((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "," +
              DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "," +
              DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + "," +
              DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 5) + "," +
              DoubleToString(PositionGetDouble(POSITION_SL), 5) + "," +
              DoubleToString(PositionGetDouble(POSITION_TP), 5) + "," +
              DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + "," +
              (string)PositionGetInteger(POSITION_TIME);
   }
   Send(id + "|ok|" + rows);
}

void OpOrder(const string id, const string symbol, const string side,
             const string lot, const string sl, const string tp, const string comment)
{
   bool isBuy = (side == "BUY");
   double price = isBuy ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                        : SymbolInfoDouble(symbol, SYMBOL_BID);
   bool ok = isBuy
      ? trade.Buy(StringToDouble(lot), symbol, price, StringToDouble(sl), StringToDouble(tp), comment)
      : trade.Sell(StringToDouble(lot), symbol, price, StringToDouble(sl), StringToDouble(tp), comment);
   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE)
      Send(id + "|ok|" + (string)trade.ResultOrder() + "|" + DoubleToString(trade.ResultPrice(), 5));
   else
      Send(id + "|err|retcode=" + (string)trade.ResultRetcode() + " " + trade.ResultRetcodeDescription());
}

void OpModify(const string id, const string ticket, const string sl, const string tp)
{
   if(trade.PositionModify((ulong)StringToInteger(ticket), StringToDouble(sl), StringToDouble(tp)))
      Send(id + "|ok|modified");
   else
      Send(id + "|err|retcode=" + (string)trade.ResultRetcode());
}

void OpClose(const string id, const string ticket)
{
   if(trade.PositionClose((ulong)StringToInteger(ticket)))
      Send(id + "|ok|closed");
   else
      Send(id + "|err|retcode=" + (string)trade.ResultRetcode());
}

void OpHistory(const string id, const string ticket)
{
   ulong posId = (ulong)StringToInteger(ticket);
   if(!HistorySelectByPosition(posId)) { Send(id + "|ok|"); return; }
   double pnl = 0, closePrice = 0;
   long closeTime = 0; string reason = "CLOSED";
   bool found = false;
   for(int i = 0; i < HistoryDealsTotal(); i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      found = true;
      pnl += HistoryDealGetDouble(deal, DEAL_PROFIT)
           + HistoryDealGetDouble(deal, DEAL_COMMISSION)
           + HistoryDealGetDouble(deal, DEAL_SWAP);
      closePrice = HistoryDealGetDouble(deal, DEAL_PRICE);
      closeTime  = HistoryDealGetInteger(deal, DEAL_TIME);
      ENUM_DEAL_REASON r = (ENUM_DEAL_REASON)HistoryDealGetInteger(deal, DEAL_REASON);
      if(r == DEAL_REASON_SL) reason = "SL";
      else if(r == DEAL_REASON_TP) reason = "TP";
   }
   if(!found) { Send(id + "|ok|"); return; }
   Send(id + "|ok|" + DoubleToString(closePrice, 5) + "|" + DoubleToString(pnl, 2) + "|" +
        reason + "|" + (string)closeTime);
}

void OpCandles(const string id, const string symbol, const string tf, const string count)
{
   ENUM_TIMEFRAMES period = PERIOD_M15;
   if(tf == "H1") period = PERIOD_H1;
   else if(tf == "D1") period = PERIOD_D1;
   else if(tf != "M15") { Send(id + "|err|unsupported timeframe " + tf); return; }

   int n = (int)StringToInteger(count);
   MqlRates rates[];
   // start at shift 1 — excludes the forming bar (Candle-table invariant)
   int got = CopyRates(symbol, period, 1, n, rates);
   if(got <= 0) { Send(id + "|err|CopyRates failed " + (string)GetLastError()); return; }
   string rows = "";
   for(int i = 0; i < got; i++)  // rates[] is oldest-first with ArraySetAsSeries false default? CopyRates returns series order
   {
      if(rows != "") rows += ";";
      rows += (string)rates[i].time + "," +
              DoubleToString(rates[i].open, 5) + "," + DoubleToString(rates[i].high, 5) + "," +
              DoubleToString(rates[i].low, 5)  + "," + DoubleToString(rates[i].close, 5) + "," +
              (string)rates[i].tick_volume;
   }
   Send(id + "|ok|" + rows);
}
//+------------------------------------------------------------------+
