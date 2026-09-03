import { describe, expect, it, vi } from "vitest";
import {
  Bone,
  BoxGeometry,
  DataTexture,
  DepthTexture,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Scene,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
  WebGLRenderTarget,
} from "three";

import { ThreeResourceDisposer } from "../../src/platform/graphics/common/three-resource-disposer";

describe("ThreeResourceDisposer", () => {
  it("disposes shared geometry, material, and texture exactly once", () => {
    const geometry = new BoxGeometry();
    const texture = new Texture();
    const material = new MeshBasicMaterial({ map: texture });
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeTexture = vi.spyOn(texture, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    const root = new Group();
    root.add(
      new Mesh(geometry, material),
      new Mesh(geometry, [material, material]),
    );
    const disposer = new ThreeResourceDisposer();

    disposer.disposeObject3DResources(root);

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(root.children).toHaveLength(2);
  });

  it("finds textures in cyclic ShaderMaterial uniform structures", () => {
    const direct = new Texture();
    const nested = new Texture();
    const repeated = new Texture();
    const cyclic: Record<string, unknown> = { texture: nested };
    cyclic.self = cyclic;
    const material = new ShaderMaterial({
      uniforms: {
        direct: { value: direct },
        nested: { value: [cyclic, repeated, { repeated }] },
      },
    });
    const spies = [direct, nested, repeated].map((texture) =>
      vi.spyOn(texture, "dispose"),
    );
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), material));

    new ThreeResourceDisposer().disposeObject3DResources(root);

    for (const dispose of spies) expect(dispose).toHaveBeenCalledOnce();
  });

  it("deduplicates shared bone textures and clears every Skeleton reference", () => {
    const boneTexture = new DataTexture(new Uint8Array(4), 1, 1);
    const disposeTexture = vi.spyOn(boneTexture, "dispose");
    const firstSkeleton = new Skeleton([new Bone()]);
    const secondSkeleton = new Skeleton([new Bone()]);
    firstSkeleton.boneTexture = boneTexture;
    secondSkeleton.boneTexture = boneTexture;
    const firstSkeletonDispose = vi.spyOn(firstSkeleton, "dispose");
    const secondSkeletonDispose = vi.spyOn(secondSkeleton, "dispose");
    const first = new SkinnedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ map: boneTexture }),
    );
    const second = new SkinnedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial(),
    );
    first.bind(firstSkeleton);
    second.bind(secondSkeleton);
    const root = new Group();
    root.add(first, second);

    new ThreeResourceDisposer().disposeObject3DResources(root);

    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(firstSkeleton.boneTexture).toBeNull();
    expect(secondSkeleton.boneTexture).toBeNull();
    expect(firstSkeletonDispose).not.toHaveBeenCalled();
    expect(secondSkeletonDispose).not.toHaveBeenCalled();
  });

  it("includes Scene-owned textures and override material", () => {
    const shared = new Texture();
    const overrideMaterial = new MeshBasicMaterial({ map: shared });
    const disposeTexture = vi.spyOn(shared, "dispose");
    const disposeMaterial = vi.spyOn(overrideMaterial, "dispose");
    const scene = new Scene();
    scene.background = shared;
    scene.environment = shared;
    scene.overrideMaterial = overrideMaterial;

    new ThreeResourceDisposer().disposeObject3DResources(scene);

    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it("empties child subtrees, preserves their owner, and accepts extras", () => {
    const parent = new Group();
    const owner = new Group();
    const unattached = new MeshBasicMaterial();
    const disposeUnattached = vi.spyOn(unattached, "dispose");
    const hidden = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    hidden.visible = false;
    const disposeHiddenGeometry = vi.spyOn(hidden.geometry, "dispose");
    parent.add(owner);
    owner.add(hidden, new Group());
    const ownerDispose = vi.fn();
    Object.assign(owner, { dispose: ownerDispose });
    const disposer = new ThreeResourceDisposer();

    disposer.disposeObject3DChildren(owner, { materials: [unattached] });
    disposer.disposeObject3DChildren(owner);

    const replacement = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial(),
    );
    const disposeReplacementGeometry = vi.spyOn(
      replacement.geometry,
      "dispose",
    );
    owner.add(replacement);
    disposer.disposeObject3DChildren(owner);

    expect(owner.parent).toBe(parent);
    expect(owner.children).toHaveLength(0);
    expect(disposeHiddenGeometry).toHaveBeenCalledOnce();
    expect(disposeUnattached).toHaveBeenCalledOnce();
    expect(disposeReplacementGeometry).toHaveBeenCalledOnce();
    expect(ownerDispose).not.toHaveBeenCalled();
  });

  it("clears the stable owner even when one resource disposal fails", () => {
    const failure = new Error("geometry listener failed");
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    vi.spyOn(geometry, "dispose").mockImplementation(() => {
      throw failure;
    });
    const disposeMaterial = vi.spyOn(material, "dispose");
    const owner = new Group();
    owner.add(new Mesh(geometry, material));

    let thrown: unknown;
    try {
      new ThreeResourceDisposer().disposeObject3DChildren(owner);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([failure]);
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(owner.children).toHaveLength(0);
  });

  it("rejects object-owned and render-target resources", () => {
    const disposer = new ThreeResourceDisposer();
    const instanced = new InstancedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial(),
      1,
    );
    expect(() => disposer.disposeObject3DResources(instanced)).toThrow(
      "InstancedMesh and BatchedMesh require dedicated owner disposal",
    );

    const target = new WebGLRenderTarget(1, 1);
    const mesh = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ map: target.texture }),
    );
    expect(() => disposer.disposeObject3DResources(mesh)).toThrow(
      "Render-target textures must be released through their target owner",
    );

    const depthTexture = new DepthTexture();
    const depthTarget = new WebGLRenderTarget(1, 1, { depthTexture });
    expect(depthTexture.isRenderTargetTexture).toBe(false);
    expect(depthTexture.renderTarget).toBe(depthTarget);
    expect(() =>
      disposer.disposeMaterials(
        new ShaderMaterial({ uniforms: { depth: { value: depthTexture } } }),
      ),
    ).toThrow(
      "Render-target textures must be released through their target owner",
    );
  });

  it("continues after disposal failures and never touches host-owned values", () => {
    const failure = new Error("geometry listener failed");
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const disposeGeometry = vi
      .spyOn(geometry, "dispose")
      .mockImplementation(() => {
        throw failure;
      });
    const disposeMaterial = vi.spyOn(material, "dispose");
    const objectDispose = vi.fn();
    const rendererDispose = vi.fn();
    const root = new Group();
    Object.assign(root, { dispose: objectDispose });
    root.userData.renderer = { dispose: rendererDispose };
    root.add(new Mesh(geometry, material));
    const disposer = new ThreeResourceDisposer();

    let thrown: unknown;
    try {
      disposer.disposeObject3DResources(root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([failure]);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(objectDispose).not.toHaveBeenCalled();
    expect(rendererDispose).not.toHaveBeenCalled();
  });
});
