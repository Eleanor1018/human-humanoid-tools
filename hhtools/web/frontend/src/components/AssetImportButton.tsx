import { Button } from "@/components/ui/button";

export type ImportAssetKind = "motion" | "robot";

const labels: Readonly<Record<ImportAssetKind, string>> = {
  motion: "Import motion",
  robot: "Import robot",
};

/** Opens the owning asset workspace; importing remains the asset view's job. */
export function AssetImportButton({
  kind,
  onClick,
}: {
  readonly kind: ImportAssetKind;
  readonly onClick: () => void;
}) {
  const label = labels[kind];
  return (
    <Button
      size="sm"
      className="shrink-0 gap-1.5 px-2.5"
      aria-label={label}
      title={`Open the ${kind === "motion" ? "Motion" : "Robot"} workspace`}
      onClick={onClick}
    >
      <span
        className="size-3.5 shrink-0 bg-current [mask:url(/icons/common/upload.svg)_center/contain_no-repeat] [-webkit-mask:url(/icons/common/upload.svg)_center/contain_no-repeat]"
        aria-hidden="true"
      />
      <span>{label}</span>
    </Button>
  );
}
