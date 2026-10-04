# Ordering, end to end

## Purpose

What happens between "place order" and "your coffee is ready".

## Key flow

1. The app places the order; the API stores it and enqueues it.
2. The barista tablet takes the next order from the queue.
3. When it is made, the tablet tells the push service, which notifies the customer.
