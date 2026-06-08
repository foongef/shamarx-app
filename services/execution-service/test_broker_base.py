import pytest
from broker_base import Broker


def test_abstract_methods_required():
    """A subclass missing any abstract method cannot be instantiated."""
    class Incomplete(Broker):
        async def initialize(self): pass
        # missing all other abstract methods

    with pytest.raises(TypeError):
        Incomplete()


def test_full_subclass_instantiates():
    class Complete(Broker):
        async def initialize(self): pass
        async def place_order(self, request): pass
        async def get_positions(self, symbol=None): pass
        async def close_position(self, ticket): pass
        async def modify_position(self, ticket, sl_price, tp_price): pass
        async def get_account_info(self): pass
        async def get_position_close_info(self, ticket): pass
        async def close(self): pass

    inst = Complete()
    assert inst is not None
