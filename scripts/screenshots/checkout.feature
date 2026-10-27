Feature: Checkout

  Background:
    Given I am logged in as a customer

  @C1042
  Scenario Outline: Pay for an order
    Given I have <items> items in my cart
    When I open the cart
    And I pay with <method>
    Then I see the order confirmation
    And I receive a receipt by email

    Examples:
      | items | method      |
      | 1     | credit card |
      | 3     | PayPal      |
