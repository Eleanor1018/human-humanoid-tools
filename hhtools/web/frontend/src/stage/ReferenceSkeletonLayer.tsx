import { useMemo } from "react";
import * as THREE from "three";

import { prepareReferenceSkeleton } from "./referenceSkeleton";
import type { StageMotionPayload, StageRobotPayload } from "./types";
import { REFERENCE_SKELETON_VISUAL } from "./visualStyle";

interface ReferenceSkeletonLayerProps {
  reference: StageMotionPayload | null;
  robot: StageRobotPayload | null;
  visible: boolean;
  mappedOnly?: boolean;
  sourceOpacity?: number;
  name?: string;
}

function referenceLinePositions(
  prepared: ReturnType<typeof prepareReferenceSkeleton>,
): Float32Array {
  const linePositions = new Float32Array(prepared.edges.length * 2 * 3);
  let offset = 0;
  for (const edge of prepared.edges) {
    const child = prepared.frame[edge.child];
    const parent = prepared.frame[edge.parent];
    linePositions.set(child, offset);
    linePositions.set(parent, offset + 3);
    offset += 6;
  }
  return linePositions;
}

/** Static calibration overlay derived from a reference pose and target IK map. */
export function ReferenceSkeletonLayer({
  reference,
  robot,
  visible,
  mappedOnly = true,
  sourceOpacity = REFERENCE_SKELETON_VISUAL.sourceOpacity,
  name = "reference-skeleton",
}: ReferenceSkeletonLayerProps) {
  const prepared = useMemo(
    () => (reference ? prepareReferenceSkeleton(reference, robot) : null),
    [reference, robot],
  );
  const opacity = THREE.MathUtils.clamp(sourceOpacity, 0.1, 1);
  const linePositions = useMemo(
    () => (prepared ? referenceLinePositions(prepared) : new Float32Array()),
    [prepared],
  );

  if (!prepared || prepared.frame.length === 0) return null;
  return (
    <group name={name} visible={visible}>
      {prepared.frame.map((position, index) => {
        const mapping = prepared.mappingByJoint.get(index);
        const mapped = mapping !== undefined;
        if (prepared.excluded.has(index) || (mappedOnly && !mapped)) return null;
        return (
          <mesh
            key={index}
            name={`reference-joint-${index}`}
            position={position}
            scale={
              mapped
                ? REFERENCE_SKELETON_VISUAL.mappedScale
                : REFERENCE_SKELETON_VISUAL.contextScale
            }
            userData={
              mapping
                ? {
                    hhtoolsSemantic: mapping.semantic,
                    hhtoolsTargetLink: mapping.targetLink,
                    hhtoolsReferenceQuaternion: mapping.quaternion,
                  }
                : undefined
            }
          >
            <sphereGeometry
              args={[
                REFERENCE_SKELETON_VISUAL.jointRadius,
                REFERENCE_SKELETON_VISUAL.jointSegments,
                REFERENCE_SKELETON_VISUAL.jointSegments,
              ]}
            />
            <meshStandardMaterial
              color={prepared.color}
              roughness={
                mapped
                  ? REFERENCE_SKELETON_VISUAL.mapped.roughness
                  : REFERENCE_SKELETON_VISUAL.context.roughness
              }
              metalness={
                mapped
                  ? REFERENCE_SKELETON_VISUAL.mapped.metalness
                  : REFERENCE_SKELETON_VISUAL.context.metalness
              }
              emissive={
                mapped
                  ? REFERENCE_SKELETON_VISUAL.mapped.emissive
                  : REFERENCE_SKELETON_VISUAL.context.emissive
              }
              emissiveIntensity={
                mapped
                  ? REFERENCE_SKELETON_VISUAL.mapped.emissiveIntensity
                  : REFERENCE_SKELETON_VISUAL.context.emissiveIntensity
              }
              transparent
              opacity={
                mapped
                  ? opacity
                  : opacity * REFERENCE_SKELETON_VISUAL.context.opacityFactor
              }
            />
          </mesh>
        );
      })}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[linePositions, 3]}
            count={linePositions.length / 3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          color={prepared.color}
          transparent
          opacity={opacity * REFERENCE_SKELETON_VISUAL.lineOpacityFactor}
        />
      </lineSegments>
    </group>
  );
}
