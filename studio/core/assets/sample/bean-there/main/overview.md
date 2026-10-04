# Bean There, the whole system

## Purpose

The one picture of where everything runs and how an order moves. Ordering and Payments have their own diagrams
(click those boxes to go a level deeper).

## Key flow

1. The customer taps an order in the app.
2. The app calls the Orders API over HTTPS.
3. The API charges the card through Payments, then puts the order on the barista queue.

## Open questions

- Fax orders are still typed in by hand; when do they go away?
