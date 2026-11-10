import { OpenTelemetry } from '@ai-sdk/otel';
import { context, diag, DiagConsoleLogger, DiagLogLevel, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerTelemetry } from 'ai';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// OTLP exporters report failures through the diag logger, which is a silent
// no-op unless one is registered — without this, a misconfigured endpoint
// (unreachable, 401, …) fails invisibly. OTEL_LOG_LEVEL tunes the verbosity
// (e.g. "debug" when debugging exports, see the DiagLogLevel docs).
diag.setLogger(new DiagConsoleLogger(), {
  logLevel: DiagLogLevel[(process.env.OTEL_LOG_LEVEL ?? 'WARN') as keyof typeof DiagLogLevel] ?? DiagLogLevel.WARN,
});

// The SDK only starts when an OTLP endpoint is configured (and not explicitly
// disabled): the exporters otherwise retry against their localhost default
// forever, which would spam deployments that have no collector yet.
const enabled =
  process.env.OTEL_SDK_DISABLED !== 'true' && process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;

const sdk = enabled
  ? new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'enac-ai-reviewer',
      traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT etc.
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 60_000,
        }),
      ],
      instrumentations: [
        getNodeAutoInstrumentations({
          // trim the noisy low-level ones
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
        }),
      ],
    })
  : null;
sdk?.start();

// Route AI SDK lifecycle events into the same OTel pipeline: every LLM call
// gets spans (with prompt/output content — see src/llm/client.ts), which in
// particular gives per-call error spans when a generation fails. No-op when
// the SDK is disabled (no OTel pipeline to send to).
if (enabled) registerTelemetry(new OpenTelemetry());

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown().catch(() => {}); // flush pending spans
}

/** pino mixin: attach the active span's ids so logs cross-reference traces. */
export function otelTraceMixin(): Record<string, string> {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
}
