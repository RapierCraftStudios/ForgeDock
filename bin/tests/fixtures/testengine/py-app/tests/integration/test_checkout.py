import orders.service


def test_checkout(order_id):
    assert orders.service.checkout(order_id) > 0
