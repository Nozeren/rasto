Feature: Checkout

  Background:
    Given the shop is open

  @C101
  Scenario: Pay by card
    When I add 1 notebook to my cart
    And I pay by card
    Then I see the order confirmation

  @C102
  Scenario: Pay with PayPal
    When I add 3 notebooks to my cart
    And I pay with PayPal
    Then I see the order confirmation

  @C103
  Scenario: Pay with a gift card
    When I add 2 notebooks to my cart
    And I pay with a gift card
    Then I see the order confirmation
