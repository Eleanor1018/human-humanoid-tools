import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

import { timelineFrameAtTime, type StagePlaybackRef } from "./playback";
import type {
  StageMatrix4,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
} from "./types";

interface RobotLayerProps {
  robot: StageRobotPayload | null;
  trajectory?: StageRobotTrajectoryPayload | null;
  playback?: StagePlaybackRef;
  visible: boolean;
}

interface LinkMesh {
  mesh: THREE.Mesh;
  baked: THREE.Matrix4;
}

interface RobotResource {
  root: THREE.Group;
  residualRoots: readonly THREE.Object3D[];
  linkMeshes: Readonly<Record<string, readonly LinkMesh[]>>;
  zeroInverse: Readonly<Record<string, THREE.Matrix4>>;
}

interface FramePair {
  first: number;
  second: number;
  blend: number;
}

const linkMatrix = new THREE.Matrix4();
const nextLinkMatrix = new THREE.Matrix4();
const linkDelta = new THREE.Matrix4();
const meshMatrix = new THREE.Matrix4();
const positionA = new THREE.Vector3();
const positionB = new THREE.Vector3();
const quaternionA = new THREE.Quaternion();
const quaternionB = new THREE.Quaternion();
const scaleA = new THREE.Vector3();
const scaleB = new THREE.Vector3();

function matrix4Into(values: StageMatrix4, target: THREE.Matrix4): THREE.Matrix4 {
  return target.set(
    values[0], values[1], values[2], values[3],
    values[4], values[5], values[6], values[7],
    values[8], values[9], values[10], values[11],
    values[12], values[13], values[14], values[15],
  );
}

function matrix4(values: StageMatrix4): THREE.Matrix4 {
  return matrix4Into(values, new THREE.Matrix4());
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
    mesh.geometry?.dispose();
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

function disposeResource(resource: RobotResource): void {
  for (const root of new Set([resource.root, ...resource.residualRoots])) {
    disposeScene(root);
  }
}

function normalizedName(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function basename(value: unknown): string {
  return String(value ?? "").split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
}

function linkForNode(node: THREE.Object3D, robot: StageRobotPayload): string | null {
  let current: THREE.Object3D | null = node;
  while (current) {
    const name = current.name || "";
    const base = basename(name);
    const mapped = robot.mesh_to_link?.[name] ?? robot.mesh_to_link?.[base];
    if (mapped) return mapped;
    const candidates = [normalizedName(name), normalizedName(base)].filter(Boolean);
    for (const link of robot.links) {
      const normalizedLink = normalizedName(link);
      const shortLink = normalizedLink.endsWith("link")
        ? normalizedLink.slice(0, -4)
        : normalizedLink;
      if (candidates.includes(normalizedLink) || candidates.includes(shortLink)) {
        return link;
      }
    }
    current = current.parent;
  }
  return null;
}

function fallbackResource(robot: StageRobotPayload): RobotResource {
  const root = new THREE.Group();
  const geometry = new THREE.SphereGeometry(0.025, 10, 10);
  const material = new THREE.MeshStandardMaterial({ color: 0x8e44ad });
  const linkMeshes: Record<string, LinkMesh[]> = {};
  const zeroInverse: Record<string, THREE.Matrix4> = {};
  for (const link of robot.links) {
    const zero = matrix4(robot.link_transforms_zero[link]);
    zeroInverse[link] = zero.clone().invert();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(zero);
    root.add(mesh);
    linkMeshes[link] = [{ mesh, baked: zero }];
  }
  return { root, residualRoots: [], linkMeshes, zeroInverse };
}

async function glbResource(robot: StageRobotPayload): Promise<RobotResource> {
  if (!robot.glb_base64) return fallbackResource(robot);
  let gltf: Awaited<ReturnType<GLTFLoader["parseAsync"]>>;
  try {
    gltf = await new Promise<Awaited<ReturnType<GLTFLoader["parseAsync"]>>>(
      (resolve, reject) => {
        new GLTFLoader().parse(decodeGlb(robot.glb_base64!), "", resolve, reject);
      },
    );
  } catch (error) {
    console.warn("Unable to parse robot GLB; using link fallback", error);
    return fallbackResource(robot);
  }
  const residualRoots = [...new Set([gltf.scene, ...(gltf.scenes ?? [])])];
  const root = new THREE.Group();
  try {
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
    const linkMeshes: Record<string, LinkMesh[]> = {};
    const zeroInverse: Record<string, THREE.Matrix4> = {};
    let unmappedMeshes = 0;
    for (const link of robot.links) {
      zeroInverse[link] = matrix4(robot.link_transforms_zero[link]).invert();
    }
    for (const mesh of meshes) {
      const link = linkForNode(mesh, robot);
      const baked = mesh.matrixWorld.clone();
      mesh.matrixAutoUpdate = false;
      if (!mesh.geometry.getAttribute("normal")) {
        mesh.geometry.computeVertexNormals();
      }
      root.add(mesh);
      mesh.matrix.copy(baked);
      mesh.matrixWorldNeedsUpdate = true;
      if (!link || !zeroInverse[link]) {
        unmappedMeshes += 1;
        continue;
      }
      (linkMeshes[link] ??= []).push({ mesh, baked });
    }
    if (Object.keys(linkMeshes).length === 0) {
      throw new Error("robot GLB does not expose link-mapped meshes");
    }
    if (unmappedMeshes > 0) {
      console.warn(
        `${unmappedMeshes} robot meshes have no link mapping and will remain static`,
      );
    }
    root.updateMatrixWorld(true);
    return { root, residualRoots, linkMeshes, zeroInverse };
  } catch (error) {
    disposeScene(root);
    for (const residual of residualRoots) disposeScene(residual);
    console.warn("Unable to prepare robot GLB; using link fallback", error);
    return fallbackResource(robot);
  }
}

function resolveFrame(trajectory: StageRobotTrajectoryPayload, frame: number): FramePair {
  const maximum = trajectory.frames.length - 1;
  const first = Math.min(maximum, Math.max(0, Math.floor(frame)));
  const blend = frame - first;
  if (blend <= 1e-5 || first >= maximum) {
    return { first, second: first, blend: 0 };
  }
  const second = first + 1;
  const sourceGap = trajectory.frame_indices?.[second] != null
    ? trajectory.frame_indices[second] - trajectory.frame_indices[first]
    : 1;
  if (sourceGap > 1) {
    const nearest = blend >= 0.5 ? second : first;
    return { first: nearest, second: nearest, blend: 0 };
  }
  return { first, second, blend };
}

function applyStatic(
  group: THREE.Group,
  resource: RobotResource,
  robot: StageRobotPayload,
): void {
  group.position.set(0, 0, robot.ground_offset_z ?? 0);
  group.quaternion.identity();
  for (const entries of Object.values(resource.linkMeshes)) {
    for (const { mesh, baked } of entries) mesh.matrix.copy(baked);
  }
  group.updateMatrixWorld(true);
}

function applyTrajectoryFrame(
  group: THREE.Group,
  resource: RobotResource,
  robot: StageRobotPayload,
  trajectory: StageRobotTrajectoryPayload,
  frame: number,
): void {
  const pair = resolveFrame(trajectory, frame);
  const current = trajectory.frames[pair.first];
  const next = pair.blend > 1e-5 ? trajectory.frames[pair.second] : undefined;
  if (!current) return;

  const liftA = current.mesh_z_lift ?? 0;
  const liftB = next?.mesh_z_lift ?? liftA;
  const lift = liftA + (liftB - liftA) * pair.blend;
  if (current.root) {
    const root = current.root;
    const nextRoot = next?.root;
    group.position.set(
      nextRoot ? root[0] + (nextRoot[0] - root[0]) * pair.blend : root[0],
      nextRoot ? root[1] + (nextRoot[1] - root[1]) * pair.blend : root[1],
      (nextRoot ? root[2] + (nextRoot[2] - root[2]) * pair.blend : root[2]) + lift,
    );
    group.quaternion.set(root[3], root[4], root[5], root[6]);
    if (nextRoot) {
      quaternionB.set(nextRoot[3], nextRoot[4], nextRoot[5], nextRoot[6]);
      group.quaternion.slerp(quaternionB, pair.blend);
    }
  } else {
    group.position.set(0, 0, (robot.ground_offset_z ?? 0) + lift);
    group.quaternion.identity();
  }

  for (const [link, entries] of Object.entries(resource.linkMeshes)) {
    const currentTransform = current.links[link];
    if (!currentTransform) continue;
    matrix4Into(currentTransform, linkMatrix);
    const nextTransform = next?.links[link];
    if (nextTransform) {
      matrix4Into(nextTransform, nextLinkMatrix);
      linkMatrix.decompose(positionA, quaternionA, scaleA);
      nextLinkMatrix.decompose(positionB, quaternionB, scaleB);
      positionA.lerp(positionB, pair.blend);
      quaternionA.slerp(quaternionB, pair.blend);
      scaleA.lerp(scaleB, pair.blend);
      linkMatrix.compose(positionA, quaternionA, scaleA);
    }
    linkDelta.copy(linkMatrix).multiply(resource.zeroInverse[link]);
    for (const { mesh, baked } of entries) {
      meshMatrix.copy(linkDelta).multiply(baked);
      mesh.matrix.copy(meshMatrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }
  group.updateMatrixWorld(true);
}

function RobotObject({
  resource,
  robot,
  trajectory,
  playback,
  visible,
}: {
  resource: RobotResource;
  robot: StageRobotPayload;
  trajectory?: StageRobotTrajectoryPayload | null;
  playback?: StagePlaybackRef;
  visible: boolean;
}) {
  const group = useRef<THREE.Group | null>(null);
  const lastFrame = useRef<number | null>(null);

  useEffect(() => {
    if (!group.current) return;
    lastFrame.current = null;
    if (trajectory?.frames.length) {
      const frame = timelineFrameAtTime(
        trajectory,
        playback?.current.elapsed ?? 0,
      );
      applyTrajectoryFrame(group.current, resource, robot, trajectory, frame);
      lastFrame.current = frame;
    } else {
      applyStatic(group.current, resource, robot);
    }
  }, [playback, resource, robot, trajectory]);

  useFrame(() => {
    if (!visible || !group.current || !trajectory?.frames.length) return;
    const frame = timelineFrameAtTime(
      trajectory,
      playback?.current.elapsed ?? 0,
    );
    if (lastFrame.current === frame) return;
    applyTrajectoryFrame(group.current, resource, robot, trajectory, frame);
    lastFrame.current = frame;
  });

  return (
    <group ref={group} name="robot-model" visible={visible}>
      <primitive object={resource.root} dispose={null} />
    </group>
  );
}

/** Loads one robot model and optionally drives it from an H2R/R2R trajectory. */
export function RobotLayer({
  robot,
  trajectory = null,
  playback,
  visible,
}: RobotLayerProps) {
  const [loaded, setLoaded] = useState<{
    owner: StageRobotPayload;
    resource: RobotResource;
  } | null>(null);
  const resourceRef = useRef<RobotResource | null>(null);
  const resource = loaded?.owner === robot ? loaded.resource : null;

  useEffect(() => {
    let cancelled = false;
    if (resourceRef.current) disposeResource(resourceRef.current);
    resourceRef.current = null;
    setLoaded(null);
    if (!robot) return undefined;

    void glbResource(robot)
      .then((next) => {
        if (cancelled) {
          disposeResource(next);
          return;
        }
        resourceRef.current = next;
        setLoaded({ owner: robot, resource: next });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn("Unable to load robot model; using link fallback", error);
        const fallback = fallbackResource(robot);
        resourceRef.current = fallback;
        setLoaded({ owner: robot, resource: fallback });
      });

    return () => {
      cancelled = true;
      if (resourceRef.current) disposeResource(resourceRef.current);
      resourceRef.current = null;
    };
  }, [robot]);

  if (!robot || !resource) return null;
  return (
    <RobotObject
      resource={resource}
      robot={robot}
      trajectory={trajectory}
      playback={playback}
      visible={visible}
    />
  );
}
