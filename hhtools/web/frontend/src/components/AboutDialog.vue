<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import type { WorkspaceLocale } from '../runtime/types'

const props = defineProps<{
  open: boolean
  locale: WorkspaceLocale
}>()

const emit = defineEmits<{
  close: []
}>()

const copy = computed(() => props.locale === 'zh-CN'
  ? {
      close: '关闭关于窗口',
      summary: '人形机器人动作重映射与数据集分析工具',
      authors: '作者与贡献者',
      authorsValue: 'jaggerShen 与 hhtools contributors',
      year: '年份',
      source: '源代码',
      license: '许可证',
      contact: '联系',
    }
  : {
      close: 'Close About dialog',
      summary: 'Humanoid motion retargeting and dataset analysis',
      authors: 'Authors and contributors',
      authorsValue: 'jaggerShen and hhtools contributors',
      year: 'Year',
      source: 'Source code',
      license: 'License',
      contact: 'Contact',
    })

function handleKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="workspace-settings-backdrop about-dialog-backdrop" @mousedown.self="emit('close')">
      <section class="workspace-settings-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
        <header class="workspace-settings-head about-dialog-head">
          <div>
            <h2 id="about-dialog-title">Human-Humanoid Tools</h2>
          </div>
          <button type="button" class="workspace-settings-close" :aria-label="copy.close" @click="emit('close')">×</button>
        </header>

        <div class="about-dialog-body">
          <p class="about-dialog-summary">{{ copy.summary }}</p>

          <dl class="about-dialog-details">
            <div>
              <dt>{{ copy.authors }}</dt>
              <dd>{{ copy.authorsValue }}</dd>
            </div>
            <div>
              <dt>{{ copy.year }}</dt>
              <dd>2026</dd>
            </div>
            <div>
              <dt>{{ copy.source }}</dt>
              <dd>
                <a href="https://github.com/Roboparty/human-humanoid-tools" target="_blank" rel="noreferrer">
                  github.com/Roboparty/human-humanoid-tools
                </a>
              </dd>
            </div>
            <div>
              <dt>{{ copy.license }}</dt>
              <dd>
                <a href="https://github.com/Roboparty/human-humanoid-tools/blob/main/LICENSE" target="_blank" rel="noreferrer">
                  Apache-2.0
                </a>
              </dd>
            </div>
          </dl>

          <section class="about-dialog-contact" :aria-label="copy.contact">
            <h3>{{ copy.contact }}</h3>
            <a href="mailto:shenyaojie@roboparty.com">shenyaojie@roboparty.com</a>
            <a href="mailto:sunlancheng@roboparty.com">sunlancheng@roboparty.com</a>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>
