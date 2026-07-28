{{- define "enac-ai-reviewer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "enac-ai-reviewer.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "enac-ai-reviewer.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "enac-ai-reviewer.labels" -}}
helm.sh/chart: {{ include "enac-ai-reviewer.chart" . }}
{{ include "enac-ai-reviewer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "enac-ai-reviewer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "enac-ai-reviewer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "enac-ai-reviewer.componentLabels" -}}
{{ include "enac-ai-reviewer.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "enac-ai-reviewer.componentSelectorLabels" -}}
{{ include "enac-ai-reviewer.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "enac-ai-reviewer.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "enac-ai-reviewer.webSecretName" -}}
{{- if .Values.web.existingSecret.enabled -}}
{{- required "web.existingSecret.enabled=true but web.existingSecret.name is empty. Set it to your pre-existing Secret's name, or set web.existingSecret.enabled=false to use a chart-managed secret." .Values.web.existingSecret.name -}}
{{- else -}}
{{ include "enac-ai-reviewer.fullname" . }}-web
{{- end -}}
{{- end -}}

{{- define "enac-ai-reviewer.workerSecretName" -}}
{{- if .Values.worker.existingSecret.enabled -}}
{{- required "worker.existingSecret.enabled=true but worker.existingSecret.name is empty. Set it to your pre-existing Secret's name, or set worker.existingSecret.enabled=false to use a chart-managed secret." .Values.worker.existingSecret.name -}}
{{- else -}}
{{ include "enac-ai-reviewer.fullname" . }}-worker
{{- end -}}
{{- end -}}

{{- define "enac-ai-reviewer.databaseSecretName" -}}
{{- if .Values.database.postgresql.enabled -}}
{{- $defaultName := printf "%s-postgresql" (include "enac-ai-reviewer.fullname" .) -}}
{{- default $defaultName .Values.database.existingSecret.name -}}
{{- else -}}
{{- required "database.existingSecret.name must be set to your pre-existing Postgres connection Secret's name, or set database.postgresql.enabled=true." .Values.database.existingSecret.name -}}
{{- end -}}
{{- end -}}

{{- define "enac-ai-reviewer.postgresqlFullname" -}}
{{ include "enac-ai-reviewer.fullname" . }}-postgresql
{{- end -}}

{{- define "enac-ai-reviewer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "enac-ai-reviewer.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
