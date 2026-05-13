# AGENTS.md

This repository explores a Walkie Tokie relay for agent-assisted PR review.

Before adding code, check the design against:

- architecture and lifecycle semantics
- API contracts and stable request shapes
- crate/module boundaries
- future proto/gRPC shape
- OpenTelemetry correctness
- naming precision
- validation coverage for new execution surfaces
- extension/decorator seam completeness
- public surface bloat

Keep the first implementation small. Prefer documented seams over broad public
APIs. Do not expose arbitrary shell or filesystem access as a review capability.

