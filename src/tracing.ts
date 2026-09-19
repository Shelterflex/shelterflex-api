import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import {
  TraceIdRatioBasedSampler,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { env } from "./schemas/env.js";

// Simple helper to parse headers from ENV string if provided (key=value,key2=value2)
const parseHeaders = (headerStr?: string): Record<string, string> => {
  if (!headerStr) return {};
  return headerStr.split(",").reduce(
    (acc, part) => {
      const [key, val] = part.split("=");
      if (key && val) acc[key.trim()] = val.trim();
      return acc;
    },
    {} as Record<string, string>,
  );
};

const otlpExporter = new OTLPTraceExporter({
  url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
});

// Console span export is opt-in. It prints every span - including the background
// worker polls that run on a timer with no traffic - to stdout, which drowns the
// application's own logs. Default is OTLP regardless of NODE_ENV.
const traceExporter = env.OTEL_CONSOLE_EXPORTER
  ? new ConsoleSpanExporter()
  : otlpExporter;

const sampler = new ParentBasedSampler({
  root: new TraceIdRatioBasedSampler(env.OTEL_SAMPLING_RATIO),
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
    [SEMRESATTRS_SERVICE_VERSION]: env.VERSION,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: env.NODE_ENV,
  }),
  traceExporter,
  sampler: sampler,
  instrumentations: [
    new HttpInstrumentation({
      // We can also filter out health checks if we wanted.
    }),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
  ],
});

// Initialize the SDK and register with the OpenTelemetry API
// this enables the instrumentations to patch the modules
try {
  sdk.start();
  console.log("[backend] OpenTelemetry initialized");
} catch (error) {
  console.error("[backend] Error initializing OpenTelemetry", error);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("[backend] OpenTelemetry terminated"))
    .catch((error) =>
      console.log("[backend] Error terminating OpenTelemetry", error),
    )
    .finally(() => process.exit(0));
});

export default sdk;
