import type { MediaRef } from './media'

export type DemoReview = {
  id: string; kind: string; kindLabel: string; title: string; sub: string
  by: string; at: string; description: string; sourcePath: string
  files?: MediaRef[]; fields?: { label: string; value: string }[]
}
