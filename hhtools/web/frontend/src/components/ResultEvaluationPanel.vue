<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  ComparisonPreset,
  ResultDiagnostics,
  WorkflowId,
} from '../runtime/types'
import { loadWorkspacePreferences } from '../runtime/workspace-preferences'

const props = defineProps<{
  workflow: WorkflowId
}>()

const diagnostics = ref<ResultDiagnostics | null>(null)
const comparisonPreset = ref<ComparisonPreset>(
  loadWorkspacePreferences().comparisonPresets[props.workflow],
)

const presets: Array<{ id: ComparisonPreset, label: string }> = [
  { id: 'source', label: '源数据' },
  { id: 'target', label: '缩放目标' },
  { id: 'result', label: '机器人结果' },
  { id: 'overlay', label: '叠加对比' },
]

const quality = computed(() => {
  if (!diagnostics.value?.available || !diagnostics.value.tracking) {
    return { label: '诊断不可用', tone: 'neutral' }
  }
  const p95 = diagnostics.value.tracking.p95_error_m
  if (p95 <= 0.05) return { label: '跟踪稳定', tone: 'good' }
  if (p95 <= 0.1) return { label: '建议复核', tone: 'warning' }
  return { label: '偏差较大', tone: 'danger' }
})

const chart = computed(() => {
  const series = diagnostics.value?.tracking?.series ?? []
  if (series.length < 2) return null
  const width = 320
  const height = 72
  const maxError = Math.max(...series.map((point) => point.max_error_m), 0.001)
  const points = (key: 'mean_error_m' | 'max_error_m'): string => series
    .map((point, index) => {
      const x = index * width / Math.max(1, series.length - 1)
      const y = height - (point[key] / maxError) * (height - 8) - 4
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return {
    width,
    height,
    mean: points('mean_error_m'),
    max: points('max_error_m'),
    maxError,
  }
})

const worstEffectors = computed(() =>
  (diagnostics.value?.tracking?.effectors ?? []).slice(0, 5),
)

function formatCm(value: number | null | undefined): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)} cm`
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${(value * 100).toFixed(0)}%`
}

function receiveDiagnostics(event: WindowEventMap['hhtools:result-diagnostics']): void {
  if (event.detail.workflow !== props.workflow) return
  diagnostics.value = event.detail.diagnostics
  comparisonPreset.value = event.detail.comparisonPreset
}

function receiveComparison(event: WindowEventMap['hhtools:comparison-state']): void {
  if (event.detail.workflow !== props.workflow) return
  comparisonPreset.value = event.detail.preset
}

function setComparison(preset: ComparisonPreset): void {
  window.dispatchEvent(new CustomEvent('hhtools:comparison-command', {
    detail: { workflow: props.workflow, preset },
  }))
}

onMounted(() => {
  window.addEventListener('hhtools:result-diagnostics', receiveDiagnostics)
  window.addEventListener('hhtools:comparison-state', receiveComparison)
})

onBeforeUnmount(() => {
  window.removeEventListener('hhtools:result-diagnostics', receiveDiagnostics)
  window.removeEventListener('hhtools:comparison-state', receiveComparison)
})
</script>

<template>
  <section v-if="diagnostics" class="card result-evaluation" aria-label="结果评估">
    <header class="result-evaluation-head">
      <div>
        <h3>结果评估</h3>
        <p>缩放目标与机器人结果的快速诊断</p>
      </div>
      <span class="result-quality" :class="`tone-${quality.tone}`">{{ quality.label }}</span>
    </header>

    <div class="comparison-presets" role="group" aria-label="结果对比视图">
      <button
        v-for="preset in presets"
        :key="preset.id"
        type="button"
        :class="{ active: comparisonPreset === preset.id }"
        :aria-pressed="comparisonPreset === preset.id"
        @click="setComparison(preset.id)"
      >
        {{ preset.label }}
      </button>
    </div>

    <p v-if="!diagnostics.available" class="result-diagnostics-empty" role="status">
      {{ diagnostics.reason || '当前结果没有足够的映射数据可供诊断。' }}
    </p>

    <template v-else-if="diagnostics.tracking">
      <div class="result-metrics">
        <div class="result-metric">
          <span>平均误差</span>
          <strong>{{ formatCm(diagnostics.tracking.mean_error_m) }}</strong>
        </div>
        <div class="result-metric">
          <span>P95 误差</span>
          <strong>{{ formatCm(diagnostics.tracking.p95_error_m) }}</strong>
        </div>
        <div class="result-metric">
          <span>接触一致率</span>
          <strong>{{ diagnostics.contact?.available ? formatPercent(diagnostics.contact.agreement_ratio) : '—' }}</strong>
        </div>
        <div class="result-metric">
          <span>接触期足部滑移</span>
          <strong>{{ diagnostics.contact?.available ? formatCm(diagnostics.contact.target_slide_mean_mps) + '/s' : '—' }}</strong>
        </div>
      </div>

      <div v-if="chart" class="tracking-chart-wrap">
        <div class="tracking-chart-head">
          <span>逐帧位置误差</span>
          <span>峰值 {{ formatCm(chart.maxError) }}</span>
        </div>
        <svg
          class="tracking-chart"
          :viewBox="`0 0 ${chart.width} ${chart.height}`"
          preserveAspectRatio="none"
          role="img"
          aria-label="逐帧平均与最大位置误差曲线"
        >
          <line x1="0" :y1="chart.height - 1" :x2="chart.width" :y2="chart.height - 1" />
          <polyline class="tracking-chart-max" :points="chart.max" />
          <polyline class="tracking-chart-mean" :points="chart.mean" />
        </svg>
        <div class="tracking-chart-legend">
          <span><i class="mean"></i>平均误差</span>
          <span><i class="max"></i>最大误差</span>
        </div>
      </div>

      <div v-if="worstEffectors.length" class="effector-diagnostics">
        <div class="effector-diagnostics-head">
          <span>偏差最大的映射点</span>
          <span>{{ diagnostics.mapped_effectors }}/{{ diagnostics.requested_effectors }} 已匹配</span>
        </div>
        <div
          v-for="effector in worstEffectors"
          :key="`${effector.canonical}:${effector.target_link}`"
          class="effector-row"
        >
          <span :title="effector.target_link">{{ effector.canonical }}</span>
          <strong>{{ formatCm(effector.p95_error_m) }}</strong>
        </div>
      </div>

      <p class="result-evaluation-note">
        该诊断基于网页预览帧，用于快速发现跟踪与接触异常，不替代仿真稳定性或真机评测。
      </p>
    </template>
  </section>
</template>
