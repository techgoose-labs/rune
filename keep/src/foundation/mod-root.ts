// keep's export root. Everything the runtime substrate owns — the mount
// primitive, the in-process client, the jar, the contract stamp, the logger,
// the tracer — now lives in @mrg-keystone/bedrock and is RE-EXPORTED here for
// exactly one release (D-6), so a 6.x app upgrades without a codemod. Import
// them from `@mrg-keystone/bedrock` in new code; they leave keep in 8.0.
export { Server } from "@foundation/domain/business/server/mod.ts";
export {
  checkBody,
  jsonDepth,
  MAX_BODY_BYTES,
  MAX_JSON_DEPTH,
} from "@foundation/domain/business/body-gateway/mod.ts";
export {
  canonicalize,
  emitContractOpenApi,
  mergedOpenApiDoc,
  sha256Hex,
  stampSpecHash,
} from "@mrg-keystone/bedrock/artifact";
export {
  DanetHttpAdapter,
  HttpAdapter,
} from "@foundation/domain/data/http-adapter/mod.ts";
export { SwaggerDescription } from "@foundation/domain/business/swagger-description/mod.ts";
export { setupWithSwagger } from "@foundation/domain/coordinators/setup-with-swagger/mod.ts";
export { DanetDocumentBuilder } from "@foundation/domain/business/document-builder/mod.ts";
export { bootstrapServer } from "@foundation/domain/coordinators/bootstrap-server/mod.ts";
export type {
  BootstrapOptions,
  ServerDisposer,
  ServerLifecycle,
} from "@foundation/domain/coordinators/bootstrap-server/mod.ts";
export {
  InjectClass,
  InjectFactory,
  InjectValue,
} from "@foundation/domain/business/injectable-builders/mod.ts";
// --- lifted to bedrock, re-exported for one release (D-6) -----------------
// The in-process client is now bedrock's ONE client, provisioned per scope.
// `createBackendClient` and `INTERNAL_REQUEST_HEADER` are GONE, not renamed:
// there is no trust header any more (the channel is an envelope fact), and a
// client built by hand would dispatch outside the instrumented root.
export {
  collectSetCookies,
  createKvTraceSink,
  KvTraceSink,
  log,
  Logger,
  logger,
  MemoryTraceSink,
  RequestJar,
  span,
  Traced,
  Tracer,
  tracer,
  traceShipper,
  traceUser,
  withBasePath,
} from "@mrg-keystone/bedrock";
export type { LogLevel, Span, Trace, TraceSink } from "@mrg-keystone/bedrock";
export { traceShellHtml } from "@foundation/domain/business/trace-ui/mod.ts";
export {
  Backend,
  KEEP_NAMESPACE,
  policyFromDocs,
} from "@foundation/domain/coordinators/bootstrap-server/mod.ts";
export type { BackendOptions } from "@foundation/domain/coordinators/bootstrap-server/mod.ts";
export type { KeepUnit } from "@foundation/domain/coordinators/bootstrap-server/mod.ts";
// The composition algebra itself: `Bedrock` composes, `of` reads the envelope
// a controller was reached with, and `Unit`/`Bag`/`Identity` are its types.
export { Bedrock, of } from "@mrg-keystone/bedrock";
export {
  channel,
  identity,
  requestId,
} from "@foundation/domain/business/identity/mod.ts";
export type {
  Access,
  App,
  Bag,
  Channel,
  Identity,
  Policy,
  Unit,
} from "@mrg-keystone/bedrock";
export type { FetchHandler } from "@types";
export {
  createDocsJsonHandler,
  injectDocsScript,
  swaggerShellHtml,
} from "@foundation/domain/business/docs-ui/mod.ts";
export type { DocsJsonHandlerOptions } from "@foundation/domain/business/docs-ui/mod.ts";
export {
  appModule,
  Endpoint,
  EndpointController,
  endpointModule,
  getProcessMetadata,
  getWsProcessMetadata,
  PROCESS_METADATA_KEY,
  WS_PROCESS_METADATA_KEY,
  WsEndpoint,
  WsEndpointController,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";
export type {
  EndpointMethod,
  EndpointOptions,
  ProcessMetadata,
  WsEndpointOptions,
  WsProcessMetadata,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";
export { endpointsFromDoc } from "@foundation/domain/business/endpoint-spec/mod.ts";
export type {
  SpecEndpoint,
  SpecField,
  SpecParam,
} from "@foundation/domain/business/endpoint-spec/mod.ts";
export { processOrder } from "@foundation/domain/business/process-graph/mod.ts";
export type {
  ProcessGraph,
  ProcessOperation,
} from "@foundation/domain/business/process-graph/mod.ts";
export { createLimiter } from "@foundation/domain/business/rate-limiter/mod.ts";
export type {
  Limiter,
  RateLimitOptions,
} from "@foundation/domain/business/rate-limiter/mod.ts";
export {
  emulatorShellHtml,
  orderedEndpoints,
} from "@foundation/domain/business/emulator-ui/mod.ts";
export {
  buildMapModel,
  mapShellHtml,
} from "@foundation/domain/business/map-ui/mod.ts";
export type {
  MapEdge,
  MapLane,
  MapModel,
  MapNode,
} from "@foundation/domain/business/map-ui/mod.ts";
export { exerciseEndpoints } from "@foundation/domain/coordinators/exercise-harness/mod.ts";
export type {
  EndpointResult,
  ExerciseAuth,
  ExerciseOptions,
  ExerciseReport,
  ExerciseTarget,
  SeedOverrides,
} from "@foundation/domain/coordinators/exercise-harness/mod.ts";
export type {
  OpenApiDocument,
  OpenApiOperation,
  ProcessExtension,
  SwaggerDocEntry,
} from "@types";
