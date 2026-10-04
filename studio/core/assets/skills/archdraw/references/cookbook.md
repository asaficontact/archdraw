# Cookbook

Tested shapes for the parts every architecture diagram has. Each snippet goes after the file header and the house
style block (`archdraw/references/conventions.md`), and each was rendered with the engine, exit 0, with that block above it. Take one,
rename the ids and texts to what the code calls things, and re-check: a snippet pasted beside other nodes can collide
with them, and the engine will say which pair.

## 1. A request path through tiers

The main flow left to right, one tier per box, each edge naming its mechanism.

```archdraw
node user  "Customer"  icon: laptop
node web   "Web app / [dim]Next.js[/dim]"  right of user (gap: wide)  style: ours
node api   "Orders API / [dim]FastAPI[/dim]"  right of web (gap: wide)  style: ours
node db    "Orders / [dim]Postgres[/dim]"  right of api (gap: wide)  style: store

edge user -> web  "HTTPS"  from: right  to: left
edge web -> api   "REST, JWT"  from: right  to: left
edge api -> db    "SQL"  from: right  to: left
```

## 2. An async queue and its worker

The producer does not wait (`async`); the worker pulls, so its arrow points at the queue.

```archdraw
node api     "Orders API"  style: ours
node queue   "orders / [dim]SQS queue[/dim]"  right of api (gap: wide)  style: store
node worker  "Fulfilment worker"  right of queue (gap: wide)  style: job
node db      "Orders"  below worker  style: store

edge api -> queue     "publish"  from: right  to: left  style: async
edge worker -> queue  "poll"  from: left  to: right
edge worker -> db     "SQL"  from: bottom  to: top
```

## 3. A cron or scheduled job

The schedule is in the job's qualifier; nothing draws a clock or an edge from one.

```archdraw
node cron  "Nightly cleanup / [dim]cron, 02:00 UTC[/dim]"  style: job
node db    "Sessions / [dim]Redis[/dim]"  right of cron (gap: wide)  style: store

edge cron -> db  "DEL expired"  from: right  to: left
```

## 4. An external API with a webhook back

Our call out, and the provider's later call in, as two edges: the second is `async` and lands on the handler that
receives it.

```archdraw
node pay     "Payments service"  style: ours
node stripe  "Stripe"  right of pay (gap: wide)  style: ext
node hook    "Webhook handler / [dim]/hooks/stripe[/dim]"  below pay  style: ours

edge pay -> stripe   "create charge, HTTPS"  from: right  to: left
edge stripe -> hook  "webhook, signed"  from: bottom  to: right  style: async
```

## 5. Data stores

The store's text names what it holds; the qualifier names the technology. Two stores off one service stack as a
list when their placement is identical.

```archdraw
node api    "API"  style: ours
node db     "Orders, users / [dim]Postgres[/dim]"  right of api (gap: wide)  style: store
node cache  "Sessions / [dim]Redis, 15 min TTL[/dim]"  right of api (gap: wide)  style: store

edge api -> db     "SQL"  from: right  to: left
edge api -> cache  "GET, SET"  from: right  to: left
```

## 6. A document or artifact

Something produced rather than run gets the folded corner. It initiates nothing, so every arrow points at it.

```archdraw
node job      "Export job / [dim]cron, weekly[/dim]"  style: job
node csv      "orders.csv / [dim]in S3[/dim]"  right of job (gap: wide)  shape: document
node analyst  "Analyst"  right of csv (gap: wide)  icon: desktop

edge job -> csv      "writes"  from: right  to: left
edge analyst -> csv  "downloads"  from: left  to: right
```

## 7. Deployment zones side by side (trust boundaries)

Each zone is where its children run; the edges that cross a zone border carry the authentication. Zones are placed
against zones and their tops lined up; children stack inside in written order.

```archdraw
node browser      "User's browser"  style: zone
node browser.app  "Web app / [dim]React[/dim]"  style: ours

node vercel       "Vercel"  right of browser (gap: wide)  top level with browser  style: zone
node vercel.api   "API routes"  style: ours
node vercel.cron  "Cleanup / [dim]cron, hourly[/dim]"  style: job

node aws          "AWS  [dim]private VPC[/dim]"  right of vercel (gap: wide)  top level with vercel  style: zone
node aws.db       "Orders / [dim]Postgres[/dim]"  style: store

edge browser.app -> vercel.api  "HTTPS, session cookie"  from: right  to: left
edge vercel.api -> aws.db       "SQL, TLS"  from: right  to: left
edge vercel.cron -> aws.db      "SQL"  from: right  to: left
```

## 8. A user or a device

A person is a picture with their role as text; the picture shows no text unless you write one.

```archdraw
node reader  "Reader / [dim]browser[/dim]"  icon: laptop
node site    "Reader site"  right of reader (gap: wide)  style: ours

edge reader -> site  "HTTPS"  from: right  to: left
```

## 9. A note

The one thing a reader would get wrong, anchored to the node it is about, wrapped, small and muted.

```archdraw
node api  "Orders API"  style: ours
node db   "Orders"  right of api (gap: wide)  style: store

edge api -> db  "SQL"  from: right  to: left

node api_note "The API is the only writer of orders; the apps never reach the database." (wrap: 36)  shape: none  style: note  below api (gap: tight)  left level with api
```

## 10. A drill-down link

The node that a detail diagram expands carries its link. Lowercase project and file slugs only.

```archdraw
node api  "Orders API"  style: ours  url: "#/bean-there/ordering"
node pay  "Payments"  right of api (gap: wide)  style: ours  url: "#/bean-there/payments"

edge api -> pay  "charge"  from: right  to: left
```

## 11. A fan-out from one service

Three nodes with the identical placement form one list, centered on the target, in written order. Give each its own
edge with sides.

```archdraw
node api     "Notifications API"  style: ours
node email   "Postmark / [dim]email[/dim]"  right of api (gap: wide)  style: ext
node sms     "Twilio / [dim]SMS[/dim]"  right of api (gap: wide)  style: ext
node push    "FCM / [dim]push[/dim]"  right of api (gap: wide)  style: ext

edge api -> email  "HTTPS"  from: right  to: left
edge api -> sms    "HTTPS"  from: right  to: left
edge api -> push   "HTTPS"  from: right  to: left
```

## 12. Steps over time, by place

For a flow diagram: a muted header per place, steps numbered and stacked down the page under their place's header.

```archdraw
style lane  text: (color: theme-muted)

node h_app  "APP"  shape: none  style: lane
node h_api  "ORDERS API"  shape: none  style: lane  right of h_app (gap: 120)  level with h_app

node tap     "1 Tap order"  below h_app  left level with h_app  style: ours
node create  "2 Create order"  below h_api  left level with h_api  style: ours
node charge  "3 Charge card"  below create  left level with create  style: ours
node shown   "4 Show receipt"  below tap (gap: 90)  left level with tap  style: ours

edge tap -> create     "POST /orders"  from: right  to: left
edge create -> charge  "Stripe"
edge charge -> shown   "201, receipt"  from: left  to: right
```
