/** Initial Stage copy from the legacy renderer, shown until a payload is loaded. */
export function StageEmpty() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-center">
      <div>
        <span
          className="mx-auto mb-[18px] block size-[54px] bg-foreground opacity-[.18] [mask:url(/icons/motion/film.svg)_center/contain_no-repeat] [-webkit-mask:url(/icons/motion/film.svg)_center/contain_no-repeat]"
          aria-hidden="true"
        />
        <p className="mb-1.5 text-[19px] leading-tight font-semibold text-foreground">
          Drop a motion here to preview
        </p>
        <p className="max-w-[360px] text-[13px] leading-normal text-muted-foreground">
          Supports BVH / GLB / NPZ and common motion datasets.
        </p>
      </div>
    </div>
  );
}
