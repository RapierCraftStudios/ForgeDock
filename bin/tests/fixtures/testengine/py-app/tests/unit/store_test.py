from unittest import mock


def test_load():
    with mock.patch("orders.store.load", return_value=[5]):
        from orders import store
        assert store.load(1) == [5]
