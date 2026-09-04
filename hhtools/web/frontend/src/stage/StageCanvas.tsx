import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { RobotLayer } from "./RobotLayer";
import { SkeletonLayer } from "./SkeletonLayer";
import type { StageLayerId } from "./StageViewMenu";
import type { StageMotionPayload, StageRobotPayload } from "./types";
/**
 * Owns the orbit controller for the one R3F canvas. R3F owns rendering and
 * resize observation; this small adapter keeps the old interaction settings
 * without introducing a second animation loop or a global event listener.
 */
function OrbitController() {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.set(0, 0.9, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    // The legacy view uses a linear wheel dolly below instead of OrbitControls'
    // exponential wheel implementation.
    controls.enableZoom = false;
    controls.update();
    controlsRef.current = controls;

    const smoothWheel = (event: WheelEvent): void => {
      if (!controls.enabled) return;

      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) delta *= 400;

      const step = THREE.MathUtils.clamp(-delta / 120, -2.5, 2.5);
      const scale = Math.pow(0.968, step);
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      if (distance < 1e-6) return;

      const nextDistance = THREE.MathUtils.clamp(
        distance * scale,
        controls.minDistance,
        controls.maxDistance,
      );
      offset.setLength(nextDistance);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      event.preventDefault();
    };

    gl.domElement.addEventListener("wheel", smoothWheel, { passive: false });
    return () => {
      gl.domElement.removeEventListener("wheel", smoothWheel);
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  useFrame(() => {
    controlsRef.current?.update();
  });

  return null;
}

function GroundGrid() {
  const gridRef = useRef<THREE.GridHelper | null>(null);

  useEffect(() => {
    const material = gridRef.current?.material;
    if (!material || Array.isArray(material)) return;
    material.opacity = 0.35;
    material.transparent = true;
    material.needsUpdate = true;
  }, []);

  return (
    <gridHelper
      ref={gridRef}
      args={[20, 40, 0x99a0ab, 0xd2d6dd]}
    />
  );
}

/** Static scene content migrated from the legacy renderer bootstrap. */
function StageScene({
  motion,
  robot,
  visibleLayers,
}: {
  motion: StageMotionPayload | null;
  robot: StageRobotPayload | null;
  visibleLayers: readonly StageLayerId[];
}) {
  const skeletonVisible =
    visibleLayers.includes("skeleton") ||
    (motion !== null && visibleLayers.includes("body"));
  const robotVisible = robot !== null && visibleLayers.includes("robot");

  return (
    <>
      <OrbitController />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={[0xffffff, 0x8899aa, 1.35]} />
      <directionalLight position={[3, 6, 4]} intensity={1.5} />
      <directionalLight position={[-3, 4, -2]} intensity={0.85} />

      <GroundGrid />
      <group name="hhtools-world" rotation={[-Math.PI / 2, 0, 0]}>
        <axesHelper args={[1.2]} />
        <SkeletonLayer motion={motion} visible={skeletonVisible} />
        <RobotLayer robot={robot} visible={robotVisible} />
      </group>
    </>
  );
}

export function StageCanvas({
  motion,
  robot = null,
  visibleLayers,
}: {
  motion: StageMotionPayload | null;
  robot?: StageRobotPayload | null;
  visibleLayers: readonly StageLayerId[];
}) {
  return (
    <Canvas
      id="three-canvas"
      data-stage-renderer="react-three-fiber"
      className="absolute inset-0 block h-full w-full"
      flat
      dpr={[1, 2]}
      camera={{
        fov: 50,
        near: 0.01,
        far: 200,
        position: [2.6, 1.9, 3.2],
      }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ gl }) => {
        // Keep the CSS stage background visible through the transparent canvas.
        gl.setClearColor(0x000000, 0);
      }}
    >
      <StageScene
        motion={motion}
        robot={robot}
        visibleLayers={visibleLayers}
      />
    </Canvas>
  );
}
