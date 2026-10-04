# Bean There

## What this is

A sample coffee-shop app that ships with archdraw, so you can try everything without your own code. Customers order
from their phone; the barista sees the queue on a tablet; payments go through a card provider.

## Non-goals

No table service, no inventory, no staff scheduling.

## Invariants

- The Orders API is the only thing that writes orders; the app never talks to the database.
- A payment is authorized before an order reaches the barista queue.
