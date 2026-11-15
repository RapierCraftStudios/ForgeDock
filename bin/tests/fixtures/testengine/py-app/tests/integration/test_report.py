from orders.report import render


def test_render():
    assert render(2) == 2
