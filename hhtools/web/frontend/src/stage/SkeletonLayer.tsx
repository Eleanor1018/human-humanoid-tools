import { useMemo } from "react";
import * as THREE from "three";

import type { StageMotionPayload } from "./types";

interface SkeletonLayerProps {
  motion: StageMotionPayload | null;
  visible: boolean;
}

interface SkeletonEdge {
  child: number;
  parent: number;
}

const SOURCE_COLOR = 0x0a84ff;

/** Renders the first source frame without owning transport or DOM state. */
export function SkeletonLayer({ motion, visible }: SkeletonLayerProps) {
  const firstFrame = motion?.positions[0] ?? [];
  const edges = useMemo<SkeletonEdge[]>(() => {
    if (!motion) return [];
    const excluded = new Set(motion.exclude_joint_indices ?? []);
    return motion.parent_indices.flatMap((parent, child) =>
      parent >= 0 && !excluded.has(child) && !excluded.has(parent)
        ? [{ child, parent }]
        : [],
    );
  }, [motion]);
  const linePositions = useMemo(
    () => {
      const positions = new Float32Array(edges.length * 2 * 3);
      let offset = 0;
      for (const edge of edges) {
        const child = firstFrame[edge.child];
        const parent = firstFrame[edge.parent];
        if (!child || !parent) continue;
        positions[offset++] = child[0];
        positions[offset++] = child[1];
        positions[offset++] = child[2];
        positions[offset++] = parent[0];
        positions[offset++] = parent[1];
        positions[offset++] = parent[2];
      }
      return positions;
    },
    [edges, firstFrame],
  );
  const excluded = new Set(motion?.exclude_joint_indices ?? []);
  return (
    <group visible={visible && motion !== null} name="source-skeleton">
      {firstFrame.map((_, index) => (
        <mesh
          key={index}
          position={firstFrame[index]}
          visible={!excluded.has(index)}
        >
          <sphereGeometry args={[0.028, 12, 12]} />
          <meshStandardMaterial
            color={SOURCE_COLOR}
            roughness={0.5}
            metalness={0.1}
          />
        </mesh>
      ))}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[linePositions, 3]}
            count={linePositions.length / 3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          color={SOURCE_COLOR}
          transparent
          opacity={0.7}
        />
      </lineSegments>
    </group>
  );
}
