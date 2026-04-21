export * from "./generated/api";
export * from "./generated/types";

// Orval emits these three names in BOTH ./generated/api (as inline operation
// param/response schemas) and ./generated/types/* (as separate per-type
// files re-exported via the types barrel). The two emissions are
// structurally identical zod schemas. We pick ./generated/api as the
// canonical source to silence TS2308 ambiguity errors. If a future orval
// upgrade stops double-emitting, this block becomes a no-op.
export {
  ExportJobParams,
  GetRouterUptimeParams,
  ImportRoutersResponse,
} from "./generated/api";
