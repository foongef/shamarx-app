"""
Broker abstract base class. MetaApiMT5 and MockMT5 implement this contract.
Adding a new broker (e.g. Moo Moo in a future spec) means implementing
these 8 methods — no scattered if/else across the codebase.
"""
from abc import ABC, abstractmethod
from typing import Optional


class Broker(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def place_order(self, request) -> object: ...

    @abstractmethod
    async def get_positions(self, symbol: Optional[str] = None) -> list: ...

    @abstractmethod
    async def close_position(self, ticket: int) -> dict: ...

    @abstractmethod
    async def modify_position(self, ticket: int, sl_price: float, tp_price: float) -> dict: ...

    @abstractmethod
    async def get_account_info(self) -> object: ...

    @abstractmethod
    async def get_position_close_info(self, ticket: int) -> Optional[dict]: ...

    @abstractmethod
    async def close(self) -> None: ...
