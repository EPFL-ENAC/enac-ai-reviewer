import { context, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

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

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown().catch(() => {}); // flush pending spans
}

/** pino mixin: attach the active span's ids so logs cross-reference traces. */
export function otelTraceMixin(): Record<string, string> {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
}
