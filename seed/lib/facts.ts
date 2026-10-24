/**
 * DEMO DATA. The fact sheet for "Acme Cloud", a fictional subscription-billing SaaS. Every
 * generated article, runbook, ticket and account is grounded in these facts, so the knowledge
 * base and the tickets agree with each other (prices, policies, SLAs). Change a fact here, not in
 * a prompt.
 */
export const COMPANY_FACTS = `
Acme Cloud is a FICTIONAL company. Its product, Acme Billing, is subscription billing and invoicing
software for small and mid-sized businesses (our "customers"). Our customers use it to bill THEIR
own customers ("end customers").

Plans (billed monthly; annual billing = 12 months for the price of 10):
- Starter: $29/month (₹2,399 in India). Up to 100 invoices/month, 1 payment gateway, email support.
- Growth: $99/month (₹7,999). Up to 2,000 invoices/month, 3 gateways, dunning, usage-based
  billing, QuickBooks/Xero sync, customer portal.
- Scale: $299/month (₹24,999). Unlimited invoices, SSO (SAML), audit log, API rate limit 600
  requests/minute (others: 120/minute), 99.9% uptime SLA.
- Enterprise: custom pricing, dedicated success manager.
- 14-day free trial on Starter and Growth. No card required for the trial.

Integrations: Stripe, Razorpay (supports UPI, cards, netbanking), PayPal; QuickBooks Online, Xero;
webhooks (signed with HMAC-SHA256, header "Acme-Signature"; retried 8 times over 24 hours with
exponential backoff); REST API at api.acmecloud.example/v2 with API keys (prefix "ak_live_" /
"ak_test_").

Billing policies for Acme's own subscription:
- Monthly plans are not refundable, except duplicate charges and billing errors, which are always
  refunded in full.
- Annual plans can be refunded pro rata within 30 days of the renewal date.
- Duplicate charges are refunded to the original payment method within 5-7 business days.
- Upgrades take effect immediately and are prorated. Downgrades take effect at the next renewal.
- A failed payment is retried on days 1, 3 and 7. After the third failure the account becomes
  read-only ("suspended"); updating the card and paying restores it instantly. Data is never
  deleted because of a failed payment.
- Cancelled accounts stay readable for 30 days, then data is deleted permanently. Export first.
- GST invoices (India) and VAT invoices (EU/UK) are available under Settings > Billing > Tax details
  once a GSTIN or VAT number is saved. Invoices cannot be re-issued for past months with a new
  tax number; a credit note + new invoice is issued instead, on request.
- Coupons apply to the next invoice, not to invoices already paid.

Support:
- Support hours: 24x5 (Monday 00:00 to Friday 23:59 UTC). Weekend coverage for Scale and above.
- First-response targets: Starter 48h, Growth 24h, Scale 4h, Enterprise 1h for urgent issues.
- Status page: status.acmecloud.example. Uptime SLA 99.9% monthly on Scale/Enterprise; service
  credits of 10% (below 99.9%) or 25% (below 99.0%) of that month's fee, claimed within 30 days.
- Security: Acme staff never ask for passwords or full card numbers. 2FA via authenticator app.
  Vulnerabilities: security@acmecloud.example. Account owner changes require the current owner's
  confirmation, or ID verification if the owner has left.

Product areas: invoices and credit notes, recurring subscriptions, dunning for end customers
(configurable retry schedule and reminder emails), usage-based (metered) billing, taxes
(GST, VAT, US sales tax), multi-currency (35 currencies), customer portal, invoice templates and PDF
generation, invoice emails (sent from billing@<customer-domain> after domain verification, or
from notifications@acmecloud.example), CSV import/export, team roles (Owner, Admin, Finance,
Viewer), SSO on Scale+.
`.trim();

export const COMPANY_NAME = "Acme Cloud";
