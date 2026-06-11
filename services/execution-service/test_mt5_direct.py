"""Mt5DirectClient tests — FakeHttp captures the proxied calls."""
import pytest

from mt5_direct_client import Mt5DirectClient
from models import OrderRequest


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.responses = {}

    async def request(self, method, url, **kw):
        self.calls.append((method, url, kw.get('json')))

        class R:
            def __init__(self, data):
                self._d = data
                self.status_code = 200

            def json(self):
                return self._d

        key = url.split('/')[-1].split('?')[0]
        return R(self.responses.get(key, {}))


def _client():
    c = Mt5DirectClient(base_url='http://10.0.2.48:8100',
                        account_id='acct-1', secret='s3cret')
    c._http = FakeHttp()
    return c


@pytest.mark.asyncio
async def test_place_order_posts_to_proxied_worker():
    c = _client()
    c._http.responses['orders'] = {'orderId': '9', 'mt5Ticket': 9,
                                   'status': 'FILLED', 'message': 'done'}
    res = await c.place_order(OrderRequest(
        symbol='EURUSD', side='BUY', lotSize=0.1,
        entryPrice=1.08, slPrice=1.07, tpPrice=1.1))
    method, url, body = c._http.calls[0]
    assert method == 'POST'
    assert url == 'http://10.0.2.48:8100/t/acct-1/orders'
    assert body['slPrice'] == 1.07
    assert res.mt5_ticket == 9
    assert res.status == 'FILLED'


@pytest.mark.asyncio
async def test_get_positions_maps_through():
    c = _client()
    c._http.responses['positions'] = [{
        'ticket': 1, 'symbol': 'EURUSD', 'side': 'BUY', 'lotSize': 0.1,
        'entryPrice': 1.0, 'currentPrice': 1.0, 'sl': 0.0, 'tp': 0.0,
        'pnl': 0.0, 'openTime': '0'}]
    out = await c.get_positions()
    assert out[0]['ticket'] == 1


@pytest.mark.asyncio
async def test_account_info_parses_model():
    c = _client()
    c._http.responses['account-info'] = {
        'balance': 1000.0, 'equity': 1001.5, 'margin': 10.0,
        'freeMargin': 991.5, 'openPositions': 2}
    info = await c.get_account_info()
    assert info.equity == 1001.5
    assert info.open_positions == 2


@pytest.mark.asyncio
async def test_modify_position_hits_path():
    c = _client()
    c._http.responses['modify'] = {'status': 'OK'}
    await c.modify_position(42, sl_price=1.07, tp_price=1.10)
    method, url, body = c._http.calls[0]
    assert url.endswith('/t/acct-1/positions/42/modify')
    assert body == {'slPrice': 1.07, 'tpPrice': 1.10}


def test_from_creds_reads_spec3_convention(monkeypatch):
    monkeypatch.setenv('MT5_MANAGER_SECRET', 'topsecret')
    c = Mt5DirectClient.from_creds({
        'managerUrl': 'http://10.0.2.48:8100',
        'brokerAccountId': 'acct-9',
        'login': '52867017', 'password': 'x', 'server': 'ICMarketsSC-Demo'})
    assert c.base_url == 'http://10.0.2.48:8100'
    assert c.account_id == 'acct-9'
    assert c.secret == 'topsecret'
