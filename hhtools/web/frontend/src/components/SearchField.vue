<script setup lang="ts">
import { nextTick, ref } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  placeholder?: string
  clearLabel?: string
  autocomplete?: string
  disabled?: boolean
}>(), {
  placeholder: '',
  clearLabel: 'Clear search',
  autocomplete: 'off',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  clear: []
}>()

const input = ref<HTMLInputElement | null>(null)

function updateValue(event: Event): void {
  emit('update:modelValue', (event.currentTarget as HTMLInputElement).value)
}

function focus(): void {
  input.value?.focus()
}

function clear(): void {
  if (props.disabled || !input.value) return

  // Dispatch the same native event as typing. This keeps the component useful
  // with Vue v-model while preserving legacy consumers that listen directly on
  // the real input element (the Motion Library runtime is one such consumer).
  input.value.value = ''
  input.value.dispatchEvent(new Event('input', { bubbles: true }))
  emit('clear')
  void nextTick(focus)
}

defineExpose({ clear, focus })
</script>

<template>
  <div class="search-field" :class="{ disabled }" role="search">
    <!-- Heroicons "magnifying-glass" outline path, MIT licensed. -->
    <svg
      class="search-field-leading-icon"
      data-icon="magnifying-glass"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />
    </svg>
    <input
      ref="input"
      v-bind="$attrs"
      class="search search-field-input"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="label"
      :autocomplete="autocomplete"
      :disabled="disabled"
      :spellcheck="false"
      @input="updateValue"
    />
    <button
      v-if="modelValue"
      type="button"
      class="search-field-clear"
      :title="clearLabel"
      :aria-label="clearLabel"
      :disabled="disabled"
      @click="clear"
    >
      <!-- Heroicons "x-mark" outline path, MIT licensed. -->
      <svg data-icon="x-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
