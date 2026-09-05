/** Single source of truth for the original Three.js Stage appearance. */

export const SKELETON_VISUALS = {
  source: {
    color: 0x0a84ff,
    jointRadius: 0.028,
    jointSegments: 12,
    roughness: 0.5,
    metalness: 0.1,
    emissive: 0x000000,
    opacity: 1,
    lineOpacity: 0.7,
  },
  scaled: {
    color: 0xffb020,
    jointRadius: 0.026,
    jointSegments: 10,
    roughness: 0.45,
    metalness: 0.15,
    emissive: 0x442200,
    opacity: 1,
    lineOpacity: 0.85,
  },
  reference: {
    color: 0x5eb3ff,
    jointRadius: 0.022,
    jointSegments: 12,
    roughness: 0.34,
    metalness: 0.03,
    emissive: 0x0a4d92,
    opacity: 0.82,
    lineOpacity: 0.82 * 0.38,
  },
} as const;

export type SkeletonVisualVariant = keyof typeof SKELETON_VISUALS;

export const CAPSULE_BODY_VISUAL = {
  color: 0xf7a470,
  boneRadius: 0.035,
  jointRadius: 0.05,
  roughness: 0.6,
  metalness: 0.05,
} as const;

export const BAKED_BODY_VISUAL = {
  color: 0xb4c8dc,
  roughness: 0.55,
  metalness: 0.05,
} as const;

export const ENVIRONMENT_VISUALS = {
  source: {
    terrainColor: 0x9a9aa0,
    terrainRoughness: 0.95,
    terrainOpacity: 1,
    objectColor: 0xff9f0a,
    objectRoughness: 0.6,
    objectOpacity: 0.55,
  },
  scaled: {
    terrainColor: 0x5c7a9e,
    terrainRoughness: 0.9,
    terrainOpacity: 0.92,
    objectColor: 0x6a9fd4,
    objectRoughness: 0.55,
    objectOpacity: 0.7,
  },
} as const;

export type EnvironmentVisualVariant = keyof typeof ENVIRONMENT_VISUALS;

export const ROBOT_VISUAL = {
  color: 0xc8ccd4,
  emissive: 0x6b7280,
  emissiveIntensity: 0.55,
  roughness: 0.6,
  metalness: 0.15,
  fallbackColor: 0xb8bdc6,
  fallbackRadius: 0.02,
  fallbackSegments: 8,
} as const;
