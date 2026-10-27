"""
Steps for the example features. "Pay with a gift card" has no step on purpose (Rasto closes it as blocked), and "Pay with
PayPal" fails because the shop shows an error (closed as fail). "Prices" never opens a browser, so it isn't recorded.
"""
from pathlib import Path

from playwright.sync_api import Page, expect
from pytest_bdd import given, parsers, scenarios, then, when

scenarios("features")

SHOP = (Path(__file__).parent / "shop.html").as_uri()


@given("the shop is open")
def shop_is_open(page: Page):
    page.goto(SHOP)


@when(parsers.re(r"I add (?P<count>\d+) notebooks? to my cart"))
def add_to_cart(page: Page, count: str):
    page.fill("#quantity", count)
    page.click("#add")


@when("I pay by card")
def pay_by_card(page: Page):
    page.fill("#name", "Alex Doe")
    page.click("#pay-now")


@when("I pay with PayPal")
def pay_with_paypal(page: Page):
    page.check("[name=method][value=paypal]")
    page.click("#pay-now")


@then("I see the order confirmation")
def order_confirmed(page: Page):
    expect(page.locator("#done")).to_be_visible(timeout=2000)


@given("the price list", target_fixture="prices")
def price_list():
    return {"Notebook": 4.5, "Fountain pen": 18.0, "Coffee beans": 9.9}


@then(parsers.parse("it has {count:d} products"))
def has_products(prices, count):
    assert len(prices) == count
