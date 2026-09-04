import { useEffect, useMemo, useRef, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

import type { StageRobotPayload } from "./types";

interface RobotLayerProps {
  robot: StageRobotPayload | null;
  visible: boolean;
}

function decodeGlb(base64: string): ArrayBuffer {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function disposeScene(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

function matrixPosition(values: readonly number[] | undefined): THREE.Vector3 | null {
  if (!values || values.length !== 16 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const matrix = new THREE.Matrix4().set(...(values as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]));
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function RobotFallback({ robot }: { robot: StageRobotPayload }) {
  const positions = useMemo(
    () => robot.links.map((link) => matrixPosition(robot.link_transforms_zero[link])),
    [robot],
  );
  const validPositions = positions.filter(
    (position): position is THREE.Vector3 => position !== null,
  );
  const linePositions = useMemo(() => {
    const values = new Float32Array(Math.max(0, validPositions.length - 1) * 6);
    for (let index = 1; index < validPositions.length; index += 1) {
      const offset = (index - 1) * 6;
      const previous = validPositions[index - 1];
      const current = validPositions[index];
      values.set(
        [previous.x, previous.y, previous.z, current.x, current.y, current.z],
        offset,
      );
    }
    return values;
  }, [validPositions]);

  return (
    <>
      {validPositions.map((position, index) => (
        <mesh key={index} position={position}>
          <sphereGeometry args={[0.035, 12, 12]} />
          <meshStandardMaterial color={0x8e44ad} roughness={0.5} />
        </mesh>
      ))}
      {linePositions.length > 0 && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[linePositions, 3]}
              count={linePositions.length / 3}
            />
          </bufferGeometry>
          <lineBasicMaterial color={0x8e44ad} transparent opacity={0.7} />
        </lineSegments>
      )}
    </>
  );
}

/** Loads a serialized zero-pose robot without introducing a second render loop. */
export function RobotLayer({ robot, visible }: RobotLayerProps) {
  const [scene, setScene] = useState<THREE.Group | null>(null);
  const [parseFailed, setParseFailed] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setScene(null);
    setParseFailed(false);
    if (!robot?.glb_base64) return;

    let parsedScene: THREE.Group | null = null;
    let cancelled = false;
    try {
      const loader = new GLTFLoader();
      loader.parse(
        decodeGlb(robot.glb_base64),
        "",
        (gltf) => {
          if (cancelled || generation.current !== currentGeneration) {
            disposeScene(gltf.scene);
            return;
          }
          parsedScene = gltf.scene;
          setScene(gltf.scene);
        },
        () => {
          if (!cancelled && generation.current === currentGeneration) {
            setParseFailed(true);
          }
        },
      );
    } catch {
      if (!cancelled && generation.current === currentGeneration) {
        setParseFailed(true);
      }
    }

    return () => {
      cancelled = true;
      if (parsedScene) disposeScene(parsedScene);
    };
  }, [robot]);

  if (!robot) return null;
  return (
    <group
      name="robot-model"
      visible={visible}
      position={[0, 0, robot.ground_offset_z ?? 0]}
    >
      {scene && !parseFailed ? (
        <primitive object={scene} dispose={null} />
      ) : (
        <RobotFallback robot={robot} />
      )}
    </group>
  );
}
