<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'

import type { PlaybackAction, PlaybackUiState } from '../runtime/types'

const state = reactive<PlaybackUiState>({
  visible: false,
  active: false,
  playing: false,
  loop: true,
  progress: 0,
  speed: 1,
  label: '0.00 / 0.00 s'
})

function send(action: PlaybackAction, value?: number): void {
  window.dispatchEvent(
    new CustomEvent('hhtools:playback-command', { detail: { action, value } })
  )
}

function receive(event: WindowEventMap['hhtools:playback-state']): void {
  Object.assign(state, event.detail)
}

onMounted(() => window.addEventListener('hhtools:playback-state', receive))
onBeforeUnmount(() => window.removeEventListener('hhtools:playback-state', receive))
</script>

<template>
  <div v-show="state.visible" id="playbar" class="playbar">
    <button
      id="play-btn"
      type="button"
      class="icon-btn"
      :aria-label="state.playing ? '暂停' : '播放'"
      @click="send('toggle')"
    >
      {{ state.playing ? '❚❚' : '▶' }}
    </button>
    <input
      id="scrubber"
      class="scrubber"
      type="range"
      min="0"
      max="100"
      :value="state.progress * 100"
      aria-label="播放进度"
      @input="send('seek', Number(($event.target as HTMLInputElement).value) / 100)"
    />
    <span id="time-label" class="time-label" :title="state.label">{{ state.label }}</span>
    <span class="speed-ctrl" title="播放速度（拖动调节，双击复位 1×）" @dblclick="send('speed', 1)">
      <span class="speed-icon" aria-hidden="true">🐢</span>
      <input
        id="speed-slider"
        class="speed-slider"
        type="range"
        min="0.1"
        max="4"
        step="0.1"
        :value="state.speed"
        aria-label="播放速度"
        @input="send('speed', Number(($event.target as HTMLInputElement).value))"
      />
      <span id="speed-label" class="speed-label">{{ state.speed.toFixed(1) }}×</span>
    </span>
    <button
      id="loop-btn"
      type="button"
      class="icon-btn ghost"
      :class="{ off: !state.loop }"
      title="循环"
      aria-label="切换循环播放"
      @click="send('loop')"
    >
      🔁
    </button>
  </div>
</template>
