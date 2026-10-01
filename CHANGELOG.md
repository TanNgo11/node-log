# Changelog

## 0.1.0

- Core logger implementing log contract v1: normalization, redaction, size limits, async context.
- Adapters: Express, Fastify, NestJS, Next.js (route handlers, onRequestError, edge request id), BullMQ.
- Helpers: createFetch (http.outbound), runJob (job.*), process lifecycle (app.*).
